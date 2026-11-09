// app/tecnico/ordenes/index.js
//
// ============================================================================
// CONVENCIÓN DE MARCAS (FMS)
//   // FMS NUEVO - INICIO ... // FMS NUEVO - FIN
//       Código agregado en esta revisión.
//   // FMS ELIMINADO - INICIO ... // FMS ELIMINADO - FIN
//       Código anterior que se retira. Se deja comentado para comparar
//       "cómo estaba" contra "cómo quedó". Se puede borrar cuando se valide.
//   // FMS REEMPLAZO: el bloque ELIMINADO y el NUEVO van seguidos.
// Todo lo que no tiene marca queda exactamente igual que antes.
// ============================================================================
import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Platform,
  Modal,
  ScrollView,
  Alert,
  Pressable,
  Image,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import NetInfo from "@react-native-community/netinfo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import { buildOfflineWindow } from "../../../src/offline/ordenesTecnicoCache";

import {
  setLocalStatusPatch,
  patchCacheOrdenesTecnicoList,
  patchCacheOrdenTecnicoDetail,
   // FMS NUEVO - INICIO
  markLocalStatusPatchSent,
  overlayRecentStatusPatches,
  // FMS NUEVO - FIN
} from "../../../src/offline/ordenesTecnicoLocalPatch";
import { useAuth } from "../../../src/context/AuthContext";
import { useOrdenesTecnico } from "../../../src/context/OrdenesTecnicoContext";
import Header from "../../../src/components/Header";
import api from "../../../src/services/api";
import * as FileSystem from "expo-file-system/legacy";
import { preloadAvisoAveriaCatalogos } from "../../../src/services/avisoAveriaSap";
import { 
  buildWorkOrderBulkId,
  // FMS NUEVO - INICIO
  getOrCreateBulkId,
  clearBulkId,
  // FMS NUEVO - FIN
} from "../../../src/utils/workOrderBulkId";
import * as Device from "expo-device";

// FMS NUEVO - INICIO
import {
  scheduleStatusConfirmation,
  resumePendingConfirmations,
} from "../../../src/offline/statusConfirmation";
// FMS NUEVO - FIN

// FMS NUEVO - INICIO
import { subscribeBootstrapSync } from "../../../src/offline/bootstrapSyncTecnico";
// FMS NUEVO - FIN

import { debugOfflineStorage } from "../../../src/utils/offlineDebug";

// ============================
// Guarda EQUIPO activo para geolocalización
// UbicacionContext leerá esta key:
//   activeEquipment:<correo> => equipment
// ============================
const ACTIVE_EQUIP_KEY = (userEmail) =>
  `activeEquipment:${String(userEmail || "anon")
    .toLowerCase()
    .trim()}`;
const TBMKY_STATUS_KEY = (orderId) =>
  `tbmky_status_${String(orderId || "").trim()}`;

const WORK_ORDER_BULK_ENDPOINT =
  "/api/odata/ZCS_CHANGE_WORKORDER_SRV/WorkOrderBulkSet";

// FMS NUEVO - INICIO
// Caché en memoria de periodos consultados fuera de la ventana offline.
// - Vive a nivel de módulo, así sobrevive aunque la pantalla se desmonte
//   (por ejemplo al entrar al detalle de una orden y regresar).
// - NO escribe en AsyncStorage/SQLite; se pierde al cerrar la app.
// - La llave incluye al usuario para no mezclar datos entre sesiones.
const HISTORICAL_TTL_MS = 10 * 60 * 1000; // 10 min sin volver a consultar SAP
const historicalMemoryCache = new Map(); // key -> { data, fetchedAt }

// Caché persistente del catálogo de estatus (cambia muy poco).
const STATUS_CATALOG_KEY = "statusCatalog:CS000001:v1";
const STATUS_CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// Texto corto "hace X min" para el banner de estado.
const formatAgo = (ts) => {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
};
// FMS NUEVO - FIN

// FMS ELIMINADO - INICIO
// function buildCheckinBulkPayload({ orderId, base64 }) {
// FMS ELIMINADO - FIN
// FMS NUEVO - INICIO
function buildCheckinBulkPayload({ orderId, base64, bulkId }) {
// FMS NUEVO - FIN
  const cleanOrderId = String(orderId || "").trim();
  const cleanBase64 = String(base64 || "")
    .replace(/^data:[^;]+;base64,/, "")
    .replace(/\s/g, "")
    .trim();

  if (!cleanOrderId) throw new Error("Falta orderId para el check-in.");
  if (!cleanBase64) throw new Error("La fotografía del check-in está vacía.");

  return {
        // FMS ELIMINADO - INICIO
    // BulkId: buildWorkOrderBulkId({ firstOrderId: cleanOrderId }),
    // FMS ELIMINADO - FIN
    // FMS NUEVO - INICIO
    BulkId: bulkId || buildWorkOrderBulkId({ firstOrderId: cleanOrderId }),
    // FMS NUEVO - FIN
    WorkOrderSet: [
      {
        OrderId: cleanOrderId,
        WorkOrderHeader: { Orderid: cleanOrderId },
        WorkOrderUserStatusSet: [
          { UserStText: "0100", Langu: "ES", Inactive: "" },
        ],
        Attachments: [
          {
            DocId: cleanOrderId,
            FileName: `CHECKIN_${cleanOrderId}.jpg`,
            MimeType: "image/jpeg",
            Base64: cleanBase64,
          },
        ],
        Return: [],
      },
    ],
  };
}

function logBulkPayload(label, payload) {
  try {
    const payloadParaLog = JSON.parse(
      JSON.stringify(payload),
    );

    payloadParaLog.WorkOrderSet?.forEach((order) => {
      order.Attachments?.forEach((attachment) => {
        const base64 = String(attachment.Base64 || "");

        attachment.Base64 =
          `<<BASE64 OMITIDO: ${base64.length} caracteres>>`;
      });
    });

    console.log(label);
    console.log(JSON.stringify(payloadParaLog, null, 2));
  } catch (error) {
    console.log(
      `${label} No se pudo imprimir el payload:`,
      error,
    );
  }
}
// ===== Fiori Palette =====
const FIORI = {
  pageBg: "#F7F7F7",
  cardBg: "#FFFFFF",
  cardSubtle: "#F5F7FA",
  border: "#DDE6F2",
  borderMuted: "#CFD8E3",
  ink: "#0B1F3B",
  textMuted: "#63718B",
  accent: "#0A6ED1",
  accentSoft: "#E3F2FD",
  neutralBtn: "#ECEFF5",
  danger: "#EB5757",
};

const atStartOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const atEndOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const startOfMonth = (d) =>
  new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);

const endOfMonth = (d) =>
  new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);

const parseSapDate = (value) => {
  if (!value) return null;

  if (typeof value === "string" && value.startsWith("/Date(")) {
    const ms = parseInt(value.replace("/Date(", "").replace(")/", ""), 10);
    if (!Number.isNaN(ms)) return new Date(ms);
    return null;
  }

  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

const getUtcYmd = (d) => {
  if (!d) return null;

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
};

const formatLocalYmd = (d) => {
  if (!d) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const getOrderKey = (item = {}) =>
  String(item?.Orderid || item?.OrderId || item?.orderid || "").trim();

const mergeOrdersKeepingCache = (cached = [], remote = []) => {
  const map = new Map();

  // Primero se conserva lo que ya existe localmente.
  for (const item of Array.isArray(cached) ? cached : []) {
    const key = getOrderKey(item);

    if (key) {
      map.set(key, item);
    }
  }

  // La respuesta más reciente de SAP reemplaza únicamente
  // las órdenes que hayan sido consultadas nuevamente.
  for (const item of Array.isArray(remote) ? remote : []) {
    const key = getOrderKey(item);

    if (key) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
};

const formatDateDMY = (value) => {
  const d = parseSapDate(value);
  if (!d) return "—";

  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();

  return `${dd}/${mm}/${yyyy}`;
};

const isWithin = (date, start, end) => {
  if (!date) return false;

  const dStr = getUtcYmd(date);
  const sStr = start ? getUtcYmd(start) : null;
  const eStr = end ? getUtcYmd(end) : null;

  if (sStr && dStr < sStr) return false;
  if (eStr && dStr > eStr) return false;

  return true;
};

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

/* =========================
   Reglas de Userstatus
   ========================= */
function normalizeCode(code) {
  if (code === null || code === undefined) return "";

  const s = String(code).trim();
  if (!s) return "";

  const n = parseInt(s, 10);
  if (Number.isNaN(n)) return s;

  return String(n).padStart(4, "0");
}

function extractCodes(raw) {
  if (!raw) return [];

  const s = String(raw).trim();
  if (!s) return [];

  const matches = s.match(/\d{1,4}/g) || [];

  const codes = matches
    .map((x) => normalizeCode(x))
    .filter((x) => /^\d{4}$/.test(x));

  return Array.from(new Set(codes));
}

const STATUS_META = {
  "0100": {
    label: "PENDIENTE",
    type: "pendiente",
    color: "#D64545",
    lockActions: false,
    allowCheckin: false,
    isNoMantto: false,
  },
  "0200": {
    label: "EN PROCESO",
    type: "proceso",
    color: "#D49C00",
    lockActions: false,
    allowCheckin: false,
    isNoMantto: false,
  },
  "0300": {
    label: "FINALIZADA",
    type: "final",
    color: "#27AE60",
    lockActions: true,
    allowCheckin: false,
    isNoMantto: false,
  },
  "0301": {
    label: "FINALIZADA SUPER",
    type: "final",
    color: "#025f29",
    lockActions: true,
    allowCheckin: false,
    isNoMantto: false,
  },
  "0400": {
    label: "PENDIENTE DE FIRMA",
    type: "firma",
    color: "#2D9CDB",
    lockActions: false,
    allowCheckin: false,
    isNoMantto: false,
  },
  "0600": {
    label: "Carta No Mantto",
    type: "no_mantto",
    color: "#b90909",
    lockActions: true,
    allowCheckin: false,
    isNoMantto: true,
  },
};

const PRIORITY = ["0600", "0400", "0300", "0200", "0100", "0301"];

function resolveUserstatus(
  rawUserstatus,
  _catalogMap = {},
  itemFromApi = null,
) {
  /*
   * estatus_code ya representa el estatus efectivo normalizado.
   * Si está presente, debe utilizarse directamente.
   *
   * No debe combinarse con userstatus porque este último puede
   * contener códigos anteriores o inactivos.
   */
  const effectiveCode = normalizeCode(itemFromApi?.estatus_code);

  if (effectiveCode) {
    const metadata = STATUS_META[effectiveCode];

    if (metadata) {
      return {
        code: effectiveCode,
        ...metadata,
        rawCodes: [effectiveCode],
      };
    }

    return {
      code: effectiveCode,
      label:
        itemFromApi?.estatus_label ||
        _catalogMap?.[effectiveCode] ||
        `Estatus ${effectiveCode}`,
      type: "unknown",
      color: "#6A7381",
      lockActions: false,
      allowCheckin: false,
      isNoMantto: false,
      rawCodes: [effectiveCode],
    };
  }

  /*
   * Compatibilidad para órdenes que todavía no tengan estatus_code.
   */
  const rawCodes = extractCodes(rawUserstatus);

  if (!rawCodes.length) {
    return {
      code: "",
      label: "Sin empezar",
      type: "start",
      color: "#6A7381",
      lockActions: false,
      allowCheckin: true,
      isNoMantto: false,
      rawCodes: [],
    };
  }

  /*
   * En el valor recibido de SAP normalmente el último código
   * corresponde al estatus más reciente.
   */
  const fallbackCode = rawCodes[rawCodes.length - 1];
  const metadata = STATUS_META[fallbackCode];

  if (metadata) {
    return {
      code: fallbackCode,
      ...metadata,
      rawCodes,
    };
  }

  return {
    code: fallbackCode,
    label:
      _catalogMap?.[fallbackCode] ||
      `Estatus ${fallbackCode}`,
    type: "unknown",
    color: "#6A7381",
    lockActions: false,
    allowCheckin: false,
    isNoMantto: false,
    rawCodes,
  };
}

/* =========================
   Search
   ========================= */
const matchesQuery = (item, q) => {
  if (!q) return true;

  const needle = q.toLowerCase().trim();

  const fields = [
    item?.Orderid?.toString?.() ?? "",
    item?.order_type ?? "",
    item?.equipment ?? "",
    item?.partner_name ?? "",
    item?.partner_address ?? "",
    item?.ShortText ?? "",
    item?.shortText ?? "",
    item?.short_text ?? "",
    item?.cobertura ?? "",
    item?.userstatus ?? "",
    item?.estatus_label ?? "",
    item?.estatus_code ?? "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return fields.includes(needle);
};

/* =========================
   CHECKIN OFFLINE QUEUE
   ========================= */
function makeQueueKey(userEmail) {
  const safe =
    String(userEmail || "anon")
      .toLowerCase()
      .trim() || "anon";

  return `checkin_queue_v1_${safe}`;
}

async function loadCheckinQueue(userEmail) {
  try {
    const key = makeQueueKey(userEmail);
    const raw = await AsyncStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];

    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveCheckinQueue(userEmail, arr) {
  const key = makeQueueKey(userEmail);

  await AsyncStorage.setItem(
    key,
    JSON.stringify(Array.isArray(arr) ? arr : []),
  );
}

async function enqueueCheckin(userEmail, item) {
  const q = await loadCheckinQueue(userEmail);

  // evita duplicados por OrderId
  const exists = q.some((x) => String(x?.orderId) === String(item?.orderId));
  if (exists) return q;

  const next = [{ ...item }, ...q].slice(0, 50);

  await saveCheckinQueue(userEmail, next);

  return next;
}

async function removeFromQueue(userEmail, orderId) {
  const q = await loadCheckinQueue(userEmail);
  const next = q.filter((x) => String(x?.orderId) !== String(orderId));

  await saveCheckinQueue(userEmail, next);

  return next;
}

// FMS NUEVO - INICIO
async function updateQueueItem(userEmail, orderId, patch) {
  const q = await loadCheckinQueue(userEmail);
  const next = q.map((x) =>
    String(x?.orderId) === String(orderId) ? { ...x, ...patch } : x,
  );

  await saveCheckinQueue(userEmail, next);
  return next;
}

// Espera entre reintentos de un envío que no obtuvo respuesta.
const SYNC_BACKOFF_MS = [15000, 30000, 60000, 120000, 300000];
// FMS NUEVO - FIN

export default function ListaOrdenesTecnico() {
  const { user, ensureValidToken } = useAuth();

  const {
    ordenes: ordenesCompartidas,
    loadingInitial: loading,
    refreshing: refreshingCentral,
    loadLocal,
    refresh,
  } = useOrdenesTecnico();

  const userEmail = user?.correo || user?.email || user?.username || null;

  const [allOrdenes, setAllOrdenes] = useState([]);
  const [historicalOrdenes, setHistoricalOrdenes] = useState([]);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const [ordenes, setOrdenes] = useState([]);

  // FMS NUEVO - INICIO
  // Estado de la consulta histórica (periodos fuera de la ventana offline):
  // - historicalError: "offline" | "request_error" | null  -> para avisar al usuario
  // - historicalUpdatedAt: cuándo se consultó SAP por última vez ese periodo
  // - historicalReqRef: contador para ignorar respuestas viejas (condición de carrera)
  // - ensureValidTokenRef: evita que cambios de identidad de ensureValidToken
  //   (AuthContext no la memoiza) vuelvan a disparar la consulta.
  const [historicalError, setHistoricalError] = useState(null);
  const [historicalUpdatedAt, setHistoricalUpdatedAt] = useState(null);
  const historicalReqRef = useRef(0);

  const ensureValidTokenRef = useRef(ensureValidToken);
  useEffect(() => {
    ensureValidTokenRef.current = ensureValidToken;
  }, [ensureValidToken]);
  // FMS NUEVO - FIN

  // FMS ELIMINADO - INICIO
  // Antes: el spinner del pull-to-refresh también se activaba con la consulta
  // histórica, pero el usuario no veía ningún mensaje claro de que se estaba consultando.
  // const refreshing = refreshingCentral || loadingHistorical;
  // FMS ELIMINADO - FIN

  // FMS NUEVO - INICIO
  // Ahora el indicador de carga histórica es un banner visible (statusBanner)
  // y el spinner dentro de la lista; el pull-to-refresh solo refleja la recarga central.
  const refreshing = refreshingCentral;
  // FMS NUEVO - FIN

  const [query, setQuery] = useState("");
  const [dateMode, setDateMode] = useState("day");

  const [dayRef, setDayRef] = useState(new Date());
  const [showDayPicker, setShowDayPicker] = useState(false);

  const [weekStart, setWeekStart] = useState(null);
  const [weekEnd, setWeekEnd] = useState(null);
  const [showWeekStartPicker, setShowWeekStartPicker] = useState(false);
  const [showWeekEndPicker, setShowWeekEndPicker] = useState(false);

  const now = new Date();

  const [monthYear, setMonthYear] = useState({
    month: now.getMonth(),
    year: now.getFullYear(),
  });

  const [showMonthModal, setShowMonthModal] = useState(false);

  // check-in modal + foto
  const [showCheckinModal, setShowCheckinModal] = useState(false);
  const [checkinOrderId, setCheckinOrderId] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [checkinPhotoBase64, setCheckinPhotoBase64] = useState(null);
  const [checkinPhotoUri, setCheckinPhotoUri] = useState(null);

  // catálogo status
  const [statusCatalogMap, setStatusCatalogMap] = useState({});

  // estado red + cola
  const [isOnline, setIsOnline] = useState(true);
  const [checkinQueue, setCheckinQueue] = useState([]);
  const syncingRef = useRef(false);
    // FMS NUEVO - INICIO
  const syncRef = useRef(null); // siempre apunta a la última syncCheckinQueue
  const syncRerunRef = useRef(false);
  const syncTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(syncTimerRef.current), []);
  // FMS NUEVO - FIN

  const pendingSet = useMemo(() => {
    const s = new Set();

    (checkinQueue || []).forEach((x) => {
      if (x?.orderId) s.add(String(x.orderId));
    });

    return s;
  }, [checkinQueue]);

  const { start, end } = useMemo(() => {
    if (dateMode === "weekRange") {
      return {
        start: weekStart ? atStartOfDay(weekStart) : atStartOfDay(new Date()),
        end: weekEnd ? atEndOfDay(weekEnd) : atEndOfDay(new Date()),
      };
    }

    if (dateMode === "month") {
      const ref = new Date(monthYear.year, monthYear.month, 1);
      return { start: startOfMonth(ref), end: endOfMonth(ref) };
    }

    // Modo por defecto: día
    const s = atStartOfDay(dayRef);
    return { start: s, end: s };
  }, [dateMode, dayRef, weekStart, weekEnd, monthYear]);

  const selectedRangeIsCached = useMemo(() => {
    const offlineWindow = buildOfflineWindow(new Date());
    const selectedStart = formatLocalYmd(start);
    const selectedEnd = formatLocalYmd(end);

    return (
      selectedStart >= offlineWindow.startStr &&
      selectedEnd <= offlineWindow.endStr
    );
  }, [start, end]);

  const selectedRangeKey = useMemo(
    () => `${formatLocalYmd(start)}:${formatLocalYmd(end)}`,
    [start, end],
  );

  const applyTbmkyOfflineStatuses = useCallback(async (data = []) => {
    try {
      const arr = Array.isArray(data) ? data : [];

      const keys = arr
        .map((x) => x?.Orderid)
        .filter(Boolean)
        .map((id) => TBMKY_STATUS_KEY(id));

      if (!keys.length) return arr;

      const pairs = await AsyncStorage.multiGet(keys);

      const statusByOrder = {};

      pairs.forEach(([key, value]) => {
        if (!value) return;

        const orderId = key.replace("tbmky_status_", "");
        statusByOrder[String(orderId)] = String(value).trim();
      });

      return arr.map((x) => {
        const orderId = String(x?.Orderid || "");
        const status = statusByOrder[orderId];

        if (!status) return x;

        const currentStatus = normalizeCode(
          x?.estatus_code ||
            x?.userstatus ||
            x?.UserStatus ||
            x?.UserStText ||
            "",
        );

        // tbmky_status_ solo puede completar una orden que todavía no tenga
        // un estatus efectivo proveniente del contexto, caché o SAP.
        if (currentStatus) {
          AsyncStorage.removeItem(TBMKY_STATUS_KEY(orderId)).catch(() => {});
          return x;
        }

        const localTbmkyStatus = normalizeCode(status);
        if (!localTbmkyStatus) return x;

        return {
          ...x,
          estatus_code: localTbmkyStatus,
          userstatus: localTbmkyStatus,
          Userstatus: localTbmkyStatus,
          UserStatus: localTbmkyStatus,
          UserStText: localTbmkyStatus,
          estatus_label:
            STATUS_META[localTbmkyStatus]?.label || localTbmkyStatus,
        };
      });
    } catch (e) {
      console.log("[ORDENES][TBMKY_STATUS] error:", e?.message || e);
      return data;
    }
  }, []);

  // FMS ELIMINADO - INICIO
  // Antes: cada vez que se montaba la pantalla se llamaba a SAP para traer el
  // catálogo de estatus, y si fallaba (offline) se borraba el mapa con {}.
  /*
  const fetchStatusCatalog = async () => {
    try {
      const res = await api.get(
        "/api/odata/ZSD_CATALOGOS_SRV/StatusWorkOrderSet?$filter=Stsma%20eq%20%27CS000001%27&$format=json",
      );

      const results = res?.data?.d?.results || [];
      const map = {};

      results.forEach((r) => {
        const k = normalizeCode(r?.Status1);
        const v = String(r?.Status2 || "").trim();

        if (k) map[k] = v;
      });

      setStatusCatalogMap(map);
    } catch (e) {
      console.log(
        "Error catálogo estatus:",
        e?.response?.data || e?.message || e,
      );
      setStatusCatalogMap({});
    }
  };
  */
  // FMS ELIMINADO - FIN

  // FMS NUEVO - INICIO
  // Ahora: 1) se pinta de inmediato lo guardado en AsyncStorage,
  //        2) solo se consulta SAP si la caché tiene más de 24 h y hay internet,
  //        3) si falla, NO se borra el mapa que ya existía.
  const fetchStatusCatalog = async () => {
    try {
      const raw = await AsyncStorage.getItem(STATUS_CATALOG_KEY);
      const cached = raw ? JSON.parse(raw) : null;

      if (cached?.map) setStatusCatalogMap(cached.map);

      const cacheIsFresh =
        cached && Date.now() - Number(cached.savedAt || 0) < STATUS_CATALOG_TTL_MS;

      if (cacheIsFresh) return;

      const net = await NetInfo.fetch();
      const online = !!(net?.isConnected && net?.isInternetReachable !== false);

      if (!online) return;

      const res = await api.get(
        "/api/odata/ZSD_CATALOGOS_SRV/StatusWorkOrderSet?$filter=Stsma%20eq%20%27CS000001%27&$format=json",
      );

      const results = res?.data?.d?.results || [];
      const map = {};

      results.forEach((r) => {
        const k = normalizeCode(r?.Status1);
        const v = String(r?.Status2 || "").trim();

        if (k) map[k] = v;
      });

      setStatusCatalogMap(map);

      await AsyncStorage.setItem(
        STATUS_CATALOG_KEY,
        JSON.stringify({ map, savedAt: Date.now() }),
      );
    } catch (e) {
      // No se sobrescribe el mapa con {}: se conserva lo que ya hubiera.
      console.log(
        "Error catálogo estatus:",
        e?.response?.data || e?.message || e,
      );
    }
  };
  // FMS NUEVO - FIN

  const refreshQueue = useCallback(async () => {
    const q = await loadCheckinQueue(userEmail);
    setCheckinQueue(q);
  }, [userEmail]);

  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

    // escuchar red
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const onlineNow = !!(
        state?.isConnected && state?.isInternetReachable !== false
      );

      setIsOnline(onlineNow);
    });

    return () => unsub();
  }, []);

  // FMS NUEVO - INICIO
  // Si la app se cerró antes de que SAP confirmara, se retoma al abrir la lista.
  useEffect(() => {
    if (userEmail) resumePendingConfirmations(userEmail);
  }, [userEmail]);
  // FMS NUEVO - FIN


  // Precarga en segundo plano los catálogos del aviso de avería (R, S, T)
  // para que el formulario pueda mostrar daños, localizaciones y causas offline.
  useEffect(() => {
    let alive = true;

    const preloadAvisoCatalogos = async () => {
      try {
        const net = await NetInfo.fetch();
        const online = !!(
          net?.isConnected && net?.isInternetReachable !== false
        );

        if (!online) return;

        const okToken = await ensureValidToken();
        if (!okToken) return;

        if (!alive) return;

        await preloadAvisoAveriaCatalogos(null);
      } catch (e) {
        console.log(
          "[ORDENES][AVISO-AVERIA][PRELOAD] No se pudieron precargar catálogos:",
          e?.message || e,
        );
      }
    };

    preloadAvisoCatalogos();

    return () => {
      alive = false;
    };
  }, [ensureValidToken]);

  const applySharedOrdenes = useCallback(
    async (data = []) => {
      const source = Array.isArray(data) ? data : [];
      const patchedData = await applyTbmkyOfflineStatuses(source);

      setAllOrdenes(patchedData);
      return patchedData;
    },
    [applyTbmkyOfflineStatuses],
  );

  // Consulta temporal para periodos fuera de la ventana offline.
  // Los resultados se guardan solo en el estado de esta pantalla.

  // FMS ELIMINADO - INICIO
  // Antes: sin caché en memoria, sin aviso de error/offline, sin protección contra
  // respuestas viejas, y se vaciaba la lista (setHistoricalOrdenes([])) en cada fallo.
  /*
  const fetchHistoricalOrdenes = useCallback(async () => {
    if (selectedRangeIsCached) {
      setHistoricalOrdenes([]);
      return { ok: true, source: "cache_window", data: [] };
    }

    try {
      setLoadingHistorical(true);

      const net = await NetInfo.fetch();
      const online = !!(
        net?.isConnected && net?.isInternetReachable !== false
      );
      setIsOnline(online);

      if (!online) {
        setHistoricalOrdenes([]);
        return { ok: false, reason: "offline", data: [] };
      }

      const okToken = await ensureValidToken();
      if (!okToken) {
        return { ok: false, reason: "invalid_token", data: [] };
      }

      const params = new URLSearchParams({
        start: formatLocalYmd(start),
        end: formatLocalYmd(end),
        mode: "range",
      });

      console.log("[ORDENES][HISTORICO] Consulta temporal:", {
        start: formatLocalYmd(start),
        end: formatLocalYmd(end),
      });

      const res = await api.get(
        `/api/ordenes/sap/list?${params.toString()}`,
      );
      const remote = Array.isArray(res?.data) ? res.data : [];
      const patchedRemote = await applyTbmkyOfflineStatuses(remote);

      setHistoricalOrdenes(patchedRemote);

      return {
        ok: true,
        source: "remote_temporary",
        data: patchedRemote,
      };
    } catch (error) {
      console.log(
        "[ORDENES][HISTORICO] Error:",
        error?.response?.data || error?.message || error,
      );

      setHistoricalOrdenes([]);
      return { ok: false, reason: "request_error", error, data: [] };
    } finally {
      setLoadingHistorical(false);
    }
  }, [
    applyTbmkyOfflineStatuses,
    ensureValidToken,
    selectedRangeIsCached,
    selectedRangeKey,
    start,
    end,
  ]);
  */
  // FMS ELIMINADO - FIN

  // FMS NUEVO - INICIO
  // Ahora:
  //  1) Si el periodo ya se consultó antes, se muestra al instante desde memoria.
  //  2) Si esa consulta es reciente (< HISTORICAL_TTL_MS) y no es recarga manual,
  //     NO se vuelve a llamar a SAP.
  //  3) Si hay que consultar, se conserva lo que ya se mostraba y se avisa
  //     "Actualizando desde SAP…" en lugar de vaciar la lista.
  //  4) Offline o error: se informa con historicalError y NO se borra la lista.
  //  5) historicalReqRef descarta respuestas de periodos que ya no están seleccionados.
  const fetchHistoricalOrdenes = useCallback(
    async ({ force = false } = {}) => {
      // Dentro de la ventana offline no hay nada que consultar a SAP.
      if (selectedRangeIsCached) {
        historicalReqRef.current += 1; // invalida respuestas en vuelo
        setHistoricalOrdenes((prev) => (prev.length ? [] : prev));
        setHistoricalError(null);
        setHistoricalUpdatedAt(null);
        setLoadingHistorical(false);
        return { ok: true, source: "cache_window", data: [] };
      }

      const reqId = ++historicalReqRef.current;
      const isCurrent = () => reqId === historicalReqRef.current;
      const cacheKey = `${userEmail || "anon"}|${selectedRangeKey}`;

      // 1) Pintar al instante lo que ya se consultó antes.
      const hit = historicalMemoryCache.get(cacheKey);

      if (hit) {
        setHistoricalOrdenes(hit.data);
        setHistoricalUpdatedAt(hit.fetchedAt);

        const fresh = Date.now() - hit.fetchedAt < HISTORICAL_TTL_MS;

        if (fresh && !force) {
          setHistoricalError(null);
          setLoadingHistorical(false);
          return { ok: true, source: "memory", data: hit.data };
        }
      } else {
        setHistoricalOrdenes((prev) => (prev.length ? [] : prev));
        setHistoricalUpdatedAt(null);
      }

      // 2) Refrescar desde SAP.
      try {
        setLoadingHistorical(true);
        setHistoricalError(null);

        const net = await NetInfo.fetch();
        const online = !!(
          net?.isConnected && net?.isInternetReachable !== false
        );
        setIsOnline(online);

        if (!online) {
          // Se conserva lo que ya se mostraba; solo se avisa.
          if (isCurrent()) setHistoricalError("offline");
          return { ok: false, reason: "offline", data: hit?.data || [] };
        }

        const okToken = await ensureValidTokenRef.current();

        if (!okToken) {
          if (isCurrent()) setHistoricalError("request_error");
          return { ok: false, reason: "invalid_token", data: [] };
        }

        const params = new URLSearchParams({
          start: formatLocalYmd(start),
          end: formatLocalYmd(end),
          mode: "range",
        });

        console.log("[ORDENES][HISTORICO] Consulta temporal:", {
          start: formatLocalYmd(start),
          end: formatLocalYmd(end),
          force,
        });

        const res = await api.get(
          `/api/ordenes/sap/list?${params.toString()}`,
        );
        const remote = Array.isArray(res?.data) ? res.data : [];
        // FMS ELIMINADO - INICIO
        // const patchedRemote = await applyTbmkyOfflineStatuses(remote);
        // FMS ELIMINADO - FIN

        // FMS NUEVO - INICIO
        // Además del estatus TBM/KY offline, se respetan los parches locales
        // vigentes (SAP aún no procesa el check-in enviado).
        const patchedRemote = await overlayRecentStatusPatches(
          userEmail,
          await applyTbmkyOfflineStatuses(remote),
        );
        // FMS NUEVO - FIN
        historicalMemoryCache.set(cacheKey, {
          data: patchedRemote,
          fetchedAt: Date.now(),
        });

        // Si el usuario ya cambió de periodo, se guarda en caché pero no se pinta.
        if (!isCurrent()) {
          return { ok: true, source: "stale_ignored", data: patchedRemote };
        }

        setHistoricalOrdenes(patchedRemote);
        setHistoricalUpdatedAt(Date.now());

        return {
          ok: true,
          source: "remote_temporary",
          data: patchedRemote,
        };
      } catch (error) {
        console.log(
          "[ORDENES][HISTORICO] Error:",
          error?.response?.data || error?.message || error,
        );

        // No se borra lo que ya se mostraba.
        if (isCurrent()) setHistoricalError("request_error");

        return { ok: false, reason: "request_error", error, data: [] };
      } finally {
        // Solo la consulta vigente apaga el indicador de carga.
        if (isCurrent()) setLoadingHistorical(false);
      }
    },
    [
      applyTbmkyOfflineStatuses,
      selectedRangeIsCached,
      selectedRangeKey,
      start,
      end,
      userEmail,
    ],
  );
  // FMS NUEVO - FIN

  // Relee únicamente AsyncStorage. No consulta SAP.
  const reloadOrdenesFromLocal = useCallback(async () => {
    try {
      const cached = await loadLocal();
      const data = Array.isArray(cached?.data) ? cached.data : [];

      await applySharedOrdenes(data);

      return { ok: true, data };
    } catch (error) {
      console.log(
        "[ORDENES] No se pudo releer la caché local:",
        error?.message || error,
      );

      return { ok: false, error };
    }
  }, [applySharedOrdenes, loadLocal]);

  // Solamente la recarga manual obliga a consultar nuevamente SAP.
  const refreshOrdenes = useCallback(async () => {
    // Fuera de la ventana offline se actualiza únicamente el periodo
    // seleccionado y no se escribe nada en AsyncStorage.
    if (!selectedRangeIsCached) {
      // FMS ELIMINADO - INICIO
      // return fetchHistoricalOrdenes();
      // FMS ELIMINADO - FIN

      // FMS NUEVO - INICIO
      // La recarga manual ignora la caché en memoria (force: true).
      return fetchHistoricalOrdenes({ force: true });
      // FMS NUEVO - FIN
    }

    try {
      const result = await refresh();
      const cached = result?.cached;
      const data = Array.isArray(cached?.data) ? cached.data : [];

      await applySharedOrdenes(data);

      if (!result?.ok && !data.length) {
        Alert.alert(
          "Actualización",
          "No se pudieron actualizar las órdenes y todavía no hay información guardada.",
        );
      }

      return result;
    } catch (error) {
      console.log(
        "[ORDENES] Error actualizando órdenes:",
        error?.response?.data || error?.message || error,
      );

      Alert.alert(
        "Actualización",
        "No se pudieron actualizar las órdenes. Se conservarán los datos guardados.",
      );

      return { ok: false, error };
    }
  }, [
    applySharedOrdenes,
    fetchHistoricalOrdenes,
    refresh,
    selectedRangeIsCached,
  ]);

  // catálogo una vez
  useEffect(() => {
    fetchStatusCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refleja la lista central compartida cuando cambia.
  useEffect(() => {
    applySharedOrdenes(ordenesCompartidas);
  }, [applySharedOrdenes, ordenesCompartidas]);

  // Al seleccionar un periodo fuera de caché, lo consulta temporalmente.

  // FMS ELIMINADO - INICIO
  // Antes: consultaba en cuanto cambiaba cualquier dependencia, incluso con la
  // semana incompleta (solo fecha inicio) y con la identidad de ensureValidToken.
  /*
  useEffect(() => {
    if (selectedRangeIsCached) {
      setHistoricalOrdenes([]);
      return;
    }

    fetchHistoricalOrdenes();
  }, [
    fetchHistoricalOrdenes,
    selectedRangeIsCached,
    selectedRangeKey,
  ]);
  */
  // FMS ELIMINADO - FIN

  // FMS NUEVO - INICIO
  // Ahora: en modo Semana no consulta hasta que existan inicio Y fin.
  // El caso "dentro de la ventana offline" lo resuelve fetchHistoricalOrdenes.
  useEffect(() => {
    if (dateMode === "weekRange" && (!weekStart || !weekEnd)) return;

    fetchHistoricalOrdenes();
  }, [fetchHistoricalOrdenes, dateMode, weekStart, weekEnd]);
  // FMS NUEVO - FIN

  // Al volver desde el detalle, relee cambios locales sin consultar SAP.
  useFocusEffect(
    useCallback(() => {
      reloadOrdenesFromLocal();
    }, [reloadOrdenesFromLocal]),
  );

  // filtrar en memoria
  useEffect(() => {
    const source = mergeOrdersKeepingCache(
      allOrdenes,
      historicalOrdenes,
    );

    const filtered = source.filter((item) => {
      const okQuery = matchesQuery(item, query);
      if (!okQuery) return false;

      const sd = parseSapDate(item?.start_date);
      if (!sd) return false;

      return isWithin(sd, start, end);
    });

    setOrdenes(filtered);
  }, [allOrdenes, historicalOrdenes, query, start, end]);

  // ===========================
  // GUARDAR EQUIPO ACTIVO
  // ===========================
  const saveActiveEquipmentFromItem = useCallback(
    async (item) => {
      try {
        const correo = userEmail || "";
        if (!correo) return;

        const equipment = String(item?.equipment || "").trim();
        if (!equipment) return;

        await AsyncStorage.setItem(ACTIVE_EQUIP_KEY(correo), equipment);

        console.log("[ORDENES] active equipment saved:", equipment);
      } catch (e) {
        console.log("[ORDENES] saveActiveEquipment error:", e?.message || e);
      }
    },
    [userEmail],
  );

  const irADetalles = async (itemOrOrderId) => {
    let orderId = itemOrOrderId;

    if (typeof itemOrOrderId === "object" && itemOrOrderId) {
      await saveActiveEquipmentFromItem(itemOrOrderId);
      orderId = itemOrOrderId?.Orderid;
    }

    const id = String(orderId);
    router.push(`/tecnico/ordenes/${id}`);
  };

  const abrirModalCheckin = (item, orderId) => {
    if (item) saveActiveEquipmentFromItem(item);

    setCheckinOrderId(orderId);
    setCheckinPhotoBase64(null);
    setCheckinPhotoUri(null);
    setShowCheckinModal(true);
  };

  // cámara -> archivo local


  const takeCheckinPhoto = async () => {
    try {
      // FMS ELIMINADO - INICIO
/*
      const perm = await ImagePicker.requestCameraPermissionsAsync();

      if (!perm.granted) {
        Alert.alert(
          "Permiso requerido",
          "Necesitamos permiso de cámara para tomar la evidencia.",
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        base64: false,
        allowsEditing: false,
      });
*/
// FMS ELIMINADO - FIN

// FMS NUEVO - INICIO
      // Solo en desarrollo y en simulador (que no tiene cámara) se usa la galería.
      // En dispositivo real y en builds de TestFlight/producción sigue la cámara.
      const useLibraryFallback = __DEV__ && !Device.isDevice;

      let result;

      if (useLibraryFallback) {
        console.log("[CHECKIN] Simulador: usando galería en lugar de cámara");

        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          quality: 0.7,
          base64: false,
          allowsEditing: false,
        });
      } else {
        const perm = await ImagePicker.requestCameraPermissionsAsync();

        if (!perm.granted) {
          Alert.alert(
            "Permiso requerido",
            "Necesitamos permiso de cámara para tomar la evidencia.",
          );
          return;
        }

        result = await ImagePicker.launchCameraAsync({
          quality: 0.7,
          base64: false,
          allowsEditing: false,
        });
      }
// FMS NUEVO - FINr
      if (result.canceled) return;

      const asset = result.assets?.[0];

      if (!asset?.uri) {
        Alert.alert("Error", "No se pudo obtener la foto.");
        return;
      }

      const manipulated = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 850 } }],
        {
          compress: 0.5,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: false,
        },
      );

      const fileName = `checkin_${Date.now()}.jpg`;
      const permanentUri = `${FileSystem.documentDirectory}${fileName}`;

      await FileSystem.copyAsync({
        from: manipulated.uri,
        to: permanentUri,
      });

      const fileInfo = await FileSystem.getInfoAsync(permanentUri);

      if (!fileInfo.exists) {
        Alert.alert(
          "Error",
          "No se pudo guardar la foto en el almacenamiento local.",
        );
        return;
      }

      setCheckinPhotoUri(permanentUri);
      setCheckinPhotoBase64(null);

      console.log("[CHECKIN] Foto guardada localmente:", permanentUri);
    } catch (e) {
      console.log("takeCheckinPhoto ERROR:", e);
      Alert.alert("Error", "No se pudo abrir la cámara o guardar la foto.");
    }
  };

  // const postCheckinBulk = async (orderId, base64) => {
  //   const bulkPayload = buildCheckinBulkPayload({
  //     orderId,
  //     base64,
  //   });

  //   console.log(
  //     "[CHECKIN][BULK][URL]",
  //     WORK_ORDER_BULK_ENDPOINT,
  //   );

  //   logBulkPayload(
  //     "[CHECKIN][BULK][PAYLOAD FINAL]",
  //     bulkPayload,
  //   );

  //   try {
  //     const response = await api.post(
  //       WORK_ORDER_BULK_ENDPOINT,
  //       bulkPayload,
  //       {
  //         timeout: 300000,
  //         headers: {
  //           "Content-Type": "application/json",
  //         },
  //       },
  //     );

  //     console.log(
  //       "[CHECKIN][BULK][RESPUESTA SAP]",
  //       JSON.stringify(response?.data, null, 2),
  //     );

  //     return response;
  //   } catch (error) {
  //     console.log(
  //       "[CHECKIN][BULK][ERROR]",
  //       JSON.stringify(
  //         error?.response?.data || {
  //           message: error?.message,
  //           code: error?.code,
  //         },
  //         null,
  //         2,
  //       ),
  //     );

  //     throw error;
  //   }
  // };

  // FMS NUEVO - INICIO
// Cuando cambia el estatus de una orden (check-in), también se actualiza la
// consulta histórica: estado en pantalla y caché en memoria.

  const postCheckinBulk = async (orderId, base64) => {
    // FMS NUEVO - INICIO
    // Un reintento de este mismo check-in lleva el MISMO BulkId.
    const { bulkId, reused } = await getOrCreateBulkId({
      orderId,
      kind: "CHECKIN",
    });
    console.log("[CHECKIN][BULK] BulkId:", { bulkId, reutilizado: reused });
    // FMS NUEVO - FIN
    // FMS ELIMINADO - INICIO
    // const bulkPayload = buildCheckinBulkPayload({ orderId, base64 });
    // FMS ELIMINADO - FIN
    // FMS NUEVO - INICIO
    const bulkPayload = buildCheckinBulkPayload({ orderId, base64, bulkId });
    // FMS NUEVO - FIN

    console.log(
      "[CHECKIN][BULK][URL]",
      WORK_ORDER_BULK_ENDPOINT,
    );

    logBulkPayload(
      "[CHECKIN][BULK][PAYLOAD FINAL]",
      bulkPayload,
    );

    // FMS NUEVO - INICIO
    // El tiempo de espera depende del tamaño del envío: se asume una subida
    // mínima de ~20 KB/s más 20 s de margen, con tope de 3 minutos.
    // Los caracteres del base64 equivalen a los bytes que viajan.
    const payloadBytes = String(base64 || "").length + 2000;
    const sendTimeoutMs = Math.min(
      180000,
      20000 + Math.ceil(payloadBytes / 20),
    );

       //const sendTimeoutMs = 1; // SOLO PARA LA PRUEBA

    console.log("[CHECKIN][BULK] tamaño y timeout:", {
      payloadBytes,
      sendTimeoutMs,
    });
    // FMS NUEVO - FIN

    try {
      // FMS NUEVO - INICIO
      const t0 = Date.now();
      // FMS NUEVO - FIN
      const response = await api.post(
        WORK_ORDER_BULK_ENDPOINT,
        bulkPayload,
        {
          // FMS ELIMINADO - INICIO
          // timeout: 300000,
          // FMS ELIMINADO - FIN

          // FMS NUEVO - INICIO
          timeout: sendTimeoutMs,
          // FMS NUEVO - FIN
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      // FMS ELIMINADO - INICIO
      // console.log(
      //   "[CHECKIN][BULK][RESPUESTA SAP]",
      //   JSON.stringify(response?.data, null, 2),
      // );
      // FMS ELIMINADO - FIN

      // FMS NUEVO - INICIO
      // Resumen: ya no se imprime la respuesta completa.
      console.log("[CHECKIN][BULK][RESPUESTA SAP]", {
        http: response?.status,
        ms: Date.now() - t0,
        bytesAprox: JSON.stringify(response?.data || {}).length,
        mensajes: (response?.data?.d?.WorkOrderSet?.results || []).flatMap(
          (o) =>
            (o?.Return?.results || []).map(
              (r) => `${r?.Type}: ${r?.Message}`,
            ),
        ),
      });
      // FMS NUEVO - FIN

                  // FMS NUEVO - INICIO
      await clearBulkId({ orderId, kind: "CHECKIN" });
      // FMS NUEVO - FIN
      return response;
    } catch (error) {
      console.log(
        "[CHECKIN][BULK][ERROR]",
        JSON.stringify(
          error?.response?.data || {
            message: error?.message,
            code: error?.code,
          },
          null,
          2,
        ),
      );

      // FMS NUEVO - INICIO
      // Sin respuesta (timeout, red caída) NO se borra: el reintento reutiliza el
      // identificador. Solo un rechazo explícito de SAP lo libera.
      const httpStatus = Number(error?.response?.status || 0);
      const rejected =
        httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429;
      if (rejected) await clearBulkId({ orderId, kind: "CHECKIN" });
      // FMS NUEVO - FIN

      throw error;
    }
  };

const patchHistoricalStatus = (orderId, statusCode) => {
  const patchItem = (x) =>
    String(x?.Orderid) === String(orderId)
      ? {
          ...x,
          estatus_code: statusCode,
          userstatus: statusCode,
          UserStatus: statusCode,
          UserStText: statusCode,
          estatus_label: STATUS_META[statusCode]?.label || statusCode,
        }
      : x;

  setHistoricalOrdenes((prev) => (prev || []).map(patchItem));

  historicalMemoryCache.forEach((entry, key) => {
    historicalMemoryCache.set(key, {
      ...entry,
      data: (entry.data || []).map(patchItem),
    });
  });
};
// FMS NUEVO - FIN


  const applyLocalOfflineStatus = async (orderId, statusCode = "0100") => {
    const finalStatus = normalizeCode(statusCode) || "0100";

    try {
      await setLocalStatusPatch(userEmail, orderId, finalStatus);
      await patchCacheOrdenesTecnicoList(userEmail, orderId, finalStatus);
      await patchCacheOrdenTecnicoDetail(orderId, finalStatus);

      setAllOrdenes((prev) =>
        (prev || []).map((x) =>
          String(x?.Orderid) === String(orderId)
            ? {
                ...x,
                estatus_code: finalStatus,
                userstatus: finalStatus,
                UserStatus: finalStatus,
                UserStText: finalStatus,
                estatus_label: STATUS_META[finalStatus]?.label || finalStatus,
              }
            : x,
        ),
        
      );

      // FMS NUEVO - INICIO
      patchHistoricalStatus(orderId, finalStatus);
      // FMS NUEVO - FIN

      console.log("[CHECKIN][STATUS][LOCAL]", {
        orderId,
        finalStatus,
      });
    } catch (e) {
      console.log("[CHECKIN][STATUS][LOCAL] error:", e?.message || e);
    }
  };

  // Sync cola a SAP (foto + estatus)
  // const syncCheckinQueue = useCallback(async () => {
  //   if (!userEmail) return;
  //   if (syncingRef.current) return;

  //   const net = await NetInfo.fetch();

  //   const online = !!(net?.isConnected && net?.isInternetReachable !== false);

  //   setIsOnline(online);

  //   if (!online) return;

  //   syncingRef.current = true;

  //   try {
  //     const q = await loadCheckinQueue(userEmail);
  //     if (!q.length) return;

  //     const ok = await ensureValidToken();
  //     if (!ok) return;

  //     const ordered = [...q].sort(
  //       (a, b) => (a?.createdAt || 0) - (b?.createdAt || 0),
  //     );

  //     for (const item of ordered) {
  //       const orderId = String(item?.orderId || "").trim();
  //       const photoUri = String(item?.photoUri || "").trim();

  //       if (!orderId || !photoUri) {
  //         await removeFromQueue(userEmail, orderId);
  //         continue;
  //       }

  //       try {
  //         const b64 = await FileSystem.readAsStringAsync(photoUri, {
  //           encoding: FileSystem.EncodingType.Base64,
  //         });

  //         console.log("[CHECKIN][SYNC] Enviando:", {
  //           orderId,
  //           photoUri,
  //           b64len: b64.length,
  //         });

  //         await postCheckinBulk(orderId, b64);
  //         // FMS NUEVO - INICIO
  //         await markLocalStatusPatchSent(userEmail, orderId);
  //         // FMS NUEVO - INICIO
  //         scheduleStatusConfirmation({ userEmail, orderId }); // sin await: no bloquea
  //         // FMS NUEVO - FIN
  //         // FMS NUEVO - FIN
          
  //         await removeFromQueue(userEmail, orderId);

  //         await FileSystem.deleteAsync(photoUri, { idempotent: true });
  //       } catch (e) {
  //         console.log(
  //           "[CHECKIN][SYNC] Error SAP:",
  //           orderId,
  //           e?.response?.data || e?.message || e,
  //         );
  //         break;
  //       }
  //     }

  //     const q2 = await loadCheckinQueue(userEmail);
  //     setCheckinQueue(q2);

  //     await refreshOrdenes();
  //   } finally {
  //     syncingRef.current = false;
  //   }
  // }, [ensureValidToken, refreshOrdenes, userEmail]);

    // Sync cola a SAP (foto + estatus)
  const syncCheckinQueue = useCallback(
    async ({ force = false } = {}) => {
      if (!userEmail) return;

      // Si ya hay un envío en curso, se vuelve a correr al terminar.
      if (syncingRef.current) {
        syncRerunRef.current = true;
        return;
      }

      // El guardia se cierra ANTES de cualquier await; si no, varias llamadas
      // simultáneas lo pasan y envían el mismo check-in varias veces.
      syncingRef.current = true;

      const net = await NetInfo.fetch();
      const online = !!(net?.isConnected && net?.isInternetReachable !== false);

      setIsOnline(online);
      if (!online) {
        syncingRef.current = false;
        return;
      }

      let sentCount = 0;

      try {
        const q = await loadCheckinQueue(userEmail);
        if (!q.length) return;

        const ok = await ensureValidToken();
        if (!ok) return;

        const ordered = [...q].sort(
          (a, b) => (a?.createdAt || 0) - (b?.createdAt || 0),
        );

        for (const item of ordered) {
          const orderId = String(item?.orderId || "").trim();
          const photoUri = String(item?.photoUri || "").trim();

          if (!orderId || !photoUri) {
            await removeFromQueue(userEmail, orderId);
            continue;
          }

          // Respeta la espera entre reintentos (salvo "Sincronizar pendientes").
          if (!force && Number(item?.nextAttemptAt || 0) > Date.now()) continue;

          try {
            const b64 = await FileSystem.readAsStringAsync(photoUri, {
              encoding: FileSystem.EncodingType.Base64,
            });

            console.log("[CHECKIN][SYNC] Enviando:", {
              orderId,
              intento: Number(item?.attempts || 0) + 1,
              b64len: b64.length,
            });

            await postCheckinBulk(orderId, b64);

            await markLocalStatusPatchSent(userEmail, orderId);
            scheduleStatusConfirmation({ userEmail, orderId }); // sin await

            await removeFromQueue(userEmail, orderId);
            await FileSystem.deleteAsync(photoUri, { idempotent: true });
            sentCount += 1;
          } catch (e) {
            const attempts = Number(item?.attempts || 0) + 1;
            const wait =
              SYNC_BACKOFF_MS[Math.min(attempts - 1, SYNC_BACKOFF_MS.length - 1)];

            await updateQueueItem(userEmail, orderId, {
              attempts,
              nextAttemptAt: Date.now() + wait,
              lastError: String(e?.message || e).slice(0, 120),
            });

            console.log("[CHECKIN][SYNC] Sin éxito; se reintenta:", {
              orderId,
              attempts,
              enSeg: Math.round(wait / 1000),
              error: e?.response?.data || e?.message || e,
            });
          }
        }

        const q2 = await loadCheckinQueue(userEmail);
        setCheckinQueue(q2);

        // Si queda algo en la cola, se reprograma el siguiente intento.
        clearTimeout(syncTimerRef.current);
        if (q2.length) {
          const nextAt = Math.min(
            ...q2.map((x) => Number(x?.nextAttemptAt || 0) || Date.now()),
          );
          const delay = Math.max(2000, nextAt - Date.now());

          syncTimerRef.current = setTimeout(() => {
            Promise.resolve(syncRef.current?.()).catch(() => {});
          }, delay);
        }

        // Solo se actualiza la lista si algo se envió.
        if (sentCount > 0) await refreshOrdenes();
      } finally {
        syncingRef.current = false;

        if (syncRerunRef.current) {
          syncRerunRef.current = false;
          Promise.resolve(syncRef.current?.()).catch(() => {});
        }
      }
    },
    [ensureValidToken, refreshOrdenes, userEmail],
  );

  // FMS NUEVO - INICIO
  syncRef.current = syncCheckinQueue;
  // FMS NUEVO - FIN

  // Auto-sync cuando regresa internet y hay cola
  // useEffect(() => {
  //   if (isOnline && checkinQueue.length > 0) {
  //     syncCheckinQueue().catch(() => {});
  //   }
  // }, [isOnline, checkinQueue.length, syncCheckinQueue]);

    // FMS ELIMINADO - INICIO
  // useEffect(() => {
  //   if (isOnline && checkinQueue.length > 0) {
  //     syncCheckinQueue().catch(() => {});
  //   }
  // }, [isOnline, checkinQueue.length, syncCheckinQueue]);
  // FMS ELIMINADO - FIN

  // FMS NUEVO - INICIO
  // Ya no depende de syncCheckinQueue: evita reintentos en cadena.
  useEffect(() => {
    if (isOnline && checkinQueue.length > 0) {
      Promise.resolve(syncRef.current?.()).catch(() => {});
    }
  }, [isOnline, checkinQueue.length]);
  // FMS NUEVO - FIN


    // FMS NUEVO - INICIO
  useEffect(() => {
    return subscribeBootstrapSync((event) => {
      if (event?.ok) reloadOrdenesFromLocal();
    });
  }, [reloadOrdenesFromLocal]);
  // FMS NUEVO - FIN

      // FMS NUEVO - INICIO
  // SOLO DESARROLLO: resumen de lo guardado para trabajar sin red.
  useEffect(() => {
    if (!__DEV__) return undefined;

    const timer = setTimeout(() => {
      debugOfflineStorage({
        userEmail,
        memory: Array.from(historicalMemoryCache.entries()).map(([key, v]) => ({
          periodo: key,
          ordenes: v?.data?.length || 0,
          haceMin: Math.round((Date.now() - v.fetchedAt) / 60000),
        })),
      });
    }, 4000);

    return () => clearTimeout(timer);
  }, [selectedRangeKey, userEmail]);
  // FMS NUEVO - FIN

  const continuarAlDetalleDespuesCheckin = async (orderId) => {
    const id = String(orderId || "").trim();

    if (!id) {
      console.log("[CHECKIN] No hay OrderId para abrir el detalle.");
      return;
    }

    // Cerramos el modal y limpiamos la evidencia temporal del estado.
    setShowCheckinModal(false);
    setCheckinPhotoBase64(null);
    setCheckinPhotoUri(null);

    // Releemos únicamente la caché local para que el detalle
    // reciba inmediatamente el nuevo estatus (0100).
    await reloadOrdenesFromLocal();

    // Abrimos el detalle de la misma orden.
    await irADetalles(id);
  };

  // const enviarCheckinCompletoASap = async () => {
  //   if (!checkinOrderId) {
  //     Alert.alert("Error", "No hay orden seleccionada.");
  //     return;
  //   }

  //   if (!checkinPhotoUri) {
  //     Alert.alert("Falta evidencia", "Primero toma una foto.");
  //     return;
  //   }

  //   const orderId = String(checkinOrderId).trim();

  //   try {
  //     setIsSending(true);

  //     const net = await NetInfo.fetch();
  //     const online = !!(net?.isConnected && net?.isInternetReachable !== false);

  //     setIsOnline(online);

  //     if (!online) {
  //       const offlineStatus = "0100";

  //       await applyLocalOfflineStatus(orderId, offlineStatus);

  //       const nextQueue = await enqueueCheckin(userEmail, {
  //         orderId,
  //         photoUri: checkinPhotoUri,
  //         statusCode: offlineStatus,
  //         lastValidStatus: offlineStatus,
  //         createdAt: Date.now(),
  //       });

  //       setCheckinQueue(nextQueue);

  //       Alert.alert(
  //         "Check-in offline",
  //         "Sin internet. Se guardó el check-in en cola y se enviará automáticamente cuando regrese la conexión ✅",
  //       );

  //       await continuarAlDetalleDespuesCheckin(orderId);

  //       return;
  //     }

  //     const ok = await ensureValidToken();
  //     if (!ok) return;

  //     const onlineStatus = "0100";

  //     const base64Data = await FileSystem.readAsStringAsync(checkinPhotoUri, {
  //       encoding: FileSystem.EncodingType.Base64,
  //     });

  //     await postCheckinBulk(orderId, base64Data);
  //     await applyLocalOfflineStatus(orderId, onlineStatus);

  //     // FMS NUEVO - INICIO
  //     await markLocalStatusPatchSent(userEmail, orderId);
  //     // FMS NUEVO - INICIO
  //         scheduleStatusConfirmation({ userEmail, orderId }); // sin await: no bloquea
  //         // FMS NUEVO - FIN
  //     // FMS NUEVO - FIN

  //     await FileSystem.deleteAsync(checkinPhotoUri, { idempotent: true });

  //     Alert.alert(
  //       "Check-in",
  //       "Evidencia enviada y estatus actualizado a PENDIENTE",
  //     );

  //     await continuarAlDetalleDespuesCheckin(orderId);
  //   } catch (e) {
  //     console.log(
  //       "enviarCheckinCompletoASap ERROR:",
  //       e?.response?.data || e?.message || e,
  //     );

  //     const net2 = await NetInfo.fetch();

  //     const online2 = !!(
  //       net2?.isConnected && net2?.isInternetReachable !== false
  //     );

  //     if (!online2) {
  //       const offlineStatus = "0100";

  //       await applyLocalOfflineStatus(orderId, offlineStatus);

  //       const nextQueue = await enqueueCheckin(userEmail, {
  //         orderId,
  //         photoUri: checkinPhotoUri,
  //         statusCode: offlineStatus,
  //         lastValidStatus: offlineStatus,
  //         createdAt: Date.now(),
  //       });

  //       setCheckinQueue(nextQueue);

  //       Alert.alert(
  //         "Check-in guardado",
  //         "Se cayó la conexión. Se guardó en cola y se enviará cuando regrese internet ✅",
  //       );

  //       await continuarAlDetalleDespuesCheckin(orderId);

  //       return;
  //     }

  //     Alert.alert(
  //       "Error SAP",
  //       "No se pudo completar el check-in (foto/estatus). Revisa logs.",
  //     );
  //   } finally {
  //     setIsSending(false);
  //   }
  // };

    const enviarCheckinCompletoASap = async () => {
    if (!checkinOrderId) {
      Alert.alert("Error", "No hay orden seleccionada.");
      return;
    }

    if (!checkinPhotoUri) {
      Alert.alert("Falta evidencia", "Primero toma una foto.");
      return;
    }

    const orderId = String(checkinOrderId).trim();
    const checkinStatus = "0100";

    try {
      setIsSending(true);

      // FMS NUEVO - INICIO
      // 1) PRIMERO se guarda todo en el teléfono: estatus local, foto y cola.
      await applyLocalOfflineStatus(orderId, checkinStatus);

      const nextQueue = await enqueueCheckin(userEmail, {
        orderId,
        photoUri: checkinPhotoUri,
        statusCode: checkinStatus,
        lastValidStatus: checkinStatus,
        createdAt: Date.now(),
        attempts: 0,
        nextAttemptAt: 0,
      });

      setCheckinQueue(nextQueue);

      // 2) El envío arranca en segundo plano y NO se espera.
      Promise.resolve(syncRef.current?.({ force: true })).catch(() => {});

      // 3) La pantalla avanza de inmediato.
      Alert.alert(
        "Check-in guardado",
        "Se envía a SAP en segundo plano. Si no hay buena señal, se reintentará solo.",
      );

      await continuarAlDetalleDespuesCheckin(orderId);
      // FMS NUEVO - FIN
    } catch (e) {
      console.log(
        "enviarCheckinCompletoASap ERROR:",
        e?.response?.data || e?.message || e,
      );

      Alert.alert(
        "Check-in",
        "No se pudo guardar el check-in en el teléfono. Intenta de nuevo.",
      );
    } finally {
      setIsSending(false);
    }
  };


  const clearFilters = () => {
    setQuery("");
    setDateMode("day");
    setDayRef(new Date());
    setWeekStart(null);
    setWeekEnd(null);
    setMonthYear({ month: now.getMonth(), year: now.getFullYear() });
  };

  const getOrderIdDisplay = (item = {}) => {
    const raw = String(item?.Orderid || item?.orderid || "").trim();

    if (!raw) return "";

    return raw.replace(/^0+/, "") || raw;
  };
  const getCoberturaOrden = (item = {}) => {
    const raw = String(
      item?.ShortText ||
        item?.shortText ||
        item?.shorttext ||
        item?.short_text ||
        item?.coverage ||
        item?.cobertura ||
        "",
    ).trim();

    if (!raw) return "";

    const upper = raw.toUpperCase();

    if (upper.includes("BASICA") || upper.includes("BÁSICA")) {
      return "BÁSICA";
    }

    if (upper.includes("MEDIA")) {
      return "MEDIA";
    }

    if (
      upper.includes("SEMI FULL") ||
      upper.includes("SEMIFULL") ||
      upper.includes("SEMI")
    ) {
      return "SEMIFULL";
    }

    if (upper.includes("FULL")) {
      return "FULL";
    }

    return raw.split("|")[0].replace(/COBERTURA/gi, "").trim();
  };

  const renderItem = ({ item }) => {
    const startLabel = formatDateDMY(item.start_date);
    const finishLabel = formatDateDMY(item.finish_date);

    const orderIdDisplay = getOrderIdDisplay(item);

    const coberturaLabel = getCoberturaOrden(item);

    const stBase = resolveUserstatus(
      item?.userstatus ?? "",
      statusCatalogMap,
      item,
    );

    const isPendingOffline = pendingSet.has(String(item?.Orderid));

    const tbmYaProceso = stBase.code === "0200";
    const ordenYaAvanzo = ["0400", "0300", "0600"].includes(stBase.code);

    const st =
      isPendingOffline && !tbmYaProceso && !ordenYaAvanzo
        ? {
            ...stBase,
            code: "0100",
            label: STATUS_META["0100"]?.label || "PENDIENTE",
            type: "pendiente",
            color: STATUS_META["0100"]?.color || "#D64545",
            lockActions: false,
            allowCheckin: false,
          }
        : stBase;

    const showCheckinBtn = st.type === "start" && st.allowCheckin;

    return (
      <Pressable
        style={[
          styles.card,
          { borderLeftColor: st.color },
          st.type === "no_mantto" && styles.cardNoMant,
          st.type === "final" && styles.cardFinished,
        ]}
        onPress={() => irADetalles(item)}
      >
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            #{orderIdDisplay}{" "}
            <Text style={styles.cardSubtitle}>• {item.order_type}</Text>
          </Text>

          <View style={[styles.badge, { backgroundColor: `${st.color}1A` }]}>
            <View style={[styles.statusDot, { backgroundColor: st.color }]} />
            <Text style={[styles.badgeText, { color: st.color }]}>
              {st.label}
            </Text>
          </View>
        </View>

        <View style={styles.cardMiddleRow}>
          <Text style={styles.infoText} numberOfLines={1}>
            <Text style={styles.infoStrong}>Eq: </Text>
            {item.equipment || "—"}
          </Text>

          <Text style={styles.infoDateText} numberOfLines={1}>
            {startLabel} - {finishLabel}
          </Text>
        </View>

        <View style={styles.coverageRow}>
          <Text style={styles.coverageText} numberOfLines={1}>
            <Text style={styles.coverageLabel}>Cobertura: </Text>
            {coberturaLabel || "Sin cobertura"}
          </Text>
        </View>

        {showCheckinBtn && (
          <View style={styles.cardBottomRow} pointerEvents="box-none">
            <TouchableOpacity
              style={[styles.boton, { backgroundColor: FIORI.accent }]}
              onPress={(e) => {
                e?.stopPropagation?.();
                abrirModalCheckin(item, item.Orderid);
              }}
            >
              <Text style={styles.botonTexto}>Check-in</Text>
            </TouchableOpacity>
          </View>
        )}
      </Pressable>
    );
  };

  const activeRangeText = useMemo(() => {
    if (dateMode === "weekRange") {
      const a = weekStart ? atStartOfDay(weekStart).toLocaleDateString() : "—";
      const b = weekEnd ? atEndOfDay(weekEnd).toLocaleDateString() : "—";
      return `Semana: ${a} → ${b}`;
    }

    if (dateMode === "month") {
      return `${MONTHS[monthYear.month]} ${monthYear.year}`;
    }

    return `Día: ${atStartOfDay(dayRef).toLocaleDateString()}`;
  }, [dateMode, dayRef, weekStart, weekEnd, monthYear]);

  // FMS NUEVO - INICIO
  // Mensaje de estado para el usuario cuando el periodo seleccionado está
  // fuera de la ventana offline (se consulta a SAP). Devuelve null si no aplica.
  const statusBanner = useMemo(() => {
    if (selectedRangeIsCached) return null;

    // Semana incompleta: todavía no se ha lanzado ninguna consulta.
    if (dateMode === "weekRange" && (!weekStart || !weekEnd)) return null;

    const hasData = historicalOrdenes.length > 0;

    if (loadingHistorical) {
      return {
        tone: "info",
        spinner: true,
        text: hasData ? "Actualizando desde SAP…" : "Consultando SAP…",
      };
    }

    if (historicalError === "offline") {
      return {
        tone: "warn",
        text: hasData
          ? "Sin conexión. Mostrando la última consulta de este periodo."
          : "Sin conexión. Este periodo no está guardado en el dispositivo.",
      };
    }

    if (historicalError === "request_error") {
      return {
        tone: "error",
        text: "No se pudo consultar SAP. Toca Recargar para reintentar.",
      };
    }

    if (historicalUpdatedAt) {
      return {
        tone: "ok",
        text: `Consultado ${formatAgo(historicalUpdatedAt)}`,
      };
    }

    return null;
  }, [
    selectedRangeIsCached,
    dateMode,
    weekStart,
    weekEnd,
    loadingHistorical,
    historicalError,
    historicalUpdatedAt,
    historicalOrdenes.length,
  ]);
  // FMS NUEVO - FIN

  return (
    <View style={styles.container}>
      <Header title="Órdenes asignadas" />

      <View style={styles.filtersWrap}>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar por #, tipo, equipo, estatus…"
            placeholderTextColor={FIORI.textMuted}
            returnKeyType="search"
          />
        </View>

        <View style={styles.filterModeRow}>
          <TouchableOpacity
            style={[
              styles.filterModeButton,
              dateMode === "day" && styles.filterModeButtonActive,
            ]}
            onPress={() => {
              setDateMode("day");
              setShowDayPicker(true);
            }}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.filterModeText,
                dateMode === "day" && styles.filterModeTextActive,
              ]}
            >
              Día
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.filterModeButton,
              dateMode === "weekRange" && styles.filterModeButtonActive,
            ]}
            onPress={() => {
              setDateMode("weekRange");
              setShowWeekStartPicker(true);
            }}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.filterModeText,
                dateMode === "weekRange" && styles.filterModeTextActive,
              ]}
            >
              Semana
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.filterModeButton,
              dateMode === "month" && styles.filterModeButtonActive,
            ]}
            onPress={() => {
              setDateMode("month");
              setShowMonthModal(true);
            }}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.filterModeText,
                dateMode === "month" && styles.filterModeTextActive,
              ]}
            >
              Mes
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.rangeSummary}>
          <View style={styles.rangeSummaryMain}>
            <Text style={styles.rangeSummaryLabel}>Periodo seleccionado</Text>
            <Text style={styles.activeRangeText}>{activeRangeText}</Text>
          </View>

          <View style={styles.connectionStatus}>
            <View
              style={[
                styles.connectionDot,
                { backgroundColor: isOnline ? "#16A34A" : "#DC2626" },
              ]}
            />
            <Text style={styles.connectionText}>
              {isOnline ? "Online" : "Offline"}
            </Text>
          </View>
        </View>

        <View style={styles.filterActionsRow}>
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={clearFilters}
            activeOpacity={0.85}
          >
            <Text style={styles.clearBtnText}>Limpiar</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.refreshBtn}
            onPress={refreshOrdenes}
            activeOpacity={0.85}
          >
            <Text style={styles.refreshBtnText}>Recargar</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.syncBtn,
              checkinQueue.length === 0 && { opacity: 0.55 },
            ]}
            onPress={async () => {
              await refreshQueue();
              //await syncCheckinQueue();

                            await syncCheckinQueue({ force: true });
            }}
            activeOpacity={0.85}
            disabled={checkinQueue.length === 0}
          >
            <Text style={styles.syncBtnText}>
              {isOnline ? "Sincronizar pendientes" : "Pendientes (sin red)"}{" "}
              {checkinQueue.length ? `(${checkinQueue.length})` : ""}
            </Text>
          </TouchableOpacity>
                    {/* FMS NUEVO - INICIO */}
          {__DEV__ && (
            
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => {
                
                console.log("[OFFLINE][DIAG] Ejecutando diagnóstico manual…");
                debugOfflineStorage({
                  userEmail,
                  memory: Array.from(historicalMemoryCache.entries()).map(
                    ([key, v]) => ({
                      periodo: key,
                      ordenes: v?.data?.length || 0,
                      haceMin: Math.round((Date.now() - v.fetchedAt) / 60000),
                    }),
                  ),
                });
              }}
              activeOpacity={0.85}
            >
              <Text style={styles.clearBtnText}>Diag</Text>
            </TouchableOpacity>
          )}
          {/* FMS NUEVO - FIN */}
        </View>

        {showDayPicker && (
          <DateTimePicker
            value={dayRef ?? new Date()}
            mode="date"
            display={Platform.OS === "ios" ? "inline" : "default"}
            onChange={(e, date) => {
              if (Platform.OS === "android") {
                setShowDayPicker(false);
                if (e.type !== "set") return;
              }

              if (date) setDayRef(date);
              if (Platform.OS === "ios") setShowDayPicker(true);
            }}
          />
        )}

        {showWeekStartPicker && (
          <DateTimePicker
            value={weekStart ?? new Date()}
            mode="date"
            display={Platform.OS === "ios" ? "inline" : "default"}
            onChange={(e, date) => {
              if (Platform.OS === "android") {
                setShowWeekStartPicker(false);
                if (e.type !== "set") return;
              }

              if (date) {
                setWeekStart(date);
                if (Platform.OS !== "ios") setShowWeekEndPicker(true);
              }

              if (Platform.OS === "ios") setShowWeekStartPicker(true);
            }}
          />
        )}

        {showWeekEndPicker && (
          <DateTimePicker
            value={weekEnd ?? weekStart ?? new Date()}
            mode="date"
            minimumDate={weekStart ?? undefined}
            display={Platform.OS === "ios" ? "inline" : "default"}
            onChange={(e, date) => {
              if (Platform.OS === "android") {
                setShowWeekEndPicker(false);
                if (e.type !== "set") return;
              }

              if (date) setWeekEnd(date);
              if (Platform.OS === "ios") setShowWeekEndPicker(true);
            }}
          />
        )}

        {dateMode === "weekRange" && (
          <View style={styles.rangeButtonsRow}>
            <TouchableOpacity
              style={[styles.smallBtn, { backgroundColor: FIORI.cardSubtle }]}
              onPress={() => setShowWeekStartPicker(true)}
            >
              <Text style={styles.smallBtnText}>
                Inicio: {weekStart ? weekStart.toLocaleDateString() : "—"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.smallBtn, { backgroundColor: FIORI.cardSubtle }]}
              onPress={() => setShowWeekEndPicker(true)}
            >
              <Text style={styles.smallBtnText}>
                Fin: {weekEnd ? weekEnd.toLocaleDateString() : "—"}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* FMS NUEVO - INICIO */}
      {/* Banner de estado de la consulta a SAP (solo periodos fuera de la ventana offline) */}
      {statusBanner && (
        <View
          style={[
            styles.syncBanner,
            styles[`syncBanner_${statusBanner.tone}`],
          ]}
        >
          {statusBanner.spinner && (
            <ActivityIndicator size="small" color={FIORI.accent} />
          )}
          <Text style={styles.syncBannerText}>{statusBanner.text}</Text>
        </View>
      )}
      {/* FMS NUEVO - FIN */}

      {/* Modal Mes */}
      <Modal
        visible={showMonthModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMonthModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <TouchableOpacity
                onPress={() =>
                  setMonthYear((s) => ({ ...s, year: s.year - 1 }))
                }
              >
                <Text style={styles.modalHeaderBtn}>{"‹"}</Text>
              </TouchableOpacity>

              <Text style={styles.modalHeaderTitle}>{monthYear.year}</Text>

              <TouchableOpacity
                onPress={() =>
                  setMonthYear((s) => ({ ...s, year: s.year + 1 }))
                }
              >
                <Text style={styles.modalHeaderBtn}>{"›"}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.monthGrid}>
              {MONTHS.map((m, idx) => {
                const active = idx === monthYear.month && dateMode === "month";

                return (
                  <TouchableOpacity
                    key={m}
                    style={[styles.monthCell, active && styles.monthCellActive]}
                    onPress={() => {
                      setMonthYear({ month: idx, year: monthYear.year });
                      setShowMonthModal(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.monthCellText,
                        active && styles.monthCellTextActive,
                      ]}
                    >
                      {m}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setShowMonthModal(false)}
            >
              <Text style={styles.modalCloseText}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal Check-in */}
      <Modal
        visible={showCheckinModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCheckinModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { maxWidth: 480 }]}>
            <Text style={styles.modalHeaderTitle}>
              Check-in #{checkinOrderId ?? ""}
            </Text>

            <Text style={{ color: FIORI.textMuted, marginBottom: 10 }}>
              Toma una foto de evidencia:
            </Text>

            {checkinPhotoUri ? (
              <View style={{ marginBottom: 12 }}>
                <Image
                  source={{ uri: checkinPhotoUri }}
                  style={{
                    width: "100%",
                    height: 180,
                    borderRadius: 10,
                    backgroundColor: "#EEE",
                  }}
                  resizeMode="cover"
                />

                <Text
                  style={{ marginTop: 6, color: FIORI.textMuted, fontSize: 12 }}
                >
                  Foto guardada localmente ✅
                </Text>
              </View>
            ) : (
              <View
                style={{
                  padding: 12,
                  borderWidth: 1,
                  borderColor: FIORI.border,
                  borderRadius: 10,
                  marginBottom: 12,
                }}
              >
                <Text style={{ color: FIORI.textMuted }}>
                  Aún no hay foto. Presiona “Tomar foto”.
                </Text>
              </View>
            )}

            <View
              style={{
                flexDirection: "row",
                justifyContent: "flex-end",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <TouchableOpacity
                style={[styles.smallBtn, { backgroundColor: FIORI.neutralBtn }]}
                onPress={() => setShowCheckinModal(false)}
                disabled={isSending}
              >
                <Text style={styles.smallBtnText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.smallBtn, { backgroundColor: FIORI.cardSubtle }]}
                onPress={takeCheckinPhoto}
                disabled={isSending}
              >
                <Text style={styles.smallBtnText}>Tomar foto</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.smallBtn, { backgroundColor: FIORI.accent }]}
                onPress={enviarCheckinCompletoASap}
                disabled={isSending}
              >
                <Text style={[styles.smallBtnText, { color: "#fff" }]}>
                  {isSending
                    ? "Procesando..."
                    : isOnline
                      ? "Enviar a SAP"
                      : "Guardar offline"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {loading && allOrdenes.length === 0 ? (
        <ActivityIndicator
          style={{ marginTop: 40 }}
          size="large"
          color={FIORI.accent}
        />
      ) : (
        <FlatList
          data={ordenes}
          keyExtractor={(item, idx) => String(item?.Orderid ?? `row-${idx}`)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12, paddingTop: 6 }}
          refreshing={refreshing}
          onRefresh={refreshOrdenes}
          // FMS ELIMINADO - INICIO
          // Antes: siempre mostraba "No hay órdenes…" aunque se estuviera
          // consultando SAP o la consulta hubiera fallado.
          /*
          ListEmptyComponent={
            <Text
              style={{
                textAlign: "center",
                marginTop: 24,
                color: FIORI.textMuted,
              }}
            >
              No hay órdenes con los filtros actuales.
            </Text>
          }
          */
          // FMS ELIMINADO - FIN

          // FMS NUEVO - INICIO
          // Ahora distingue: cargando / sin conexión / error / realmente vacío.
          ListEmptyComponent={
            loadingHistorical && !selectedRangeIsCached ? (
              <ActivityIndicator
                style={{ marginTop: 32 }}
                size="large"
                color={FIORI.accent}
              />
            ) : (
              <Text
                style={{
                  textAlign: "center",
                  marginTop: 24,
                  color: FIORI.textMuted,
                }}
              >
                {!selectedRangeIsCached && historicalError === "offline"
                  ? "Este periodo no está disponible sin conexión."
                  : !selectedRangeIsCached && historicalError === "request_error"
                    ? "No se pudieron cargar las órdenes de este periodo."
                    : "No hay órdenes con los filtros actuales."}
              </Text>
            )
          }
          // FMS NUEVO - FIN
        />
      )}
    </View>
  );

  



}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: FIORI.pageBg,
  },

  filtersWrap: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    padding: 12,
    backgroundColor: FIORI.cardBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: FIORI.border,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.04,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
      },
      android: {
        elevation: 2,
      },
      default: {},
    }),
  },

  searchRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },

  searchInput: {
    flex: 1,
    backgroundColor: FIORI.cardSubtle,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    fontSize: 14,
    color: FIORI.ink,
    borderWidth: 1,
    borderColor: FIORI.border,
  },

  clearBtn: {
    backgroundColor: FIORI.neutralBtn,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIORI.border,
  },

  clearBtnText: {
    color: FIORI.ink,
    fontWeight: "700",
    fontSize: 12,
  },

  refreshBtn: {
    backgroundColor: FIORI.accent,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },

  refreshBtnText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 12,
  },

  syncBtn: {
    backgroundColor: "#111827",
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },

  syncBtnText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 12,
  },

  filterModeRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    padding: 4,
    borderRadius: 14,
    backgroundColor: FIORI.cardSubtle,
    borderWidth: 1,
    borderColor: FIORI.border,
  },

  filterModeButton: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },

  filterModeButtonActive: {
    backgroundColor: FIORI.accent,
  },

  filterModeText: {
    color: FIORI.textMuted,
    fontWeight: "800",
    fontSize: 12,
  },

  filterModeTextActive: {
    color: "#FFFFFF",
  },

  filterActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },

  rangeSummary: {
    marginTop: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: FIORI.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  rangeSummaryMain: {
    flex: 1,
  },

  rangeSummaryLabel: {
    color: FIORI.textMuted,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  activeRangeText: {
    marginTop: 2,
    color: FIORI.ink,
    fontSize: 12,
    fontWeight: "800",
  },

  connectionStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },

  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },

  connectionText: {
    color: FIORI.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },

  rangeButtonsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 10,
  },

  smallBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: FIORI.cardSubtle,
    borderWidth: 1,
    borderColor: FIORI.border,
  },

  smallBtnText: {
    color: FIORI.ink,
    fontWeight: "600",
  },

  card: {
    backgroundColor: FIORI.cardBg,
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: FIORI.border,
    borderLeftWidth: 4,
    shadowColor: "#000",
    shadowOpacity: 0.03,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 1,
  },

  coverageRow: {
    marginTop: 6,
    backgroundColor: "#F5F7FA",
    borderWidth: 1,
    borderColor: FIORI.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },

  coverageText: {
    fontSize: 11,
    color: FIORI.textMuted,
    fontWeight: "600",
  },

  coverageLabel: {
    color: FIORI.ink,
    fontWeight: "800",
  },
  cardNoMant: {
    backgroundColor: "#F8F9FA",
    borderColor: "#E2E2E2",
  },

  cardFinished: {
    backgroundColor: "#F2FCF5",
    borderColor: "#D3EEDC",
  },

  cardTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  cardTitle: {
    fontWeight: "800",
    fontSize: 14,
    color: FIORI.ink,
    flex: 1,
    marginRight: 6,
  },

  cardSubtitle: {
    fontWeight: "400",
    color: FIORI.textMuted,
  },

  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
  },

  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginRight: 4,
  },

  badgeText: {
    fontSize: 9,
    fontWeight: "800",
    textTransform: "uppercase",
  },

  cardMiddleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
    gap: 8,
  },

  infoText: {
    flex: 1,
    fontSize: 12,
    color: FIORI.textMuted,
  },

  infoStrong: {
    fontWeight: "700",
    color: FIORI.ink,
  },

  infoDateText: {
    fontSize: 12,
    color: FIORI.textMuted,
    textAlign: "right",
  },

  cardBottomRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    marginTop: 8,
    gap: 6,
    flexWrap: "wrap",
  },

  lockText: {
    color: FIORI.textMuted,
    fontSize: 11,
    fontStyle: "italic",
    flex: 1,
    textAlign: "right",
  },

  boton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },

  botonTexto: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 11,
  },

  botonSecundario: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: FIORI.accent,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },

  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: FIORI.cardBg,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: FIORI.border,
  },

  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },

  modalHeaderTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: FIORI.ink,
  },

  modalHeaderBtn: {
    fontSize: 22,
    fontWeight: "900",
    color: FIORI.accent,
    paddingHorizontal: 12,
  },

  monthGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "space-between",
  },

  monthCell: {
    width: "31.5%",
    backgroundColor: FIORI.cardSubtle,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 8,
    borderWidth: 1,
    borderColor: FIORI.border,
  },

  monthCellActive: {
    backgroundColor: FIORI.accent,
    borderColor: FIORI.accent,
  },

  monthCellText: {
    color: FIORI.ink,
    fontWeight: "600",
  },

  monthCellTextActive: {
    color: "#fff",
  },

  modalClose: {
    marginTop: 10,
    alignSelf: "flex-end",
    backgroundColor: FIORI.accent,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },

  modalCloseText: {
    color: "#fff",
    fontWeight: "700",
  },

  // FMS NUEVO - INICIO
  // Estilos del banner de estado de la consulta a SAP.
  syncBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 12,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },

  syncBanner_info: {
    backgroundColor: FIORI.accentSoft,
    borderColor: FIORI.accent,
  },

  syncBanner_warn: {
    backgroundColor: "#FFF7E6",
    borderColor: "#F5C26B",
  },

  syncBanner_error: {
    backgroundColor: "#FDECEC",
    borderColor: FIORI.danger,
  },

  syncBanner_ok: {
    backgroundColor: "#F2FCF5",
    borderColor: "#D3EEDC",
  },

  syncBannerText: {
    color: FIORI.ink,
    fontSize: 12,
    fontWeight: "700",
    flex: 1,
  },
  // FMS NUEVO - FIN

});