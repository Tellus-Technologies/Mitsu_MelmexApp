// app/supervisor/averia/[averiaid]/crear-orden-mantto.js
import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
  Modal,
  Pressable,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, router } from "expo-router";
// FMS NUEVO - INICIO
import { encolarCreacion, procesarCreaciones } from "../../../../src/offline/ordenCreacionQueue";
import { OPCIONES_CREACION } from "../../../../src/offline/ordenCreacionConfig";
// FMS NUEVO - FIN
import { Ionicons } from "@expo/vector-icons";
import Header from "../../../../src/components/Header";
import api from "../../../../src/services/api";
// FMS NUEVO - INICIO
import { extractOrderFromReturn, extractFromSapMessageHeader } from "../../../../src/utils/sapOrderReturn";
// FMS NUEVO - FIN

const COLORS = {
  pageBg: "#F4F6F9",
  cardBg: "#FFFFFF",
  border: "#E4E9F0",
  title: "#0B1F3B",
  text: "#52616B",
  accent: "#0A6ED1",
  muted: "#9AA5B1",
  danger: "#E74C3C",
  chipBg: "#EAF3FF",
};

const MATERIAL_CATEGORIES = [
  "GRASAS",
  "DIELECTRIC",
  "ACEITE",
  "TRAPO",
  "ESTOPA",
  "BANDAMOTOR",
  "CADENTRACC",
  "FUSIBLE",
  "DEMARESCAL",
  "PEINES",
  "TORNILLESP",
  "BOBINAFREN",
  "CONTACTOR",
  "MICROSWTCH",
  "BUJESESCAL",
  "BOTONPAROS",
];

function elev(multiplier = 1) {
  return Platform.select({
    ios: {
      shadowColor: "#000",
      shadowOpacity: 0.06 * multiplier,
      shadowRadius: 6 * multiplier,
      shadowOffset: { width: 0, height: 3 * multiplier },
    },
    android: { elevation: 2 * multiplier },
    default: {},
  });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function toIsoLocalFromDate(d) {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}
function datePlusDays(hour = 8, minute = 0, plusDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + plusDays);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** 🧠 Calcula inteligentemente qué piezas del técnico aún no han sido seleccionadas */
const obtenerPiezasPendientesDeSugerir = (opComponentes, piezasAviso) => {
  if (!piezasAviso || piezasAviso.length === 0) return [];

  const elegidasEnOp = (opComponentes || [])
    .filter((c) => c.NotFound && (c.MultiSelected || []).length > 0)
    .map((c) => String(c.MultiSelected[0].Descripcion || "").toLowerCase());

  return piezasAviso.filter((pieza) => {
    const pLower = pieza.toLowerCase();
    const palabrasPieza = pLower.split(/\s+/).filter(w => w.length > 2);

    const yaFueElegida = elegidasEnOp.some((descElegida) => {
      if (descElegida.includes(pLower)) return true;
      return palabrasPieza.some((palabra) => descElegida.includes(palabra));
    });

    return !yaFueElegida;
  });
};

function normActivity(n) {
  const v = Number(n);
  const act = Number.isFinite(v) ? v : 10;
  return String(act).padStart(4, "0");
}

function normItemNumberByIndex(index) {
  return String((index + 1) * 10).padStart(4, "0");
}

const FIXED_INTRM_FOR_BOM = "MX06GR478NL3-10P";

function emptyComponent(itemNumber, planPlant, activity) {
  return {
    ItemNumber: String(itemNumber).padStart(4, "0"),
    Activity: String(activity || "0010").padStart(4, "0"),
    Category: "",
    Materials: [],
    LoadingMaterials: false,
    Material: "",
    RequirementQuantity: "",
    StgeLoc: "",
    Plant: planPlant,
    Trackingno: "01",
    NotFound: false,
    NotFoundCategories: [],
    LoadingNotFoundCategories: false,
    NotFoundCategory: "",
    NotFoundMaterials: [],
    LoadingNotFoundMaterials: false,
    MultiSelected: [],
    MultiTrackingno: "01",
  };
}

function emptyOperation(index, planPlant) {
  const activity = normActivity((index + 1) * 10);
  return {
    Activity: activity,
    Description: "",
    DurationNormal: "",
    IsExternal: false,
    Components: [],
  };
}

function normalizeOpsAndComponents(list, planPlant) {
  return (list || []).map((op, opIdx) => {
    const act = normActivity((opIdx + 1) * 10);
    const comps = (op.Components || []).map((c, ci) => {
      const itemNo = normItemNumberByIndex(ci);
      return {
        ...c,
        Plant: c.Plant || planPlant,
        Activity: act,
        ItemNumber: itemNo,
      };
    });
    return { ...op, Activity: act, Components: comps };
  });
}

export default function CrearOrdenMantto() {
  const params = useLocalSearchParams();
  const { averiaid, notifNo, equipment, MaterialLong, shortText, ubicacionObjetoFalla } = params;
  const bomCacheRef = React.useRef({});
  const [expandedOpIndex, setExpandedOpIndex] = useState(0);
  const scrollViewRef = React.useRef(null);
  const scrollToBottom = () => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 250); // Un pequeño retraso para asegurar que el teclado o el renderizado terminen
  };

  const [step, setStep] = useState(1);

  const piezasAviso = useMemo(() => {
    try {
      return params?.piezas ? JSON.parse(params.piezas) : [];
    } catch (e) {
      return [];
    }
  }, [params?.piezas]);

  const [orderType] = useState("SM01");
  const [planPlant] = useState("TLP1");

  const [startDT, setStartDT] = useState(datePlusDays(8, 0, 0));
  const [finishDT, setFinishDT] = useState(datePlusDays(18, 0, 1));
  const [headerShortText, setHeaderShortText] = useState("");

  const [operations, setOperations] = useState(() =>
    normalizeOpsAndComponents([emptyOperation(0, planPlant)], planPlant),
  );

  const [saving, setSaving] = useState(false);
  const [payloadPreview, setPayloadPreview] = useState(null);

  const [multiVisible, setMultiVisible] = useState(false);
  const [multiOpIndex, setMultiOpIndex] = useState(-1);
  const [multiCompIndex, setMultiCompIndex] = useState(-1);
  const [multiQuery, setMultiQuery] = useState("");

  const [dtPickerVisible, setDtPickerVisible] = useState(false);
  const [dtPickerField, setDtPickerField] = useState(null);
  const [dtPickerStep, setDtPickerStep] = useState("date");
  const [dtPickerTemp, setDtPickerTemp] = useState(new Date());

  const [peopleCount, setPeopleCount] = useState(null);

  const goBack = () => {
    if (step > 1) {
      setStep(step - 1);
    } else {
      router.back();
    }
  };

  const startDateStr = useMemo(() => toIsoLocalFromDate(startDT), [startDT]);
  const finishDateStr = useMemo(() => toIsoLocalFromDate(finishDT), [finishDT]);

  const openDateTimePicker = (field) => {
    const current = field === "start" ? startDT : finishDT;
    setDtPickerField(field);
    setDtPickerTemp(new Date(current));
    if (Platform.OS === "android") setDtPickerStep("date");
    setDtPickerVisible(true);
  };

  const applyPickedDateTime = (finalDate) => {
    if (!finalDate || !dtPickerField) return;
    if (dtPickerField === "start") setStartDT(finalDate);
    if (dtPickerField === "finish") setFinishDT(finalDate);
  };

  const updateOperation = (opIndex, field, value) => {
    setOperations((prev) =>
      prev.map((op, i) => (i === opIndex ? { ...op, [field]: value } : op)),
    );
  };

  const addOperation = () => {
    setOperations((prev) => {
      const next = [...prev, emptyOperation(prev.length, planPlant)];
      const normalized = normalizeOpsAndComponents(next, planPlant);
      setExpandedOpIndex(normalized.length - 1); //  Colapsa las anteriores y abre la nueva recién creada
      return normalized;
    });
  };

  const removeOperation = (opIndex) => {
    setOperations((prev) => {
      if (prev.length === 1) {
        Alert.alert(
          "No permitido",
          "La orden debe tener al menos una operación.",
        );
        return prev;
      }
      const next = prev.filter((_, i) => i !== opIndex);
      return normalizeOpsAndComponents(next, planPlant);
    });
  };

  const updateComponent = (opIndex, compIndex, field, value) => {
    setOperations((prev) => {
      const next = prev.map((op, i) => {
        if (i !== opIndex) return op;
        const comps = (op.Components || []).map((c, j) =>
          j === compIndex ? { ...c, [field]: value } : c,
        );
        return { ...op, Components: comps };
      });
      return normalizeOpsAndComponents(next, planPlant);
    });
  };

  const removeComponentFromOp = (opIndex, compIndex) => {
    setOperations((prev) => {
      const next = prev.map((op, i) => {
        if (i !== opIndex) return op;
        const comps = op.Components || [];
        if (comps.length === 1) {
          Alert.alert(
            "No permitido",
            "Debe haber al menos un componente por operación.",
          );
          return op;
        }
        return { ...op, Components: comps.filter((_, j) => j !== compIndex) };
      });
      return normalizeOpsAndComponents(next, planPlant);
    });
  };

  const fetchNotFoundCategories = async () => {
    const url = "/api/odata/ZSD_CATALOGOS_SRV/CategoriaManttoSet?$format=json";
    const res = await api.get(url, { headers: { Accept: "application/json" } });
    const data = res?.data?.d?.results ?? res?.data?.value ?? [];

    const mapped = data
      .map((x) => {
        const desc = String(x?.Descripcion ?? x?.DESCRIPCION ?? "").trim();
        return {
          Id: String(x?.Id ?? x?.ID ?? "").trim(),
          Zeinr: desc,
          Texto: desc,
        };
      })
      .filter((x) => !!x.Zeinr);

    const uniq = new Map();
    for (const it of mapped) if (!uniq.has(it.Zeinr)) uniq.set(it.Zeinr, it);
    return Array.from(uniq.values());
  };

  const fetchNotFoundBomItems = async ({ equipmentIntrm, zeinr, werks }) => {
    const eq = FIXED_INTRM_FOR_BOM;
    const cat = String(zeinr || "").trim();
    const centro = String(werks || "TLP1").trim();
    if (!eq || !cat) return [];

    const cacheKey = `${eq}_${cat}_${centro}`;
    if (bomCacheRef.current[cacheKey]) {
      return bomCacheRef.current[cacheKey];
    }

    const filterRaw = `Intrm eq '${eq}' and Zeinr eq '${cat}' and Werks eq '${centro}'`;
    const url =
      "/api/odata/ZCS_GET_BOM_MATERIAL_SRV/BomItemsSet" +
      `?$filter=${encodeURIComponent(filterRaw)}` +
      "&$format=json";

    try {
      const res = await api.get(url, { headers: { Accept: "application/json" } });
      const data = res?.data?.d?.results ?? res?.data?.value ?? [];

      const mappedRaw = data.map((x) => ({
        Idnrk: String(x?.Idnrk ?? x?.IDNRK ?? "").trim(),
        Ojtxp: String(x?.Ojtxp ?? x?.OJTXP ?? "").trim(),
      }));

      const uniq = new Map();
      for (const it of mappedRaw) {
        if (!it.Idnrk) continue;
        if (!uniq.has(it.Idnrk)) uniq.set(it.Idnrk, it);
      }
      
      const resultadoFinal = Array.from(uniq.values());
      bomCacheRef.current[cacheKey] = resultadoFinal;

      return resultadoFinal;
    } catch (err) {
      throw err;
    }
  };

  const ensureNotFoundCategories = async (opIndex, compIndex) => {
    updateComponent(opIndex, compIndex, "LoadingNotFoundCategories", true);

    try {
      const cats = await fetchNotFoundCategories();
      setOperations((prev) => {
        const next = prev.map((op, i) => {
          if (i !== opIndex) return op;
          const comps = (op.Components || []).map((c, j) => {
            if (j !== compIndex) return c;
            return {
              ...c,
              NotFoundCategories: cats,
              LoadingNotFoundCategories: false,
            };
          });
          return { ...op, Components: comps };
        });
        return normalizeOpsAndComponents(next, planPlant);
      });
    } catch (e) {
      Alert.alert(
        "Categorías",
        "No se pudieron cargar las categorías de mantenimiento.",
      );
      updateComponent(opIndex, compIndex, "LoadingNotFoundCategories", false);
    }
  };

  const loadNotFoundMaterialsByCategory = async (
    opIndex,
    compIndex,
    zeinrDescripcion,
  ) => {
    const intrm = FIXED_INTRM_FOR_BOM;
    const zeinr = String(zeinrDescripcion || "").trim();

    setOperations((prev) => {
      const next = prev.map((op, i) => {
        if (i !== opIndex) return op;
        const comps = (op.Components || []).map((c, j) => {
          if (j !== compIndex) return c;
          return {
            ...c,
            NotFoundCategory: zeinr,
            LoadingNotFoundMaterials: true,
            NotFoundMaterials: [],
            MultiSelected: [],
          };
        });
        return { ...op, Components: comps };
      });
      return normalizeOpsAndComponents(next, planPlant);
    });

    try {
      const mats = await fetchNotFoundBomItems({
        equipmentIntrm: intrm,
        zeinr,
        werks: planPlant,
      });
      setOperations((prev) => {
        const next = prev.map((op, i) => {
          if (i !== opIndex) return op;
          const comps = (op.Components || []).map((c, j) => {
            if (j !== compIndex) return c;
            return {
              ...c,
              NotFoundMaterials: mats,
              LoadingNotFoundMaterials: false,
            };
          });
          return { ...op, Components: comps };
        });
        return normalizeOpsAndComponents(next, planPlant);
      });
    } catch (e) {
      Alert.alert(
        "Materiales",
        "No se pudieron cargar los materiales por BOM.",
      );
      setOperations((prev) => {
        const next = prev.map((op, i) => {
          if (i !== opIndex) return op;
          const comps = (op.Components || []).map((c, j) => {
            if (j !== compIndex) return c;
            return { ...c, LoadingNotFoundMaterials: false };
          });
          return { ...op, Components: comps };
        });
        return normalizeOpsAndComponents(next, planPlant);
      });
    }
  };

  const openMultiSelect = async (opIndex, compIndex, forceNotFound = false) => {
    setMultiOpIndex(opIndex);
    setMultiCompIndex(compIndex);
    setMultiQuery("");
    setMultiVisible(true);

    if (forceNotFound) {
      const cats = await ensureNotFoundCategoriesAndMatch(opIndex, compIndex);
      return;
    }
  };

 // 🧠 Función auxiliar para buscar coincidencia automática con el reporte del mecánico
  const ensureNotFoundCategoriesAndMatch = async (opIndex, compIndex) => {
    updateComponent(opIndex, compIndex, "LoadingNotFoundCategories", true);

    try {
      const cats = await fetchNotFoundCategories();
      
      // Intentamos hacer match inteligente con la ubicación que trajo el aviso (ej. "Cuarto de Máquinas" -> "CUARTOMAQ")
      const matchCat = cats.find(c => {
        if (!ubicacionObjetoFalla) return false;
        const catText = (c.Texto || c.Zeinr || "").toLowerCase();
        const objFalla = ubicacionObjetoFalla.toLowerCase();
        return objFalla.includes(catText) || catText.includes(objFalla.substring(0, 6));
      });

      setOperations((prev) => {
        const next = prev.map((op, i) => {
          if (i !== opIndex) return op;
          const comps = (op.Components || []).map((c, j) => {
            if (j !== compIndex) return c;
            return {
              ...c,
              NotFoundCategories: cats,
              LoadingNotFoundCategories: false,
            };
          });
          return { ...op, Components: comps };
        });
        return normalizeOpsAndComponents(next, planPlant);
      });

      // Si encontró una categoría gemela exacta del reporte del mecánico, la cargamos de inmediato
      if (matchCat) {
        await loadNotFoundMaterialsByCategory(opIndex, compIndex, matchCat.Zeinr);
      }

    } catch (e) {
      Alert.alert("Categorías", "No se pudieron cargar las categorías de mantenimiento.");
      updateComponent(opIndex, compIndex, "LoadingNotFoundCategories", false);
    }
  };

  const handleCategoryChangeForComponent = async (
    opIndex,
    compIndex,
    category,
  ) => {
    const op = operations[opIndex];
    if (!op) return;

    if (!category) {
      setOperations((prev) => {
        const next = prev.map((o, i) => {
          if (i !== opIndex) return o;
          const comps = (o.Components || []).map((c, j) => {
            if (j !== compIndex) return c;
            return {
              ...c,
              Category: "",
              Materials: [],
              Material: "",
              LoadingMaterials: false,
              MultiSelected: [],
              MultiTrackingno: "01",
            };
          });
          return { ...o, Components: comps };
        });
        return normalizeOpsAndComponents(next, planPlant);
      });
      return;
    }

    setOperations((prev) => {
      const next = prev.map((o, i) => {
        if (i !== opIndex) return o;
        const comps = (o.Components || []).map((c, j) => {
          if (j !== compIndex) return c;
          return {
            ...c,
            Category: category,
            Materials: [],
            Material: "",
            LoadingMaterials: true,
          };
        });
        return { ...o, Components: comps };
      });
      return normalizeOpsAndComponents(next, planPlant);
    });

    try {
      const baseUrl =
        "https://my-node-api-qas-01.cfapps.us10-001.hana.ondemand.com/api/odata/ZSD_CATALOGOS_SRV/MaterialesCoberturaSet";
      const url =
        baseUrl +
        `?$filter=Agrupador1 eq 'BASICO' and Agrupador2 eq '${category}'&$format=json`;

      const res = await fetch(encodeURI(url));
      const json = await res.json();
      const list = json?.d?.results ?? json?.value ?? [];

      const mappedRaw = list.map((m) => ({
        Id: m.Id,
        Material: String(m.Material || "").trim(),
        Descripcion: String(m.Descripcion || "").trim(),
      }));

      const uniqMap = new Map();
      for (const it of mappedRaw) {
        if (!it.Material) continue;
        if (!uniqMap.has(it.Material)) uniqMap.set(it.Material, it);
      }
      const mapped = Array.from(uniqMap.values());

      setOperations((prev) => {
        const next = prev.map((o, i) => {
          if (i !== opIndex) return o;
          const comps = (o.Components || []).map((c, j) => {
            if (j !== compIndex) return c;
            return { ...c, Materials: mapped, LoadingMaterials: false };
          });
          return { ...o, Components: comps };
        });
        return normalizeOpsAndComponents(next, planPlant);
      });
    } catch (err) {
      Alert.alert("Catálogo de materiales", "No se pudo cargar el catálogo.");
      setOperations((prev) => {
        const next = prev.map((o, i) => {
          if (i !== opIndex) return o;
          const comps = (o.Components || []).map((c, j) => {
            if (j !== compIndex) return c;
            return { ...c, LoadingMaterials: false };
          });
          return { ...o, Components: comps };
        });
        return normalizeOpsAndComponents(next, planPlant);
      });
    }
  };

  const construirPayloadOrden = () => {
    if (!String(headerShortText || "").trim()) {
      Alert.alert("Descripción corta", "Captura el ShortText.");
      return null;
    }

    const opsValidas = operations
      .map((op) => ({
        ...op,
        Activity: String(op.Activity || "").padStart(4, "0"),
        Description: String(op.Description || "").trim(),
        DurationNormal: String(op.DurationNormal || "").trim(),
      }))
      .filter((op) => {
        const dur = Number(op.DurationNormal);
        return (
          /^\d{4}$/.test(op.Activity) &&
          !!op.Description &&
          !!op.DurationNormal &&
          Number.isFinite(dur) &&
          dur > 0
        );
      });

    if (!opsValidas.length) {
      Alert.alert(
        "Operaciones",
        "Debes capturar al menos una operación válida (descripción + duración > 0).",
      );
      return null;
    }

    const planPlantValue = String(planPlant).trim();
    const componentItems = [];
    opsValidas.forEach((op) => {
      const opActivity = String(op.Activity).padStart(4, "0");

      (op.Components || []).forEach((c) => {
        const stge = String(c.StgeLoc || "").trim();
        const qty = String(c.RequirementQuantity || "").trim();

        const hasSomething =
          String(c.Material || "").trim() ||
          String(qty || "").trim() ||
          String(stge || "").trim() ||
          String(c.Category || "").trim() ||
          (c.NotFound && (c.MultiSelected || []).length > 0);

        if (!hasSomething) return;

        if (c.NotFound) {
          const tracking = String(c.MultiTrackingno || "01").trim();
          const selBOM = (c.MultiSelected || [])[0];
          if (!selBOM?.Material) return;

          const descBOM = String(selBOM.Descripcion || selBOM.Ojtxp || "").trim();

          componentItems.push({
            ItemNumber: String(c.ItemNumber || "").padStart(4, "0"),
            Material: String(selBOM.Material || "").trim(),
            //Descripcion: String(selBOM.Descripcion || selBOM.Ojtxp || "").trim(), // 👈 Validamos ambas opciones de la BOM
            RequirementQuantity: qty,
            StgeLoc: stge,
            Plant: planPlantValue,
            Activity: opActivity,
            Trackingno: tracking,
            ItemCat: "L"
          });
          c.DescripcionVisual = descBOM;
          
          return;
        }

        const matEncontrado = (c.Materials || []).find(m => m.Material === c.Material);
        const descConsumible = matEncontrado ? (matEncontrado.Descripcion || matEncontrado.Ojtxp) : c.Material;

        componentItems.push({
          ItemNumber: String(c.ItemNumber || "").padStart(4, "0"),
          Material: String(c.Material || "").trim(),
          //Descripcion: String(descConsumible || "").trim(), // 👈 Aseguramos que pinte el nombre del consumible
          RequirementQuantity: qty,
          StgeLoc: stge,
          Plant: planPlantValue,
          Activity: opActivity,
          Trackingno: String(c.Trackingno || "01").trim(),
          ItemCat: "L"
        });
        c.DescripcionVisual = String(descConsumible || "").trim();
      });
    });

    const notifOriginal = String(notifNo || averiaid || "").trim();
    const numPeople =
      Number.isFinite(Number(peopleCount)) && Number(peopleCount) > 0
        ? Number(peopleCount)
        : 1;

    return {
      WorkOrderHeader: {
        OrderType: String(orderType).trim(),
        Planplant: planPlantValue,
        MnWkCtr: "TEC_ELEV",
        Equipment: String(equipment || "").trim(),
        ShortText: String(headerShortText || "").trim(),
        StartDate: String(startDateStr).trim(),
        FinishDate: String(finishDateStr).trim(),
        NotifNo: notifOriginal,
      },
      WorkOrderOperationSet: opsValidas.map((op) => {
        const base = {
          Activity: String(op.Activity || "").padStart(4, "0"),
          WorkCntr: "TEC_ELEV",
          Plant: planPlantValue,
          Description: String(op.Description || "").trim(),
          DurationNormal: String(op.DurationNormal || "").trim(),
          NumberOfCapacities: String(numPeople),
        };
        if (op.IsExternal) base.ControlKey = "X";
        return base;
      }),
      WorkOrderComponentSet: componentItems,
      Return: [],
    };
  };

const handleIrAVistaPrevia = () => {
    if (!String(headerShortText || "").trim()) {
      Alert.alert("Descripción corta", "Captura la descripción corta de la orden.");
      return;
    }

    const opsValidas = operations.filter((op) => {
      const dur = Number(op.DurationNormal);
      return /^\d{4}$/.test(op.Activity) && !!op.Description && !!op.DurationNormal && dur > 0;
    });

    if (!opsValidas.length) {
      Alert.alert(
        "Operaciones",
        "Debes capturar al menos una operación válida (descripción + duración > 0)."
      );
      return;
    }

    // 🧠 VALIDACIÓN DINÁMICA: Solo exigimos datos si el componente tiene un material elegido
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const comps = op.Components || [];

      for (let j = 0; j < comps.length; j++) {
        const c = comps[j];
        
        const tieneMaterialBOM = c.NotFound && (c.MultiSelected || []).length > 0;
        const tieneMaterialConsumible = !c.NotFound && !!c.Material;

        // Si seleccionó material, entonces SÍ es obligatorio cantidad y almacén
        if (tieneMaterialBOM || tieneMaterialConsumible) {
          const qty = String(c.RequirementQuantity || "").trim();
          const stge = String(c.StgeLoc || "").trim();
          const nombreMat = tieneMaterialBOM 
            ? c.MultiSelected[0].Descripcion 
            : (c.Materials.find(m => m.Material === c.Material)?.Descripcion || c.Material);

          if (!qty || Number(qty) <= 0 || !stge) {
            Alert.alert(
              "Datos incompletos en Materiales",
              `La pieza "${nombreMat}" en la Operación ${i + 1} tiene el material seleccionado pero te falta capturar:\n` +
              (!qty || Number(qty) <= 0 ? "• La cantidad requerida\n" : "") +
              (!stge ? "• El almacén (ej. BHER)" : "")
            );
            return;
          }
        }
      }
    }

    const payload = construirPayloadOrden();
    if (!payload) return;
    setPayloadPreview(payload);
    setStep(3);
  };

  // FMS NUEVO - INICIO
  const verificarOrdenDelAviso = async (avisoId) => {
    const res = await api.get(
      `/api/odata/ZCS_GET_NOTIFICATION_SRV/NotificationHeaderSet('${encodeURIComponent(avisoId)}')`,
      { params: { $format: "json" }, timeout: 20000 },
    );
    const hdr = res?.data?.d ?? res?.data ?? null;
    return String(hdr?.Orderid ?? hdr?.OrderId ?? hdr?.Aufnr ?? "").trim() || null;
  };

  // Consulta a los 5, 15 y 30 s. Devuelve el número de orden o null.
  const esperarOrdenDelAviso = async (avisoId) => {
    if (!avisoId) return null;
    for (const espera of [5000, 15000, 30000]) {
      await new Promise((r) => setTimeout(r, espera));
      try {
        const orden = await verificarOrdenDelAviso(avisoId);
        if (orden) return orden;
      } catch {}
    }
    return null;
  };
  // FMS NUEVO - FIN

  // FMS NUEVO - INICIO
  // Guardar primero, enviar después: la creación queda en la cola y su estado se ve en la lista de avisos.
  const onConfirmarGuardado = async () => {
    if (!payloadPreview) return;
    const avisoId = String(notifNo || averiaid || "").trim();
    const r = await encolarCreacion({
      avisoId,
      payload: payloadPreview,
      resumen: { equipment, shortText },
    });
    if (!r.ok) {
      Alert.alert(
        "Este aviso ya tiene una creación",
        `Estado actual: ${r.item.estado}. Revisa la lista de avisos.`,
      );
      return;
    }
    procesarCreaciones(OPCIONES_CREACION); // sin await: no se espera a SAP
    Alert.alert(
      "Guardado",
      "La orden se está enviando a SAP. Verás su estado en la lista de avisos.",
      [{ text: "OK", onPress: () => router.replace("/supervisor/averia") }],
    );
  };
  // FMS NUEVO - FIN

  // Envío directo anterior (se conserva por si hay que volver a él)
  const onConfirmarGuardadoDirecto = async () => {
    if (!payloadPreview) return;

    console.log("🚀 [SAP PAYLOAD ENVIADO]:", JSON.stringify(payloadPreview, null, 2));

    try {
      setSaving(true);
      const url = "/api/odata/ZCS_CREATE_WORKORDER_SRV_02/WorkOrderSet";

      const res = await api.post(url, payloadPreview, {
        timeout: 120000, // FMS NUEVO: la creación puede tardar más que el timeout por defecto
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });

      const parsed = extractOrderFromReturn(res?.data);
      let orderId = parsed?.orderId || null;
      let avisoCreado = parsed?.notifNo || null;
      let ofertaNo = parsed?.offerNo || null;
      let ofertaMsg = parsed?.offerMessage || null;

      if (!orderId) {
        const fromHeader = extractFromSapMessageHeader(res?.headers);
        orderId = fromHeader.orderId || orderId;
        avisoCreado = fromHeader.notifNo || avisoCreado;
      }

      const errors = parsed?.errors || [];
      const avisoOriginal = String(notifNo || averiaid || "").trim();

      if (errors.length && !orderId) {
        const errText = errors
          .map((e) => `• ${e?.Message || "Error SAP"}`)
          .join("\n");
        Alert.alert("Error SAP", errText || "Error al crear la orden.");
        return;
      }

      const baseMsg = orderId
        ? `✅ Orden creada: ${orderId}
📌 Aviso original: ${avisoOriginal || "—"}
📩 Aviso SAP (retorno): ${avisoCreado || "—"}
💰 Oferta: ${ofertaNo ? ofertaNo : "—"}${ofertaMsg ? `\n🧾 ${ofertaMsg}` : ""}`
        : "✅ Orden creada exitosamente.";

      Alert.alert("Orden creada", baseMsg, [
        { text: "OK", onPress: () => router.replace("/supervisor/averia") },
      ]);
    } catch (err) {
      // FMS NUEVO - INICIO
      // Sin respuesta (timeout o red): SAP pudo haber creado la orden. NO se reenvía:
      // se consulta el aviso para saber si ya tiene orden.
      if (!err?.response) {
        const avisoId = String(notifNo || averiaid || "").trim();
        const ordenCreada = await esperarOrdenDelAviso(avisoId);
        if (ordenCreada) {
          Alert.alert(
            "Orden creada",
            `✅ SAP sí creó la orden: ${ordenCreada}\n(la respuesta se perdió por la conexión)`,
            [{ text: "OK", onPress: () => router.replace("/supervisor/averia") }],
          );
          return;
        }
        Alert.alert(
          "Sin confirmación",
          "No se pudo confirmar si SAP creó la orden. NO la vuelvas a crear todavía: revisa el aviso en unos minutos.",
        );
        return;
      }
      // FMS NUEVO - FIN
      const sapMsg =
        err?.response?.data?.error?.message?.value ||
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.message ||
        "No se pudo crear la orden.";

      Alert.alert("Error", String(sapMsg));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <Header title="Crear orden de mantenimiento" />

      <ScrollView
      ref={scrollViewRef} 
      contentContainerStyle={styles.scrollContent}>
        <TouchableOpacity
          style={styles.backRow}
          onPress={goBack}
          activeOpacity={0.6}
        >
          <Ionicons name="chevron-back" size={20} color={COLORS.accent} />
          <Text style={styles.backText}>
            {step === 3 ? "Volver a operaciones" : step === 2 ? "Volver a datos generales" : "Volver al aviso"}
          </Text>
        </TouchableOpacity>

        {/* 🗺️ BARRA DE PROGRESO POR ETAPAS */}
        <View style={styles.wizardIndicatorRow}>
          <View style={[styles.wizardStepBadge, step === 1 && styles.wizardStepActive]}>
            <Text style={[styles.wizardStepText, step === 1 && styles.wizardTextActive]}>1. General</Text>
          </View>
          <View style={[styles.wizardStepBadge, step === 2 && styles.wizardStepActive]}>
            <Text style={[styles.wizardStepText, step === 2 && styles.wizardTextActive]}>2. Operaciones</Text>
          </View>
          <View style={[styles.wizardStepBadge, step === 3 && styles.wizardStepActive]}>
            <Text style={[styles.wizardStepText, step === 3 && styles.wizardTextActive]}>3. Resumen</Text>
          </View>
        </View>

        {/* ======================================================== */}
        {/* ETAPA 1: INFORMACIÓN GENERAL Y TÉCNICO */}
        {/* ======================================================== */}
        {step === 1 && (
          <>
            <View style={styles.cardHighlight}>
              <View style={styles.chipRow}>
                <View style={styles.chip}>
                  <Ionicons name="alert-circle-outline" size={14} color={COLORS.accent} style={{ marginRight: 4 }} />
                  <Text style={styles.chipText}>Aviso {notifNo || averiaid}</Text>
                </View>

                {equipment ? (
                  <View style={styles.chip}>
                    <Ionicons name="hardware-chip-outline" size={14} color={COLORS.accent} style={{ marginRight: 4 }} />
                    <Text style={styles.chipText}>{equipment}</Text>
                  </View>
                ) : null}
              </View>

              {shortText ? (
                <Text style={styles.mainTitle}>{shortText}</Text>
              ) : (
                <Text style={styles.mainTitleMuted}>Sin descripción corta en el aviso</Text>
              )}

              <View style={styles.block}>
                <Text style={styles.infoLabel}>Ubicación funcional</Text>
                <Text style={styles.infoValue}>{MaterialLong || "—"}</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Datos de la orden</Text>

              <View style={styles.chipRow}>
                <View style={styles.chipSmall}>
                  <Text style={styles.chipTextSmall}>OrderType: {orderType}</Text>
                </View>
                <View style={styles.chipSmall}>
                  <Text style={styles.chipTextSmall}>Planplant: {planPlant}</Text>
                </View>
              </View>

              <View style={{ marginTop: 12, marginBottom: 14 }}>
                <Text style={styles.fieldLabel}>Descripción corta de la orden</Text>
                <TextInput
                  style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]}
                  value={headerShortText}
                  onChangeText={setHeaderShortText}
                  placeholder="Escribe aquí la descripción corta (Supervisor)..."
                  placeholderTextColor={COLORS.muted}
                  multiline
                />
              </View>

              <View style={styles.dateRow}>
                <View style={styles.dateCol}>
                  <Text style={styles.fieldLabel}>Fecha inicio</Text>
                  <TouchableOpacity
                    style={[styles.input, styles.multiInput]}
                    onPress={() => openDateTimePicker("start")}
                    activeOpacity={0.75}
                  >
                    <Text style={{ fontSize: 13, color: COLORS.title }} numberOfLines={1}>
                      {startDateStr}
                    </Text>
                    <Ionicons name="calendar-outline" size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                </View>

                <View style={styles.dateCol}>
                  <Text style={styles.fieldLabel}>Fecha fin</Text>
                  <TouchableOpacity
                    style={[styles.input, styles.multiInput]}
                    onPress={() => openDateTimePicker("finish")}
                    activeOpacity={0.75}
                  >
                    <Text style={{ fontSize: 13, color: COLORS.title }} numberOfLines={1}>
                      {finishDateStr}
                    </Text>
                    <Ionicons name="calendar-outline" size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Asignación</Text>
              <SelectNumber
                label="Seleccione el número de personas que se asignarán"
                value={peopleCount}
                min={1}
                max={20}
                onSelect={setPeopleCount}
              />
            </View>

            <Pressable
              style={styles.btnPrimary}
              onPress={() => {
                if (!headerShortText.trim()) {
                  return Alert.alert("Faltan datos", "Captura la descripción corta de la orden.");
                }
                setStep(2);
              }}
            >
              <View style={styles.btnPrimaryContent}>
                <Text style={styles.btnPrimaryText}>Siguiente: Operaciones y Materiales</Text>
                <Ionicons name="chevron-forward" size={18} color="#fff" style={{ marginLeft: 6 }} />
              </View>
            </Pressable>
          </>
        )}

        {/* ======================================================== */}
        {/* ETAPA 2: OPERACIONES Y TAREAS GUIADAS CON MEMORIA INTELIGENTE */}
        {/* ======================================================== */}
        {step === 2 && (
          <>
            <View style={styles.cardAsistencia}>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
                <Ionicons name="sparkles" size={18} color={COLORS.accent} style={{ marginRight: 6 }} />
                <Text style={styles.asistenciaTitle}>Asistente Inteligente de Mantenimiento</Text>
              </View>
              <Text style={styles.asistenciaText}>
                La app te guiará paso a paso: primero define la tarea, luego cubre las refacciones reportadas y finalmente añade consumibles opcionales.
              </Text>
            </View>

            {(() => {
              const opActual = operations[0] || {};
              const pendientes = obtenerPiezasPendientesDeSugerir(opActual.Components || [], piezasAviso);

              if (piezasAviso.length > 0) {
                return (
                  <View style={[styles.sugerenciaCard, pendientes.length === 0 && { backgroundColor: "#F0FDF4", borderColor: "#BBF7D0" }]}>
                    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
                      <Ionicons 
                        name={pendientes.length > 0 ? "alert-circle" : "checkmark-circle"} 
                        size={16} 
                        color={pendientes.length > 0 ? "#D97706" : "#166534"} 
                        style={{ marginRight: 6 }} 
                      />
                      <Text style={[styles.sugerenciaTitle, pendientes.length === 0 && { color: "#166534" }]}>
                        {pendientes.length > 0 
                          ? `⚠️ Faltan ${pendientes.length} refacción(es) por agregar de las reportadas:` 
                          : "✅ ¡Todas las piezas reportadas ya fueron agregadas a la orden!"}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                      {piezasAviso.map((p, idx) => {
                        const estaPendiente = pendientes.includes(p);
                        return (
                          <View 
                            key={idx} 
                            style={[
                              styles.badgePiezaReportada, 
                              !estaPendiente && { backgroundColor: "#DCFCE7", borderColor: "#BBF7D0" }
                            ]}
                          >
                            <Text style={[styles.badgePiezaText, !estaPendiente && { color: "#166534" }]}>
                              {estaPendiente ? "⏳ Pendiente: " : "✔ Agregada: "} {p}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                );
              }
              return null;
            })()}

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Definición de Tareas y Materiales</Text>
              <Text style={styles.sectionSubtitle}>
                Paso 2 de 3: Estructura la operación paso a paso.
              </Text>

             {operations.map((op, opIndex) => {
                const faltaDesc = !op.Description.trim();
                const faltaDuracion = !op.DurationNormal;
                
                // 🧠 Validaciones de avance progresivo por pasos en cascada
                const paso1Completo = !faltaDesc; // Ya escribió la descripción
                const paso2Completo = paso1Completo; // Ya seleccionó si es interno o externo (por defecto toma un estado)
                const paso3Completo = paso2Completo && !faltaDuracion; // Ya indicó las horas de duración

                const piezasPendientesOp = obtenerPiezasPendientesDeSugerir(op.Components || [], piezasAviso);
                const refaccionesBOMAgregadas = (op.Components || []).filter(c => c.NotFound);
                const todasLasPiezasCubiertas = piezasAviso.length === 0 || piezasPendientesOp.length === 0;

                const estaExpandida = opIndex === expandedOpIndex;
                const tareaLista = !faltaDuracion && !faltaDesc;

                return (
                  <View key={`${opIndex}-${op.Activity}`} style={styles.opCard}>
                    
                    {/* 🔄 ENCABEZADO TIPO ACORDEÓN INTELIGENTE */}
                    <TouchableOpacity 
                      style={styles.opHeaderMain}
                      onPress={() => setExpandedOpIndex(estaExpandida ? -1 : opIndex)}
                      activeOpacity={0.8}
                    >
                      <View style={styles.opBadgeActivity}>
                        <Text style={styles.opBadgeText}>Actividad {op.Activity}</Text>
                      </View>
                      
                      <View style={{ flex: 1, marginLeft: 6 }}>
                        <Text style={styles.opTitleHeader}>
                          Operación {opIndex + 1} {op.Description ? `— "${op.Description.substring(0, 22)}..."` : ""}
                        </Text>
                        {!estaExpandida && (
                          <Text style={{ fontSize: 10, color: tareaLista && todasLasPiezasCubiertas ? "#166534" : "#D97706", fontWeight: "700" }}>
                            {tareaLista && todasLasPiezasCubiertas ? "✔ Tarea configurada correctamente" : "⚠️ Configuración pendiente de completar"}
                          </Text>
                        )}
                      </View>

                      {operations.length > 1 && (
                        <TouchableOpacity
                          onPress={(e) => {
                            e.stopPropagation?.();
                            removeOperation(opIndex);
                          }}
                          style={styles.opDeleteBtn}
                          hitSlop={8}
                        >
                          <Ionicons name="trash-outline" size={16} color={COLORS.danger} />
                        </TouchableOpacity>
                      )}

                      <Ionicons 
                        name={estaExpandida ? "chevron-up" : "chevron-down"} 
                        size={18} 
                        color={COLORS.muted} 
                        style={{ marginLeft: 6 }} 
                      />
                    </TouchableOpacity>

                    {/* 📂 CONTENIDO DE ASISTENTE PASO A PASO EN CASCADA */}
                    {estaExpandida && (
                      <>
                        {/* ======================================================== */}
                        {/* PASO 1: DESCRIPCIÓN DEL TRABAJO */}
                        {/* ======================================================== */}
                        <View style={styles.pasoPreguntaContainer}>
                          <View style={styles.pasoHeaderRow}>
                            <View style={styles.numeroPasoBadge}><Text style={styles.numeroPasoText}>1</Text></View>
                            <Text style={styles.fieldLabelQuestion}>¿Qué trabajo específico se va a realizar?*</Text>
                          </View>

                          <TextInput
                            style={[
                              styles.input,
                              { minHeight: 60, textAlignVertical: "top" },
                              faltaDesc && { borderColor: "#93C5FD", backgroundColor: "#F8FAFC" }
                            ]}
                            value={op.Description}
                            onChangeText={(txt) => updateOperation(opIndex, "Description", txt)}
                            placeholder="Ej. Desmontaje de válvula de control..."
                            placeholderTextColor={COLORS.muted}
                            multiline
                          />
                          {faltaDesc && <Text style={styles.inputHelperText}>👉 Escribe la descripción para desbloquear los siguientes pasos.</Text>}
                        </View>

                        {/* ======================================================== */}
                        {/* PASO 2: TIPO DE EJECUCIÓN (Se activa al llenar Paso 1) */}
                        {/* ======================================================== */}
                        {paso1Completo && (
                          <View style={styles.pasoPreguntaContainer}>
                            <View style={styles.pasoHeaderRow}>
                              <View style={styles.numeroPasoBadge}><Text style={styles.numeroPasoText}>2</Text></View>
                              <Text style={styles.fieldLabelQuestion}>¿Cómo se ejecutará esta tarea?</Text>
                            </View>

                            <View style={styles.toggleRow}>
                              <TouchableOpacity
                                style={[styles.toggleChipSmall, !op.IsExternal && styles.toggleChipActive]}
                                onPress={() => updateOperation(opIndex, "IsExternal", false)}
                              >
                                <Text style={[styles.toggleTextSmall, !op.IsExternal && styles.toggleTextActive]}>🔧 Personal Interno</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.toggleChipSmall, op.IsExternal && styles.toggleChipActive]}
                                onPress={() => updateOperation(opIndex, "IsExternal", true)}
                              >
                                <Text style={[styles.toggleTextSmall, op.IsExternal && styles.toggleTextActive]}>🏢 Proveedor / Externo</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        )}

                        {/* ======================================================== */}
                        {/* PASO 3: DURACIÓN EN HORAS (Se activa al completar Paso 2) */}
                        {/* ======================================================== */}
                        {paso2Completo && (
                          <View style={styles.pasoPreguntaContainer}>
                            <View style={styles.pasoHeaderRow}>
                              <View style={styles.numeroPasoBadge}><Text style={styles.numeroPasoText}>3</Text></View>
                              <Text style={styles.fieldLabelQuestion}>¿Cuánto tiempo (duración en horas) tomará esta tarea?*</Text>
                            </View>

                            <View style={{ width: 140 }}>
                              <Field
                            label=""
                            value={op.DurationNormal}
                            onChangeText={(txt) => {
                              const valorLimpio = String(txt || "").replace(/[^0-9.]/g, "");
                              updateOperation(opIndex, "DurationNormal", valorLimpio);
                              
                              // 🚀 Si acaba de poner un valor válido, hacemos scroll automático hacia abajo
                              if (valorLimpio.length > 0) {
                                scrollToBottom();
                              }
                            }}
                            placeholder="Ej. 3"
                            keyboardType="numeric"
                          />
                            </View>
                            {faltaDuracion && <Text style={styles.inputHelperText}>👉 Indica las horas para habilitar las refacciones de la BOM.</Text>}
                          </View>
                        )}

                        {/* ======================================================== */}
                        {/* PASO 4: REFACCIONES DE LA BOM (LIBRE Y MÚLTIPLE) */}
                        {/* ======================================================== */}
                        {paso3Completo && (
                          <View style={styles.pasoPreguntaContainer}>
                            <View style={styles.pasoHeaderRow}>
                              <View style={[styles.numeroPasoBadge, { backgroundColor: "#166534" }]}><Text style={styles.numeroPasoText}>4</Text></View>
                              <Text style={styles.fieldLabelQuestion}>Refacciones de la BOM del equipo</Text>
                            </View>
                            <Text style={styles.subSectionHint}>
                              {piezasAviso.length > 0 
                                ? `El técnico reportó: ${piezasAviso.join(", ")}. Puedes agregar estas u otras refacciones adicionales detectadas.`
                                : "Selecciona las partes específicas del equipo requeridas."}
                            </Text>

                            {/* 💡 Atajo inteligente si hay piezas reportadas pendientes */}
                            {refaccionesBOMAgregadas.length === 0 && piezasAviso.length > 0 && (
                              <TouchableOpacity 
                                style={styles.btnAsistenteDestacado} 
                                onPress={async () => {
                                  setOperations((prev) => {
                                    const next = prev.map((o, i) => {
                                      if (i !== opIndex) return o;
                                      const newComp = emptyComponent(normItemNumberByIndex((o.Components || []).length), planPlant, o.Activity);
                                      newComp.NotFound = true;
                                      return { ...o, Components: [...(o.Components || []), newComp] };
                                    });
                                    return normalizeOpsAndComponents(next, planPlant);
                                  });
                                  await openMultiSelect(opIndex, operations[opIndex].Components.length, true);
                                }}
                              >
                                <Ionicons name="sparkles" size={16} color="#166534" style={{ marginRight: 6 }} />
                                <Text style={styles.btnAsistenteText}>Asociar pieza reportada por el técnico ("{piezasAviso[0]}")</Text>
                              </TouchableOpacity>
                            )}

                            {/* Listado de refacciones BOM que ya se fueron agregando */}
                            {refaccionesBOMAgregadas.map((c) => {
                              const compIndex = op.Components.findIndex(item => item === c);
                              const notFoundSelected = (c.MultiSelected || [])[0] || null;
                              const materialSeleccionado = !!(c.MultiSelected || [])[0]?.Material; 
                              const incompletoBOM = materialSeleccionado && (!c.RequirementQuantity || !c.StgeLoc);

                              return (
                                <View 
                                  key={`bom-${compIndex}`} 
                                  style={[
                                    styles.materialCard, 
                                    { backgroundColor: "#FAFBFF", marginBottom: 8 },
                                    incompletoBOM && { borderColor: "#F87171", borderWidth: 1.5 }
                                  ]}
                                >
                                  <View style={styles.materialCardHeader}>
                                    <Text style={styles.materialCardTitle}>Refacción BOM · Item {c.ItemNumber}</Text>
                                    <TouchableOpacity
                                      onPress={() => removeComponentFromOp(opIndex, compIndex)}
                                      style={styles.opDeleteBtn}
                                    >
                                      <Ionicons name="trash-outline" size={14} color={COLORS.danger} />
                                    </TouchableOpacity>
                                  </View>

                                  <TouchableOpacity
                                    style={styles.btnBomSelect}
                                    onPress={() => openMultiSelect(opIndex, compIndex, true)}
                                    activeOpacity={0.85}
                                  >
                                    <Ionicons name="search-outline" size={16} color={COLORS.accent} />
                                    <Text style={styles.btnBomSelectText}>
                                      {notFoundSelected ? "Cambiar refacción BOM" : "🔍 Buscar refacción en BOM"}
                                    </Text>
                                  </TouchableOpacity>

                                  {!!notFoundSelected && (
                                    <View style={styles.selectedBimBox}>
                                      <Text style={{ fontSize: 11, color: COLORS.muted, marginBottom: 2 }}>Seleccionado:</Text>
                                      <Text style={{ fontSize: 13, color: COLORS.title, fontWeight: "800" }}>
                                        {notFoundSelected.Descripcion || "—"}
                                      </Text>
                                      <Text style={{ fontSize: 11, color: COLORS.text }}>
                                        Código: {notFoundSelected.Material || "—"}
                                      </Text>
                                    </View>
                                  )}

                                  <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                                    <View style={{ flex: 1 }}>
                                      <Field
                                        label="Cantidad"
                                        value={c.RequirementQuantity}
                                        onChangeText={(txt) =>
                                          updateComponent(
                                            opIndex,
                                            compIndex,
                                            "RequirementQuantity",
                                            String(txt || "").replace(/[^0-9.]/g, ""),
                                          )
                                        }
                                        placeholder="Ej. 1"
                                        keyboardType="numeric"
                                      />
                                    </View>
                                    <View style={{ width: 100 }}>
                                      <Field
                                        label="Almacén"
                                        value={c.StgeLoc}
                                        onChangeText={(txt) => updateComponent(opIndex, compIndex, "StgeLoc", txt)}
                                        placeholder="BHER"
                                      />
                                    </View>
                                  </View>

                                  {incompletoBOM && (
                                    <Text style={{ fontSize: 10, color: "#DC2626", marginTop: 4, fontWeight: "700" }}>
                                      ⚠️ Falta capturar cantidad y/o almacén para esta pieza.
                                    </Text>
                                  )}
                                </View>
                              );
                            })}

                            {/* 🚀 BOTÓN LIBRE: Permite agregar cualquier otra refacción de la BOM sin restricciones */}
                            <TouchableOpacity 
                              style={styles.btnAddConsumibleBtn} 
                              onPress={async () => {
                                setOperations((prev) => {
                                  const next = prev.map((o, i) => {
                                    if (i !== opIndex) return o;
                                    const newComp = emptyComponent(normItemNumberByIndex((o.Components || []).length), planPlant, o.Activity);
                                    newComp.NotFound = true; // Sigue siendo de la BOM
                                    return { ...o, Components: [...(o.Components || []), newComp] };
                                  });
                                  return normalizeOpsAndComponents(next, planPlant);
                                });
                                await openMultiSelect(opIndex, operations[opIndex].Components.length, true);
                              }}
                            >
                              <Ionicons name="add-circle-outline" size={16} color="#166534" />
                              <Text style={[styles.btnAddMaterialText, { color: "#166534" }]}>
                                + Agregar otra refacción adicional de la BOM
                              </Text>
                            </TouchableOpacity>
                          </View>
                        )}

                        {/* ======================================================== */}
                        {/* PASO 5: CONSUMIBLES DE ALMACÉN (DINÁMICO Y OCULTO HASTA DECIDIR) */}
                        {/* ======================================================== */}
                        {paso3Completo && (
                          <View style={styles.pasoPreguntaContainer}>
                            <View style={styles.pasoHeaderRow}>
                              <View style={[styles.numeroPasoBadge, { backgroundColor: "#64748B" }]}><Text style={styles.numeroPasoText}>5</Text></View>
                              <Text style={styles.fieldLabelQuestion}>¿Requiere consumibles de almacén para esta tarea?</Text>
                            </View>

                            {(() => {
                              // Filtramos únicamente los consumibles (los que NO son NotFound/BOM)
                              const consumiblesOp = (op.Components || []).filter(c => !c.NotFound);

                              // SI NO HAY CONSUMIBLES ACTIVOS: Mostramos únicamente el botón de decisión
                              if (consumiblesOp.length === 0) {
                                return (
                                  <TouchableOpacity 
                                    style={styles.btnAddConsumibleBtn} 
                                    onPress={() => {
                                      setOperations((prev) => {
                                        const next = prev.map((o, i) => {
                                          if (i !== opIndex) return o;
                                          const newComp = emptyComponent(normItemNumberByIndex((o.Components || []).length), planPlant, o.Activity);
                                          newComp.NotFound = false; // Marcado como consumible
                                          return { ...o, Components: [...(o.Components || []), newComp] };
                                        });
                                        return normalizeOpsAndComponents(next, planPlant);
                                      });
                                    }}
                                  >
                                    <Ionicons name="add-circle-outline" size={16} color={COLORS.accent} />
                                    <Text style={styles.btnAddMaterialText}>+ Sí, requiero un consumible de almacén</Text>
                                  </TouchableOpacity>
                                );
                              }

                              // SI YA DECIDIÓ AGREGAR: Mostramos las tarjetas de consumibles y el botón para agregar más
                              return (
                                <>
                                  {consumiblesOp.map((c) => {
                                    const compIndex = op.Components.findIndex(item => item === c);
                                    const materialConsumibleSeleccionado = !!c.Material; 
                                    const incompletoConsumible = materialConsumibleSeleccionado && (!c.RequirementQuantity || !c.StgeLoc);
                                    return (
                                      <View 
                                        key={`cons-${compIndex}`} 
                                        style={[
                                          styles.materialCard, 
                                          { marginBottom: 8, marginTop: 6 },
                                          incompletoConsumible && { borderColor: "#F87171", borderWidth: 1.5 }
                                        ]}
                                      >
                                        <View style={styles.materialCardHeader}>
                                          <Text style={styles.materialCardTitle}>Consumible · Item {c.ItemNumber}</Text>
                                          <TouchableOpacity
                                            onPress={() => removeComponentFromOp(opIndex, compIndex)}
                                            style={styles.opDeleteBtn}
                                          >
                                            <Ionicons name="trash-outline" size={14} color={COLORS.danger} />
                                          </TouchableOpacity>
                                        </View>

                                        <Text style={styles.fieldLabel}>Categoría</Text>
                                        <View style={styles.categoryRow}>
                                          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                            <View style={styles.categoryChipsWrapper}>
                                              {MATERIAL_CATEGORIES.map((cat) => {
                                                const active = c.Category === cat;
                                                return (
                                                  <TouchableOpacity
                                                    key={cat}
                                                    style={[styles.categoryChip, active && styles.categoryChipActive]}
                                                    onPress={() => handleCategoryChangeForComponent(opIndex, compIndex, cat)}
                                                    activeOpacity={0.8}
                                                  >
                                                    <Text style={[styles.categoryChipText, active && styles.categoryChipTextActive]}>
                                                      {cat}
                                                    </Text>
                                                  </TouchableOpacity>
                                                );
                                              })}
                                            </View>
                                          </ScrollView>
                                        </View>

                                        {c.LoadingMaterials && (
                                          <View style={{ paddingVertical: 4 }}>
                                            <ActivityIndicator color={COLORS.accent} />
                                          </View>
                                        )}

                                        <View style={{ marginBottom: 10, marginTop: 6 }}>
                                          <Text style={styles.fieldLabel}>Material</Text>
                                          <SelectMaterial
                                            items={c.Materials || []}
                                            value={c.Material}
                                            onSelect={(materialCode) =>
                                              updateComponent(opIndex, compIndex, "Material", materialCode)
                                            }
                                            disabled={!c.Category || c.LoadingMaterials}
                                          />
                                        </View>

                                        <View style={{ flexDirection: "row", gap: 10 }}>
                                          <View style={{ flex: 1 }}>
                                            <Field
                                              label="Cantidad"
                                              value={c.RequirementQuantity}
                                              onChangeText={(txt) =>
                                                updateComponent(
                                                  opIndex,
                                                  compIndex,
                                                  "RequirementQuantity",
                                                  String(txt || "").replace(/[^0-9.]/g, ""),
                                                )
                                              }
                                              placeholder="Ej. 2"
                                              keyboardType="numeric"
                                            />
                                          </View>
                                          <View style={{ width: 100 }}>
                                            <Field
                                              label="Almacén"
                                              value={c.StgeLoc}
                                              onChangeText={(txt) => updateComponent(opIndex, compIndex, "StgeLoc", txt)}
                                              placeholder="BHER"
                                            />
                                          </View>
                                        </View>

                                        {incompletoConsumible && (
                                          <Text style={{ fontSize: 10, color: "#DC2626", marginTop: 4, fontWeight: "700" }}>
                                            ⚠️ Selecciona material, cantidad y almacén.
                                          </Text>
                                        )}
                                      </View>
                                    );
                                  })}

                                  <TouchableOpacity 
                                    style={styles.btnAddConsumibleBtn} 
                                    onPress={() => {
                                      setOperations((prev) => {
                                        const next = prev.map((o, i) => {
                                          if (i !== opIndex) return o;
                                          const newComp = emptyComponent(normItemNumberByIndex((o.Components || []).length), planPlant, o.Activity);
                                          newComp.NotFound = false;
                                          return { ...o, Components: [...(o.Components || []), newComp] };
                                        });
                                        return normalizeOpsAndComponents(next, planPlant);
                                      });
                                    }}
                                  >
                                    <Ionicons name="add-circle-outline" size={16} color={COLORS.accent} />
                                    <Text style={styles.btnAddMaterialText}>+ ¿Requiere otro consumible adicional?</Text>
                                  </TouchableOpacity>
                                </>
                              );
                            })()}
                          </View>
                        )}

                      </>
                    )}

                  </View>
                );
              })}


              <TouchableOpacity style={styles.btnAddOperationBtn} onPress={addOperation}>
                <Ionicons name="add-circle" size={18} color="#fff" />
                <Text style={styles.btnAddOperationText}>+ ¿Requiere otra tarea u operación?</Text>
              </TouchableOpacity>
            </View>

            <Pressable
              style={styles.btnPrimary}
              onPress={() => {
                const hayIncompletas = operations.some(op => !op.Description.trim() || !op.DurationNormal);
                if (hayIncompletas) {
                  return Alert.alert(
                    "Faltan detalles de la tarea", 
                    "Por favor asegúrate de indicar la descripción y la duración en horas de cada operación antes de continuar."
                  );
                }
                handleIrAVistaPrevia();
              }}
            >
              <View style={styles.btnPrimaryContent}>
                <Text style={styles.btnPrimaryText}>Revisar Resumen y Vista Previa</Text>
                <Ionicons name="eye-outline" size={18} color="#fff" style={{ marginLeft: 6 }} />
              </View>
            </Pressable>
          </>
        )}



        {/* ======================================================== */}
        {/* ETAPA 3: RESUMEN Y VISTA PREVIA ANTES DE GUARDAR */}
        {/* ======================================================== */}
        {step === 3 && payloadPreview && (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>3. Resumen y Confirmación</Text>
              <Text style={styles.sectionSubtitle}>
                Verifica la estructura de tareas y materiales antes de transmitir la orden a SAP.
              </Text>

              <Text style={styles.previewSectionTitle}>Cabecera de la Orden</Text>
              <View style={styles.previewBox}>
                <Text style={styles.previewText}>Tipo: <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.OrderType}</Text></Text>
                <Text style={styles.previewText}>Centro (Planplant): <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.Planplant}</Text></Text>
                <Text style={styles.previewText}>Técnico (MnWkCtr): <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.MnWkCtr}</Text></Text>
                <Text style={styles.previewText}>Equipo: <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.Equipment || "—"}</Text></Text>
                <Text style={styles.previewText}>Texto Breve: <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.ShortText}</Text></Text>
                <Text style={styles.previewText}>Inicio: <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.StartDate}</Text></Text>
                <Text style={styles.previewText}>Fin: <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.FinishDate}</Text></Text>
                <Text style={styles.previewText}>Aviso Referencia: <Text style={styles.previewValue}>{payloadPreview.WorkOrderHeader.NotifNo}</Text></Text>
              </View>

              <Text style={styles.previewSectionTitle}>Operaciones y Materiales Asignados</Text>
              
              {/* 🧠 AGRUPACIÓN VISUAL: Recorremos cada operación y le asociamos sus componentes */}
              {payloadPreview.WorkOrderOperationSet.map((op, i) => {
                // Filtramos los componentes que pertenecen exactamente a esta actividad
                const componentesDeEstaOperacion = payloadPreview.WorkOrderComponentSet.filter(
                  (comp) => String(comp.Activity) === String(op.Activity)
                );

                return (
                  <View key={`res-op-${i}`} style={styles.previewOpGroupCard}>
                    {/* Encabezado de la Tarea / Operación */}
                    <View style={styles.previewOpHeaderRow}>
                      <View style={styles.previewOpBadge}>
                        <Text style={styles.previewOpBadgeText}>Actividad {op.Activity}</Text>
                      </View>
                      <Text style={styles.previewOpTitle}>Operación {i + 1}</Text>
                    </View>

                    <Text style={styles.previewText}>Descripción: <Text style={styles.previewValue}>{op.Description}</Text></Text>
                    <Text style={styles.previewText}>Duración: <Text style={styles.previewValue}>{op.DurationNormal} hrs</Text></Text>
                    <Text style={styles.previewText}>Capacidad personas: <Text style={styles.previewValue}>{op.NumberOfCapacities}</Text></Text>

                    <View style={styles.operationDivider} />

                    {/* Subsección de Materiales de esta Operación específica */}
                    <Text style={styles.previewSubSectionTitle}>
                      Materiales / Refacciones ({componentesDeEstaOperacion.length})
                    </Text>

                    {componentesDeEstaOperacion.length === 0 ? (
                      <Text style={{ fontSize: 11, color: COLORS.muted, fontStyle: "italic", marginBottom: 4 }}>
                        Sin materiales asignados a esta operación.
                      </Text>
                    ) : (
                      // Buscamos el componente real en el state 'operations' para pintar su DescripcionVisual
                      operations.find(o => String(o.Activity) === String(op.Activity))?.Components?.map((comp, j) => (
                        <View key={`res-comp-${j}`} style={styles.previewComponentBox}>
                          <Text style={styles.previewText}>Item: <Text style={styles.previewValue}>{comp.ItemNumber}</Text></Text>
                          <Text style={styles.previewText}>Material: <Text style={styles.previewValue}>{comp.DescripcionVisual || (comp.MultiSelected || [])[0]?.Descripcion || comp.Material}</Text></Text>
                          <Text style={styles.previewText}>Código ID: <Text style={styles.previewValue}>{comp.Material || (comp.MultiSelected || [])[0]?.Material}</Text></Text>
                          <Text style={styles.previewText}>Cantidad: <Text style={styles.previewValue}>{comp.RequirementQuantity || "—"}</Text></Text>
                          <Text style={styles.previewText}>Almacén: <Text style={styles.previewValue}>{comp.StgeLoc || "—"}</Text></Text>
                        </View>
                      ))
                    )}
                  </View>
                );
              })}
            </View>

            {/* 🔄 BOTONES DE ACCIÓN EN RESUMEN: EDITAR O GUARDAR */}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
              <TouchableOpacity
                style={[styles.btnSecondary, { flex: 1, paddingVertical: 12, justifyContent: "center", backgroundColor: "#F1F5F9", borderRadius: 12, borderWidth: 1, borderColor: COLORS.border }]}
                onPress={() => setStep(2)}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <Ionicons name="arrow-back-outline" size={16} color={COLORS.accent} />
                  <Text style={[styles.btnSecondaryText, { marginTop: 0 }]}>Editar operaciones</Text>
                </View>
              </TouchableOpacity>

              <Pressable
                style={({ pressed }) => [
                  styles.btnPrimary,
                  { flex: 1, backgroundColor: "#166534", marginTop: 0 },
                  pressed && styles.btnPrimaryPressed,
                  saving && styles.btnPrimaryDisabled,
                ]}
                onPress={onConfirmarGuardado}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <View style={styles.btnPrimaryContent}>
                    <Ionicons name="save-outline" size={18} color="#fff" style={{ marginRight: 6 }} />
                    <Text style={styles.btnPrimaryText}>Guardar en SAP</Text>
                  </View>
                )}
              </Pressable>
            </View>
          </>
        )}



        <View style={{ height: 30 }} />
      </ScrollView>

      {/* ===== Modal MultiSelect (NotFound) ===== */}
      <Modal
        visible={multiVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMultiVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Seleccionar material BOM</Text>
              <TouchableOpacity
                onPress={() => setMultiVisible(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={{ padding: 12, paddingBottom: 6 }}>
              <View
                style={[
                  styles.input,
                  { flexDirection: "row", alignItems: "center", gap: 8 },
                ]}
              >
                <Ionicons name="search" size={16} color={COLORS.muted} />
                <TextInput
                  style={{ flex: 1, fontSize: 13, color: COLORS.title }}
                  value={multiQuery}
                  onChangeText={setMultiQuery}
                  placeholder="Buscar..."
                  placeholderTextColor={COLORS.muted}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {!!multiQuery && (
                  <TouchableOpacity
                    onPress={() => setMultiQuery("")}
                    hitSlop={8}
                  >
                    <Ionicons
                      name="close-circle"
                      size={18}
                      color={COLORS.muted}
                    />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <ScrollView
        style={{ maxHeight: 320 }}
        contentContainerStyle={{ paddingVertical: 8 }}
      >
        {(() => {
          const op = operations[multiOpIndex] || {};
          const c = (op.Components || [])[multiCompIndex] || {};
          const q = String(multiQuery || "")
            .trim()
            .toLowerCase();

          if (!c.NotFound) {
            return (
              <View
                style={{ paddingHorizontal: 14, paddingVertical: 10 }}
              >
                <Text style={{ color: COLORS.muted, fontSize: 12 }}>
                  Este selector es solo para “Material no encontrado (BOM)”.
                </Text>
              </View>
            );
          }

          const cats = c.NotFoundCategories || [];
          const zeinr = String(c.NotFoundCategory || "").trim();

          // Paso 1: elegir categoría
          if (!zeinr) {
            if (c.LoadingNotFoundCategories) {
              return (
                <View style={{ paddingVertical: 16 }}>
                  <ActivityIndicator color={COLORS.accent} />
                </View>
              );
            }

            const filteredCats = !q
              ? cats
              : cats.filter((x) =>
                  `${x.Texto || ""} ${x.Zeinr || ""}`
                    .toLowerCase()
                    .includes(q),
                );

            if (!filteredCats.length) {
              return (
                <View
                  style={{ paddingHorizontal: 14, paddingVertical: 10 }}
                >
                  <Text style={{ color: COLORS.muted, fontSize: 12 }}>
                    No hay categorías (o no hay resultados con esa búsqueda).
                  </Text>
                </View>
              );
            }

            return filteredCats.map((cat, idx) => {
              const key = `${cat.Zeinr}-${idx}`;
              return (
                <TouchableOpacity
                  key={key}
                  style={styles.workerRow}
                  onPress={() =>
                    loadNotFoundMaterialsByCategory(
                      multiOpIndex,
                      multiCompIndex,
                      cat.Zeinr,
                    )
                  }
                  activeOpacity={0.7}
                >
                  <View style={[styles.checkbox, { opacity: 0.6 }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.workerName}>
                      {cat.Texto || cat.Zeinr}
                    </Text>
                    <Text style={styles.materialCodeText}>
                      {cat.Zeinr}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={COLORS.muted}
                  />
                </TouchableOpacity>
              );
            });
          }

          // Paso 2: elegir materiales BOM con inteligencia de pendientes y exclusión
          const list = c.NotFoundMaterials || [];

          if (c.LoadingNotFoundMaterials) {
            return (
              <View style={{ paddingVertical: 16 }}>
                <ActivityIndicator color={COLORS.accent} />
              </View>
            );
          }

          if (!list.length) {
            return (
              <View
                style={{ paddingHorizontal: 14, paddingVertical: 10 }}
              >
                <Text style={{ color: COLORS.muted, fontSize: 12 }}>
                  No hay materiales BOM para: {zeinr}
                </Text>
              </View>
            );
          }

          const piezasPendientesModal = obtenerPiezasPendientesDeSugerir(op.Components || [], piezasAviso);
          const piezaObjetivoActual = piezasPendientesModal[0] || piezasAviso[multiCompIndex] || piezasAviso[0] || "";

          const matchesPieza = (matDesc) => {
            if (!matDesc || !piezaObjetivoActual) return false;
            const desc = matDesc.toLowerCase();
            const palabras = piezaObjetivoActual.toLowerCase().split(/\s+/);
            return palabras.some((palabra) => palabra.length > 2 && desc.includes(palabra));
          };

          const tieneAlgunaSugerencia = list.some((m) => matchesPieza(m.Ojtxp));

          const codigosYaSeleccionadosEnOtrosItems = (op.Components || [])
            .filter((cc, ci) => ci !== multiCompIndex && (cc.MultiSelected || []).length > 0)
            .map((cc) => cc.MultiSelected[0].Material);

          const filtered = list
            .filter((m) => {
              if (codigosYaSeleccionadosEnOtrosItems.includes(m.Idnrk)) return false;

              if (!q) return true;
              return `${m.Ojtxp || ""} ${m.Idnrk || ""}`
                .toLowerCase()
                .includes(q);
            })
            .sort((a, b) => {
              const matchA = matchesPieza(a.Ojtxp);
              const matchB = matchesPieza(b.Ojtxp);
              if (matchA && !matchB) return -1;
              if (!matchA && matchB) return 1;
              return 0;
            });

          const selected0 = (c.MultiSelected || [])[0]?.Material || null;

          return (
            <>
              {/* 🔄 BOTÓN PARA CAMBIAR DE UBICACIÓN / CATEGORÍA SI EL MECÁNICO SE EQUIVOCÓ */}
              <TouchableOpacity
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  backgroundColor: "#EFF6FF",
                  borderBottomWidth: 1,
                  borderBottomColor: COLORS.border,
                  gap: 8,
                }}
                onPress={() => {
                  setOperations((prev) => {
                    const nextOps = prev.map((o, oi) => {
                      if (oi !== multiOpIndex) return o;
                      const comps = (o.Components || []).map((cc, ci) => {
                        if (ci !== multiCompIndex) return cc;
                        return { ...cc, NotFoundCategory: "", NotFoundMaterials: [] };
                      });
                      return { ...o, Components: comps };
                    });
                    return normalizeOpsAndComponents(nextOps, planPlant);
                  });
                }}
              >
                <Ionicons name="arrow-back" size={16} color={COLORS.accent} />
                <Text style={{ fontSize: 12, fontWeight: "800", color: COLORS.accent, flex: 1 }}>
                  Ubicación: {zeinr} (Toca aquí para cambiar de categoría)
                </Text>
              </TouchableOpacity>

              {!tieneAlgunaSugerencia && piezasAviso.length > 0 && !q && (
                <View style={styles.bannerAvisoSinMatch}>
                  <Ionicons name="information-circle-outline" size={16} color="#D97706" style={{ marginRight: 6 }} />
                  <Text style={styles.bannerAvisoText}>
                    Mostrando el catálogo completo para este equipo.
                  </Text>
                </View>
              )}

              {filtered.map((m, idx) => {
                const checked = selected0 === m.Idnrk;
                const key = `${m.Idnrk}-${idx}`;
                const esSugerenciaTecnico = matchesPieza(m.Ojtxp);

                return (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.workerRow,
                      esSugerenciaTecnico && { backgroundColor: "#F0FDF4" },
                    ]}
                    onPress={() => {
                      setOperations((prev) => {
                        const nextOps = prev.map((o, oi) => {
                          if (oi !== multiOpIndex) return o;
                          const comps = (o.Components || []).map((cc, ci) => {
                            if (ci !== multiCompIndex) return cc;

                            const curr =
                              (cc.MultiSelected || [])[0]?.Material || null;
                            const nextSel =
                              curr === m.Idnrk
                                ? []
                                : [
                                    {
                                      Material: m.Idnrk,
                                      Descripcion: m.Ojtxp,
                                    },
                                  ];

                            return { ...cc, MultiSelected: nextSel };
                          });
                          return { ...o, Components: comps };
                        });
                        return normalizeOpsAndComponents(nextOps, planPlant);
                      });
                    }}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        checked && styles.checkboxChecked,
                      ]}
                    >
                      {checked && (
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <Text style={styles.workerName}>
                          {m.Ojtxp || m.Idnrk}
                        </Text>
                        {esSugerenciaTecnico && (
                          <View style={styles.badgeSugerencia}>
                            <Text style={styles.badgeSugerenciaText}>⭐ Sugerido</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.materialCodeText}>{m.Idnrk}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </>
          );
        })()}
      </ScrollView>

            <View style={styles.modalFooterRow}>
              <TouchableOpacity
                style={[styles.smallBtn, { backgroundColor: COLORS.cardBg }]}
                onPress={() => {
                  if (multiOpIndex < 0 || multiCompIndex < 0) return;
                  setOperations((prev) => {
                    const nextOps = prev.map((o, oi) => {
                      if (oi !== multiOpIndex) return o;
                      const comps = (o.Components || []).map((cc, ci) => {
                        if (ci !== multiCompIndex) return cc;
                        return { ...cc, MultiSelected: [] };
                      });
                      return { ...o, Components: comps };
                    });
                    return normalizeOpsAndComponents(nextOps, planPlant);
                  });
                }}
              >
                <Text style={styles.smallBtnText}>Limpiar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.smallBtn,
                  {
                    backgroundColor: COLORS.accent,
                    borderColor: COLORS.accent,
                  },
                ]}
                onPress={() => setMultiVisible(false)}
              >
                <Text style={[styles.smallBtnText, { color: "#fff" }]}>
                  Listo
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ===== DateTime Picker (modal) ===== */}
      <Modal
        visible={dtPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDtPickerVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {dtPickerField === "start"
                  ? "Seleccionar inicio"
                  : "Seleccionar fin"}
              </Text>
              <TouchableOpacity
                onPress={() => setDtPickerVisible(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={{ padding: 14 }}>
              {Platform.OS === "ios" ? (
                <>
                  <DateTimePicker
                    value={dtPickerTemp}
                    mode="datetime"
                    display="spinner"
                    onChange={(_, selectedDate) => {
                      if (selectedDate) setDtPickerTemp(selectedDate);
                    }}
                  />

                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "flex-end",
                      gap: 10,
                      marginTop: 10,
                    }}
                  >
                    <TouchableOpacity
                      style={[
                        styles.smallBtn,
                        { backgroundColor: COLORS.cardBg },
                      ]}
                      onPress={() => setDtPickerVisible(false)}
                    >
                      <Text style={styles.smallBtnText}>Cancelar</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.smallBtn,
                        {
                          backgroundColor: COLORS.accent,
                          borderColor: COLORS.accent,
                        },
                      ]}
                      onPress={() => {
                        applyPickedDateTime(dtPickerTemp);
                        setDtPickerVisible(false);
                      }}
                    >
                      <Text style={[styles.smallBtnText, { color: "#fff" }]}>
                        Confirmar
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <Text
                    style={{
                      color: COLORS.muted,
                      fontSize: 12,
                      marginBottom: 10,
                    }}
                  >
                    Primero elige la fecha y luego la hora.
                  </Text>

                  <DateTimePicker
                    value={dtPickerTemp}
                    mode={dtPickerStep}
                    display="default"
                    onChange={(event, selectedDate) => {
                      if (event?.type === "dismissed") {
                        setDtPickerVisible(false);
                        return;
                      }

                      const picked = selectedDate || dtPickerTemp;
                      if (dtPickerStep === "date") {
                        const next = new Date(dtPickerTemp);
                        next.setFullYear(
                          picked.getFullYear(),
                          picked.getMonth(),
                          picked.getDate(),
                        );
                        setDtPickerTemp(next);
                        setDtPickerStep("time");
                        return;
                      }

                      const next = new Date(dtPickerTemp);
                      next.setHours(
                        picked.getHours(),
                        picked.getMinutes(),
                        0,
                        0,
                      );
                      setDtPickerTemp(next);

                      applyPickedDateTime(next);
                      setDtPickerVisible(false);
                      setDtPickerStep("date");
                    }}
                  />
                </>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ========= Subcomponentes ========= */

const Row = ({ label, value }) => (
  <View style={styles.row}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text style={styles.infoValue}>{value || "—"}</Text>
  </View>
);

const Field = ({ label, value, onChangeText, placeholder, keyboardType }) => (
  <View style={{ marginBottom: 10 }}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput
      style={styles.input}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={COLORS.muted}
      keyboardType={keyboardType}
    />
  </View>
);

const SelectMaterial = ({ items, value, onSelect, disabled }) => {
  const [visible, setVisible] = useState(false);

  const selectedItem = items.find((m) => m.Material === value) || null;
  const label = disabled
    ? "Selecciona primero una categoría"
    : selectedItem
      ? `${selectedItem.Descripcion} (${selectedItem.Material})`
      : "Seleccionar material de catálogo";

  const open = () => {
    if (disabled) return;
    setVisible(true);
  };

  return (
    <>
      <TouchableOpacity
        style={[
          styles.input,
          styles.multiInput,
          disabled && { backgroundColor: "#F0F1F5" },
        ]}
        onPress={open}
        activeOpacity={disabled ? 1 : 0.7}
      >
        <Text
          style={{
            fontSize: 13,
            color: selectedItem && !disabled ? COLORS.title : COLORS.muted,
          }}
          numberOfLines={2}
        >
          {label}
        </Text>
        {!disabled && (
          <Ionicons
            name="chevron-down-outline"
            size={18}
            color={COLORS.muted}
            style={{ marginLeft: 6 }}
          />
        )}
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Seleccionar material</Text>
              <TouchableOpacity
                onPress={() => setVisible(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={{ maxHeight: 320 }}
              contentContainerStyle={{ paddingVertical: 8 }}
            >
              {items.map((m, index) => {
                const checked = value === m.Material;
                const key = m.Id ? `${m.Id}-${index}` : `mat-${index}`;

                return (
                  <TouchableOpacity
                    key={key}
                    style={styles.workerRow}
                    onPress={() => {
                      onSelect(m.Material);
                      setVisible(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        checked && styles.checkboxChecked,
                      ]}
                    >
                      {checked && (
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.workerName}>
                        {m.Descripcion || m.Material}
                      </Text>
                      <Text style={styles.materialCodeText}>{m.Material}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={styles.modalFooterRow}>
              <TouchableOpacity
                style={[styles.smallBtn, { backgroundColor: COLORS.cardBg }]}
                onPress={() => onSelect("")}
              >
                <Text style={styles.smallBtnText}>Limpiar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.smallBtn,
                  {
                    backgroundColor: COLORS.accent,
                    borderColor: COLORS.accent,
                  },
                ]}
                onPress={() => setVisible(false)}
              >
                <Text style={[styles.smallBtnText, { color: "#fff" }]}>
                  Listo
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
};

const SelectNumber = ({ label, value, min = 1, max = 20, onSelect }) => {
  const [visible, setVisible] = useState(false);

  const numbers = useMemo(() => {
    const arr = [];
    for (let i = min; i <= max; i++) arr.push(i);
    return arr;
  }, [min, max]);

  return (
    <>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[styles.input, styles.multiInput]}
        onPress={() => setVisible(true)}
        activeOpacity={0.75}
      >
        <Text
          style={{ fontSize: 13, color: value ? COLORS.title : COLORS.muted }}
          numberOfLines={1}
        >
          {value ? `${value} persona(s)` : "Seleccionar..."}
        </Text>
        <Ionicons name="chevron-down-outline" size={18} color={COLORS.muted} />
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                Seleccionar número de personas
              </Text>
              <TouchableOpacity
                onPress={() => setVisible(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={{ maxHeight: 320 }}
              contentContainerStyle={{ paddingVertical: 8 }}
            >
              {numbers.map((n) => {
                const checked = value === n;
                return (
                  <TouchableOpacity
                    key={`n-${n}`}
                    style={styles.workerRow}
                    onPress={() => {
                      onSelect(n);
                      setVisible(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        checked && styles.checkboxChecked,
                      ]}
                    >
                      {checked && (
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      )}
                    </View>
                    <Text style={styles.workerName}>{n} persona(s)</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={styles.modalFooterRow}>
              <TouchableOpacity
                style={[styles.smallBtn, { backgroundColor: COLORS.cardBg }]}
                onPress={() => {
                  onSelect(null);
                  setVisible(false);
                }}
              >
                <Text style={styles.smallBtnText}>Limpiar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.smallBtn,
                  {
                    backgroundColor: COLORS.accent,
                    borderColor: COLORS.accent,
                  },
                ]}
                onPress={() => setVisible(false)}
              >
                <Text style={[styles.smallBtnText, { color: "#fff" }]}>
                  Listo
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
};

/* ========= Estilos ========= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.pageBg },
  scrollContent: { padding: 16, paddingBottom: 90 },

  backRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  backText: { marginLeft: 4, color: COLORS.accent, fontWeight: "600" },

  wizardIndicatorRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
    gap: 8,
  },
  wizardStepBadge: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    backgroundColor: "#E2E8F0",
    borderRadius: 8,
  },
  wizardStepActive: {
    backgroundColor: COLORS.accent,
  },
  wizardStepText: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.text,
  },
  wizardTextActive: {
    color: "#FFFFFF",
  },

  cardHighlight: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...elev(1.2),
  },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.chipBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 11, color: COLORS.title },

  chipSmall: {
    backgroundColor: COLORS.chipBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginTop: 4,
  },
  chipTextSmall: { fontSize: 11, color: COLORS.title },

  mainTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.title,
    marginBottom: 6,
  },
  mainTitleMuted: {
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.muted,
    fontStyle: "italic",
    marginBottom: 6,
  },

  block: { marginTop: 4 },
  infoLabel: {
    fontSize: 11,
    color: COLORS.text,
    opacity: 0.8,
    marginBottom: 2,
  },
  infoValue: { fontSize: 13, color: COLORS.title, fontWeight: "600" },

  card: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...elev(1),
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.title,
    marginBottom: 4,
  },
  sectionSubtitle: { fontSize: 12, color: COLORS.muted, marginBottom: 10 },

  row: { marginBottom: 6 },

  fieldLabel: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: "600",
    marginBottom: 4,
  },

  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    fontSize: 13,
    color: COLORS.title,
    backgroundColor: "#FDFDFE",
  },

  multiInput: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  dateRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  dateCol: { flex: 1 },
  helpText: { fontSize: 11, color: COLORS.muted, marginTop: 4 },

  opCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 18,
    backgroundColor: "#FAFBFF",
  },

  opHeader: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  opTitle: { flex: 1, fontSize: 13, fontWeight: "700", color: COLORS.title },
  opDeleteBtn: { paddingHorizontal: 6, paddingVertical: 4 },

  btnSecondary: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
    paddingVertical: 8,
  },
  btnSecondaryText: {
    marginLeft: 6,
    color: COLORS.accent,
    fontWeight: "700",
    fontSize: 13,
  },

  btnPrimary: {
    marginTop: 10,
    backgroundColor: COLORS.accent,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    ...elev(1.4),
  },
  btnPrimaryPressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  btnPrimaryDisabled: { opacity: 0.7 },
  btnPrimaryContent: { flexDirection: "row", alignItems: "center" },
  btnPrimaryText: { color: "#FFFFFF", fontWeight: "900", fontSize: 15 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: COLORS.cardBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
    ...elev(1.4),
  },
  modalHeader: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  modalTitle: { flex: 1, color: "#fff", fontWeight: "700", fontSize: 14 },
  modalCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },

  workerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },

  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  checkboxChecked: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },

  workerName: { fontSize: 13, color: COLORS.title },
  materialCodeText: { fontSize: 11, color: COLORS.muted },

  modalFooterRow: {
    padding: 10,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  smallBtnText: { fontSize: 13, fontWeight: "700", color: COLORS.text },

  categoryRow: { marginBottom: 8 },
  categoryChipsWrapper: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
  },
  categoryChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#F7F8FC",
    marginRight: 6,
  },
  categoryChipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  categoryChipText: { fontSize: 11, color: COLORS.text, fontWeight: "600" },
  categoryChipTextActive: { color: "#fff" },

  toggleRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  toggleChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#F7F8FC",
  },
  toggleChipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  toggleText: { fontSize: 12, fontWeight: "800", color: COLORS.text },
  toggleTextActive: { color: "#fff" },

  btnMini: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
  },
  btnMiniText: { color: COLORS.accent, fontWeight: "900" },

  materialCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 12,
    backgroundColor: "#FFFFFF",
  },

  materialCardSpaced: {
    marginTop: 14,
  },

  operationDivider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 12,
    opacity: 0.6,
  },

  sugerenciaCard: {
    backgroundColor: "#EFF6FF",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#BFDBFE",
    ...elev(1),
  },
  sugerenciaTitle: { fontSize: 13, fontWeight: "800", color: "#1E3A8A" },
  sugerenciaSub: { fontSize: 11, color: "#64748B", marginTop: 8 },
  badgePiezaReportada: { 
    backgroundColor: "#FFFFFF", 
    paddingHorizontal: 10, 
    paddingVertical: 5, 
    borderRadius: 8, 
    borderWidth: 1, 
    borderColor: "#DBEAFE" 
  },
  badgePiezaText: { fontSize: 12, fontWeight: "700", color: "#1E40AF" },

  bannerAvisoSinMatch: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#FEF3C7",
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  bannerAvisoText: {
    fontSize: 11,
    color: "#92400E",
    fontWeight: "600",
    flex: 1,
    lineHeight: 16,
  },
  badgeSugerencia: {
    backgroundColor: "#DCFCE7",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#BBF7D0",
  },
  badgeSugerenciaText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#166534",
  },

  previewSectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: COLORS.accent,
    marginBottom: 6,
    marginTop: 10,
  },
  previewBox: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  previewText: {
    fontSize: 12,
    color: COLORS.text,
    marginBottom: 2,
  },
  previewValue: {
    fontWeight: "700",
    color: COLORS.title,
  },
  opHeaderMain: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    backgroundColor: "#EFF6FF",
    padding: 8,
    borderRadius: 10,
  },
  opBadgeActivity: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 8,
  },
  opBadgeText: { fontSize: 11, fontWeight: "800", color: "#FFF" },
  opTitleHeader: { flex: 1, fontSize: 13, fontWeight: "800", color: COLORS.title },

  toggleChipSmall: {
    flex: 1,
    paddingVertical: 6,
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#F7F8FC",
  },
  toggleTextSmall: { fontSize: 11, fontWeight: "700", color: COLORS.text },

  subSectionHeader: { fontSize: 13, fontWeight: "800", color: COLORS.title },
  subSectionHint: { fontSize: 11, color: COLORS.muted, fontStyle: "italic" },

  materialCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  materialCardTitle: { fontSize: 12, fontWeight: "700", color: COLORS.text },

  btnBomSelect: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    borderRadius: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  btnBomSelectText: { fontSize: 12, fontWeight: "800", color: COLORS.accent },

  selectedBimBox: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },

  btnAddOperationBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 6,
    gap: 6,
    ...elev(1),
  },
  btnAddOperationText: { color: "#FFF", fontWeight: "800", fontSize: 13 },

  materialSectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    marginBottom: 2,
  },

  btnAddConsumibleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
    paddingVertical: 8,
    backgroundColor: "#F8FAFC",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: "dashed",
  },
  btnAddMaterialText: { marginLeft: 4, fontSize: 12, fontWeight: "700", color: COLORS.accent },

  btnAddRefaccionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
    paddingVertical: 8,
    backgroundColor: "#F0FDF4",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#BBF7D0",
    borderStyle: "dashed",
  },
  btnAddRefaccionText: { marginLeft: 4, fontSize: 12, fontWeight: "700", color: "#166534" },

  cardAsistencia: {
    backgroundColor: "#EFF6FF",
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  asistenciaTitle: { fontSize: 13, fontWeight: "800", color: "#1E3A8A" },
  asistenciaText: { fontSize: 11, color: "#1E40AF", marginTop: 2, lineHeight: 15 },

  fieldLabelQuestion: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.title,
    marginBottom: 4,
    marginTop: 6,
  },

  inputHelperText: {
    fontSize: 10,
    color: "#64748B",
    marginTop: 3,
    fontStyle: "italic",
  },
  previewOpGroupCard: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  previewOpHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  previewOpBadge: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginRight: 8,
  },
  previewOpBadgeText: { fontSize: 11, fontWeight: "800", color: "#FFF" },
  previewOpTitle: { fontSize: 13, fontWeight: "800", color: COLORS.title },
  
  previewSubSectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.title,
    marginBottom: 6,
    marginTop: 4,
  },
  previewComponentBox: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
  },

  pasoPreguntaContainer: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  pasoHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  numeroPasoBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.accent,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  numeroPasoText: {
    color: "#FFFFFF",
    fontWeight: "900",
    fontSize: 11,
  },
  btnAsistenteDestacado: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  btnAsistenteText: {
    color: "#166534",
    fontWeight: "800",
    fontSize: 12,
  },
  preguntaCierreBomBox: {
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
  },
  preguntaCierreText: {
    fontSize: 11,
    fontWeight: "700",
    color: COLORS.title,
  },
  btnMiniAccionVerde: {
    backgroundColor: "#DCFCE7",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#BBF7D0",
  },
  btnMiniAccionVerdeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#166534",
  },
  btnMiniAccionAzul: {
    backgroundColor: "#DBEAFE",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  btnMiniAccionAzulText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#1E40AF",
  },
  btnCierreAccion: {
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
  },

  
});