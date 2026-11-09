// src/utils/offlineDebug.js
// SOLO DESARROLLO. Resume qué hay guardado para trabajar sin red.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

const DETAIL_PREFIX = "ordenesTecnico:detail:";
const LISTS_DIR = `${FileSystem.documentDirectory}ordenesTecnicoLists/`;

const normId = (v) => String(v ?? "").trim().replace(/^0+(?=\d)/, "");
const minutesAgo = (ts) =>
  Number(ts) > 0 ? Math.round((Date.now() - Number(ts)) / 60000) : null;

function ymdOf(value) {
  if (!value) return "sin fecha";
  let d;
  if (typeof value === "string" && value.startsWith("/Date(")) {
    d = new Date(parseInt(value.replace("/Date(", "").replace(")/", ""), 10));
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return "sin fecha";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function debugOfflineStorage({ userEmail, memory = [] } = {}) {
  try {
    /* 1) Listas (encabezados) guardadas como archivo */
    const myFile = `${encodeURIComponent(
      String(userEmail || "unknown").trim().toLowerCase(),
    ).replace(/%/g, "_")}.json`;

    let files = [];
    try {
      files = await FileSystem.readDirectoryAsync(LISTS_DIR);
    } catch {}

    for (const file of files) {
      try {
        const uri = `${LISTS_DIR}${file}`;
        const info = await FileSystem.getInfoAsync(uri);
        const raw = await FileSystem.readAsStringAsync(uri);
        const payload = raw ? JSON.parse(raw) : null;
        const data = Array.isArray(payload?.data) ? payload.data : [];

        const porMes = {};
        data.forEach((o) => {
          const mes = ymdOf(o?.start_date).slice(0, 7);
          porMes[mes] = (porMes[mes] || 0) + 1;
        });

        console.log("[OFFLINE][DIAG] Lista:", {
          archivo: file,
          esDelUsuarioActual: file === myFile,
          kb: Math.round((info?.size || 0) / 1024),
          guardadaHaceMin: minutesAgo(payload?.updatedAt),
          ventana: payload?.window
            ? `${payload.window.startStr} -> ${payload.window.endStr}`
            : null,
          ordenes: data.length,
          porMes,
        });

        if (file === myFile) {
          console.log(
            "[OFFLINE][DIAG] Órdenes de la lista:",
            data
              .slice(0, 80)
              .map(
                (o) =>
                  `${normId(o?.Orderid)} | ${ymdOf(o?.start_date)} | ${
                    o?.estatus_code || o?.userstatus || "-"
                  }`,
              ),
          );
        }
      } catch (e) {
        console.log("[OFFLINE][DIAG] No se pudo leer", file, e?.message || e);
      }
    }

    /* 2) Detalles (operaciones, dirección, cliente...) en AsyncStorage */
    const allKeys = await AsyncStorage.getAllKeys();
    const detailKeys = allKeys.filter((k) => k.startsWith(DETAIL_PREFIX));
    const rows = [];

    for (let i = 0; i < detailKeys.length; i += 40) {
      const batch = detailKeys.slice(i, i + 40);
      const pairs = await AsyncStorage.multiGet(batch);

      pairs.forEach(([key, raw]) => {
        try {
          const p = raw ? JSON.parse(raw) : null;
          const d = p?.data || {};
          const st = d?._prefetch_status || {};

          rows.push({
            id: normId(key.slice(DETAIL_PREFIX.length)),
            ops: Array.isArray(d?.operaciones) ? d.operaciones.length : 0,
            comp: Array.isArray(d?.componentes) ? d.componentes.length : 0,
            dir: !!String(d?.direccion || "").trim(),
            mail: !!String(d?.cliente_email || "").trim(),
            completo: d?._prefetch_complete === true,
            falta: Object.entries(st)
              .filter(([, ok]) => ok !== true)
              .map(([name]) => name),
            fecha: ymdOf(d?.start_date),
            hace: minutesAgo(p?.updatedAt),
            kb: Math.round((raw?.length || 0) / 1024),
          });
        } catch {}
      });
    }

    console.log("[OFFLINE][DIAG] Detalles guardados:", {
      total: rows.length,
      kbTotal: rows.reduce((a, r) => a + r.kb, 0),
      completos: rows.filter((r) => r.completo).length,
      sinOperaciones: rows.filter((r) => !r.ops).map((r) => r.id),
      incompletos: rows
        .filter((r) => !r.completo)
        .map((r) => `${r.id} (falta: ${r.falta.join(",") || "?"})`),
    });

    console.log(
      "[OFFLINE][DIAG] Detalle por orden (id | fecha | ops | materiales | dir | mail | completo | min | kb):",
      rows
        .slice(0, 80)
        .map(
          (r) =>
            `${r.id} | ${r.fecha} | ${r.ops} | ${r.comp} | ${r.dir ? "si" : "NO"} | ${
              r.mail ? "si" : "NO"
            } | ${r.completo ? "si" : "NO"} | ${r.hace}m | ${r.kb}kb`,
        ),
    );

    /* 3) Otras claves relacionadas */
    const matKeys = allKeys.filter((k) => k.startsWith("orderComponents:"));
    const matOrders = new Set(matKeys.map((k) => normId(k.split(":")[1])));

    console.log("[OFFLINE][DIAG] Otras claves:", {
      materialesPorOperacion: matKeys.length,
      ordenesConMateriales: Array.from(matOrders),
      parchesDeEstatus: allKeys.filter((k) => k.includes("statusPatch")).length,
      colasDeCheckin: allKeys.filter((k) => k.startsWith("checkin_queue_v1_")).length,
      tbmky: allKeys.filter((k) => k.startsWith("tbmky_")).length,
    });

    /* 4) Memoria (se pierde al cerrar la app) */
    console.log("[OFFLINE][DIAG] Solo en memoria (consultas de otros periodos):", memory);
  } catch (error) {
    console.log("[OFFLINE][DIAG] Error:", error?.message || error);
  }
}