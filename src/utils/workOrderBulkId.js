import { Platform } from "react-native";
import * as Device from "expo-device";
// FMS NUEVO - INICIO
import AsyncStorage from "@react-native-async-storage/async-storage";
// FMS NUEVO - FIN

export function sanitizeBulkPart(value) {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function getDeviceModelForBulkId() {
  const rawModel =
    Device.modelName ||
    Device.productName ||
    Device.manufacturer ||
    Device.brand ||
    Platform.OS ||
    "DISPOSITIVO";

  return sanitizeBulkPart(rawModel).slice(0, 24) || "DISPOSITIVO";
}

export function buildWorkOrderBulkId({
  firstOrderId,
  timestampMs = Date.now(),
} = {}) {
  const cleanTimestamp = String(
    Number.isFinite(Number(timestampMs))
      ? Math.trunc(Number(timestampMs))
      : Date.now(),
  );

  const cleanOrderId =
    sanitizeBulkPart(firstOrderId || "SIN_ORDEN") || "SIN_ORDEN";

  const cleanDeviceModel = getDeviceModelForBulkId();

  return `PAQUETE_${cleanTimestamp}_${cleanOrderId}_${cleanDeviceModel}`;
}

// FMS NUEVO - INICIO
/* =========================================================================
   BulkId ESTABLE por operación.

   Un reintento de la MISMA operación (por ejemplo, un check-in que dio timeout)
   debe llevar el MISMO BulkId, para que SAP o el log ZLOG_ORD_BULK puedan
   reconocerlo como repetido. El identificador se guarda hasta que la operación
   tenga un resultado definitivo (éxito, o rechazo explícito de SAP).
   kind: "CHECKIN", "TBMKY", "FINALIZAR", ...
   ========================================================================= */
const PENDING_BULKIDS_KEY = "bulkId:pending:v1";
const PENDING_BULKID_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const normOrder = (orderId) =>
  String(orderId ?? "").trim().replace(/^0+(?=\d)/, "");

const pendingKey = (kind, orderId) =>
  `${String(kind || "OP").toUpperCase()}:${normOrder(orderId)}`;

async function readPendingBulkIds() {
  try {
    const raw = await AsyncStorage.getItem(PENDING_BULKIDS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writePendingBulkIds(map) {
  try {
    await AsyncStorage.setItem(PENDING_BULKIDS_KEY, JSON.stringify(map || {}));
  } catch {}
}

// Cola que serializa TODOS los accesos al mapa de BulkId pendientes.
// Sin ella, dos llamadas simultáneas leen el mapa vacío y cada una crea su
// propio BulkId (el mismo check-in se enviaba dos veces con ids distintos).
let bulkIdQueue = Promise.resolve();
function runExclusive(fn) {
  const run = bulkIdQueue.then(fn, fn);
  bulkIdQueue = run.catch(() => {});
  return run;
}

export function getOrCreateBulkId(args = {}) {
  return runExclusive(() => getOrCreateBulkIdInner(args));
}

async function getOrCreateBulkIdInner({ orderId, kind = "OP" } = {}) {
  const map = await readPendingBulkIds();
  const key = pendingKey(kind, orderId);
  const now = Date.now();

  // Limpia lo vencido para que el mapa no crezca.
  Object.keys(map).forEach((k) => {
    if (now - Number(map[k]?.createdAt || 0) > PENDING_BULKID_MAX_AGE_MS) {
      delete map[k];
    }
  });

  const existing = map[key];
  if (existing?.bulkId) {
    return { bulkId: existing.bulkId, reused: true };
  }

  const bulkId = buildWorkOrderBulkId({ firstOrderId: orderId });
  map[key] = { bulkId, createdAt: now };
  await writePendingBulkIds(map);

  return { bulkId, reused: false };
}

// Llamar cuando la operación ya tiene un resultado definitivo.
export function clearBulkId(args = {}) {
  return runExclusive(() => clearBulkIdInner(args));
}

async function clearBulkIdInner({ orderId, kind = "OP" } = {}) {
  const map = await readPendingBulkIds();
  const key = pendingKey(kind, orderId);

  if (map[key]) {
    delete map[key];
    await writePendingBulkIds(map);
  }
}
// FMS NUEVO - FIN