import { createHash } from "node:crypto";
import { scopeKey, type CallerContext } from "../identity/scope.js";

/** Explicit management grants here apply only to this creator's Tasks created
 * at this exact channel scope. This is not an ownership-implies-permission rule. */
export function taskPolicyResourceId(caller: CallerContext): string {
  return taskPolicyResourceIdForScope(caller.principalId, scopeKey(caller.scope));
}

export function taskPolicyResourceIdForScope(principalId: string, taskScopeKey: string): string {
  return `task-policy:${createHash("sha256")
    .update(JSON.stringify([principalId, taskScopeKey]))
    .digest("hex")}`;
}
