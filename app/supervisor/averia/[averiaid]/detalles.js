// app/supervisor/averia/[averiaid]/detalles.js
import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
  Pressable,
  Modal,
  TextInput,
  FlatList,
  Alert,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Header from "../../../../src/components/Header";
import api from "../../../../src/services/api";

import {
  loadAveriaDetailCache,
  saveAveriaDetailCache,
  loadCatalogCache,
  saveCatalogCache,
} from "../../../../src/offline/averiasCache";

const COLORS = {
  pageBg: "#F4F6F9",
  cardBg: "#FFFFFF",
  border: "#E4E9F0",
  title: "#0B1F3B",
  text: "#52616B",
  accent: "#0A6ED1",
  chipBg: "#EAF3FF",
  danger: "#E74C3C",
  success: "#6FCF97",
};

const parseSapDate = (value) => {
  if (!value) return null;
  if (typeof value === "string" && value.startsWith("/Date(")) {
    const ms = parseInt(value.replace("/Date(", "").replace(")/", ""), 10);
    if (!Number.isNaN(ms)) return new Date(ms);
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatDate = (value) => {
  const d = parseSapDate(value);
  if (!d) return "—";
  return d.toLocaleDateString();
};

export default function DetallesAveriaSupervisor() {
  const { averiaid } = useLocalSearchParams();

  const [header, setHeader] = useState(null);
  const [itemsList, setItemsList] = useState([]);
  const [textosList, setTextosList] = useState([]);
  const [loading, setLoading] = useState(true);

  const [cacheInfo, setCacheInfo] = useState(null);

  // ======= Causa (P) =======
  const [modalCausa, setModalCausa] = useState(false);
  const [loadingCausas, setLoadingCausas] = useState(false);
  const [savingCausa, setSavingCausa] = useState(false);
  const [causas, setCausas] = useState([]);
  const [searchCausa, setSearchCausa] = useState("");
  const [selectedCausa, setSelectedCausa] = useState(null);

  const fetchDetalleOnline = async () => {
    const encodedId = encodeURIComponent(averiaid);
    const res = await api.get(
      `/api/odata/ZCS_GET_NOTIFICATION_SRV/NotificationHeaderSet('${encodedId}')`,
      {
        params: {
          $expand: "NotificationItemsSet,NotificationTextSet",
          $format: "json",
        },
      },
    );

    const hdr = res?.data?.d ?? res?.data ?? null;

    if (!hdr) throw new Error("No se encontró cabecera de aviso.");
    

    const items = hdr.NotificationItemsSet?.results ?? hdr.NotificationItemsSet ?? [];
    const textos = hdr.NotificationTextSet?.results ?? hdr.NotificationTextSet ?? [];

   // console.log("🔍 [DETALLES AVISO] NotificationTextSet en JSON:", JSON.stringify(textos, null, 2));
    // console.log("🔍 [DETALLES AVISO] NotificationItemsSet en JSON:", JSON.stringify(items, null, 2));

    const codeGroup = hdr.CodeGroup ?? hdr.Codegroup ?? hdr.CODEGROUP ?? hdr.codeGroup ?? null;
    const coding = hdr.Coding ?? hdr.CODING ?? hdr.coding ?? null;
    
    // 🔍 Capturamos el ID de la orden si ya viene en el header del aviso de SAP
    const orderId = hdr.Orderid ?? hdr.OrderId ?? hdr.Aufnr ?? null;

    const hdrFixed = { ...(hdr || {}), CodeGroup: codeGroup, Coding: coding, Orderid: orderId };

    return { hdrFixed, items, textos };
  };

  const fetchDetalle = async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);

      const { hdrFixed, items, textos } = await fetchDetalleOnline();

      setHeader(hdrFixed);
      setItemsList(Array.isArray(items) ? items : []);
      setTextosList(Array.isArray(textos) ? textos : []);
      setCacheInfo(null);

      if (codeGroupAndCoding(hdrFixed)) {
        setSelectedCausa({
          GrupoCodigo: hdrFixed.CodeGroup,
          Codigo: hdrFixed.Coding,
          Descripcion: "",
        });
      }

      await saveAveriaDetailCache({
        averiaid,
        header: hdrFixed,
        items: items,
        textos: textos,
      });
    } catch (err) {
      console.error("Error al cargar detalle de avería:", err?.response?.data || err);

      const cached = await loadAveriaDetailCache({ averiaid });
      if (cached?.header) {
        setHeader(cached.header);
        setItemsList(cached.items || []);
        setTextosList(cached.textos || []);
        setCacheInfo({ savedAt: cached.savedAt });

        if (codeGroupAndCoding(cached.header)) {
          setSelectedCausa({
            GrupoCodigo: cached.header.CodeGroup,
            Codigo: cached.header.Coding,
            Descripcion: "",
          });
        }

        if (!silent) Alert.alert("Sin conexión", "Mostrando detalle guardado (offline).");
      } else {
        Alert.alert("Error", "No se pudo cargar el detalle del aviso y no hay cache guardado.");
      }
    } finally {
      setLoading(false);
    }
  };

  function codeGroupAndCoding(h) {
    return !!(h?.CodeGroup && h?.Coding);
  }

  const CATALOGOS_P_URL =
    "https://qas-mitsu-ti2dye4u.launchpad.cfapps.us10.hana.ondemand.com/94971020-c396-427a-97c1-57aa50753fd3.comtelluscustomerservice.comtelluscustomerservice/sap/opu/odata/sap/ZSD_CATALOGOS_SRV/CircunstanciaSet?$filter=Catalogo%20eq%20%27P%27";

  const fetchCatalogoCausas = async () => {
    try {
      setLoadingCausas(true);
      setSearchCausa("");

      const cached = await loadCatalogCache({ catalogo: "P" });
      if (cached?.items?.length) setCausas(cached.items);

      try {
        const { data } = await api.get("/api/aviso-averia/catalogos/circunstancia", { params: { catalogo: "P" } });
        if (Array.isArray(data) && data.length) {
          setCausas(data);
          await saveCatalogCache({ catalogo: "P", items: data });
          return;
        }
      } catch (e1) {
        console.log("[CATALOGO] No disponible en API, fallback a Launchpad");
      }

      const resp = await fetch(CATALOGOS_P_URL, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error((await resp.text())?.slice(0, 200));

      const json = await resp.json();
      const results = json?.d?.results ?? json?.value ?? [];

      const mapped = results.map((r) => ({
        Catalogo: r.Catalogo,
        GrupoCodigo: r.GrupoCodigo,
        Codigo: r.Codigo,
        Descripcion: r.Descripcion,
      }));

      setCausas(mapped);
      await saveCatalogCache({ catalogo: "P", items: mapped });
    } catch (e) {
      const cached = await loadCatalogCache({ catalogo: "P" });
      if (cached?.items?.length) {
        setCausas(cached.items);
        Alert.alert("Sin conexión", "Mostrando catálogo guardado (offline).");
      } else {
        Alert.alert("Error", "No se pudo cargar el catálogo de causas.");
      }
    } finally {
      setLoadingCausas(false);
    }
  };

  const openModalCausa = async () => {
    setModalCausa(true);
    await fetchCatalogoCausas();
  };

  const asignarCausa = async () => {
    if (!selectedCausa?.GrupoCodigo || !selectedCausa?.Codigo) {
      return Alert.alert("Falta selección", "Selecciona una causa para asignarla.");
    }

    const notifNoToUse = String(header?.NotifNo || averiaid || "").trim();
    if (!notifNoToUse) return Alert.alert("Error", "No se pudo determinar el número de aviso.");

    try {
      setSavingCausa(true);

      const payload = {
        Orderid: notifNoToUse,
        NotifHeader: {
          Refobjecttype: notifNoToUse,
          CodeGroup: selectedCausa.GrupoCodigo,
          Coding: selectedCausa.Codigo,
        },
        Return: [],
      };

      await api.post("/api/odata/ZCS_CHANGE_AVISO_SRV/NotificationHeaderSet", payload, {
        params: { "sap-client": "400", "sap-language": "ES" },
      });

      const nextHeader = {
        ...(header || {}),
        CodeGroup: selectedCausa.GrupoCodigo,
        Coding: selectedCausa.Codigo,
      };
      setHeader(nextHeader);

      await saveAveriaDetailCache({ averiaid, header: nextHeader, items: itemsList, textos: textosList });

      setModalCausa(false);
      Alert.alert("Listo", `Causa asignada: ${selectedCausa.Descripcion || selectedCausa.Codigo}`);
    } catch (e) {
      Alert.alert("Error", "No se pudo asignar la causa.");
    } finally {
      setSavingCausa(false);
    }
  };

  useEffect(() => {
    if (averiaid) {
      (async () => {
        const cached = await loadAveriaDetailCache({ averiaid });
        if (cached?.header) {
          setHeader(cached.header);
          setItemsList(cached.items || []);
          setTextosList(cached.textos || []);
          setCacheInfo({ savedAt: cached.savedAt });
          setLoading(false);
        }
        await fetchDetalle({ silent: true });
      })();
    }
  }, [averiaid]);

  const goBack = () => router.back();

  // const datosFormateadosTextos = useMemo(() => {
  //   if (!Array.isArray(textosList) || textosList.length === 0) {
  //     return { solicitanteInfo: null, piezasList: [], notasLibres: [] };
  //   }

  //   let solicitanteLineas = [];
  //   let piezasList = [];
  //   let notasLibres = [];
  //   let leyendoSolicitante = false;

  //   textosList.forEach((t) => {
  //     const line = String(t?.TextLine || "").trim();
  //     if (!line || line.startsWith("*")) return;

  //     if (line.includes("Sol:")) {
  //       leyendoSolicitante = true;
  //     }

  //     if (leyendoSolicitante) {
  //       if (line.includes("Obs:")) {
  //         const partesObs = line.split("Obs:");
  //         if (partesObs[0]) {
  //           solicitanteLineas.push(partesObs[0].trim());
  //         }
  //         if (partesObs[1] && partesObs[1].trim() && partesObs[1].trim() !== "---") {
  //           notasLibres.push(partesObs[1].replace(/---/g, "").trim());
  //         }
  //         leyendoSolicitante = false;
  //       } else {
  //         solicitanteLineas.push(line);
  //         if (line.includes("Tel:")) {
  //           leyendoSolicitante = false;
  //         }
  //       }
  //     } 
  //     else if (line.includes("Pieza:")) {
  //       const partes = line.split("Pieza:");
  //       if (partes.length > 1) {
  //         partes.slice(1).forEach((fragmento) => {
  //           let nombrePieza = fragmento.split(/Falla:|Causa:|---/)[0].trim();
  //           if (nombrePieza && !piezasList.includes(nombrePieza)) {
  //             piezasList.push(nombrePieza);
  //           }
  //         });
  //       }
  //     } 
  //     else if (line.includes("Obs:")) {
  //       const obsText = line.split("Obs:")[1]?.replace(/---/g, "").trim();
  //       if (obsText && obsText !== "") {
  //         notasLibres.push(obsText);
  //       }
  //     }
  //   });

  //   const solicitanteInfo = solicitanteLineas.length > 0 ? solicitanteLineas.join(" ").replace(/\s+/g, " ").trim() : null;

  //   return { solicitanteInfo, piezasList, notasLibres };
  // }, [textosList]);
  

  const datosFormateadosTextos = useMemo(() => {
    if (!Array.isArray(textosList) || textosList.length === 0) {
      return { solicitanteInfo: null, piezasList: [], notasLibres: [] };
    }

    // 1. Unimos todas las líneas de texto en un solo string plano para buscar con precisión
    const textoCompleto = textosList
      .map((t) => String(t?.TextLine || ""))
      .filter((line) => !line.startsWith("*"))
      .join(" ");

    let solicitanteInfo = null;
    let piezasList = [];
    let notasLibres = [];

    // 2. Extraer datos del solicitante usando Regex limpias sobre el texto unificado
    // Buscamos desde "Sol:" hasta donde empieza "Obs:" o "--- Posición"
    const matchSol = textoCompleto.match(/Sol:\s*(.*?)(?=Obs:|---|Pieza:|$)/i);
    if (matchSol && matchSol[1]) {
      solicitanteInfo = matchSol[1].replace(/\s+/g, " ").trim();
    }

    // 3. Extraer Observaciones / Notas libres
    const matchObs = textoCompleto.match(/Obs:\s*(.*?)(?=---|Pieza:|$)/i);
    if (matchObs && matchObs[1]) {
      const notaLimpia = matchObs[1].replace(/---/g, "").trim();
      if (notaLimpia) notasLibres.push(notaLimpia);
    }

    // 4. Extraer Piezas afectadas
    textosList.forEach((t) => {
      const line = String(t?.TextLine || "").trim();
      if (line.includes("Pieza:")) {
        const partes = line.split("Pieza:");
        if (partes.length > 1) {
          partes.slice(1).forEach((fragmento) => {
            let nombrePieza = fragmento.split(/Falla:|Causa:|---/)[0].trim();
            if (nombrePieza && !piezasList.includes(nombrePieza)) {
              piezasList.push(nombrePieza);
            }
          });
        }
      }
    });

    return { solicitanteInfo, piezasList, notasLibres };
  }, [textosList]);






  const causasFiltradas = useMemo(() => {
    const q = searchCausa.trim().toLowerCase();
    if (!q) return causas;
    return causas.filter((c) => {
      const t = `${c?.Descripcion || ""} ${c?.GrupoCodigo || ""} ${c?.Codigo || ""}`.toLowerCase();
      return t.includes(q);
    });
  }, [causas, searchCausa]);

  const causaAsignada = !!(header?.CodeGroup && header?.Coding);
  const ordenExistenteId = header?.Orderid || header?.OrderId || header?.Aufnr || null; // 🧠 Verificamos si ya existe orden

  if (loading) {
    return (
      <View style={styles.container}>
        <Header title="Detalle de avería" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>Cargando detalle…</Text>
        </View>
      </View>
    );
  }

  if (!header) {
    return (
      <View style={styles.container}>
        <Header title="Detalle de avería" />
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: COLORS.text }}>No se encontró información para el aviso #{averiaid}</Text>
        </View>
      </View>
    );
  }

  const notifNo = header.NotifNo;
  const notifType = header.NotifType;
  const shortText = header.ShortText;
  const reportedBy = header.Reportedby;
  const codeGroup = header.CodeGroup;
  const coding = header.Coding;
  const equipment = header.Equipment;
  const functLoc = header.FunctLoc;
  const notifDate = header.NotifDate;
  const desstdate = header.Desstdate;

  return (
    <View style={styles.container}>
      <Header title={`Aviso ${notifNo || averiaid}`} />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <TouchableOpacity style={styles.backRow} onPress={goBack} activeOpacity={0.6}>
          <Ionicons name="chevron-back" size={20} color={COLORS.accent} />
          <Text style={styles.backText}>Volver a la lista</Text>
        </TouchableOpacity>

        {/* 🔵 Banner informativo si la orden ya fue creada */}
        {!!ordenExistenteId && (
          <View style={styles.bannerOrdenAsociada}>
            <Ionicons name="construct" size={18} color={COLORS.accent} style={{ marginRight: 8 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerOrdenTitle}>Orden de mantenimiento en curso</Text>
              <Text style={styles.bannerOrdenSub}>Este aviso ya cuenta con la Orden SAP: #{ordenExistenteId}</Text>
            </View>
          </View>
        )}

        {!!cacheInfo?.savedAt && (
          <View style={styles.offlineBadge}>
            <Ionicons name="cloud-offline-outline" size={14} color={COLORS.title} />
            <Text style={styles.offlineBadgeText}>
              Offline · Guardado: {new Date(cacheInfo.savedAt).toLocaleString()}
            </Text>
          </View>
        )}

        <Pressable style={({ pressed }) => [styles.refreshInline, pressed && { opacity: 0.9 }]} onPress={() => fetchDetalle()}>
          <Ionicons name="refresh-outline" size={16} color={COLORS.accent} />
          <Text style={styles.refreshInlineText}>Actualizar detalle</Text>
        </Pressable>

        <View style={styles.cardHighlight}>
          <View style={styles.chipRow}>
            <View style={styles.chip}>
              <Ionicons name="alert-circle-outline" size={14} color={COLORS.accent} style={{ marginRight: 4 }} />
              <Text style={styles.chipText}>{notifType || "Sin tipo"}</Text>
            </View>

            {equipment ? (
              <View style={styles.chip}>
                <Ionicons name="hardware-chip-outline" size={14} color={COLORS.accent} style={{ marginRight: 4 }} />
                <Text style={styles.chipText}>{equipment}</Text>
              </View>
            ) : null}
          </View>

          <Text style={styles.mainTitle}>{shortText || "Sin descripción"}</Text>

          {reportedBy ? (
            <Text style={styles.subtitle}>
              Reportado por <Text style={{ fontWeight: "700", color: COLORS.title }}>{reportedBy}</Text>
            </Text>
          ) : null}

          <View style={{ marginTop: 10 }}>
            <Text style={styles.infoLabel}>Causa asignada</Text>
            <Text style={styles.infoValue}>
              {codeGroup && coding ? `${codeGroup} / ${coding}` : "No asignada"}
            </Text>
          </View>

          <Pressable
            style={({ pressed }) => [styles.btnSecondary, pressed && { opacity: 0.9 }]}
            onPress={openModalCausa}
          >
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Ionicons name="list-outline" size={18} color={COLORS.accent} style={{ marginRight: 8 }} />
              <Text style={styles.btnSecondaryText}>Asignar causa de la avería</Text>
            </View>
          </Pressable>
        </View>

        {/* ================= DATOS GENERALES ================= */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Datos generales</Text>
          <View style={styles.infoGrid}>
            <View style={styles.infoItem}><Text style={styles.infoLabel}>Número de aviso</Text><Text style={styles.infoValue}>{notifNo || "—"}</Text></View>
            <View style={styles.infoItem}><Text style={styles.infoLabel}>Tipo de aviso</Text><Text style={styles.infoValue}>{notifType || "—"}</Text></View>
            <View style={styles.infoItemFull}><Text style={styles.infoLabel}>Ubicación funcional</Text><Text style={styles.infoValue}>{functLoc || "—"}</Text></View>
            <View style={styles.infoItem}><Text style={styles.infoLabel}>Fecha de notificación</Text><Text style={styles.infoValue}>{formatDate(notifDate)}</Text></View>
            <View style={styles.infoItem}><Text style={styles.infoLabel}>Fecha deseada inicio</Text><Text style={styles.infoValue}>{formatDate(desstdate)}</Text></View>
          </View>
        </View>

        {/* ================= DATOS DEL SOLICITANTE ================= */}
        {datosFormateadosTextos.solicitanteInfo && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Datos del Solicitante</Text>
            <View style={styles.solicitanteBox}>
              <Ionicons name="person-outline" size={16} color={COLORS.accent} style={{ marginRight: 8, marginTop: 2 }} />
              <Text style={styles.solicitanteText}>{datosFormateadosTextos.solicitanteInfo}</Text>
            </View>
          </View>
        )}

       {/* ================= PIEZAS AFECTADAS ================= */}
        {datosFormateadosTextos.piezasList.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Piezas Afectadas</Text>
            {datosFormateadosTextos.piezasList.map((pieza, idx) => (
              <View key={idx} style={styles.piezaRow}>
                <Ionicons name="cog-outline" size={16} color={COLORS.accent} style={{ marginRight: 8, marginTop: 1 }} />
                <Text style={styles.piezaText}>{pieza}</Text>
              </View>
            ))}
          </View>
        )}

        {/* ================= OBSERVACIONES LIBRES ================= */}
        {datosFormateadosTextos.notasLibres.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Observaciones del Reporte</Text>
            {datosFormateadosTextos.notasLibres.map((nota, idx) => (
              <View key={idx} style={styles.textLineRow}>
                <Ionicons name="document-text-outline" size={14} color={COLORS.accent} style={{ marginRight: 6, marginTop: 2 }} />
                <Text style={styles.textLineContent}>{nota}</Text>
              </View>
            ))}
          </View>
        )}

        {/* ================= POSICIONES / ÍTEMS DE FALLA ================= */}
        <Text style={[styles.sectionTitle, { marginTop: 4, marginBottom: 8 }]}>
          Posiciones de Falla ({itemsList.length})
        </Text>

        {itemsList.length === 0 ? (
          <View style={styles.card}>
            <Text style={{ color: COLORS.text, fontSize: 13 }}>No hay posiciones registradas para este aviso.</Text>
          </View>
        ) : (
          itemsList.map((it, idx) => (
            <View key={it.ItemKey || idx} style={styles.cardItemPosicion}>
              <View style={styles.posHeaderBadge}>
                <Text style={styles.posHeaderText}>Posición #{it.ItemKey || idx + 1}</Text>
              </View>

              <View style={styles.block}>
                <Text style={styles.infoLabel}>Descripción de la falla</Text>
                <Text style={styles.infoValueLarge}>{it.Descript || "—"}</Text>
              </View>

              <View style={styles.infoGrid}>
                <View style={styles.infoItemFull}>
                  <Text style={styles.infoLabel}>Síntoma / Problema ({it.DCode})</Text>
                  <Text style={styles.infoValue}>{it.TxtProbcd || it.DCodegrp || "—"}</Text>
                </View>

                <View style={styles.infoItemFull}>
                  <Text style={styles.infoLabel}>Ubicación / Objeto ({it.DlCode})</Text>
                  <Text style={styles.infoValue}>{it.TxtObjptcd || it.DlCodegrp || "—"}</Text>
                </View>
              </View>

              <View style={styles.chipRowWrap}>
                <View style={styles.chipSmall}><Text style={styles.chipSmallText}>Daño: {it.DCatTyp} / {it.DCodegrp} / {it.DCode}</Text></View>
                <View style={styles.chipSmall}><Text style={styles.chipSmallText}>Parte: {it.DlCatTyp} / {it.DlCodegrp} / {it.DlCode}</Text></View>
              </View>
            </View>
          ))
        )}

        <View style={{ height: 16 }} />

        {/* ================= BOTÓN PRINCIPAL (Deshabilitado si ya tiene orden) ================= */}
        <Pressable
          style={({ pressed }) => [
            styles.btnPrimary,
            (!causaAsignada || !!ordenExistenteId || savingCausa) && styles.btnDisabled,
            pressed && causaAsignada && !ordenExistenteId && !savingCausa && styles.btnPrimaryPressed,
          ]}
          disabled={!causaAsignada || !!ordenExistenteId || savingCausa}
          onPress={() => {
            if (!!ordenExistenteId) return; // Protección adicional por seguridad

            router.push({
              pathname: "/supervisor/ordenes/crear/crearOrden",
              params: {
                averiaid,
                notifNo: String(notifNo || ""),
                equipment: String(equipment || ""),
                shortText: String(shortText || ""),
                piezas: JSON.stringify(datosFormateadosTextos.piezasList || []),
                ubicacionObjetoFalla: String(itemsList[0]?.TxtObjptcd || itemsList[0]?.DlCode || ""),
              },
            });
          }}
        >
          <View style={styles.btnPrimaryContent}>
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" style={{ marginRight: 6 }} />
            <Text style={styles.btnPrimaryText}>
              {!!ordenExistenteId
                ? "Este aviso ya tiene orden creada"
                : causaAsignada
                ? "Crear nueva orden de mantenimiento"
                : "Asigna la causa para continuar"}
            </Text>
            {causaAsignada && !ordenExistenteId && <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />}
          </View>
        </Pressable>
      </ScrollView>

      {/* ================= MODAL CAUSA ================= */}
      <Modal visible={modalCausa} transparent animationType="fade" onRequestClose={() => setModalCausa(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Asignar causa (Catálogo P)</Text>
              <Pressable onPress={() => setModalCausa(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={COLORS.title} />
              </Pressable>
            </View>

            <View style={styles.searchBox}>
              <Ionicons name="search" size={18} color={COLORS.text} style={{ marginRight: 6 }} />
              <TextInput
                value={searchCausa}
                onChangeText={setSearchCausa}
                placeholder="Buscar por descripción…"
                placeholderTextColor="#8A96A3"
                style={styles.searchInput}
              />
            </View>

            {loadingCausas ? (
              <View style={{ paddingVertical: 18, alignItems: "center" }}>
                <ActivityIndicator size="small" color={COLORS.accent} />
                <Text style={{ marginTop: 8, color: COLORS.text, fontSize: 12 }}>Cargando catálogo…</Text>
              </View>
            ) : (
              <FlatList
                data={causasFiltradas}
                keyExtractor={(item, idx) => `${item?.GrupoCodigo || "X"}-${item?.Codigo || idx}`}
                style={{ maxHeight: 340 }}
                renderItem={({ item }) => {
                  const active = selectedCausa?.Codigo === item?.Codigo && selectedCausa?.GrupoCodigo === item?.GrupoCodigo;
                  return (
                    <Pressable
                      onPress={() => setSelectedCausa({ GrupoCodigo: item.GrupoCodigo, Codigo: item.Codigo, Descripcion: item.Descripcion })}
                      style={[styles.optionRow, active && styles.optionRowActive]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.optionText}>{item?.Descripcion || "—"}</Text>
                        <Text style={styles.optionSub}>{item?.GrupoCodigo} / {item?.Codigo}</Text>
                      </View>
                      {active ? <Ionicons name="checkmark-circle" size={20} color={COLORS.accent} /> : <Ionicons name="ellipse-outline" size={18} color="#9AA5B1" />}
                    </Pressable>
                  );
                }}
                ListEmptyComponent={<Text style={{ color: COLORS.text, fontSize: 12, paddingVertical: 10 }}>No hay resultados.</Text>}
              />
            )}

            <View style={styles.modalFooter}>
              <Pressable style={styles.btnGhost} onPress={() => setModalCausa(false)} disabled={savingCausa}>
                <Text style={styles.btnGhostText}>Cancelar</Text>
              </Pressable>

              <Pressable style={[styles.btnSave, (!selectedCausa || savingCausa) && styles.btnSaveDisabled]} disabled={!selectedCausa || savingCausa} onPress={asignarCausa}>
                {savingCausa ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.btnSaveText}>Guardar causa</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.pageBg },
  scrollContent: { padding: 16, paddingBottom: 90 },
  loadingWrap: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 8, color: COLORS.text, fontSize: 13 },
  backRow: { flexDirection: "row", alignItems: "center", marginBottom: 12, paddingVertical: 4 },
  backText: { marginLeft: 4, color: COLORS.accent, fontWeight: "600", fontSize: 13 },

  bannerOrdenAsociada: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  bannerOrdenTitle: { fontSize: 13, fontWeight: "800", color: "#1E3A8A" },
  bannerOrdenSub: { fontSize: 11, color: "#1E40AF", marginTop: 2 },

  offlineBadge: {
    marginBottom: 10,
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

  refreshInline: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#fff",
    marginBottom: 10,
  },
  refreshInlineText: { color: COLORS.title, fontWeight: "900", fontSize: 12 },

  cardHighlight: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  mainTitle: { fontSize: 16, fontWeight: "700", color: COLORS.title, marginBottom: 4 },
  subtitle: { fontSize: 13, color: COLORS.text },

  chipRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8, gap: 6 },
  chipRowWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.chipBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { fontSize: 13, color: COLORS.title, fontWeight: "600" },

  chipSmall: { backgroundColor: "#F1F5F9", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  chipSmallText: { fontSize: 11, color: COLORS.text, fontWeight: "700" },

  card: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: "#000",
    shadowOpacity: 0.03,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  cardItemPosicion: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1.5,
    borderColor: "#CBD5E1",
  },
  posHeaderBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#E0F2FE",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 8,
  },
  posHeaderText: { color: COLORS.accent, fontWeight: "900", fontSize: 12 },

  sectionTitle: { fontSize: 15, fontWeight: "700", color: COLORS.title, marginBottom: 10 },
  infoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  infoItem: { width: "48%" },
  infoItemFull: { width: "100%" },
  infoLabel: { fontSize: 11, color: COLORS.text, opacity: 0.8, marginBottom: 2 },
  infoValue: { fontSize: 14, color: COLORS.title, fontWeight: "600" },
  infoValueLarge: { fontSize: 15, color: COLORS.title, fontWeight: "700" },
  block: { marginBottom: 8 },

  solicitanteBox: { flexDirection: "row", alignItems: "flex-start", backgroundColor: "#F8FAFC", padding: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border },
  solicitanteText: { fontSize: 13, color: COLORS.title, fontWeight: "600", flex: 1, lineHeight: 18 },

  piezaRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#F0FDF4", padding: 10, borderRadius: 10, borderWidth: 1, borderColor: "#BBF7D0", marginBottom: 6 },
  piezaText: { fontSize: 13, color: "#166534", fontWeight: "700", flex: 1 },

  textLineRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 6 },
  textLineContent: { fontSize: 13, color: COLORS.title, fontWeight: "500", flex: 1, lineHeight: 18 },

  btnSecondary: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#FFFFFF",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
  },
  btnSecondaryText: { color: COLORS.accent, fontWeight: "800", fontSize: 13 },

  btnPrimary: {
    marginTop: 8,
    backgroundColor: COLORS.accent,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  btnDisabled: { opacity: 0.55 },
  btnPrimaryPressed: { transform: [{ scale: 0.98 }] },
  btnPrimaryContent: { flexDirection: "row", alignItems: "center" },
  btnPrimaryText: { color: "#FFFFFF", fontWeight: "700", fontSize: 13, marginHorizontal: 4 },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 16 },
  modalCard: { backgroundColor: "#FFF", borderRadius: 18, padding: 14, borderWidth: 1, borderColor: COLORS.border },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  modalTitle: { fontSize: 15, fontWeight: "800", color: COLORS.title },
  searchBox: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10 },
  searchInput: { flex: 1, color: COLORS.title, fontSize: 13 },
  optionRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, marginBottom: 8 },
  optionRowActive: { borderColor: COLORS.accent, backgroundColor: "#F2F8FF" },
  optionText: { color: COLORS.title, fontWeight: "800", fontSize: 13 },
  optionSub: { marginTop: 2, color: COLORS.text, fontSize: 11 },

  modalFooter: { marginTop: 10, flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  btnGhost: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, backgroundColor: "#FFF" },
  btnGhostText: { color: COLORS.title, fontWeight: "800" },

  btnSave: { paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14, backgroundColor: COLORS.accent, alignItems: "center", justifyContent: "center", minWidth: 120 },
  btnSaveDisabled: { opacity: 0.6 },
  btnSaveText: { color: "#FFF", fontWeight: "900" },
});