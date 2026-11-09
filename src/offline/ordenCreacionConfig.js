// Configuración de la cola de creación de órdenes (la comparten crearOrden y la lista de avisos).
import api from "../services/api";
import { extractOrderFromReturn, extractFromSapMessageHeader } from "../utils/sapOrderReturn";

export const OPCIONES_CREACION = {
  api,
  parse(res) {
    const parsed = extractOrderFromReturn(res?.data) || {};
    if (!parsed.orderId) {
      const h = extractFromSapMessageHeader(res?.headers);
      parsed.orderId = h.orderId || parsed.orderId;
      parsed.notifNo = h.notifNo || parsed.notifNo;
    }
    return parsed;
  },
  // Devuelve el número de orden del aviso, o null si todavía no tiene.
  async verificar(avisoId) {
    const res = await api.get(
      `/api/odata/ZCS_GET_NOTIFICATION_SRV/NotificationHeaderSet('${encodeURIComponent(avisoId)}')`,
      { params: { $format: "json" }, timeout: 20000 },
    );
    const hdr = res?.data?.d ?? res?.data ?? null;
    return String(hdr?.Orderid ?? hdr?.OrderId ?? hdr?.Aufnr ?? "").trim() || null;
  },
};
