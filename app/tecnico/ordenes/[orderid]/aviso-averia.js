// app/tecnico/ordenes/[orderid]/aviso-averia.js
import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Image,
  Platform,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Device from "expo-device";
import * as ImageManipulator from "expo-image-manipulator";
import * as LegacyFS from "expo-file-system/legacy";
import { Ionicons } from "@expo/vector-icons";

import Header from "../../../../src/components/Header";
import { useLocalSearchParams, router } from "expo-router";
import { useAuth } from "../../../../src/context/AuthContext";
import NetInfo from "@react-native-community/netinfo";

import {
  fetchMetaAviso,
  fetchCatalogoCircunstancia,
  crearAvisoAveriaSap,
} from "../../../../src/services/avisoAveriaSap";

import { enqueueCrearAvisoAveria } from "../../../../src/offline/avisoAveriaOutbox";

const FIORI = {
  bg: "#F5F7FB",
  card: "#FFFFFF",
  border: "#D1D5DB",
  text: "#111827",
  textMuted: "#6B7280",
  primary: "#0A6ED1",
  danger: "#A10000",
  success: "#10B981",
};

async function isOnlineNow() {
  const st = await NetInfo.fetch();
  return !!st?.isConnected && st?.isInternetReachable !== false;
}

const Chip = ({ active, label, onPress }) => (
  <TouchableOpacity onPress={onPress} style={[styles.chip, active && styles.chipOn]}>
    <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
  </TouchableOpacity>
);

async function uriToBase64(uri) {
  if (!uri) return null;
  const b64 = await LegacyFS.readAsStringAsync(uri, { encoding: "base64" });
  return b64 || null;
}

async function ensureFileUri(uri, ext = "jpg") {
  if (!uri) return null;
  if (!uri.startsWith("content://")) return uri;

  const dest = `${LegacyFS.cacheDirectory}aviso_${Date.now()}.${ext}`;
  await LegacyFS.copyAsync({ from: uri, to: dest });
  return dest;
}

export default function AvisoAveriaSapScreen() {
  const params = useLocalSearchParams();
  const rawId = params.orderid || params.id || params.Orderid || params.ordenId || params.orderId || null;
  const orderid = rawId ? String(rawId).trim() : null;

  const { token, user } = useAuth();
  const emailUsuario = String(user?.email || user?.correo || user?.preferred_username || "").trim() || null;

  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState(null);

  const [catR, setCatR] = useState([]);
  const [catS, setCatS] = useState([]);
  const [catT, setCatT] = useState([]);

  // Control de flujo general (Wizard)
  const [pasoGlobal, setPasoGlobal] = useState(1); // 1: Info General, 2: Tipo Fallas, 3: Posiciones Etapificadas
  const [tieneMultiplesFallas, setTieneMultiplesFallas] = useState(null);
  
  // Control por Posición
  const [posicionIndexActiva, setPosicionIndexActiva] = useState(0);
  const [miniPasoPos, setMiniPasoPos] = useState(1); // 1: Pieza, 2: Falla, 3: Daño R, 4: Localización S, 5: Causa, 6: Causa T, 7: Foto

  // Campos de Información General
  const [shortText, setShortText] = useState("");
  const [solicitante, setSolicitante] = useState("");
  const [puesto, setPuesto] = useState("");
  const [emailSolicitante, setEmailSolicitante] = useState("");
  const [telefono, setTelefono] = useState("");
  const [observaciones, setObservaciones] = useState("");

  // Posiciones dinámicas
  const [posiciones, setPosiciones] = useState([
    {
      id: Date.now(),
      piezaDescripcion: "",
      itemDescript: "",
      causaText: "",
      selR: [],
      selS: null,
      selT: [],
      evidenceUri: null,
      evidenceMeta: null,
    },
  ]);

  const [saving, setSaving] = useState(false);
  const [online, setOnline] = useState(true);
  const [catalogosDesdeCache, setCatalogosDesdeCache] = useState(false);
  const scrollViewRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        if (!orderid) return;
        const currentlyOnline = await isOnlineNow();
        if (alive) setOnline(currentlyOnline);

        const [metaRes, r, s, t] = await Promise.all([
          fetchMetaAviso(orderid, token),
          fetchCatalogoCircunstancia("R", token),
          fetchCatalogoCircunstancia("S", token),
          fetchCatalogoCircunstancia("T", token),
        ]);

        if (!alive) return;
        setMeta(metaRes);
        setCatR(Array.isArray(r) ? r : []);
        setCatS(Array.isArray(s) ? s : []);
        setCatT(Array.isArray(t) ? t : []);
      } catch (e) {
        Alert.alert("Error", e?.message || "No se pudo cargar la información.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [orderid, token]);

  const validarPaso1 = () => {
    if (!shortText.trim() || shortText.length < 5) return Alert.alert("Falta información", "Captura una descripción breve válida (máx 40 caracteres).");
    if (!solicitante.trim() || !puesto.trim() || !emailSolicitante.trim() || !telefono.trim()) return Alert.alert("Falta información", "Completa todos los datos generales.");
    setPasoGlobal(2);
  };

  const seleccionarTipoFallas = (esMultiples) => {
    setTieneMultiplesFallas(esMultiples);
    if (esMultiples && posiciones.length < 2) {
      setPosiciones([
        posiciones[0],
        { id: Date.now(), piezaDescripcion: "", itemDescript: "", causaText: "", selR: [], selS: null, selT: [], evidenceUri: null, evidenceMeta: null }
      ]);
    } else if (!esMultiples) {
      setPosiciones([posiciones[0]]);
    }
    setPosicionIndexActiva(0);
    setMiniPasoPos(1);
    setPasoGlobal(3);
  };

  const actualizarPosicion = (campo, valor) => {
    const nuevas = [...posiciones];
    nuevas[posicionIndexActiva][campo] = valor;
    setPosiciones(nuevas);
  };

  const toggleChipPosicion = (catalogType, item, max = 2) => {
    const nuevas = [...posiciones];
    const currentList = nuevas[posicionIndexActiva][catalogType];
    const exists = currentList.some((sel) => sel.Codigo === item.Codigo);

    if (exists) {
      nuevas[posicionIndexActiva][catalogType] = currentList.filter((sel) => sel.Codigo !== item.Codigo);
    } else {
      if (currentList.length >= max) return Alert.alert("Límite alcanzado", `Solo puedes seleccionar hasta ${max} opciones.`);
      nuevas[posicionIndexActiva][catalogType] = [...currentList, item];
    }
    setPosiciones(nuevas);
  };

  const seleccionarLocalizacionPosicion = (item) => {
    const nuevas = [...posiciones];
    nuevas[posicionIndexActiva].selS = item;
    setPosiciones(nuevas);
  };

  // const handleTakePhotoForPosition = async () => {
  //   try {
  //     const { status } = await ImagePicker.requestCameraPermissionsAsync();
  //     if (status !== "granted") return Alert.alert("Permiso requerido", "Se requiere permiso de cámara.");
      
  //     const result = await ImagePicker.launchCameraAsync({ allowsEditing: false, quality: 0.6, base64: false });
  //     if (result.canceled) return;

  //     let uri = result.assets?.[0]?.uri;
  //     uri = await ensureFileUri(uri, "jpg");
      
  //     const manipulated = await ImageManipulator.manipulateAsync(
  //       uri, 
  //       [{ resize: { width: 800 } }], 
  //       { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
  //     );
      
  //     const base64 = await uriToBase64(manipulated?.uri || uri);
  //     if (!base64) return Alert.alert("Error", "No se pudo procesar la imagen.");

  //     const shortFileName = `aviso_p${posicionIndexActiva + 1}.jpg`;

  //     const nuevas = [...posiciones];
  //     nuevas[posicionIndexActiva].evidenceUri = manipulated?.uri || uri;
  //     nuevas[posicionIndexActiva].evidenceMeta = {
  //       fileName: shortFileName,
  //       mimeType: "image/jpeg",
  //       base64,
  //       sizeBytes: null,
  //     };
  //     setPosiciones(nuevas);
  //   } catch (e) {
  //     Alert.alert("Error", "No se pudo abrir la cámara.");
  //   }
  // };


  const handleTakePhotoForPosition = async () => {
    try {
      // FMS NUEVO - INICIO
      // En el simulador (solo desarrollo) no hay cámara: se usa la galería, igual que en el check-in.
      const useLibraryFallback = __DEV__ && !Device.isDevice;
      let result;
      if (useLibraryFallback) {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          quality: 0.6,
          base64: false,
          allowsEditing: false,
        });
      } else {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== "granted") return Alert.alert("Permiso requerido", "Se requiere permiso de cámara.");
        result = await ImagePicker.launchCameraAsync({ allowsEditing: false, quality: 0.6, base64: false });
      }
      // FMS NUEVO - FIN
      if (result.canceled) return;

      let uri = result.assets?.[0]?.uri;
      uri = await ensureFileUri(uri, "jpg");
      
      // Compresión agresiva para mantener el peso bajo control (máx 800px, 50% calidad)
      const manipulated = await ImageManipulator.manipulateAsync(
        uri, 
        [{ resize: { width: 800 } }], 
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
      );
      
      const base64 = await uriToBase64(manipulated?.uri || uri);
      if (!base64) return Alert.alert("Error", "No se pudo procesar la imagen.");

      const shortFileName = `aviso_p${posicionIndexActiva + 1}.jpg`;

      const nuevas = [...posiciones];
      nuevas[posicionIndexActiva].evidenceUri = manipulated?.uri || uri;
      nuevas[posicionIndexActiva].evidenceMeta = {
        fileName: shortFileName,
        mimeType: "image/jpeg",
        base64,
        sizeBytes: null,
      };
      setPosiciones(nuevas);

      // 🧹 LIMPIEZA DE URI TEMPORAL DE CACHÉ PARA LIBERAR RAM INMEDIATAMENTE
      // Evita acumulación de referencias de archivos locales pesados en el puente de RN
      try {
        if (uri && uri.startsWith("file://")) {
          await LegacyFS.deleteAsync(uri, { idempotent: true });
        }
      } catch (err) {
        // Silencioso si no requiere borrado
      }

    } catch (e) {
      Alert.alert("Error", "No se pudo abrir la cámara.");
    }
  };


  
  const avanzarMiniPaso = () => {
    const pos = posiciones[posicionIndexActiva];

    if (miniPasoPos === 1 && !pos.piezaDescripcion.trim()) return Alert.alert("Falta dato", "Indica la descripción de la pieza afectada.");
    if (miniPasoPos === 2 && !pos.itemDescript.trim()) return Alert.alert("Falta dato", "Indica la descripción de la falla.");
    if (miniPasoPos === 3 && pos.selR.length === 0) return Alert.alert("Falta dato", "Selecciona al menos un Código de Daño (Catálogo R).");
    if (miniPasoPos === 4 && !pos.selS) return Alert.alert("Falta dato", "Selecciona la Localización de la falla (Catálogo S).");
    if (miniPasoPos === 5 && !pos.causaText.trim()) return Alert.alert("Falta dato", "Indica el texto de la causa probable.");
    if (miniPasoPos === 6 && pos.selT.length === 0) return Alert.alert("Falta dato", "Selecciona al menos un Código de Causa (Catálogo T).");
    
    if (miniPasoPos < 7) {
      setMiniPasoPos(miniPasoPos + 1);
    } else {
      if (!pos.evidenceMeta?.base64) return Alert.alert("Falta evidencia", "Adjunta la foto de esta posición para continuar.");

      if (posicionIndexActiva < posiciones.length - 1) {
        setPosicionIndexActiva(posicionIndexActiva + 1);
        setMiniPasoPos(1);
      } else {
        onGuardarFinal();
      }
    }
  };

  const retrocederMiniPaso = () => {
    if (miniPasoPos > 1) {
      setMiniPasoPos(miniPasoPos - 1);
    } else if (posicionIndexActiva > 0) {
      setPosicionIndexActiva(posicionIndexActiva - 1);
      setMiniPasoPos(7);
    } else {
      setPasoGlobal(2);
    }
  };

  const agregarNuevaPosicionForzada = () => {
    setPosiciones([
      ...posiciones,
      { id: Date.now(), piezaDescripcion: "", itemDescript: "", causaText: "", selR: [], selS: null, selT: [], evidenceUri: null, evidenceMeta: null }
    ]);
    setPosicionIndexActiva(posiciones.length);
    setMiniPasoPos(1);
  };

  const onGuardarFinal = async () => {
    if (saving) return;
    if (!emailUsuario) return Alert.alert("Falta usuario", "No se encontró el email del usuario.");

    const infoGeneralLineas = [
      `  Sol: ${solicitante.trim()}`,
      `  Puesto: ${puesto.trim()}`,
      `  Email: ${emailSolicitante.trim()}`,
      `  Tel: ${telefono.trim()}`,
      observaciones.trim() ? `  Obs: ${observaciones.trim()}` : "",
    ].filter(Boolean);

    const posicionesLineas = [];
    posiciones.forEach((pos, idx) => {
      posicionesLineas.push(`  --- Posición #${idx + 1} ---`);
      posicionesLineas.push(`  Pieza: ${pos.piezaDescripcion.trim()}`);
      posicionesLineas.push(`  Falla: ${pos.itemDescript.trim()}`);
      posicionesLineas.push(`  Causa: ${pos.causaText.trim()}`);
    });

    const piezaDescripcionCompleta = [...infoGeneralLineas, ...posicionesLineas].join("\n");

    const notificationItemsSet = [];
    const notificationCausesSet = [];
    let piezaCircListGlobal = [];
    let causasCircListGlobal = [];
    let attachmentsList = [];

    posiciones.forEach((pos, index) => {
      const itemNum = String(index + 1).padStart(4, '0');
      
      notificationItemsSet.push({ 
        ItemNo: itemNum, 
        Descript: pos.itemDescript.trim().slice(0, 40) 
      });

      notificationCausesSet.push({ 
        ItemNo: itemNum, 
        CauseNo: "0001", 
        CauseText: pos.causaText.trim() 
      });

      if (pos.selR) piezaCircListGlobal = [...piezaCircListGlobal, ...pos.selR];
      if (pos.selT) causasCircListGlobal = [...causasCircListGlobal, ...pos.selT];
      
      if (pos.evidenceMeta?.base64) {
        attachmentsList.push({
          DocId: " ",
          FileName: pos.evidenceMeta.fileName,
          MimeType: pos.evidenceMeta.mimeType,
          Base64: pos.evidenceMeta.base64,
        });
      }
    });

    const payload = {
      equipment: meta.Equipment,
      docNumber: meta.DocNumber,
      itmNumber: meta.ItmNumber,
      shortText: String(shortText || "").trim().slice(0, 40),
      piezaDescripcion: piezaDescripcionCompleta,
      itemDescript: posiciones[0]?.itemDescript || "",
      causaText: posiciones[0]?.causaText || "",
      notificationItemsSet,
      notificationCausesSet,
      email: emailUsuario,
      piezaCircList: piezaCircListGlobal,
      lugarCirc: posiciones[0]?.selS || null,
      causasCirc: causasCircListGlobal,
      Attachments: attachmentsList,
    };

    try {
      setSaving(true);
      const online = await isOnlineNow();
      if (!online) {
        const r = await enqueueCrearAvisoAveria({ payload });
        if (r?.ok) {
          Alert.alert("Guardado offline", "Sin conexión. El aviso se guardó localmente.", [{ text: "OK", onPress: () => router.back() }]);
        } else {
          Alert.alert("Error", "No se pudo guardar offline.");
        }
        return;
      }

      const res = await crearAvisoAveriaSap(payload, token);
      if (res?.ok) {
        const notifNo = res?.notifNo || res?.raw?.NotifNo || "Generado";
        Alert.alert("Aviso creado", `Se creó el aviso en SAP.\nNo. de aviso: ${notifNo}`, [{ text: "OK", onPress: () => router.back() }]);
      } else {
        Alert.alert("Aviso no creado", res?.error || "Error al crear en SAP.");
      }
    } catch (e) {
      Alert.alert("Error", e?.message || "Error al conectar con SAP.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: FIORI.bg }}>
        <Header title="Aviso de avería" />
        <View style={styles.center}><ActivityIndicator size="large" color={FIORI.primary} /></View>
      </View>
    );
  }

  const posActiva = posiciones[posicionIndexActiva];

  return (
    <View style={{ flex: 1, backgroundColor: FIORI.bg }}>
      <Header title="Aviso de avería" />

      {/* 🏷️ TARJETA FIJA DE ORDEN Y EQUIPO */}
      <View style={styles.heroCardContainer}>
        <View style={styles.heroCard}>
          <View style={styles.heroInfoGrid}>
            <View style={styles.heroInfoBox}>
              <Text style={styles.heroInfoLabel}>Orden</Text>
              <Text style={styles.heroInfoValue}>#{meta?.Orderid || orderid}</Text>
            </View>
            <View style={styles.heroInfoBox}>
              <Text style={styles.heroInfoLabel}>Equipo</Text>
              <Text style={styles.heroInfoValue}>{meta?.Equipment || "—"}</Text>
            </View>
          </View>
        </View>
      </View>

      <ScrollView ref={scrollViewRef} contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
        
        {/* ================= PASO GLOBAL 1: INFO GENERAL ================= */}
        {pasoGlobal === 1 && (
          <View>
            <Text style={styles.stepTitle}>Paso 1: Información General</Text>
            <View style={styles.card}>
              <Text style={styles.label}>Descripción breve (máx 40 car.)</Text>
              <TextInput style={styles.input} value={shortText} onChangeText={(t) => setShortText(t.slice(0, 40))} placeholder="Ej. Falla en motor principal" />

              <Text style={styles.label}>Solicitante</Text>
              <TextInput style={styles.input} value={solicitante} onChangeText={setSolicitante} placeholder="Nombre completo" />

              <Text style={styles.label}>Puesto</Text>
              <TextInput style={styles.input} value={puesto} onChangeText={setPuesto} placeholder="Puesto de trabajo" />

              <Text style={styles.label}>Email</Text>
              <TextInput style={styles.input} value={emailSolicitante} onChangeText={setEmailSolicitante} keyboardType="email-address" autoCapitalize="none" placeholder="correo@empresa.com" />

              <Text style={styles.label}>Teléfono</Text>
              <TextInput style={styles.input} value={telefono} onChangeText={setTelefono} keyboardType="phone-pad" placeholder="10 dígitos" />

              <Text style={styles.label}>Observaciones adicionales (Opcional)</Text>
              <TextInput style={[styles.input, { height: 70, textAlignVertical: "top" }]} multiline value={observaciones} onChangeText={setObservaciones} placeholder="Comentarios generales" />
            </View>

            <TouchableOpacity style={styles.btnPrimary} onPress={validarPaso1}>
              <Text style={styles.btnPrimaryText}>Siguiente ➔</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ================= PASO GLOBAL 2: TIPO DE FALLAS ================= */}
        {pasoGlobal === 2 && (
          <View style={styles.centerCard}>
            <Ionicons name="help-circle-outline" size={50} color={FIORI.primary} />
            <Text style={styles.stepTitleCenter}>¿Cuántas fallas presenta el equipo?</Text>
            <Text style={styles.stepSubCenter}>Indica si se trata de una avería puntual o si necesitas reportar múltiples piezas y fallas separadas.</Text>

            <TouchableOpacity style={styles.choiceCard} onPress={() => seleccionarTipoFallas(false)}>
              <Ionicons name="checkmark-circle" size={24} color={FIORI.success} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.choiceTitle}>Solo 1 falla</Text>
                <Text style={styles.choiceDesc}>Un flujo guiado paso a paso para una única anomalía.</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.choiceCard} onPress={() => seleccionarTipoFallas(true)}>
              <Ionicons name="list" size={24} color={FIORI.primary} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={styles.choiceTitle}>Múltiples fallas o posiciones</Text>
                <Text style={styles.choiceDesc}>Te guiaremos paso a paso registrando cada posición y su evidencia.</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.btnBack} onPress={() => setPasoGlobal(1)}>
              <Text style={styles.btnBackText}>← Volver al paso anterior</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ================= PASO GLOBAL 3: LLENADO ETAPIFICADO MINI-PASO A MINI-PASO ================= */}
        {pasoGlobal === 3 && (
          <View>
            <View style={styles.posHeaderRow}>
              <Text style={styles.stepTitle}>
                Posición #{posicionIndexActiva + 1} {tieneMultiplesFallas ? `(de ${posiciones.length})` : ""}
              </Text>
              {tieneMultiplesFallas && (
                <TouchableOpacity style={styles.btnAddMini} onPress={agregarNuevaPosicionForzada}>
                  <Text style={styles.btnAddMiniText}>+ Otra posición</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Barra de progreso de la posición actual */}
            <View style={styles.miniProgressBar}>
              <Text style={styles.miniProgressText}>Paso {miniPasoPos} de 7</Text>
              <View style={styles.miniProgressTrack}>
                <View style={[styles.miniProgressFill, { width: `${(miniPasoPos / 7) * 100}%` }]} />
              </View>
            </View>

            <View style={styles.card}>
              {/* MINI-PASO 1: PIEZA */}
              {miniPasoPos === 1 && (
                <View>
                  <Text style={styles.miniStepHeader}>1️⃣ Descripción de la pieza afectada</Text>
                  <Text style={styles.label}>¿Qué componente o pieza presenta el problema?</Text>
                  <TextInput style={styles.input} value={posActiva.piezaDescripcion} onChangeText={(t) => actualizarPosicion("piezaDescripcion", t)} placeholder="Ej. Válvula de control / Rodamiento" autoFocus />
                </View>
              )}

              {/* MINI-PASO 2: FALLA */}
              {miniPasoPos === 2 && (
                <View>
                  <Text style={styles.miniStepHeader}>2️⃣ Descripción de la falla</Text>
                  <Text style={styles.label}>¿Qué anomalía o síntoma observas en la pieza?</Text>
                  <TextInput style={[styles.input, { height: 90, textAlignVertical: "top" }]} multiline value={posActiva.itemDescript} onChangeText={(t) => actualizarPosicion("itemDescript", t)} placeholder="Ej. Fuga de aceite persistente" autoFocus />
                </View>
              )}

              {/* MINI-PASO 3: CATÁLOGO DAÑO R */}
              {miniPasoPos === 3 && (
                <View>
                  <Text style={styles.miniStepHeader}>3️⃣ Código de Daño (Catálogo R)</Text>
                  <Text style={styles.label}>Selecciona hasta 2 códigos de daño:</Text>
                  <View style={styles.chipsWrap}>
                    {catR.map((c) => (
                      <Chip key={c.Codigo} label={`${c.Codigo} - ${c.Descripcion}`} active={posActiva.selR.some((s) => s.Codigo === c.Codigo)} onPress={() => toggleChipPosicion("selR", c, 2)} />
                    ))}
                  </View>
                </View>
              )}

              {/* MINI-PASO 4: LOCALIZACIÓN S */}
              {miniPasoPos === 4 && (
                <View>
                  <Text style={styles.miniStepHeader}>4️⃣ Localización de la falla (Catálogo S)</Text>
                  <Text style={styles.label}>Selecciona la ubicación exacta del daño:</Text>
                  <View style={styles.chipsWrap}>
                    {catS.map((c) => (
                      <Chip key={c.Codigo} label={`${c.Codigo} - ${c.Descripcion}`} active={posActiva.selS?.Codigo === c.Codigo} onPress={() => seleccionarLocalizacionPosicion(c)} />
                    ))}
                  </View>
                </View>
              )}

              {/* MINI-PASO 5: TEXTO CAUSA */}
              {miniPasoPos === 5 && (
                <View>
                  <Text style={styles.miniStepHeader}>5️⃣ Texto de Causa Probable</Text>
                  <Text style={styles.label}>Describe qué originó esta falla:</Text>
                  <TextInput style={[styles.input, { height: 90, textAlignVertical: "top" }]} multiline value={posActiva.causaText} onChangeText={(t) => actualizarPosicion("causaText", t)} placeholder="Ej. Desgaste prematuro por fricción" autoFocus />
                </View>
              )}

              {/* MINI-PASO 6: CATÁLOGO CAUSA T */}
              {miniPasoPos === 6 && (
                <View>
                  <Text style={styles.miniStepHeader}>6️⃣ Código de Causa (Catálogo T)</Text>
                  <Text style={styles.label}>Selecciona hasta 2 códigos de causa:</Text>
                  <View style={styles.chipsWrap}>
                    {catT.map((c) => (
                      <Chip key={c.Codigo} label={`${c.Codigo} - ${c.Descripcion}`} active={posActiva.selT.some((s) => s.Codigo === c.Codigo)} onPress={() => toggleChipPosicion("selT", c, 2)} />
                    ))}
                  </View>
                </View>
              )}

              {/* MINI-PASO 7: FOTO DE EVIDENCIA */}
              {miniPasoPos === 7 && (
                <View>
                  <Text style={styles.miniStepHeader}>7️⃣ Evidencia Fotográfica</Text>
                  <Text style={styles.label}>Toma o adjunta la foto para la Posición #{posicionIndexActiva + 1}:</Text>
                  <TouchableOpacity style={styles.btnSecondary} onPress={handleTakePhotoForPosition}>
                    <Text style={styles.btnSecondaryText}>📷 Tomar Foto de Evidencia</Text>
                  </TouchableOpacity>

                  {posActiva.evidenceUri ? (
                    <View style={{ marginTop: 12 }}>
                      <Image source={{ uri: posActiva.evidenceUri }} style={{ width: "100%", height: 180, borderRadius: 10 }} resizeMode="cover" />
                      <Text style={[styles.label, { color: FIORI.success, textAlign: "center", fontWeight: "bold", marginTop: 4 }]}>✓ Foto guardada correctamente</Text>
                    </View>
                  ) : (
                    <Text style={[styles.label, { color: FIORI.danger, marginTop: 10 }]}>* Obligatorio adjuntar foto para avanzar.</Text>
                  )}
                </View>
              )}
            </View>

            {/* Botones de navegación del mini-paso */}
            <View style={styles.btnRowDual}>
              <TouchableOpacity style={styles.btnBackHalf} onPress={retrocederMiniPaso}>
                <Text style={styles.btnBackText}>← Anterior</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.btnPrimaryHalf, saving && styles.btnPrimaryDisabled]} onPress={avanzarMiniPaso} disabled={saving}>
                {saving ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.btnPrimaryText}>
                    {miniPasoPos === 7 && posicionIndexActiva === posiciones.length - 1 ? (online ? "Crear Aviso en SAP 🚀" : "Guardar Offline 💾") : "Siguiente ➔"}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  
  heroCardContainer: { paddingHorizontal: 16, paddingTop: 12 },
  heroCard: {
    backgroundColor: FIORI.card,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 1 },
      default: {},
    }),
  },
  heroInfoGrid: { flexDirection: "row", gap: 10 },
  heroInfoBox: { flex: 1, backgroundColor: "#F9FAFB", borderRadius: 10, padding: 8, borderWidth: 1, borderColor: "#E5E7EB" },
  heroInfoLabel: { fontSize: 10, color: FIORI.textMuted, fontWeight: "800", textTransform: "uppercase" },
  heroInfoValue: { marginTop: 2, fontSize: 13, color: FIORI.text, fontWeight: "900" },

  stepTitle: { fontSize: 18, fontWeight: "900", color: FIORI.text, marginBottom: 12, marginTop: 6 },
  stepTitleCenter: { fontSize: 18, fontWeight: "900", color: FIORI.text, textAlign: "center", marginTop: 10 },
  stepSubCenter: { fontSize: 13, color: FIORI.textMuted, textAlign: "center", marginTop: 4, marginBottom: 20 },

  centerCard: { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 20, alignItems: "center", marginTop: 20, borderWidth: 1, borderColor: "#E5E7EB" },
  choiceCard: { flexDirection: "row", alignItems: "center", backgroundColor: "#F9FAFB", borderWidth: 1, borderColor: "#D1D5DB", padding: 14, borderRadius: 12, width: "100%", marginBottom: 12 },
  choiceTitle: { fontSize: 15, fontWeight: "bold", color: FIORI.text },
  choiceDesc: { fontSize: 12, color: FIORI.textMuted, marginTop: 2 },

  posHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  btnAddMini: { backgroundColor: "#E0F2FE", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  btnAddMiniText: { color: FIORI.primary, fontWeight: "bold", fontSize: 12 },

  miniProgressBar: { marginVertical: 10 },
  miniProgressText: { fontSize: 11, fontWeight: "bold", color: FIORI.primary, marginBottom: 4, textAlign: "right" },
  miniProgressTrack: { height: 6, backgroundColor: "#E2E8F0", borderRadius: 3, overflow: "hidden" },
  miniProgressFill: { height: "100%", backgroundColor: FIORI.primary },

  miniStepHeader: { fontSize: 16, fontWeight: "900", color: FIORI.primary, marginBottom: 8 },

  card: { backgroundColor: FIORI.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: "#E5E7EB", marginBottom: 14 },
  label: { fontSize: 12, color: FIORI.textMuted, marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14, color: FIORI.text, backgroundColor: "#F9FAFB", marginTop: 4, fontWeight: "600" },

  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#FFFFFF" },
  chipOn: { backgroundColor: FIORI.primary, borderColor: FIORI.primary },
  chipText: { fontSize: 11, color: FIORI.text, fontWeight: "700" },
  chipTextOn: { color: "#FFFFFF" },

  btnPrimary: { marginTop: 16, backgroundColor: FIORI.danger, paddingVertical: 14, borderRadius: 14, alignItems: "center" },
  btnPrimaryText: { color: "#FFFFFF", fontWeight: "900", fontSize: 15 },
  btnPrimaryDisabled: { opacity: 0.7 },

  btnRowDual: { flexDirection: "row", gap: 10, marginTop: 16 },
  btnBackHalf: { flex: 1, backgroundColor: "#E5E7EB", paddingVertical: 14, borderRadius: 14, alignItems: "center" },
  btnPrimaryHalf: { flex: 2, backgroundColor: FIORI.danger, paddingVertical: 14, borderRadius: 14, alignItems: "center" },

  btnBack: { marginTop: 10, padding: 10 },
  btnBackText: { color: FIORI.textMuted, fontWeight: "bold", fontSize: 13 },

  btnSecondary: { backgroundColor: "#111827", paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 6 },
  btnSecondaryText: { color: "#FFFFFF", fontWeight: "800", fontSize: 14 },
});