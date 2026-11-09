// app/supervisor/averia/index.js
import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  TextInput,
  Alert,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Header from "../../../src/components/Header";
import { useAuth } from "../../../src/context/AuthContext";
import api from "../../../src/services/api";
// FMS NUEVO - INICIO
import {
  useCreaciones, ESTADO, iniciarAutoProceso, procesarCreaciones,
  reintentarVerificacion, reenviar, descartar,
  getProximaPasadaEn,
} from "../../../src/offline/ordenCreacionQueue";
import { OPCIONES_CREACION } from "../../../src/offline/ordenCreacionConfig";
// FMS NUEVO - FIN

import {
  loadAveriasListCache,
  saveAveriasListCache,
} from "../../../src/offline/averiasCache";

const COLORS = {
  pageBg: "#F4F6F9",
  cardBg: "#FFFFFF",
  border: "#E4E9F0",
  title: "#0B1F3B",
  text: "#52616B",
  accent: "#0A6ED1",
  danger: "#E76565",
  warning: "#F5C044",
  success: "#6FCF97",
  inProgressOrder: "#0A6ED1", // 🔵 Azul operativo para indicar que ya tiene orden generada en curso
};

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// OData datetime: YYYY-MM-DDTHH:mm:ss (sin Z)
const toOdataDateTime = (d, endOfDay = false) => {
  const date = new Date(d);
  if (endOfDay) date.setHours(23, 59, 59, 0);
  else date.setHours(0, 0, 0, 0);

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
};

// const sapDateToISO = (val) => {
//   if (!val) return null;
//   if (typeof val === "string" && val.startsWith("/Date(")) {
//     const ms = parseInt(val.replace("/Date(", "").replace(")/", ""), 10);
//     if (!Number.isNaN(ms)) return new Date(ms).toISOString();
//     return null;
//   }
//   const d = new Date(val);
//   return Number.isNaN(d.getTime()) ? null : d.toISOString();
// };

const sapDateToISO = (val) => {
  if (!val) return null;
  if (typeof val === "string" && val.startsWith("/Date(")) {
    const ms = parseInt(val.replace("/Date(", "").replace(")/", ""), 10);
    if (!Number.isNaN(ms)) {
      const d = new Date(ms);
      // Creamos la fecha usando UTC para evitar el salto de día por la zona horaria local
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
    }
    return null;
  }
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
};

// Y aseguramos que el formateador imprima la fecha exacta sin alteraciones locales
const formatDate = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  
  // Extraemos directamente los valores UTC para que coincidan con lo que manda SAP
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${month}/${day}/${year}`;
};

// const formatDate = (value) => {
//   if (!value) return "—";
//   const d = new Date(value);
//   if (Number.isNaN(d.getTime())) return "—";
//   return d.toLocaleDateString();
// };

// ✅ detecta “offline/network error” sin reventar LogBox con console.error
const isNetworkError = (err) => {
  const msg = String(err?.message || "").toLowerCase();
  return (
    !err?.response &&
    (msg.includes("network") ||
      msg.includes("timeout") ||
      err?.code === "ERR_NETWORK" ||
      err?.code === "ECONNABORTED")
  );
};

export default function NotificacionesAveriaSupervisor() {
  // FMS NUEVO - INICIO
  const creaciones = useCreaciones();
  // FMS NUEVO - INICIO
  const accionReenviar = (cr) =>
    Alert.alert(
      "Reenviar creación",
      cr.estado === "SIN_CONFIRMAR"
        ? "No se pudo confirmar si SAP creó la orden. Revisa en SAP (IW53) que el aviso NO tenga orden; si ya la tiene, se duplicaría."
        : "Se enviará de nuevo a SAP.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Reenviar",
          style: "destructive",
          onPress: async () => {
            await reenviar(cr.avisoId);
            procesarCreaciones(OPCIONES_CREACION);
          },
        },
      ],
    );
  const accionDescartar = (cr) =>
    Alert.alert("Descartar", "Se quita esta creación de la cola. El aviso queda sin orden.", [
      { text: "Cancelar", style: "cancel" },
      { text: "Descartar", style: "destructive", onPress: () => descartar(cr.avisoId) },
    ]);
  const botonCr = { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: "#0A6ED1" };
  // FMS NUEVO - FIN
  // FMS NUEVO - INICIO
  const [segundo, setSegundo] = useState(0);
  const hayEnCurso = Object.values(creaciones).some((c) =>
    ["PENDIENTE", "ENVIANDO", "CONFIRMANDO"].includes(c.estado),
  );
  useEffect(() => {
    if (!hayEnCurso) return;
    const t = setInterval(() => setSegundo((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [hayEnCurso]);

  // Cuando una creación pasa a CREADA, se recarga la lista para traer el número de orden de SAP.
  const nCreadas = Object.values(creaciones).filter((c) => c.estado === "CREADA").length;
  useEffect(() => {
    if (nCreadas > 0) fetchAverias({ silent: true });
  }, [nCreadas]);
  // FMS NUEVO - FIN
  useEffect(() => {
    iniciarAutoProceso(OPCIONES_CREACION);
  }, []);
  // FMS NUEVO - FIN
  const { token, user } = useAuth();

  const [averias, setAverias] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cacheInfo, setCacheInfo] = useState(null); // {savedAt}

  // filtros
  const now = new Date();
 
  const primerDiaMes = new Date(now.getFullYear(), now.getMonth(), 1);
  const ultimoDiaMes = new Date(now.getFullYear(), now.getMonth() + 1, 0);

 // const [startDate, setStartDate] = useState(new Date(now.getFullYear(), 0, 1));
  //const [endDate, setEndDate] = useState(new Date(now.getFullYear(), 11, 31));
  const [startDate, setStartDate] = useState(primerDiaMes);
  const [endDate, setEndDate] = useState(ultimoDiaMes);
  //console.log("📅 Fecha de inicio:", startDate.toLocaleDateString());
  //console.log("📅 Fecha de fin:", endDate.toLocaleDateString());
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  const [query, setQuery] = useState("");

  const getCorreo = () => {
    return (
      user?.email ||
      user?.correo ||
      user?.preferred_username ||
      user?.upn ||
      user?.username ||
      ""
    );
  };

  const loadFromCache = async () => {
    const correo = getCorreo();
    if (!correo) return false;

    const startYmd = ymd(startDate);
    const endYmd = ymd(endDate);

    const cached = await loadAveriasListCache({ correo, startYmd, endYmd });
    if (cached?.items?.length) {
      setAverias(cached.items);
      setCacheInfo({ savedAt: cached.savedAt });
      return true;
    }
    return false;
  };

  const fetchAverias = async ({ silent = false } = {}) => {
    const correo = getCorreo();
    if (!correo) {
      setAverias([]);
      Alert.alert(
        "Sin correo",
        "No se pudo obtener el correo del usuario logueado.",
      );
      setLoading(false);
      return;
    }

    const startYmd = ymd(startDate);
    const endYmd = ymd(endDate);

    try {
      if (!silent) setLoading(true);

      const createdFrom = toOdataDateTime(startDate, false);
      const notifTo = toOdataDateTime(endDate, true);

      const filter = `CreatedOn ge datetime'${createdFrom}' and NotifDate le datetime'${notifTo}' and Userstatus eq '${correo}'`;

      const res = await api.get(
        `/api/odata/ZCS_GET_NOTIFICATION_SRV/NotificationHeaderSet`,
        {
          params: { $filter: filter,$format: "json" },
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        },
      );

      // 🔍 CONSOLE.LOG PARA INSPECCIONAR LA RESPUESTA DE ODATA
     // console.log("📥 [ODATA RESPUESTA NotificationHeaderSet]:", JSON.stringify(res?.data, null, 2));

      const raw = res?.data;
      const results =
        raw?.d?.results ??
        raw?.value ??
        (Array.isArray(raw?.d) ? raw.d : null) ??
        (Array.isArray(raw) ? raw : []);

      const mapped = (Array.isArray(results) ? results : []).map((it) => {
        const notifISO = sapDateToISO(it?.NotifDate);
        const createdISO = sapDateToISO(it?.CreatedOn);

        let estatus = "pendiente";
        const sys = String(it?.SysStatus || "").toUpperCase();
        if (sys.includes("NOCO") || sys.includes("CERR")) estatus = "cerrada";
        else if (sys.includes("PROC") || sys.includes("INPR"))
          estatus = "en_proceso";

        return {
          NotifNo: it?.NotifNo,
          short_text: it?.ShortText || "",
          equipment: it?.Equipment || "",
          priority: it?.Priority || it?.Priotype || "",
          notif_date: notifISO,
          created_on: createdISO,
          cust_no: it?.CustNo || "",
          funct_loc: it?.MaterialLong || "",
          estatus,
          order_id: it?.Orderid || it?.OrderId || it?.Aufnr || "",
        };
      });

      mapped.sort(
        (a, b) =>
          new Date(b.notif_date || 0).getTime() -
          new Date(a.notif_date || 0).getTime(),
      );

      setAverias(mapped);
      setCacheInfo(null);

      await saveAveriasListCache({ correo, startYmd, endYmd, items: mapped });
    } catch (error) {
      const offline = isNetworkError(error);
      const ok = await loadFromCache();

      if (ok) {
        if (offline) {
          console.log("[AVERIAS] Offline: usando cache");
        } else {
          console.log(
            "[AVERIAS] Falló online, usando cache:",
            error?.response?.data || error,
          );
        }
        if (!silent) {
          Alert.alert(
            "Sin conexión",
            "Mostrando las averías guardadas (offline).",
          );
        }
        return;
      }

      console.error(
        "Error al cargar averías por OData:",
        error?.response?.data || error,
      );
      setAverias([]);
      Alert.alert(
        "Error",
        "No se pudieron cargar los avisos de avería y no hay cache guardado.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      await loadFromCache();
      await fetchAverias({ silent: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return averias;
    return averias.filter((item) => {
      const text = [
        item?.NotifNo,
        item?.short_text,
        item?.equipment,
        item?.cust_no,
        item?.funct_loc,
        item?.estatus,
        item?.order_id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(q);
    });
  }, [averias, query]);

  const renderItem = ({ item: itemSap }) => {
    // FMS NUEVO - INICIO
    // Si la cola ya tiene la orden creada y la lista de SAP aún no la trae, se usa la de la cola.
    const crCreada = creaciones[String(itemSap.NotifNo || "").trim()];
    const item =
      crCreada?.estado === ESTADO.CREADA &&
      crCreada?.orderId &&
      !String(itemSap.order_id || "").trim()
        ? { ...itemSap, order_id: crCreada.orderId }
        : itemSap;
    // FMS NUEVO - FIN
    const tieneOrden = !!String(item.order_id || "").trim();
    // FMS NUEVO - INICIO
    const cr = creaciones[String(item.NotifNo || "").trim()];
    const crActiva = cr && cr.estado !== ESTADO.CREADA ? cr : null;
    const reintentoEn = Math.max(0, Math.ceil((getProximaPasadaEn() - Date.now()) / 1000));
    const CR_TXT = {
      PENDIENTE: "En cola",
      ENVIANDO: "Enviando a SAP…",
      CONFIRMANDO: "Verificando con SAP…",
      ERROR: "Error al crear",
      SIN_CONFIRMAR: "Sin confirmar",
    };
    const CR_COLOR = {
      PENDIENTE: "#6B7280", ENVIANDO: "#0A6ED1", CONFIRMANDO: "#0A6ED1",
      ERROR: "#C62828", SIN_CONFIRMAR: "#B26A00",
    };
    // FMS NUEVO - FIN

    // 🔵 Si ya tiene orden, usamos el color azul operativo en lugar de verde
    const estatusColor = tieneOrden
      ? COLORS.inProgressOrder
      : item.estatus === "pendiente"
        ? COLORS.danger
        : item.estatus === "en_proceso"
          ? COLORS.warning
          : COLORS.success;

    const estatusIcon = tieneOrden
      ? "construct-outline" // Icono de llave/proceso técnico para diferenciarlo de cerrado
      : item.estatus === "pendiente"
        ? "alert-circle-outline"
        : item.estatus === "en_proceso"
          ? "refresh-outline"
          : "checkmark-circle-outline";

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => {
          if (tieneOrden) {
            // 🚀 Si ya tiene orden, lo mandamos a la vista de detalles/visualización de la orden existente
            router.push(`/supervisor/averia/${item.NotifNo}/detalles?orderId=${item.order_id}`);
          } else {
            // ➕ Si NO tiene orden, lo mandamos a crearla normalmente
            router.push(`/supervisor/averia/${item.NotifNo}/detalles`);
          }
        }}
      >
        <View style={[styles.sideBar, { backgroundColor: estatusColor }]} />

        <View style={styles.cardBody}>
          <View style={styles.topRow}>
            <View style={styles.titleWrap}>
              <View style={styles.avatar}>
                <Ionicons 
                  name={tieneOrden ? "construct" : "warning-outline"} 
                  size={20} 
                  color={tieneOrden ? COLORS.inProgressOrder : "#0B1F3B"} 
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.title} numberOfLines={1}>
                  #{item.NotifNo} — {item.short_text || "Sin descripción"}
                </Text>
                <Text style={styles.subTitle} numberOfLines={1}>
                  Equipo: {item.equipment || "—"}
                </Text>
              </View>
            </View>

            <View
              style={[
                styles.statusPill,
                {
                  backgroundColor: estatusColor + "20",
                  borderColor: estatusColor,
                },
              ]}
            >
              <Ionicons
                name={estatusIcon}
                size={14}
                color={tieneOrden ? COLORS.inProgressOrder : "#0B1F3B"}
                style={{ marginRight: 4 }}
              />
              {/* FMS NUEVO - INICIO */}
              {crActiva ? (
                <Text style={[styles.statusText, { color: CR_COLOR[crActiva.estado], fontWeight: "700" }]}>
                  {CR_TXT[crActiva.estado]}
                  {["PENDIENTE", "CONFIRMANDO"].includes(crActiva.estado) ? ` · reintento en ${reintentoEn}s` : ""}
                </Text>
              ) : null}
              {/* FMS NUEVO - FIN */}
              <Text style={[styles.statusText, tieneOrden && { color: COLORS.inProgressOrder, fontWeight: "700" }]}>
                {crActiva ? "" : tieneOrden ? `Orden: ${item.order_id}` : item.estatus?.replace("_", " ") || "—"}
              </Text>
            </View>
          </View>

          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Ionicons name="time-outline" size={14} color="#52616B" />
              <Text style={styles.metaText}>
                Notif.: {formatDate(item.notif_date)}
              </Text>
            </View>
            <View style={styles.metaItem}>
              <Ionicons name="person-outline" size={14} color="#52616B" />
              <Text style={styles.metaText}>
                Cliente: {item.cust_no || "—"}
              </Text>
            </View>
          </View>

          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Ionicons name="pin-outline" size={14} color="#52616B" />
              <Text style={styles.metaText} numberOfLines={1}>
                {item.funct_loc || "Sin ubicación funcional"}
              </Text>
            </View>
          </View>

          {/* FMS NUEVO - INICIO */}
          {crActiva && (crActiva.estado === "ERROR" || crActiva.estado === "SIN_CONFIRMAR") ? (
            <View style={{ marginTop: 8 }}>
              {crActiva.error ? (
                <Text style={{ color: "#C62828", fontSize: 12, marginBottom: 6 }} numberOfLines={3}>
                  {crActiva.error}
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {crActiva.estado === "SIN_CONFIRMAR" ? (
                  <TouchableOpacity style={botonCr} onPress={() => reintentarVerificacion(crActiva.avisoId)}>
                    <Text style={{ color: "#0A6ED1", fontWeight: "700" }}>Verificar otra vez</Text>
                  </TouchableOpacity>
                ) : null}
                {crActiva.estado === "SIN_CONFIRMAR" ? (
                  <TouchableOpacity style={botonCr} onPress={() => accionReenviar(crActiva)}>
                    <Text style={{ color: "#0A6ED1", fontWeight: "700" }}>Reenviar</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={[botonCr, { borderColor: "#C62828" }]} onPress={() => accionDescartar(crActiva)}>
                  <Text style={{ color: "#C62828", fontWeight: "700" }}>Descartar</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
          {/* FMS NUEVO - FIN */}
        </View>
      </TouchableOpacity>
    );
  };

  const onChangeStart = (_e, date) => {
    if (Platform.OS === "android") setShowStartPicker(false);
    if (date) setStartDate(date);
  };

  const onChangeEnd = (_e, date) => {
    if (Platform.OS === "android") setShowEndPicker(false);
    if (date) setEndDate(date);
  };

  return (
    <View style={styles.container}>
      <Header title="Avisos de avería" />

      <View style={styles.pageHeader}>
        <View style={{ marginBottom: 8 }}>
          <Text style={styles.pageTitle}>Lista de averías</Text>
          <Text style={styles.pageSubtitle}>
            {loading
              ? "Cargando..."
              : `${filtered.length} notificaciones de avería encontradas`}
          </Text>

          {!!cacheInfo?.savedAt && (
            <View style={styles.offlineBadge}>
              <Ionicons
                name="cloud-offline-outline"
                size={14}
                color={COLORS.title}
              />
              <Text style={styles.offlineBadgeText}>
                Offline · Guardado:{" "}
                {new Date(cacheInfo.savedAt).toLocaleString()}
              </Text>
            </View>
          )}
        </View>

        <TextInput
          style={styles.searchInput}
          placeholder="Buscar por #, equipo, cliente, ubicación, orden…"
          placeholderTextColor="#9AA5B1"
          value={query}
          onChangeText={setQuery}
        />

        <View style={styles.dateRow}>
          <TouchableOpacity
            style={styles.dateBtn}
            onPress={() => setShowStartPicker(true)}
          >
            <Ionicons name="calendar-outline" size={16} color={COLORS.text} />
            <Text style={styles.dateBtnText}>
              Desde: {startDate.toLocaleDateString()}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.dateBtn}
            onPress={() => setShowEndPicker(true)}
          >
            <Ionicons name="calendar-outline" size={16} color={COLORS.text} />
            <Text style={styles.dateBtnText}>
              Hasta: {endDate.toLocaleDateString()}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.refreshBtn}
            onPress={() => fetchAverias()}
          >
            <Ionicons name="refresh-outline" size={18} color="#fff" />
          </TouchableOpacity>
        </View>

        {showStartPicker && (
          <DateTimePicker
            value={startDate}
            mode="date"
            display={Platform.OS === "ios" ? "inline" : "default"}
            onChange={onChangeStart}
          />
        )}

        {showEndPicker && (
          <DateTimePicker
            value={endDate}
            mode="date"
            display={Platform.OS === "ios" ? "inline" : "default"}
            onChange={onChangeEnd}
          />
        )}

        <TouchableOpacity
          style={styles.applyBtn}
          onPress={async () => {
            await loadFromCache();
            await fetchAverias();
          }}
        >
          <Ionicons name="filter-outline" size={16} color="#fff" />
          <Text style={styles.applyBtnText}>Aplicar filtros</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator
          style={{ marginTop: 40 }}
          size="large"
          color={COLORS.accent}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) =>
            item.NotifNo?.toString() ?? Math.random().toString()
          }
          extraData={[creaciones, segundo]}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text
              style={{ textAlign: "center", marginTop: 24, color: COLORS.text }}
            >
              No hay averías con los filtros actuales.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.pageBg },
  pageHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  pageTitle: { fontSize: 18, fontWeight: "700", color: COLORS.title },
  pageSubtitle: { fontSize: 13, color: COLORS.text, marginTop: 3 },

  offlineBadge: {
    marginTop: 8,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#F8FAFC",
  },
  offlineBadgeText: { fontSize: 12, fontWeight: "700", color: COLORS.title },

  searchInput: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 8 : 6,
    backgroundColor: "#F8FAFC",
    fontSize: 14,
    color: COLORS.title,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    gap: 8,
  },
  dateBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#F8FAFC",
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
  },
  dateBtnText: { fontSize: 12, color: COLORS.text },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.accent,
    alignItems: "center",
    justifyContent: "center",
  },

  applyBtn: {
    marginTop: 10,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.accent,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
  },
  applyBtnText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  listContent: { paddingHorizontal: 12, paddingBottom: 80 },
  card: {
    flexDirection: "row",
    backgroundColor: COLORS.cardBg,
    borderRadius: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: "#000",
    shadowOpacity: 0.03,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
    minHeight: 92,
  },
  sideBar: { width: 5, borderTopLeftRadius: 16, borderBottomLeftRadius: 16 },
  cardBody: { flex: 1, paddingHorizontal: 14, paddingVertical: 12 },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
  },
  titleWrap: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#EFF4F9",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 15, fontWeight: "600", color: COLORS.title },
  subTitle: { fontSize: 12.5, color: "#7A8794", marginTop: 1 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  statusText: {
    fontSize: 11,
    fontWeight: "500",
    textTransform: "capitalize",
    color: COLORS.title,
  },
  metaRow: { flexDirection: "row", gap: 16, marginTop: 8 },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
  },
  metaText: { fontSize: 12, color: COLORS.text },
});