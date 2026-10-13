import type { QqLiveNativeMuteStatePrecondition } from "./qq-live-lease.js";

export type QqLiveNativeMuteStateDenial =
  | "invalid_precondition"
  | "operation_mismatch"
  | "member_identity_mismatch"
  | "member_role_mismatch"
  | "member_state_mismatch"
  | "mute_state_changed"
  | "mute_state_expired";

export type QqLiveNativeMuteStateVerification =
  | { status: "verified"; phase: "mute" | "unmute" }
  | { status: "denied"; reason: QqLiveNativeMuteStateDenial };

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function nativeId(value: unknown): string | undefined {
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value)) return value;
  if (Number.isSafeInteger(value) && (value as number) > 0) return String(value);
  return undefined;
}

/** Verifies a fresh OneBot member row against one lease-bound moderation operation. */
export function verifyQqLiveNativeMuteStatePrecondition(input: {
  precondition: QqLiveNativeMuteStatePrecondition;
  toolName: string;
  action: string;
  resourceId: string;
  toolInput: Readonly<Record<string, unknown>>;
  memberState: unknown;
  nowSeconds: number;
}): QqLiveNativeMuteStateVerification {
  const { precondition, toolName, action, resourceId, toolInput, memberState, nowSeconds } = input;
  if (
    !plainRecord(precondition) ||
    !exactKeys(precondition, ["kind", "phase", "expectedMuteUntil"]) ||
    precondition.kind !== "qq-member-mute-state" ||
    (precondition.phase !== "mute" && precondition.phase !== "unmute") ||
    !Number.isSafeInteger(precondition.expectedMuteUntil) ||
    (precondition.expectedMuteUntil as number) < 0 ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0
  )
    return { status: "denied", reason: "invalid_precondition" };

  if (
    toolName !== "qq_group_moderation" ||
    action !== "group:moderate" ||
    !plainRecord(toolInput) ||
    !exactKeys(toolInput, ["groupId", "operation", "params"]) ||
    typeof toolInput.groupId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(toolInput.groupId) ||
    !Number.isSafeInteger(Number(toolInput.groupId)) ||
    toolInput.operation !== "set_group_ban" ||
    resourceId !== `group:${toolInput.groupId}` ||
    !plainRecord(toolInput.params) ||
    !exactKeys(toolInput.params, ["user_id", "duration"]) ||
    !Number.isSafeInteger(toolInput.params.user_id) ||
    (toolInput.params.user_id as number) <= 0 ||
    !Number.isSafeInteger(toolInput.params.duration)
  )
    return { status: "denied", reason: "operation_mismatch" };

  const duration = toolInput.params.duration as number;
  if (
    (precondition.phase === "mute" && (duration < 30 || duration > 60)) ||
    (precondition.phase === "unmute" && (duration !== 0 || precondition.expectedMuteUntil === 0))
  )
    return { status: "denied", reason: "operation_mismatch" };

  if (!plainRecord(memberState)) return { status: "denied", reason: "member_identity_mismatch" };
  if (
    nativeId(memberState.group_id) !== toolInput.groupId ||
    nativeId(memberState.user_id) !== String(toolInput.params.user_id)
  )
    return { status: "denied", reason: "member_identity_mismatch" };
  if (memberState.role !== "member") return { status: "denied", reason: "member_role_mismatch" };
  if (
    !Number.isSafeInteger(memberState.shut_up_timestamp) ||
    memberState.shut_up_timestamp !== precondition.expectedMuteUntil
  )
    return { status: "denied", reason: "member_state_mismatch" };

  if (precondition.phase === "mute" && precondition.expectedMuteUntil > nowSeconds)
    return { status: "denied", reason: "mute_state_changed" };
  if (precondition.phase === "unmute" && precondition.expectedMuteUntil <= nowSeconds)
    return { status: "denied", reason: "mute_state_expired" };

  return { status: "verified", phase: precondition.phase };
}
