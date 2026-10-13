import { createHash } from "node:crypto";

const SEND_ACTIONS = new Set(["send_private_msg", "send_group_msg"]);
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_HASH_BYTES = 8192;
const MAX_NATIVE_MESSAGE_BYTES = 4096;
const NATIVE_PREFIX =
  "EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n";
const NATIVE_EVENT = Object.freeze({
  service: "NodeIKernelMsgService",
  method: "sendMsg",
  listener: "NodeIKernelMsgListener",
  event: "onMsgInfoListUpdate",
});

function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function kind(value, present) {
  if (!present) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isSafeInteger(value) ? "integer" : "number";
  return "other";
}

function classifyNativeErrMsg(errMsg) {
  const requiresLogin =
    /(?:\u8bf7|\u9700\u8981|\u5fc5\u987b|\u8981\u6c42)\u91cd\u65b0\u767b\u5f55/u.test(errMsg);
  const deniesLogin =
    /(?:\u65e0\u9700|\u4e0d\u9700\u8981|\u4e0d\u5fc5|\u4e0d\u8981|\u8bf7\u52ff|\u7981\u6b62)\u91cd\u65b0\u767b\u5f55/u.test(
      errMsg,
    );
  if (deniesLogin) return "contradictory";
  return requiresLogin ? "recognized" : "unrecognized";
}

function nativeProjection(action, response, message, bytes) {
  if (!message.startsWith(NATIVE_PREFIX)) return { messageForm: "other" };
  const wording = own(response, "wording");
  if (
    !SEND_ACTIONS.has(action) ||
    own(response, "status") !== "failed" ||
    own(response, "retcode") !== 1200 ||
    (wording !== undefined && wording !== message) ||
    bytes > MAX_NATIVE_MESSAGE_BYTES
  )
    return { messageForm: "native-event-other-payload" };
  let payload;
  try {
    payload = JSON.parse(message.slice(NATIVE_PREFIX.length));
  } catch {
    return { messageForm: "native-event-malformed-json" };
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join(",") !== "errMsg,result" ||
    typeof payload.errMsg !== "string" ||
    !Number.isSafeInteger(payload.result) ||
    payload.result < -2147483648 ||
    payload.result > 2147483647
  )
    return { messageForm: "native-event-other-payload" };
  return {
    messageForm: "native-event-json",
    nativeEvent: { ...NATIVE_EVENT, result: payload.result },
    nativeErrMsgClassification: classifyNativeErrMsg(payload.errMsg),
  };
}

/** Capture bounded, payload-free shape evidence for a send API response. */
function diagnoseOneBotSendFailureUnsafe(action, response) {
  if (
    !SEND_ACTIONS.has(action) ||
    !response ||
    typeof response !== "object" ||
    Array.isArray(response)
  )
    return undefined;
  const status = own(response, "status");
  const retcode = own(response, "retcode");
  const message = own(response, "message");
  const wording = own(response, "wording");
  const echo = own(response, "echo");
  const data = own(response, "data");
  const isMessage = typeof message === "string";
  const messageBytes = isMessage ? Buffer.byteLength(message, "utf8") : null;
  const parsed = isMessage
    ? nativeProjection(action, response, message, messageBytes)
    : { messageForm: "absent" };
  const diagnostic = {
    version: 1,
    action,
    responseShape: {
      status:
        status === "ok" || status === "failed"
          ? status
          : status === undefined
            ? "missing"
            : "other",
      retcode: Number.isSafeInteger(retcode)
        ? "integer"
        : retcode === undefined
          ? "missing"
          : "other",
      message: kind(message, Object.hasOwn(response, "message")),
      wording: !Object.hasOwn(response, "wording")
        ? "missing"
        : typeof wording !== "string"
          ? "other"
          : wording === message
            ? "same"
            : "different",
      echo: kind(echo, Object.hasOwn(response, "echo")),
      data: kind(data, Object.hasOwn(response, "data")),
    },
    messageForm: parsed.messageForm,
    messageBytes,
    ...(isMessage && messageBytes <= MAX_HASH_BYTES
      ? {
          messageSha256: createHash("sha256").update(message, "utf8").digest("hex"),
        }
      : {}),
    ...(parsed.nativeEvent
      ? {
          nativeEvent: parsed.nativeEvent,
          nativeErrMsgClassification: parsed.nativeErrMsgClassification,
        }
      : {}),
  };
  return projectOneBotSendDiagnostic(diagnostic);
}

export function diagnoseOneBotSendFailure(action, response) {
  try {
    return diagnoseOneBotSendFailureUnsafe(action, response);
  } catch {
    return undefined;
  }
}

/** Validate and clone the closed diagnostic schema without reading accessors. */
function projectOneBotSendDiagnosticUnsafe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort().join(",");
  const hasHash = Object.hasOwn(value, "messageSha256");
  const hasNative = Object.hasOwn(value, "nativeEvent");
  const hasNativeErrMsgClassification = Object.hasOwn(value, "nativeErrMsgClassification");
  const wantedKeys = [
    "action",
    "messageBytes",
    "messageForm",
    "responseShape",
    "version",
    ...(hasHash ? ["messageSha256"] : []),
    ...(hasNative ? ["nativeEvent"] : []),
    ...(hasNativeErrMsgClassification ? ["nativeErrMsgClassification"] : []),
  ]
    .sort()
    .join(",");
  const version = own(value, "version");
  const action = own(value, "action");
  const bytes = own(value, "messageBytes");
  const form = own(value, "messageForm");
  const shape = own(value, "responseShape");
  const hash = own(value, "messageSha256");
  const native = own(value, "nativeEvent");
  const nativeErrMsgClassification = own(value, "nativeErrMsgClassification");
  if (
    keys !== wantedKeys ||
    version !== 1 ||
    !SEND_ACTIONS.has(action) ||
    !(
      bytes === null ||
      (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_MESSAGE_BYTES)
    ) ||
    ![
      "absent",
      "other",
      "native-event-json",
      "native-event-malformed-json",
      "native-event-other-payload",
    ].includes(form) ||
    !shape ||
    typeof shape !== "object" ||
    Array.isArray(shape) ||
    Object.keys(shape).sort().join(",") !== "data,echo,message,retcode,status,wording" ||
    !["ok", "failed", "other", "missing"].includes(own(shape, "status")) ||
    !["integer", "other", "missing"].includes(own(shape, "retcode")) ||
    ![
      "string",
      "integer",
      "number",
      "boolean",
      "object",
      "array",
      "null",
      "other",
      "missing",
    ].includes(own(shape, "message")) ||
    !["same", "different", "other", "missing"].includes(own(shape, "wording")) ||
    ![
      "string",
      "integer",
      "number",
      "boolean",
      "object",
      "array",
      "null",
      "other",
      "missing",
    ].includes(own(shape, "echo")) ||
    ![
      "string",
      "integer",
      "number",
      "boolean",
      "object",
      "array",
      "null",
      "other",
      "missing",
    ].includes(own(shape, "data")) ||
    (hasHash &&
      (!/^[a-f0-9]{64}$/u.test(hash ?? "") ||
        !Number.isSafeInteger(bytes) ||
        bytes > MAX_HASH_BYTES ||
        own(shape, "message") !== "string")) ||
    (hasNative &&
      (!native ||
        typeof native !== "object" ||
        Array.isArray(native) ||
        Object.keys(native).sort().join(",") !== "event,listener,method,result,service" ||
        own(native, "service") !== NATIVE_EVENT.service ||
        own(native, "method") !== NATIVE_EVENT.method ||
        own(native, "listener") !== NATIVE_EVENT.listener ||
        own(native, "event") !== NATIVE_EVENT.event ||
        !Number.isSafeInteger(own(native, "result")) ||
        own(native, "result") < -2147483648 ||
        own(native, "result") > 2147483647 ||
        form !== "native-event-json" ||
        own(shape, "status") !== "failed" ||
        own(shape, "retcode") !== "integer")) ||
    (form === "native-event-json") !== hasNative ||
    (hasNativeErrMsgClassification &&
      (!hasNative ||
        !["recognized", "unrecognized", "contradictory"].includes(nativeErrMsgClassification))) ||
    (bytes === null && (hasHash || hasNative || hasNativeErrMsgClassification))
  )
    return undefined;
  const projectedShape = Object.fromEntries(
    ["status", "retcode", "message", "wording", "echo", "data"].map((key) => [
      key,
      own(shape, key),
    ]),
  );
  return {
    version,
    action,
    responseShape: projectedShape,
    messageForm: form,
    messageBytes: bytes,
    ...(hasHash ? { messageSha256: hash } : {}),
    ...(hasNative
      ? {
          nativeEvent: { ...NATIVE_EVENT, result: own(native, "result") },
        }
      : {}),
    ...(hasNativeErrMsgClassification ? { nativeErrMsgClassification } : {}),
  };
}

export function projectOneBotSendDiagnostic(value) {
  try {
    return projectOneBotSendDiagnosticUnsafe(value);
  } catch {
    return undefined;
  }
}
