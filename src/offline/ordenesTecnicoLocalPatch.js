// src/offline/ordenesTecnicoLocalPatch.js
//
// ============================================================================
// CONVENCIÓN DE MARCAS (FMS)
//   // FMS NUEVO - INICIO ... // FMS NUEVO - FIN
//       Código agregado en esta revisión.
//   // FMS ELIMINADO - INICIO ... // FMS ELIMINADO - FIN
//       Código anterior que se retira (queda comentado para comparar).
// Todo lo que no tiene marca queda exactamente igual que antes.
// ============================================================================
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  loadOrdenesTecnicoList,
  saveOrdenesTecnicoList,
  loadOrdenTecnicoDetail,
  saveOrdenTecnicoDetail,
} from "./ordenesTecnicoCache";
import { clearSapStatusAck, getSapQueueStatusState } from "./sapQueue";

const PATCH_KEY = (userEmail) =>
  `ordenesTecnico:statusPatch:${String(userEmail || "unknown").trim().toLowerCase()}`;
const TBMKY_STATUS_KEY = (orderId) =>
  `tbmky_status_${String(orderId || "").trim()}`;

export const STATUS_LABELS = {
  "0100": "PENDIENTE",
  "0200": "EN PROCESO",
  "0300": "FINALIZADA",
  "0400": "PENDIENTE DE FIRMA",
  "0500": "FINALIZADA C/PENDIENTES",
  "0600": "Carta No Mantto",
};

export function normalizeStatusCode(code) {
  if (code === null || code === undefined) return "";
  const value = String(code).trim();
  if (!value) return "";
  const number = parseInt(value, 10);
  return Number.isNaN(number) ? value : String(number).padStart(4, "0");
}

export function resolveStatusLabel(code) {
  const normalized = normalizeStatusCode(code);
  return STATUS_LABELS[normalized] || normalized || "Sin empezar";
}

function getOrderId(item) {
  return String(item?.Orderid ?? item?.OrderId ?? item?.orderid ?? "").trim();
}

function extractStatusCodes(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];

  const matches = text.match(/\b\d{1,4}\b/g) || [];
  return matches.map(normalizeStatusCode).filter(Boolean);
}

function getEffectiveStatusCode(item) {
  const explicitCode = normalizeStatusCode(item?.estatus_code);
  if (explicitCode) return explicitCode;

  const rawStatus =
    item?.userstatus ||
    item?.Userstatus ||
    item?.UserStatus ||
    item?.UserStText ||
    "";

  const codes = extractStatusCodes(rawStatus);
  return codes[codes.length - 1] || "";
}

// FMS NUEVO - INICIO
// SAP procesa los paquetes bulk en segundo plano ("Paquete masivo recibido con
// éxito. Procesando en segundo plano"). Durante ese lapso, SAP sigue devolviendo
// el estatus anterior. Para que la app no "retroceda" el estatus, el parche local
// se conserva un tiempo después de enviado, mientras SAP no lo alcance.
export const SENT_GRACE_MS = 15 * 60 * 1000; // 15 min de margen tras el envío

// Orden lógico del flujo. Un código desconocido NO participa (gana SAP).
const STATUS_RANK = {
  "": 0,
  "0100": 1,
  "0200": 2,
  "0400": 3,
  "0300": 4,
  "0500": 4,
  "0600": 4,
};

const statusRank = (code) => {
  const key = normalizeStatusCode(code);
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, key)
    ? STATUS_RANK[key]
    : null;
};

// ¿Debe el parche local seguir mandando sobre lo que dice SAP?
//  - Si la orden sigue en la cola SAP: sí (comportamiento original).
//  - Si ya se envió hace menos de SENT_GRACE_MS y SAP todavía va ATRÁS del
//    parche: sí (SAP aún no procesa el paquete).
//  - En cualquier otro caso: no (gana SAP, como antes).
function shouldKeepPatch(patch, sapCode, pendingInQueue) {
  if (!patch) return false;

  const patchCode = normalizeStatusCode(patch.estatus_code);
  if (!patchCode) return false;

  if (pendingInQueue) return true;

  const sentAt = Number(patch.sentAt || 0);
  const withinGrace =
    patch.pendingSync === false &&
    sentAt > 0 &&
    Date.now() - sentAt < SENT_GRACE_MS;

  if (!withinGrace) return false;

  const sapRank = statusRank(sapCode);
  const patchRank = statusRank(patchCode);

  if (sapRank === null || patchRank === null) return false;

  return sapRank < patchRank;
}
// FMS NUEVO - FIN

// FMS NUEVO - INICIO
// Helpers para confirmar contra SAP el estatus de UNA orden (ver statusConfirmation.js).

// Estatus efectivo de una orden tal como la devuelve SAP/backend.
export function extractEffectiveStatusCode(item) {
  return getEffectiveStatusCode(item);
}

// ¿SAP ya alcanzó (o superó) el estatus esperado? Un código desconocido se
// considera alcanzado: en caso de duda manda SAP, como antes.
export function hasSapReachedStatus(sapCode, expectedCode) {
  const sapRank = statusRank(sapCode);
  const expectedRank = statusRank(expectedCode);

  if (sapRank === null || expectedRank === null) return true;

  return sapRank >= expectedRank;
}
// FMS NUEVO - FIN

export function getPreviousStatusForTransition(nextStatus, currentStatus = "") {
  const next = normalizeStatusCode(nextStatus);
  const current = normalizeStatusCode(currentStatus);
  if (next === "0100") return "";
  if (next === "0200") return "0100";
  if (next === "0400") return "0200";
  if (next === "0300") return current === "0400" ? "0400" : "0200";
  if (next === "0600") return current || "0100";
  return current;
}

export function buildStatusTransitionSet({
  nextStatus,
  currentStatus = "",
  language = "ES",
}) {
  const next = normalizeStatusCode(nextStatus);
  const previous = getPreviousStatusForTransition(next, currentStatus);
  if (!next) return [];
  const rows = [{ UserStText: next, Langu: language, Inactive: "" }];
  if (previous && previous !== next) {
    rows.push({ UserStText: previous, Langu: language, Inactive: "X" });
  }
  return rows;
}

export async function getLocalStatusPatch(userEmail) {
  try {
    const raw = await AsyncStorage.getItem(PATCH_KEY(userEmail));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveLocalStatusPatchMap(userEmail, patchMap) {
  await AsyncStorage.setItem(PATCH_KEY(userEmail), JSON.stringify(patchMap || {}));
}

export async function setLocalStatusPatch(userEmail, orderId, estatusCode, options = {}) {
  try {
    const cleanOrderId = String(orderId || "").trim();
    const code = normalizeStatusCode(estatusCode);
    if (!cleanOrderId || !code) return null;
    const patchMap = await getLocalStatusPatch(userEmail);
    const previousPatch = patchMap[cleanOrderId] || {};
    patchMap[cleanOrderId] = {
      ...previousPatch,
      estatus_code: code,
      estatus_label: resolveStatusLabel(code),
      previous_status: normalizeStatusCode(
        options.previousStatus ?? previousPatch.previous_status ?? "",
      ),
      pendingSync: options.pendingSync === undefined ? true : !!options.pendingSync,
      source: String(options.source || previousPatch.source || "local"),
      updatedAt: Date.now(),
    };
    if (options.pendingSync === false) patchMap[cleanOrderId].sentAt = Date.now();
    await saveLocalStatusPatchMap(userEmail, patchMap);
    if (["0200", "0300", "0400", "0600"].includes(code)) {
      await AsyncStorage.removeItem(TBMKY_STATUS_KEY(cleanOrderId));
    }
    return patchMap[cleanOrderId];
  } catch (error) {
    console.log("[STATUS PATCH] No se pudo guardar:", error?.message || error);
    return null;
  }
}

export async function removeLocalStatusPatch(userEmail, orderId) {
  try {
    const cleanOrderId = String(orderId || "").trim();
    if (!cleanOrderId) return false;
    const patchMap = await getLocalStatusPatch(userEmail);
    if (patchMap[cleanOrderId]) {
      delete patchMap[cleanOrderId];
      await saveLocalStatusPatchMap(userEmail, patchMap);
    }
    await clearSapStatusAck(cleanOrderId);
    return true;
  } catch {
    return false;
  }
}

export async function markLocalStatusPatchSent(userEmail, orderId) {
  try {
    const cleanOrderId = String(orderId || "").trim();
    const patchMap = await getLocalStatusPatch(userEmail);
    const currentPatch = patchMap[cleanOrderId];
    if (!currentPatch) return null;
    patchMap[cleanOrderId] = {
      ...currentPatch,
      pendingSync: false,
      sentAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveLocalStatusPatchMap(userEmail, patchMap);
    return patchMap[cleanOrderId];
  } catch {
    return null;
  }
}

function buildStatusFields(item, code) {
  const normalized = normalizeStatusCode(code);
  return {
    ...(item || {}),
    estatus_code: normalized,
    userstatus: normalized,
    Userstatus: normalized,
    UserStatus: normalized,
    UserStText: normalized,
    estatus_label: resolveStatusLabel(normalized),
    isPendingSignature: normalized === "0400",
    isFinal: ["0300", "0600"].includes(normalized),
    checkin_done: ["0100", "0200", "0300", "0400", "0600"].includes(normalized),
  };
}

export function applyStatusPatchToOrdenes(ordenes = [], patchMap = {}) {
  const list = Array.isArray(ordenes) ? ordenes : [];
  return list.map((item) => {
    const code = normalizeStatusCode(patchMap?.[getOrderId(item)]?.estatus_code);
    return code ? buildStatusFields(item, code) : item;
  });
}

export async function reconcileStatusPatchesWithSap(userEmail, sapOrders = []) {
  const list = Array.isArray(sapOrders) ? sapOrders : [];
  const [patchMap, queueState] = await Promise.all([
    getLocalStatusPatch(userEmail),
    getSapQueueStatusState(),
  ]);
  const pendingOrderIds =
    queueState?.pendingOrderIds instanceof Set
      ? queueState.pendingOrderIds
      : new Set(queueState?.pendingOrderIds || []);
  let patchMapChanged = false;
  const acksToClear = new Set();
  const detailsToUpdate = [];

  const data = list.map((item) => {
    const orderId = getOrderId(item);
    if (!orderId) return item;
    const sapCode = getEffectiveStatusCode(item);
    const patchCode = normalizeStatusCode(patchMap?.[orderId]?.estatus_code);

    // FMS ELIMINADO - INICIO
    // Antes: el parche solo sobrevivía mientras la orden siguiera en la cola SAP.
    // En cuanto salía de la cola se borraba y mandaba lo que dijera SAP, aunque
    // SAP todavía no hubiera procesado el paquete (procesa en segundo plano).
    // if (patchCode && pendingOrderIds.has(orderId)) {
    // FMS ELIMINADO - FIN

    // FMS NUEVO - INICIO
    // Ahora: además de la cola, el parche sobrevive un margen tras el envío
    // mientras SAP siga reportando un estatus anterior.
    if (
      patchCode &&
      shouldKeepPatch(patchMap?.[orderId], sapCode, pendingOrderIds.has(orderId))
    ) {
    // FMS NUEVO - FIN
      detailsToUpdate.push({ orderId, code: patchCode });
      return buildStatusFields(item, patchCode);
    }
    if (patchCode) {
      delete patchMap[orderId];
      patchMapChanged = true;
      acksToClear.add(orderId);
    }
    if (sapCode) detailsToUpdate.push({ orderId, code: sapCode });
    return sapCode ? buildStatusFields(item, sapCode) : item;
  });

  if (patchMapChanged) await saveLocalStatusPatchMap(userEmail, patchMap);
  await Promise.all(
    Array.from(acksToClear).map((orderId) => clearSapStatusAck(orderId)),
  );
  await Promise.all(
    detailsToUpdate.map(({ orderId, code }) =>
      patchCacheOrdenTecnicoDetail(orderId, code),
    ),
  );
  return data;
}

// FMS NUEVO - INICIO
// Versión de SOLO LECTURA de la regla anterior: aplica los parches locales
// vigentes sobre órdenes que llegaron de SAP sin borrar nada ni escribir en
// caché. Sirve para pantallas que consultan SAP directamente (lista histórica,
// detalle de una orden que no está en la caché de la ventana offline).
// Si SAP ya alcanzó o superó el parche, la orden queda tal como la dio SAP.
export async function overlayRecentStatusPatches(userEmail, orders = []) {
  const list = Array.isArray(orders) ? orders : [];
  if (!list.length) return list;

  try {
    const [patchMap, queueState] = await Promise.all([
      getLocalStatusPatch(userEmail),
      getSapQueueStatusState(),
    ]);

    if (!patchMap || !Object.keys(patchMap).length) return list;

    const pendingOrderIds =
      queueState?.pendingOrderIds instanceof Set
        ? queueState.pendingOrderIds
        : new Set(queueState?.pendingOrderIds || []);

    // FMS ELIMINADO - INICIO
    // Antes: el parche se buscaba por el número de orden EXACTO. Si SAP devolvía
    // el mismo número con distintos ceros a la izquierda, el parche no se encontraba.
    // return list.map((item) => {
    //   const orderId = getOrderId(item);
    //   const patch = orderId ? patchMap[orderId] : null;
    //   if (!patch) return item;
    //   const keep = shouldKeepPatch(
    //     patch,
    //     getEffectiveStatusCode(item),
    //     pendingOrderIds.has(orderId),
    //   );
    //   return keep ? buildStatusFields(item, patch.estatus_code) : item;
    // });
    // FMS ELIMINADO - FIN

    // FMS NUEVO - INICIO
    // SAP puede devolver el número de orden con o sin ceros a la izquierda
    // ("000040224775" vs "40224775"); se compara sin ceros iniciales.
    const normalizeKey = (value) => {
      const clean = String(value ?? "").trim();
      return clean.replace(/^0+(?=\d)/, "") || (clean ? "0" : "");
    };

    const patchByKey = {};
    Object.keys(patchMap).forEach((key) => {
      patchByKey[normalizeKey(key)] = patchMap[key];
    });

    const pendingKeys = new Set(
      Array.from(pendingOrderIds).map((value) => normalizeKey(value)),
    );

    return list.map((item) => {
      const key = normalizeKey(getOrderId(item));
      const patch = key ? patchByKey[key] : null;

      if (!patch) return item;

      const keep = shouldKeepPatch(
        patch,
        getEffectiveStatusCode(item),
        pendingKeys.has(key),
      );

      return keep ? buildStatusFields(item, patch.estatus_code) : item;
    });
    // FMS NUEVO - FIN
  } catch (error) {
    console.log(
      "[STATUS PATCH] No se pudo aplicar el parche de lectura:",
      error?.message || error,
    );
    return list;
  }
}
// FMS NUEVO - FIN

export async function patchCacheOrdenesTecnicoList(userEmail, orderId, newStatusCode) {
  try {
    const cached = await loadOrdenesTecnicoList(userEmail);
    if (!Array.isArray(cached?.data)) return false;
    const cleanOrderId = String(orderId || "").trim();
    const code = normalizeStatusCode(newStatusCode);
    const newData = cached.data.map((item) =>
      getOrderId(item) === cleanOrderId ? buildStatusFields(item, code) : item,
    );
    await saveOrdenesTecnicoList(userEmail, newData, cached?.window || null);
    return true;
  } catch (error) {
    console.log("[STATUS PATCH] Error actualizando lista:", error?.message || error);
    return false;
  }
}

export async function patchCacheOrdenTecnicoDetail(orderId, newStatusCode) {
  try {
    const cached = await loadOrdenTecnicoDetail(orderId);
    if (!cached?.data) return false;
    return (
      (await saveOrdenTecnicoDetail(
        orderId,
        buildStatusFields(cached.data, newStatusCode),
      )) === true
    );
  } catch (error) {
    console.log("[STATUS PATCH] Error actualizando detalle:", error?.message || error);
    return false;
  }
}

export async function applyLocalStatusTransition({
  userEmail,
  orderId,
  nextStatus,
  currentStatus = "",
  source = "local",
  pendingSync = true,
}) {
  const code = normalizeStatusCode(nextStatus);
  const previousStatus = getPreviousStatusForTransition(code, currentStatus);
  if (!userEmail || !orderId || !code) {
    return { ok: false, reason: "missing_data" };
  }
  const patch = await setLocalStatusPatch(userEmail, orderId, code, {
    previousStatus,
    pendingSync,
    source,
  });
  const listUpdated = await patchCacheOrdenesTecnicoList(userEmail, orderId, code);
  const detailUpdated = await patchCacheOrdenTecnicoDetail(orderId, code);
  return {
    ok: !!patch,
    orderId: String(orderId),
    previousStatus,
    nextStatus: code,
    listUpdated,
    detailUpdated,
    patch,
  };
}