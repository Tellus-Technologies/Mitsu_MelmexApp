// Interpreta la respuesta de SAP al crear una orden de mantenimiento.
export function extractOrderFromReturn(dataOrD) {
  const d = dataOrD?.d ? dataOrD.d : dataOrD;
  const returns = d?.Return?.results || d?.ReturnSet?.results || [];
  if (!Array.isArray(returns) || returns.length === 0) {
    return {
      orderId: null,
      notifNo: null,
      offerNo: null,
      offerMessage: null,
      successItem: null,
      offerItem: null,
      errors: [],
      warnings: [],
      message: null,
      successMessages: [],
    };
  }

  const upperType = (x) => String(x?.Type || "").toUpperCase();
  const isSuccess = (r) => upperType(r) === "S";
  const isError = (r) => upperType(r) === "E";
  const isWarning = (r) => upperType(r) === "W" || upperType(r) === "A";

  const errors = returns.filter(isError);
  const warnings = returns.filter(isWarning);

  const successMessages = returns
    .filter(isSuccess)
    .map((r) => String(r?.Message || "").trim())
    .filter(Boolean);

  const successItem =
    returns.find(
      (r) =>
        isSuccess(r) &&
        String(r?.MessageV2 || "")
          .trim()
          .match(/^\d+$/),
    ) ||
    returns.find(
      (r) =>
        isSuccess(r) &&
        String(r?.Message || "")
          .toLowerCase()
          .includes("se ha grabado con número"),
    ) ||
    returns.find(isSuccess) ||
    null;

  const message = successItem?.Message ? String(successItem.Message) : null;

  let orderId = successItem?.MessageV2
    ? String(successItem.MessageV2).trim()
    : null;
  let notifNo = successItem?.MessageV3
    ? String(successItem.MessageV3).trim()
    : null;

  const offerItem =
    returns.find(
      (r) =>
        isSuccess(r) &&
        (String(r?.Id || "").toUpperCase() === "ZSD" ||
          String(r?.Message || "")
            .toLowerCase()
            .includes("oferta creada")),
    ) || null;

  const offerMessage = offerItem?.Message
    ? String(offerItem.Message).trim()
    : null;

  let offerNo = null;
  if (offerMessage) {
    const m = offerMessage.match(/oferta creada:\s*([0-9]+)/i);
    if (m?.[1]) offerNo = m[1];
    if (!offerNo) {
      const nums = offerMessage.match(/\b\d{6,15}\b/g) || [];
      offerNo = nums[0] || null;
    }
  }

  if ((!orderId || !notifNo) && message) {
    const numbers = message.match(/\b\d{6,12}\b/g) || [];
    if (!orderId && numbers.length >= 1) orderId = numbers[0];
    if (!notifNo && numbers.length >= 2) notifNo = numbers[1];
  }

  return {
    orderId,
    notifNo,
    offerNo,
    offerMessage,
    successItem,
    offerItem,
    errors,
    warnings,
    message,
    successMessages,
  };
}

export function extractFromSapMessageHeader(headers) {
  const h = headers || {};
  const raw = h["sap-message"] || h["SAP-MESSAGE"] || h["Sap-Message"] || null;
  if (!raw) return { orderId: null, notifNo: null, text: null };

  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    const text = String(obj?.message || obj?.msg || obj?.Message || "").trim();
    const nums = text.match(/\b\d{6,12}\b/g) || [];
    return { orderId: nums[0] || null, notifNo: nums[1] || null, text };
  } catch (e) {
    const text = String(raw || "").trim();
    const nums = text.match(/\b\d{6,12}\b/g) || [];
    return { orderId: nums[0] || null, notifNo: nums[1] || null, text };
  }
}

