// src/offline/statusConfirmation.js
//
// ARCHIVO NUEVO (FMS)
//
// Confirma contra SAP, en segundo plano, el estatus de UNA orden después de que
// la app lo cambió localmente (por ejemplo, tras el check-in).
//
// Principios:
//  - Offline-first: el estatus local (parche) manda mientras SAP no lo confirme;
//    nada de esto bloquea el trabajo del técnico ni se espera con await en la UI.
//  - Solo se consulta LA orden afectada (1 GET a /api/ordenes/sap/<id>), nunca
//    la lista completa.
//  - Con backoff: 15 s, 45 s, 1.5 min, 3 min, 5 min, 5 min (~15 min en total,
//    igual al margen SENT_GRACE_MS del archivo de parches). Se detiene en
//    cuanto SAP confirma.
//  - Sin internet no se gastan intentos: se reanuda solo al volver la red o al
//    volver la app a primer plano.
//  - Si la app se cierra, resumePendingConfirmations() lo retoma al abrir la lista.
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import AsyncStorage from "@react-native-async-storage/async-storage";

import api from "../services/api";
import {
  SENT_GRACE_MS,
  getLocalStatusPatch,
  normalizeStatusCode,
  extractEffectiveStatusCode,
  hasSapReachedStatus,
  patchCacheOrdenesTecnicoList,
  patchCacheOrdenTecnicoDetail,
  removeLocalStatusPatch,
} from "./ordenesTecnicoLocalPatch";

// Esperas entre consultas (acumulado ≈ 15 min).
const CHECK_DELAYS_MS = [15000, 45000, 90000, 180000, 300000, 300000];
const REQUEST_TIMEOUT_MS = 20000;
const CONFIRMED_VISIBLE_MS = 6000; // cuánto se muestra "Confirmado por SAP"

// Último usuario que programó una confirmación. Sirve para retomarlas solas
// después de una recarga o de reabrir la app (los temporizadores viven en memoria).
const LAST_USER_KEY = "statusConfirm:lastUserEmail";

// TEMPORAL (diagnóstico): confirma que los helpers llegaron desde el archivo de
// parches. Los tres deben decir "function"/"number". Borrar cuando se valide.
console.log("[STATUS CONFIRM] módulo cargado:", {
  hasSapReachedStatus: typeof hasSapReachedStatus,
  extractEffectiveStatusCode: typeof extractEffectiveStatusCode,
  SENT_GRACE_MS: typeof SENT_GRACE_MS,
});

// SAP puede devolver el número de orden con o sin ceros a la izquierda.
const normalizeKey = (value) => {
  const clean = String(value ?? "").trim();
  return clean.replace(/^0+(?=\d)/, "") || (clean ? "0" : "");
};

const jobs = new Map(); // key -> { orderId, userEmail, attempt, timer, running, expected, firstDelayMs }
const states = new Map(); // key -> { status, expected, sapCode, attempts, userEmail, updatedAt }
const listeners = new Set();

let netUnsub = null;
let appStateSub = null;

/* =========================
   Estado observable
   ========================= */
function emit(orderId) {
  const current = states.get(normalizeKey(orderId)) || null;

  listeners.forEach((listener) => {
    try {
      listener(orderId, current);
    } catch {}
  });
}

function setState(orderId, next) {
  const key = normalizeKey(orderId);
  if (!key) return;

  states.set(key, {
    ...(states.get(key) || {}),
    ...next,
    updatedAt: Date.now(),
  });

  emit(orderId);
}

function clearState(orderId) {
  const key = normalizeKey(orderId);
  if (!key) return;

  states.delete(key);
  emit(orderId);
}

export function getStatusConfirmation(orderId) {
  return states.get(normalizeKey(orderId)) || null;
}

export function subscribeStatusConfirmations(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Hook para pantallas: devuelve { status, ... } o null.
// status: "checking" | "waiting_network" | "confirmed" | "unconfirmed"
export function useStatusConfirmation(orderId) {
  const [state, setLocalState] = useState(() =>
    getStatusConfirmation(orderId),
  );

  useEffect(() => {
    const key = normalizeKey(orderId);
    setLocalState(getStatusConfirmation(orderId));

    return subscribeStatusConfirmations((changedId, next) => {
      if (normalizeKey(changedId) === key) setLocalState(next);
    });
  }, [orderId]);

  return state;
}

/* =========================
   Listeners globales (se crean una sola vez)
   ========================= */
function isActive(job) {
  return jobs.get(normalizeKey(job.orderId)) === job;
}

function ensureNetListener() {
  if (netUnsub) return;

  netUnsub = NetInfo.addEventListener((state) => {
    const online = !!(
      state?.isConnected && state?.isInternetReachable !== false
    );

    if (!online) return;

    // Reanuda SOLO los trabajos que se quedaron esperando red (waitingNetwork).
    // Importante: NetInfo puede llamar a este listener de inmediato al
    // suscribirse, justo antes de que el trabajo programe su primer timer; sin
    // esta marca, esa llamada adelantaba la primera consulta a ~2 s.
    jobs.forEach((job) => {
      if (job.waitingNetwork && !job.running && !job.timer) {
        job.waitingNetwork = false;
        job.timer = setTimeout(() => runCheck(job), 2000);
      }
    });
  });
}

function ensureAppStateListener() {
  if (appStateSub) return;

  appStateSub = AppState.addEventListener("change", (state) => {
    if (state !== "active") return;

    // Los timers de JS se pausan en segundo plano. Solo se adelanta la
    // consulta si el timer YA VENCIÓ (o no hay ninguno). Si todavía no toca,
    // se respeta el calendario: de lo contrario, cada vez que la app vuelve a
    // primer plano (cámara, galería, alertas del sistema) se gastaría un intento.
    jobs.forEach((job) => {
      if (job.running) return;
      if (job.timer && job.dueAt && Date.now() < job.dueAt) return;

      clearTimeout(job.timer);
      job.timer = setTimeout(() => runCheck(job), 1500);
    });
  });
}

/* =========================
   Núcleo
   ========================= */
function findPatch(patchMap, orderId) {
  const key = normalizeKey(orderId);
  const entryKey = Object.keys(patchMap || {}).find(
    (candidate) => normalizeKey(candidate) === key,
  );

  return entryKey ? { key: entryKey, patch: patchMap[entryKey] } : null;
}

function scheduleNext(job) {
  if (!isActive(job)) return;

  const delay =
    job.attempt === 0 && job.firstDelayMs != null
      ? job.firstDelayMs
      : CHECK_DELAYS_MS[job.attempt];

  // Se agotaron los intentos: SAP no confirmó dentro del margen.
  if (delay === undefined) {
    jobs.delete(normalizeKey(job.orderId));
    setState(job.orderId, {
      status: "unconfirmed",
      expected: job.expected,
      attempts: job.attempt,
      userEmail: job.userEmail,
    });
    console.log("[STATUS CONFIRM] Sin confirmación de SAP:", {
      orderId: job.orderId,
      expected: job.expected,
      attempts: job.attempt,
    });
    return;
  }

  setState(job.orderId, {
    status: "checking",
    expected: job.expected,
    attempts: job.attempt,
    userEmail: job.userEmail,
  });

  // Se guarda cuándo toca la próxima consulta para distinguir un timer que
  // sigue en curso de uno que venció mientras la app estaba en segundo plano.
  job.dueAt = Date.now() + delay;
  job.timer = setTimeout(() => runCheck(job), delay);
}

async function runCheck(job) {
  if (job.running || !isActive(job)) return;

  job.running = true;
  job.waitingNetwork = false;
  clearTimeout(job.timer);
  job.timer = null;

  const key = normalizeKey(job.orderId);

  try {
    // 1) ¿Sigue existiendo un parche por confirmar? Siempre se compara contra
    //    el parche VIGENTE (puede haber avanzado: check-in -> TBM/KY).
    const patchMap = await getLocalStatusPatch(job.userEmail);
    const found = findPatch(patchMap, job.orderId);
    const patchCode = normalizeStatusCode(found?.patch?.estatus_code);

    if (!found || !patchCode) {
      // Sin parche no hay nada que confirmar (otro flujo ya lo resolvió o
      // SAP lo alcanzó y el parche se limpió). Se deja constancia en el log.
      console.log("[STATUS CONFIRM] Sin parche pendiente; se cierra:", {
        orderId: job.orderId,
      });
      jobs.delete(key);
      clearState(job.orderId);
      return;
    }

    job.expected = patchCode;

    // 2) Sin internet: no se gasta un intento; se reanuda al volver la red.
    const net = await NetInfo.fetch();
    const online = !!(net?.isConnected && net?.isInternetReachable !== false);

    if (!online) {
      job.waitingNetwork = true;

      setState(job.orderId, {
        status: "waiting_network",
        expected: patchCode,
        attempts: job.attempt,
        userEmail: job.userEmail,
      });
      return;
    }

    const ensureValidToken = globalThis.__AUTH__?.ensureValidToken;
    if (typeof ensureValidToken === "function") {
      const okToken = await ensureValidToken();
      if (!okToken) throw new Error("token_invalido");
    }

    // 3) UNA sola consulta: la orden afectada.
    const res = await api.get(`/api/ordenes/sap/${job.orderId}`, {
      timeout: REQUEST_TIMEOUT_MS,
    });

    if (!isActive(job)) return;

    const sapCode = extractEffectiveStatusCode(res?.data || {});

    // segundosDesdeEnvio mide cuánto tarda SAP en reflejar el cambio; sirve
    // para ajustar SENT_GRACE_MS y CHECK_DELAYS_MS con datos reales.
    const sentAt = Number(found?.patch?.sentAt || 0);

    console.log("[STATUS CONFIRM] Consulta:", {
      orderId: job.orderId,
      patchCode,
      sapCode,
      attempt: job.attempt,
      segundosDesdeEnvio: sentAt ? Math.round((Date.now() - sentAt) / 1000) : null,
    });

    // 4) ¿SAP ya refleja el cambio (o va más adelante)?
    if (hasSapReachedStatus(sapCode, patchCode)) {
      const finalCode = sapCode || patchCode;

      await patchCacheOrdenesTecnicoList(job.userEmail, job.orderId, finalCode);
      await patchCacheOrdenTecnicoDetail(job.orderId, finalCode);
      await removeLocalStatusPatch(job.userEmail, found.key);

      jobs.delete(key);

      setState(job.orderId, {
        status: "confirmed",
        expected: patchCode,
        sapCode: finalCode,
        attempts: job.attempt,
        userEmail: job.userEmail,
      });

      setTimeout(() => {
        const current = states.get(key);
        if (current?.status === "confirmed") clearState(job.orderId);
      }, CONFIRMED_VISIBLE_MS);

      return;
    }

    // 5) SAP todavía va atrás: se vuelve a intentar más tarde.
    job.attempt += 1;
    scheduleNext(job);
  } catch (error) {
    console.log("[STATUS CONFIRM] Error consultando SAP:", {
      orderId: job.orderId,
      message: error?.response?.data?.detail || error?.message || String(error),
    });

    job.attempt += 1;
    scheduleNext(job);
  } finally {
    job.running = false;
  }
}

/* =========================
   API pública
   ========================= */

// Programa la confirmación de UNA orden. Llamar justo después de enviar el
// cambio a SAP y marcar el parche como enviado. No bloquea: no usar await.
export function scheduleStatusConfirmation({
  userEmail,
  orderId,
  firstDelayMs = null,
}) {
  const key = normalizeKey(orderId);
  if (!userEmail || !key) return;

  const previous = jobs.get(key);
  if (previous) clearTimeout(previous.timer);

  const job = {
    orderId: String(orderId).trim(),
    userEmail,
    attempt: 0,
    timer: null,
    running: false,
    expected: "",
    firstDelayMs,
  };

  jobs.set(key, job);

  AsyncStorage.setItem(LAST_USER_KEY, String(userEmail)).catch(() => {});

  ensureNetListener();
  ensureAppStateListener();

  console.log("[STATUS CONFIRM] Programada:", {
    orderId: job.orderId,
    primeraConsultaEnSeg: Math.round(
      (firstDelayMs != null ? firstDelayMs : CHECK_DELAYS_MS[0]) / 1000,
    ),
  });

  scheduleNext(job);
}

// Reintento manual (botón "Reintentar").
export function retryStatusConfirmation(orderId) {
  const state = getStatusConfirmation(orderId);
  if (!state?.userEmail) return;

  scheduleStatusConfirmation({
    userEmail: state.userEmail,
    orderId,
    firstDelayMs: 300,
  });
}

// Si la app se cerró antes de confirmar, retoma los cambios enviados
// recientemente. Llamar al abrir la lista de órdenes.
export async function resumePendingConfirmations(userEmail) {
  if (!userEmail) return;

  try {
    const patchMap = await getLocalStatusPatch(userEmail);
    const now = Date.now();

    Object.keys(patchMap || {}).forEach((orderId) => {
      const patch = patchMap[orderId];
      const sentAt = Number(patch?.sentAt || 0);

      const recentlySent =
        patch?.pendingSync === false &&
        sentAt > 0 &&
        now - sentAt < SENT_GRACE_MS;

      if (recentlySent && !jobs.has(normalizeKey(orderId))) {
        scheduleStatusConfirmation({
          userEmail,
          orderId,
          firstDelayMs: 2000,
        });
      }
    });
  } catch (error) {
    console.log(
      "[STATUS CONFIRM] No se pudieron retomar confirmaciones:",
      error?.message || error,
    );
  }
}

// Al cargar el módulo (arranque, recarga de Metro, reapertura tras un cierre)
// se retoman solas las confirmaciones recientes del último usuario. Sin esto,
// una recarga borraba los temporizadores y la confirmación se perdía hasta
// volver a abrir la lista. Si la lista ya la retomó, jobs.has() evita duplicar.
(async () => {
  try {
    const lastUserEmail = await AsyncStorage.getItem(LAST_USER_KEY);

    if (lastUserEmail) {
      setTimeout(() => resumePendingConfirmations(lastUserEmail), 3000);
    }
  } catch {}
})();