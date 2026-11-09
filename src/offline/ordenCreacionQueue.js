// src/offline/ordenCreacionQueue.js
// Creación de órdenes de mantenimiento "guardar primero, enviar después".
// Una creación por aviso. El estado cambia cuando SAP responde y la app lo ve.
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { useEffect, useState } from "react";

const KEY = "ordenCreacion:v1";
// FMS NUEVO - INICIO
// La cola es por usuario: una creación guardada por uno nunca la envía otro.
let usuario = "";
const clave = () => `${KEY}:${usuario}`;
// FMS NUEVO - FIN
const POST_URL = "/api/odata/ZCS_CREATE_WORKORDER_SRV_02/WorkOrderSet";
const POST_TIMEOUT_MS = 120000;
const MARGEN_SIN_CONFIRMAR_MS = 10 * 60 * 1000;
const MIN_VERIFICACIONES = 3;
const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];

export const ESTADO = {
  PENDIENTE: "PENDIENTE", // guardada, aún no enviada
  ENVIANDO: "ENVIANDO", // POST en curso
  CONFIRMANDO: "CONFIRMANDO", // sin respuesta: se pregunta a SAP, NO se reenvía
  CREADA: "CREADA",
  ERROR: "ERROR", // SAP rechazó: hay que corregir
  SIN_CONFIRMAR: "SIN_CONFIRMAR", // pasó el margen sin saber: decisión manual
};

/* ---------- almacenamiento con acceso serializado ---------- */
let cache = null;
const listeners = new Set();
let chain = Promise.resolve();

// FMS NUEVO - INICIO
export function usarUsuarioCola(correo) {
  const nuevo = String(correo || "").trim().toLowerCase();
  if (nuevo === usuario) return;
  usuario = nuevo;
  cache = null; // se vuelve a leer, ahora de la cola de este usuario
  return leer().then((m) => {
    const snap = { ...m };
    listeners.forEach((l) => {
      try {
        l(snap);
      } catch {}
    });
  });
}
// FMS NUEVO - FIN

async function leer() {
  if (cache) return cache;
  try {
    if (!usuario) {
      cache = {};
      return cache;
    }
    const raw = await AsyncStorage.getItem(clave());
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function mutar(fn) {
  const run = chain.then(async () => {
    const k = usuario ? clave() : null; // la clave se fija al empezar la operación
    const m = await leer();
    const res = await fn(m);
    try {
      if (k) await AsyncStorage.setItem(k, JSON.stringify(m));
    } catch {}
    const snap = { ...m };
    listeners.forEach((l) => {
      try {
        l(snap);
      } catch {}
    });
    return res;
  });
  chain = run.catch(() => {});
  return run;
}

const parchear = (id, cambios) =>
  mutar((m) => {
    if (!m[id]) return null;
    m[id] = { ...m[id], ...cambios, actualizadoEn: Date.now() };
    return m[id];
  });

export async function leerCreaciones() {
  return { ...(await leer()) };
}

export function suscribirCreaciones(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCreaciones() {
  const [mapa, setMapa] = useState({});
  useEffect(() => {
    let vivo = true;
    leerCreaciones().then((m) => vivo && setMapa(m));
    const un = suscribirCreaciones((m) => vivo && setMapa(m));
    return () => {
      vivo = false;
      un();
    };
  }, []);
  return mapa;
}

/* ---------- acciones ---------- */
// Un aviso solo admite una creación. Si ya hay una (en curso, creada o sin confirmar), no se duplica.
export function encolarCreacion({ avisoId, payload, resumen }) {
  const id = String(avisoId || "").trim();
  // FMS NUEVO - INICIO
  if (!usuario) return Promise.resolve({ ok: false, item: { estado: "SIN_USUARIO" } });
  // FMS NUEVO - FIN
  return mutar((m) => {
    const prev = m[id];
    if (prev && prev.estado !== ESTADO.ERROR) return { ok: false, item: prev };
    const ahora = Date.now();
    m[id] = {
      avisoId: id,
      payload,
      resumen: resumen || null,
      estado: ESTADO.PENDIENTE,
      creadoEn: prev?.creadoEn || ahora,
      actualizadoEn: ahora,
      intentos: prev?.intentos || 0,
      verificaciones: 0,
      error: null,
      orderId: null,
    };
    return { ok: true, item: m[id] };
  });
}

export const reintentarVerificacion = (id) =>
  parchear(id, { estado: ESTADO.CONFIRMANDO, verificaciones: 0, enviadoEn: Date.now() });

// Vuelve a PENDIENTE: antes de enviar, la pasada pregunta a SAP si ya existe la orden.
export const reenviar = (id) => parchear(id, { estado: ESTADO.PENDIENTE, error: null });

export const descartar = (id) =>
  mutar((m) => {
    const it = m[id];
    if (it && [ESTADO.ERROR, ESTADO.CREADA, ESTADO.SIN_CONFIRMAR].includes(it.estado)) delete m[id];
  });

/* ---------- procesamiento: una sola pasada a la vez ---------- */
// opciones = {
//   api,                          // instancia axios
//   parse(res) -> { orderId, notifNo, offerNo, offerMessage, errors[] },
//   verificar(avisoId) -> orderId | null   (lanza error si no hay red)
// }
let corriendo = null;
let repetir = false;
let opcionesActuales = null;
let timer = null;

export function procesarCreaciones(opciones) {
  if (opciones) opcionesActuales = opciones;
  if (corriendo) {
    repetir = true;
    return corriendo;
  }
  corriendo = (async () => {
    try {
      do {
        repetir = false;
        await pasada(opcionesActuales);
      } while (repetir);
    } finally {
      corriendo = null;
      programarVerificacion();
    }
  })();
  return corriendo;
}

async function pasada(op) {
  if (!op?.api || !op?.parse || !op?.verificar) return;
  if (!usuario) return; // sin usuario identificado no se envía nada
  const net = await NetInfo.fetch();
  const online = !!(net?.isConnected && net?.isInternetReachable !== false);
  // FMS NUEVO - INICIO (diagnóstico)
  const activos = Object.values(await leerCreaciones()).filter((i) =>
    [ESTADO.PENDIENTE, ESTADO.ENVIANDO, ESTADO.CONFIRMANDO].includes(i.estado),
  );
  // FMS NUEVO - FIN
  // FMS NUEVO - INICIO
  // NetInfo puede quedarse atascado (sobre todo en el simulador). Si hay algo pendiente,
  // se prueba el servidor de verdad antes de darse por vencido.
  let puedeEnviar = online;
  if (!puedeEnviar && activos.length) {
    try {
      await op.api.get("/health", { timeout: 5000 });
      puedeEnviar = true;
      console.log("[ORDEN QUEUE] NetInfo dice sin red, pero el servidor responde: se envía.");
    } catch {}
  }
  if (!puedeEnviar) return;
  // FMS NUEVO - FIN

  const ids = Object.keys(await leerCreaciones());
  for (const id of ids) {
    try {
      let it = (await leerCreaciones())[id];
      if (!it) continue;
      // La app se cerró a mitad del envío: no se sabe si SAP la creó.
      if (it.estado === ESTADO.ENVIANDO) it = await parchear(id, { estado: ESTADO.CONFIRMANDO });
      if (it.estado === ESTADO.PENDIENTE) await enviar(it, op);
      else if (it.estado === ESTADO.CONFIRMANDO) await confirmar(it, op);
    } catch (e) {
      console.log("[ORDEN QUEUE] Error:", e?.message || e);
    }
  }
}

async function enviar(it, op) {
  // Reintento: primero se pregunta, por si SAP ya la creó. Si no se puede preguntar, no se envía.
  if (it.intentos > 0) {
    try {
      const orden = await op.verificar(it.avisoId);
      if (orden) return parchear(it.avisoId, { estado: ESTADO.CREADA, orderId: orden, error: null });
    } catch {
      return;
    }
  }

  await parchear(it.avisoId, {
    estado: ESTADO.ENVIANDO,
    enviadoEn: Date.now(),
    intentos: it.intentos + 1,
  });
  console.log("[ORDEN QUEUE] Enviando:", { aviso: it.avisoId, intento: it.intentos + 1 });

  try {
    const res = await op.api.post(POST_URL, it.payload, {
      timeout: POST_TIMEOUT_MS,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    const r = op.parse(res) || {};
    if (!r.orderId && r.errors?.length) {
      const texto = r.errors.map((e) => `• ${e?.Message || "Error SAP"}`).join("\n");
      return parchear(it.avisoId, { estado: ESTADO.ERROR, error: texto });
    }
    return parchear(it.avisoId, {
      estado: ESTADO.CREADA,
      orderId: r.orderId || null,
      notifNo: r.notifNo || null,
      ofertaNo: r.offerNo || null,
      ofertaMsg: r.offerMessage || null,
      error: null,
    });
  } catch (err) {
    if (err?.response) {
      const msg =
        err?.response?.data?.error?.message?.value ||
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.message ||
        "No se pudo crear la orden.";
      return parchear(it.avisoId, { estado: ESTADO.ERROR, error: String(msg) });
    }
    // Timeout o red caída: SAP pudo haberla creado. Se pregunta, NO se reenvía.
    return parchear(it.avisoId, { estado: ESTADO.CONFIRMANDO, verificaciones: 0 });
  }
}

async function confirmar(it, op) {
  // FMS NUEVO: respeta la espera entre verificaciones (el latido no la salta)
  if (it.proximaVerificacion && Date.now() < it.proximaVerificacion) return;
  let orden = null;
  try {
    orden = await op.verificar(it.avisoId);
  } catch {
    return; // sin red: no cuenta como verificación
  }
  if (orden) return parchear(it.avisoId, { estado: ESTADO.CREADA, orderId: orden, error: null });

  const v = (it.verificaciones || 0) + 1;
  const vencido = Date.now() - (it.enviadoEn || it.creadoEn) > MARGEN_SIN_CONFIRMAR_MS;
  return parchear(it.avisoId, {
    verificaciones: v,
    proximaVerificacion: Date.now() + BACKOFF_MS[Math.min(v, BACKOFF_MS.length - 1)],
    estado: vencido && v >= MIN_VERIFICACIONES ? ESTADO.SIN_CONFIRMAR : ESTADO.CONFIRMANDO,
  });
}

async function programarVerificacion() {
  clearTimeout(timer);
  const pendientes = Object.values(await leerCreaciones()).filter(
    (i) => i.estado === ESTADO.CONFIRMANDO,
  );
  if (!pendientes.length) return;
  const n = Math.max(...pendientes.map((i) => i.verificaciones || 0));
  timer = setTimeout(() => procesarCreaciones(), BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]);
}

/* ---------- disparadores automáticos ---------- */
let auto = false;
// FMS NUEVO - INICIO
// Latido: mientras haya algo pendiente se reintenta solo, sin depender de que llegue el evento de red.
const HEARTBEAT_MS = 30000;
let proximaPasadaEn = 0;
export const getProximaPasadaEn = () => proximaPasadaEn;
// FMS NUEVO - FIN
export function iniciarAutoProceso(opciones) {
  opcionesActuales = opciones;
  if (auto) return;
  auto = true;
  AppState.addEventListener("change", (s) => {
    if (s === "active") procesarCreaciones();
  });
  NetInfo.addEventListener((s) => {
    if (s?.isConnected && s?.isInternetReachable !== false) procesarCreaciones();
  });
  // FMS NUEVO - INICIO
  proximaPasadaEn = Date.now() + HEARTBEAT_MS;
  setInterval(async () => {
    proximaPasadaEn = Date.now() + HEARTBEAT_MS;
    const hay = Object.values(await leerCreaciones()).some((i) =>
      [ESTADO.PENDIENTE, ESTADO.ENVIANDO, ESTADO.CONFIRMANDO].includes(i.estado),
    );
    if (hay) procesarCreaciones();
  }, HEARTBEAT_MS);
  // FMS NUEVO - FIN
  procesarCreaciones();
}