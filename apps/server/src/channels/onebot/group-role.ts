import type { QqNativeGroupRole } from "../../identity/scope.js";

export type { QqNativeGroupRole, QqNativeGroupRoleObservation } from "../../identity/scope.js";

/** Normalize only NapCat's documented sender.role values. Unknown input fails closed. */
export function normalizeQqNativeGroupRole(value: unknown): QqNativeGroupRole {
  if (value === "owner") return "qq_group_owner";
  if (value === "admin") return "qq_group_admin";
  return "qq_group_member";
}
