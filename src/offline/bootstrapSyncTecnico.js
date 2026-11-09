// src/offline/bootstrapSyncTecnico.js

import { isOnline } from "./net";

import {
  buildOfflineWindow,
  filterOrdenesByWindow,
  saveOrdenesTecnicoList,
  loadOrdenesTecnicoList,
  pruneDetallesNoUsados,
  isCacheFresh,
  ORDENES_CACHE_TTL_MS,
  MAX_DETAIL_CACHE_ITEMS,
  // FMS NUEVO - INICIO
  isOrderInWindow,
  // FMS NUEVO - FIN
} from "./ordenesTecnicoCache";

import {
  getLocalStatusPatch,
  applyStatusPatchToOrdenes,
  reconcileStatusPatchesWithSap,
} from "./ordenesTecnicoLocalPatch";

import { prefetchOrdenesTecnicoDetalles } from "./prefetchOrdenesTecnico";

import api from "../services/api";
// FMS NUEVO - INICIO
import AsyncStorage from "@react-native-async-storage/async-storage";
// FMS NUEVO - FIN

/**
 * Normaliza las propiedades de cada orden.
 *
 * SAP y el backend pueden mandar propiedades con nombres distintos.
 * Esta función crea una estructura consistente.
 */
function normalizeOrdenFromList(row) {
  if (!row) return null;

  const Orderid = String(
    row?.Orderid ||
      row?.OrderId ||
      row?.OrderID ||
      "",
  ).trim();

  if (!Orderid) return null;

  return {
    ...row,

    Orderid,

    order_type:
      row?.order_type ||
      row?.OrderType ||
      row?.OrderTypeTxt ||
      null,

    equipment:
      row?.equipment ||
      row?.Equipment ||
      null,

    plant:
      row?.plant ||
      row?.Plant ||
      null,

    start_date:
      row?.start_date ||
      row?.StartDate ||
      row?.BasicStartDate ||
      null,

    finish_date:
      row?.finish_date ||
      row?.FinishDate ||
      row?.BasicFinDate ||
      null,

    short_text:
      row?.short_text ||
      row?.ShortText ||
      row?.shorttext ||
      null,

    userstatus:
      row?.userstatus ||
      row?.Userstatus ||
      row?.UserStatus ||
      row?.UserSt ||
      null,

    estatus_code:
      row?.estatus_code ||
      row?.EstatusCode ||
      row?.StatusCode ||
      null,

    estatus_label:
      row?.estatus_label ||
      row?.EstatusLabel ||
      row?.StatusText ||
      null,
  };
}

/**
 * Obtiene todos los OrderId válidos de una lista.
 */
function getOrderIds(orders = []) {
  return Array.from(
    new Set(
      (Array.isArray(orders) ? orders : [])
        .map((item) =>
          String(
            item?.Orderid ||
              item?.OrderId ||
              item?.orderid ||
              "",
          ).trim(),
        )
        .filter(Boolean),
    ),
  );
}

function normalizeStatusCode(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  const matches = text.match(/(?:^|\D)(0?[1-6]00)(?=\D|$)/g);

  if (matches?.length) {
    const last = matches[matches.length - 1].match(/0?[1-6]00/);
    if (last?.[0]) return last[0].padStart(4, "0");
  }

  const number = Number.parseInt(text, 10);
  return Number.isNaN(number)
    ? text
    : String(number).padStart(4, "0");
}

function getOrderStatusCode(order) {
  return normalizeStatusCode(
    order?.estatus_code ??
      order?.userstatus ??
      order?.Userstatus ??
      order?.UserStatus ??
      order?.UserStText ??
      "",
  );
}

function parseOrderDateMs(order) {
  const value =
    order?.start_date ??
    order?.StartDate ??
    order?.BasicStartDate ??
    null;

  if (!value) return Number.POSITIVE_INFINITY;

  if (typeof value === "string" && value.startsWith("/Date(")) {
    const milliseconds = Number.parseInt(
      value.replace("/Date(", "").replace(")/", ""),
      10,
    );

    return Number.isFinite(milliseconds)
      ? milliseconds
      : Number.POSITIVE_INFINITY;
  }

  const parsed = new Date(value).getTime();

  return Number.isFinite(parsed)
    ? parsed
    : Number.POSITIVE_INFINITY;
}

/**
 * Construye las pistas de estatus que utiliza la precarga para no
 * sobrescribir con un estado anterior el valor efectivo de la lista.
 */
function buildStatusByOrderId(orders = []) {
  return Object.fromEntries(
    (Array.isArray(orders) ? orders : [])
      .map((order) => {
        const orderId = String(
          order?.Orderid ||
            order?.OrderId ||
            order?.orderid ||
            "",
        ).trim();

        if (!orderId) return null;

        return [
          orderId,
          {
            estatus_code: order?.estatus_code ?? null,
            userstatus:
              order?.userstatus ??
              order?.Userstatus ??
              order?.UserStatus ??
              order?.UserStText ??
              null,
            estatus_label: order?.estatus_label ?? null,
            isPendingSignature: order?.isPendingSignature,
            isFinal: order?.isFinal,
            checkin_done: order?.checkin_done,
          },
        ];
      })
      .filter(Boolean),
  );
}

/**
 * Solamente se seleccionan los candidatos cuyos detalles pesados se intentarán precargar.
 *
 * Primero van las ordenes del díay después las fechas más
 * cercanas al día actual priorizando las pendientes de firma
 */
function getDetailPrefetchOrderIds(orders = []) {
  const uniqueOrders = new Map();

  /*
   * Normalizamos HOY a las 00:00.
   *
   * Esto permite comparar solamente el día de la orden
   * y no la hora exacta.
   */
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayMs = today.getTime();

  /*
   * Evitamos órdenes duplicadas.
   */
  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const orderId = String(
      order?.Orderid ||
        order?.OrderId ||
        order?.orderid ||
        "",
    ).trim();

    if (orderId && !uniqueOrders.has(orderId)) {
      uniqueOrders.set(orderId, order);
    }
  });

  /*
   * Determina el grupo de prioridad.
   *
   * 0 = órdenes de HOY
   * 1 = órdenes anteriores PENDIENTES DE FIRMA (0400)
   * 2 = demás órdenes anteriores
   * 3 = órdenes posteriores a HOY
   * 4 = órdenes sin fecha válida
   */
  const getPriorityGroup = (order) => {
    const dateMs = parseOrderDateMs(order);

    if (!Number.isFinite(dateMs)) {
      return 4;
    }

    const orderDate = new Date(dateMs);
    orderDate.setHours(0, 0, 0, 0);

    const orderDayMs = orderDate.getTime();
    const statusCode = getOrderStatusCode(order);

    // PRIORIDAD PRINCIPAL:
    // cualquier orden correspondiente al día actual.
    if (orderDayMs === todayMs) {
      return 0;
    }

    // Después de las de hoy:
    // órdenes anteriores pendientes de firma.
    if (
      orderDayMs < todayMs &&
      statusCode === "0400"
    ) {
      return 1;
    }

    // Después:
    // cualquier otra orden anterior.
    if (orderDayMs < todayMs) {
      return 2;
    }

    // Finalmente:
    // órdenes posteriores, que con nuestra ventana
    // serán básicamente las de mañana.
    if (orderDayMs > todayMs) {
      return 3;
    }

    return 4;
  };

  return Array.from(uniqueOrders.entries())
    .sort(([orderIdA, orderA], [orderIdB, orderB]) => {
      const priorityA = getPriorityGroup(orderA);
      const priorityB = getPriorityGroup(orderB);

      /*
       * Primero manda el grupo de prioridad.
       */
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      const dateA = parseOrderDateMs(orderA);
      const dateB = parseOrderDateMs(orderB);

      /*
       * Dentro de las órdenes anteriores queremos
       * primero las más recientes:
       *
       * ayer
       * hace 2 días
       * hace 3 días
       * ...
       */
      if (
        priorityA === 1 ||
        priorityA === 2
      ) {
        if (dateA !== dateB) {
          return dateB - dateA;
        }
      }

      /*
       * Para las órdenes futuras:
       * primero la fecha más cercana.
       */
      if (priorityA === 3) {
        if (dateA !== dateB) {
          return dateA - dateB;
        }
      }

      /*
       * Si tienen exactamente la misma prioridad
       * y fecha, mantenemos un orden estable.
       */
      return orderIdA.localeCompare(orderIdB);
    })
    .slice(0, MAX_DETAIL_CACHE_ITEMS)
    .map(([orderId]) => orderId);
}

/**
 * Aplica los cambios locales pendientes a una lista.
 *
 * Esto evita que una respuesta atrasada de SAP haga retroceder:
 *
 * 0300 -> 0200
 * 0300 -> 0100
 * 0400 -> 0200
 * 0200 -> 0100
 */
async function applyLocalStatuses(userEmail, orders = []) {
  try {
    const patchMap = await getLocalStatusPatch(userEmail);

    return applyStatusPatchToOrdenes(
      Array.isArray(orders) ? orders : [],
      patchMap,
    );
  } catch (error) {
    console.log(
      "[BOOTSTRAP TECNICO] No se pudieron aplicar parches locales:",
      error?.message || error,
    );

    return Array.isArray(orders) ? orders : [];
  }
}

/**
 * Inicia la precarga de detalles sin detener la carga de la lista.
 *
 * La función de precarga revisa cuáles detalles ya existen y solamente
 * descarga los faltantes o vencidos.
 */
function startDetailsPrefetch({
  orderIds,
  statusByOrderId = {},
  ttlMs,
  reason,
  force = false,
}) {
  if (!Array.isArray(orderIds) || !orderIds.length) {
    return;
  }

  console.log("[BOOTSTRAP TECNICO] Iniciando precarga:", {
    reason,
    total: orderIds.length,
  });

  prefetchOrdenesTecnicoDetalles({
    orderIds,
    statusByOrderId,
    concurrency: 3,
    force,
    ttlMs,
  })
    .then((result) => {
      console.log(
        "[BOOTSTRAP TECNICO] Resultado precarga:",
        {
          reason,
          ...result,
        },
      );
    })
    .catch((error) => {
      console.log(
        "[BOOTSTRAP TECNICO] Error precargando detalles:",
        {
          reason,
          error: error?.message || error,
        },
      );
    });
}



// FMS NUEVO - INICIO
/* =========================================================================
   FASE 1 ("HOY"): lista del día + detalle completo, guardados ANTES de pedir
   el rango. Si el rango tarda o falla, lo de hoy ya está en disco.
   ========================================================================= */
const TODAY_TTL_MS = 10 * 60 * 1000; // datos de hoy: refresco cada 10 min
const TODAY_LIST_TIMEOUT_MS = 20000;
const TODAY_DETAILS_MAX_WAIT_MS = 45000; // espera máxima del detalle antes del rango
const TODAY_RETRY_MS = 20000; // un único reintento de lo que quede incompleto
const RANGE_LIST_TIMEOUT_MS = 90000;
// SOLO DESARROLLO: simula un rango lento (p. ej. 60000) para probar la fase 1.
const DEBUG_DELAY_RANGE_MS = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const localYmd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

const SYNC_META_KEY = (email) => `ordenesTecnico:syncPhases:${email}`;

async function readSyncMeta(email) {
  try {
    const raw = await AsyncStorage.getItem(SYNC_META_KEY(email));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSyncMeta(email, patch) {
  try {
    const current = await readSyncMeta(email);
    await AsyncStorage.setItem(
      SYNC_META_KEY(email),
      JSON.stringify({ ...current, ...patch }),
    );
  } catch {}
}

// Para que las pantallas recarguen cuando termina una fase en segundo plano.
const syncListeners = new Set();

export function subscribeBootstrapSync(listener) {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function emitSync(event) {
  syncListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {}
  });
}

let todayPhasePromise = null; // evita dos fases "hoy" simultáneas

function refreshTodayPhase(email, { force = false, waitDetails = false } = {}) {
  if (todayPhasePromise) return todayPhasePromise;

  const promise = (async () => {
    const t0 = Date.now();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = localYmd(today);

    const meta = await readSyncMeta(email);
    const stale =
      force ||
      meta.todayYmd !== todayStr ||
      !isCacheFresh(meta.todayAt, TODAY_TTL_MS);

        // FMS ELIMINADO - INICIO
    // if (!stale) return { ran: false, ok: false, reason: "fresh" };
    // if (!(await isOnline())) return { ran: false, ok: false, reason: "offline" };
    // FMS ELIMINADO - FIN

    // FMS NUEVO - INICIO
    if (!stale) {
      console.log("[BOOTSTRAP][HOY] Omitida: datos del día vigentes", {
        haceSeg: Math.round((Date.now() - Number(meta.todayAt || 0)) / 1000),
      });
      return { ran: false, ok: false, reason: "fresh" };
    }

    if (!(await isOnline())) {
      console.log("[BOOTSTRAP][HOY] Omitida: sin conexión");
      return { ran: false, ok: false, reason: "offline" };
    }
    // FMS NUEVO - FIN

    try {
      const params = new URLSearchParams({
        start: todayStr,
        end: todayStr,
        mode: "range",
      });

      console.log("[BOOTSTRAP][HOY] Consultando SAP:", { start: todayStr, end: todayStr });

      const response = await api.get(`/api/ordenes/sap/list?${params.toString()}`, {
        timeout: TODAY_LIST_TIMEOUT_MS,
      });

      const normalized = (Array.isArray(response?.data) ? response.data : [])
        .map(normalizeOrdenFromList)
        .filter(Boolean);

      const todayOrders = filterOrdenesByWindow(normalized, today, today);
      const effectiveToday = await reconcileStatusPatchesWithSap(email, todayOrders);

      // Se reemplazan solo las órdenes de hoy; el resto de la lista no se toca.
      const cached = await loadOrdenesTecnicoList(email);
      const cachedList = Array.isArray(cached?.data) ? cached.data : [];
      const todayWindow = { start: today, end: today };
      const keepOthers = cachedList.filter((o) => !isOrderInWindow(o, todayWindow));
      const merged = [...keepOthers, ...effectiveToday];

      // updatedAt NO cambia: el rango sigue contando como "no sincronizado".
      const saved = await saveOrdenesTecnicoList(
        email,
        merged,
        buildOfflineWindow(new Date()),
        Number(cached?.updatedAt) || 0,
      );

      await writeSyncMeta(email, { todayYmd: todayStr, todayAt: Date.now() });

      console.log("[BOOTSTRAP][HOY] Lista del día guardada:", {
        ordenes: effectiveToday.length,
        saved,
        ms: Date.now() - t0,
      });

      // Detalle completo de las órdenes de hoy (frescura de 10 min).
      const ids = getOrderIds(effectiveToday);
      const statusByOrderId = buildStatusByOrderId(effectiveToday);
      let detailsPromise = Promise.resolve(null);

      if (ids.length) {
        detailsPromise = prefetchOrdenesTecnicoDetalles({
          orderIds: ids,
          statusByOrderId,
          concurrency: 3,
          force,
          ttlMs: TODAY_TTL_MS,
        })
          .then((result) => {
            console.log("[BOOTSTRAP][HOY] Detalles del día:", {
              ok: result?.ok,
              fresh: result?.fresh,
              partial: result?.partial,
              fail: result?.fail,
              total: result?.total,
              ms: Date.now() - t0,
            });

            // Un único reintento de lo que haya quedado incompleto.
            if ((result?.partial || 0) + (result?.fail || 0) > 0) {
              setTimeout(() => {
                prefetchOrdenesTecnicoDetalles({
                  orderIds: ids,
                  statusByOrderId,
                  concurrency: 2,
                  force: true,
                  ttlMs: TODAY_TTL_MS,
                }).catch(() => {});
              }, TODAY_RETRY_MS);
            }

            return result;
          })
          .catch((error) => {
            console.log("[BOOTSTRAP][HOY] Error en detalles:", error?.message || error);
            return null;
          });
      }

      if (waitDetails) {
        await Promise.race([detailsPromise, sleep(TODAY_DETAILS_MAX_WAIT_MS)]);
      }

      emitSync({ phase: "today", ok: true });

      return {
        ran: true,
        ok: true,
        data: merged,
        todayOrders: effectiveToday,
        ms: Date.now() - t0,
      };
    } catch (error) {
      console.log(
        "[BOOTSTRAP][HOY] Error consultando SAP:",
        error?.response?.data || error?.message || error,
      );
      return { ran: true, ok: false, reason: "error" };
    }
  })().finally(() => {
    todayPhasePromise = null;
  });

  todayPhasePromise = promise;
  return promise;
}

// Si la fase "hoy" tuvo éxito, sus órdenes mandan sobre las del rango.
function mergeTodayFirst(rangeOrders, todayPhase) {
  if (!todayPhase?.ok || !Array.isArray(todayPhase.todayOrders)) return rangeOrders;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayWindow = { start: today, end: today };

  return [
    ...rangeOrders.filter((o) => !isOrderInWindow(o, todayWindow)),
    ...todayPhase.todayOrders,
  ];
}
// FMS NUEVO - FIN

/**
 * Sincroniza las órdenes del técnico.
 *
 * force=false:
 *   Respeta la caché de una hora para la lista.
 *
 * force=true:
 *   Consulta SAP aunque la lista sea reciente.
 *
 * prefetchDetails=true:
 *   Revisa y precarga los detalles faltantes en segundo plano.
 */
export async function bootstrapPrefetchOrdenesTecnico(
  userEmail,
  {
    force = false,
    prefetchDetails = true,
    ttlMs = ORDENES_CACHE_TTL_MS,
  } = {},
) {
  const cleanEmail = String(userEmail || "")
    .trim()
    .toLowerCase();

  if (!cleanEmail) {
    return {
      ok: false,
      reason: "missing_user",
      source: "none",
      data: [],
    };
  }

  /*
   * Primero obtenemos la lista guardada.
   */
  const cached = await loadOrdenesTecnicoList(cleanEmail);

  const hasCachedList =
    cached &&
    Array.isArray(cached.data);

  const rawCachedData = hasCachedList
    ? cached.data
    : [];

  /*
   * Incluso la caché debe combinarse con los parches locales.
   */
  const cachedData = await applyLocalStatuses(
    cleanEmail,
    rawCachedData,
  );

  const cachedIsFresh = isCacheFresh(
    cached?.updatedAt,
    ttlMs,
  );

  /*
   * Si la lista tiene menos de una hora, no consultamos SAP.
   *
   * Sin embargo, sí revisamos todos los detalles. Esto permite
   * continuar una precarga que haya quedado incompleta.
   */
  // if (!force && hasCachedList && cachedIsFresh) {
  //   console.log(
  //     "[BOOTSTRAP TECNICO] Usando caché vigente:",
  //     {
  //       count: cachedData.length,
  //       updatedAt: cached?.updatedAt,
  //     },
  //   );

  //   const orderIds = getOrderIds(cachedData);
  //   const detailOrderIds = getDetailPrefetchOrderIds(cachedData);
  //   const statusByOrderId = buildStatusByOrderId(cachedData);

  //   if (prefetchDetails) {
  //     startDetailsPrefetch({
  //       orderIds: detailOrderIds,
  //       statusByOrderId,
  //       ttlMs,
  //       reason: "cache_fresh",
  //     });
  //   }

  //   return {
  //     ok: true,
  //     reason: "cache_fresh",
  //     source: "cache",
  //     updatedAt: cached?.updatedAt || null,
  //     count: cachedData.length,
  //     data: cachedData,
  //     orderIds,
  //     window: cached?.window || null,
  //   };
  // }

    if (!force && hasCachedList && cachedIsFresh) {
    console.log("[BOOTSTRAP TECNICO] Usando caché vigente:", {
      count: cachedData.length,
      updatedAt: cached?.updatedAt,
    });

    // FMS NUEVO - INICIO
    // Aunque el rango sea vigente (1 h), lo de HOY se refresca cada 10 min.
    // Se espera como máximo 6 s la lista del día; si SAP tarda, continúa en
    // segundo plano y se guarda sola, sin retrasar el arranque.
    const todayPhase = await Promise.race([
      refreshTodayPhase(cleanEmail, { force: false, waitDetails: false }),
      sleep(6000).then(() => null),
    ]);

    const currentData = todayPhase?.ok
      ? await applyLocalStatuses(cleanEmail, todayPhase.data)
      : cachedData;
    // FMS NUEVO - FIN

    const orderIds = getOrderIds(currentData);
    const detailOrderIds = getDetailPrefetchOrderIds(currentData);
    const statusByOrderId = buildStatusByOrderId(currentData);

       if (prefetchDetails) {
      startDetailsPrefetch({
        orderIds: detailOrderIds,
        statusByOrderId,
        ttlMs,
        reason: "sap_updated",
        // FMS ELIMINADO - INICIO
        // force,
        // FMS ELIMINADO - FIN
        // FMS NUEVO - INICIO
        // Recargar actualiza la lista y lo de hoy (fase 1). El resto de los
        // detalles se renueva por vigencia (1 h); su estatus ya se corrige
        // con la lista. Así no se repiten 120+ peticiones por cada Recargar.
        force: false,
        // FMS NUEVO - FIN
      });
    }

    return {
      ok: true,
      reason: "cache_fresh",
      source: "cache",
      updatedAt: cached?.updatedAt || null,
      count: currentData.length,
      data: currentData,
      orderIds,
      window: cached?.window || null,
    };
  }

  /*
   * La lista no existe, está vencida o el usuario solicitó
   * una actualización manual.
   */
  const online = await isOnline();

  /*
   * Sin conexión no borramos nada.
   *
   * Regresamos la lista guardada con los estatus locales aplicados.
   */
  if (!online) {
    console.log(
      "[BOOTSTRAP TECNICO] Sin conexión:",
      {
        hasCachedList,
        count: cachedData.length,
      },
    );

    return {
      ok: hasCachedList,
      reason: "offline",
      source: hasCachedList ? "cache" : "none",
      updatedAt: cached?.updatedAt || null,
      count: cachedData.length,
      data: cachedData,
      orderIds: getOrderIds(cachedData),
      window: cached?.window || null,
    };
  }

  /*
   * Ventana offline:
   * 15 días anteriores y 1 días posteriores.
   */

    // FMS NUEVO - INICIO
  // Fase 1: hoy primero (espera la lista y hasta 45 s de detalle).
  const todayPhase = await refreshTodayPhase(cleanEmail, {
    force,
    waitDetails: true,
  });

  if (__DEV__ && DEBUG_DELAY_RANGE_MS > 0) {
    console.log("[BOOTSTRAP][RANGO] Retraso de prueba:", DEBUG_DELAY_RANGE_MS);
    await sleep(DEBUG_DELAY_RANGE_MS);
  }
  // FMS NUEVO - FIN

  const window = buildOfflineWindow(new Date());

  const params = new URLSearchParams({
    start: window.startStr,
    end: window.endStr,
    mode: "range",
  });

  console.log(
    "[BOOTSTRAP TECNICO] Consultando SAP:",
    {
      start: window.startStr,
      end: window.endStr,
      force,
    },
  );

  try {
    /*
     * No enviamos el usuario por query.
     * El backend obtiene el correo desde el token Azure.
     */
    // FMS ELIMINADO - INICIO
    // const response = await api.get(`/api/ordenes/sap/list?${params.toString()}`);
    // FMS ELIMINADO - FIN
    // FMS NUEVO - INICIO
    const response = await api.get(
      `/api/ordenes/sap/list?${params.toString()}`,
      { timeout: RANGE_LIST_TIMEOUT_MS },
    );
    // FMS NUEVO - FIN

    const rawRows = Array.isArray(response?.data)
      ? response.data
      : [];

    const normalizedRows = rawRows
      .map(normalizeOrdenFromList)
      .filter(Boolean);

    /*
     * Segunda validación de fechas en la aplicación.
     */
    const sapOrdersInWindow = filterOrdenesByWindow(
      normalizedRows,
      window.start,
      window.end,
    );

    /*
     * Paso importante:
     *
     * La respuesta de SAP se reconcilia contra la cola real.
     * Solo un cambio todavía pendiente o dentro de la breve gracia
     * posterior al envío puede conservar prioridad sobre SAP.
     */
        // FMS ELIMINADO - INICIO
    // const effectiveOrders = await reconcileStatusPatchesWithSap(cleanEmail, sapOrdersInWindow);
    // FMS ELIMINADO - FIN

    // FMS NUEVO - INICIO
    const reconciledRangeOrders = await reconcileStatusPatchesWithSap(
      cleanEmail,
      sapOrdersInWindow,
    );
    const effectiveOrders = mergeTodayFirst(reconciledRangeOrders, todayPhase);
    // FMS NUEVO - FIN

    const orderIds = getOrderIds(effectiveOrders);

    /*
     * Primero se eliminan únicamente los detalles que ya no
     * pertenecen a la ventana. Esto libera caché reconstruible antes
     * de intentar guardar la lista nueva.
     */
    await pruneDetallesNoUsados(orderIds);

    /*
     * Guardamos la lista ya reconciliada. Si Android devuelve
     * SQLITE_FULL, esta función regresa false en vez de lanzar un error.
     * La lista de SAP se conserva en memoria y no desaparece de la UI.
     */
    const listSaved = await saveOrdenesTecnicoList(
      cleanEmail,
      effectiveOrders,
      window,
    );

        // FMS NUEVO - INICIO
    await writeSyncMeta(cleanEmail, { rangeAt: Date.now() });
    emitSync({ phase: "range", ok: true });
    // FMS NUEVO - FIN

    /*
     * Conserva exactamente el estatus efectivo que acaba de quedar en
     * el index. La precarga puede consultar un endpoint de detalle que
     * todavía devuelva un estado anterior; estas pistas impiden que ese
     * resultado vuelva a sobrescribir el estado ya reconciliado.
     */
    const statusByOrderId = buildStatusByOrderId(effectiveOrders);
    const detailOrderIds = getDetailPrefetchOrderIds(effectiveOrders);

    /*
     * Precarga detalles en segundo plano.
     *
     * No usamos await porque la lista debe aparecer inmediatamente.
     */
    if (prefetchDetails) {
      startDetailsPrefetch({
        orderIds: detailOrderIds,
        statusByOrderId,
        ttlMs,
        reason: "sap_updated",
        force,
      });
    }

    console.log(
      "[BOOTSTRAP TECNICO] Lista actualizada:",
      {
        count: effectiveOrders.length,
        listSaved,
        detailsSelected: detailOrderIds.length,
        start: window.startStr,
        end: window.endStr,
      },
    );

    return {
      ok: true,
      reason: "sap_updated",
      source: "sap",
      updatedAt: Date.now(),
      count: effectiveOrders.length,
      data: effectiveOrders,
      orderIds,
      cacheSaved: listSaved,
      window,
    };
  } catch (error) {

        // FMS NUEVO - INICIO
    const cachedDataForError = todayPhase?.ok
      ? await applyLocalStatuses(cleanEmail, todayPhase.data)
      : cachedData;
    // FMS NUEVO - FIN
    /*
     * Si SAP o la API fallan, conservamos la lista anterior
     * y también conservamos sus estatus locales.
     */
    const errorDetail =
      error?.response?.data ||
      error?.message ||
      String(error);

    console.log(
      "[BOOTSTRAP TECNICO] Error consultando SAP:",
      errorDetail,
    );

    /*
     * Aunque la lista SAP falle, intentamos continuar la precarga
     * de los detalles que todavía falten si existe conexión parcial.
     */
    const orderIds = getOrderIds(cachedData);
    const detailOrderIds = getDetailPrefetchOrderIds(cachedData);
    const statusByOrderId = buildStatusByOrderId(cachedData);

    if (prefetchDetails && detailOrderIds.length > 0) {
      startDetailsPrefetch({
        orderIds: detailOrderIds,
        statusByOrderId,
        ttlMs,
        reason: "sap_error_cached_list",
      });
    }

    return {
      ok: hasCachedList,
      reason: "sap_error",
      source: hasCachedList ? "cache" : "none",
      updatedAt: cached?.updatedAt || null,
      count: cachedData.length,
      data: cachedData,
      orderIds,
      window: cached?.window || null,
      error: errorDetail,
    };
  }
}