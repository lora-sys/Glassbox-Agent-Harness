/** Closed diagnostic codes only. Never persist provider error text or arbitrary codes. */
const failedReasons = [
  "invalid_target",
  "invalid_message",
  "not_connected",
  "request_limit",
  "api_rejected",
  "cancelled_before_send",
  "artifact_unavailable",
  "unclassified",
] as const;
const unknownReasons = [
  "timeout",
  "disconnected",
  "send_error",
  "invalid_response",
  "async_response",
  "delivery_timeout",
  "transport_error",
  "process_interrupted",
  "unclassified",
] as const;
export type DeliveryReason = (typeof failedReasons)[number] | (typeof unknownReasons)[number];

export function deliveryReason(status: "failed" | "unknown", value: unknown): DeliveryReason {
  const allowed: readonly string[] = status === "failed" ? failedReasons : unknownReasons;
  return typeof value === "string" && allowed.includes(value)
    ? (value as DeliveryReason)
    : "unclassified";
}
