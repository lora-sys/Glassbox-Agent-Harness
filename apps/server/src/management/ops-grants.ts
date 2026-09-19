import { taskPolicyResourceId } from "../auth/task-policy.js";
import { scopeKey } from "../identity/scope.js";
import type { DomainStore } from "../persistence/index.js";
import type { WorkerPolicy } from "../ops/service.js";
import { ManagementError } from "./access.js";

const collectionActions = ["ops:status", "task:list", "task:create", "task:delegate"];
const taskActions = [
  "task:read",
  "task:delegate",
  "worker:status",
  "worker:read",
  "worker:prompt",
  "task:rework",
  "task:accept",
  "task:cancel",
  "delivery:send",
];
const fileActions = ["worker:file:read", "worker:file:write"];

/** Called only by the authenticated local management API, never by a model Tool.
 * Routing and actor come from a real Run, not caller-supplied scope fields. */
export async function grantOpsPermissions(
  store: DomainStore,
  workerPolicy: WorkerPolicy | undefined,
  input: unknown,
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ManagementError("INVALID_REQUEST", "Invalid Ops grant request");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["runId", "actions", "workspaceDelivery"].includes(key)) ||
    (value.workspaceDelivery !== undefined && typeof value.workspaceDelivery !== "boolean") ||
    typeof value.runId !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/u.test(value.runId) ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    value.actions.length > 20 ||
    value.actions.some(
      (action) =>
        typeof action !== "string" ||
        ![...collectionActions, ...taskActions, ...fileActions].includes(action),
    )
  )
    throw new ManagementError("INVALID_REQUEST", "Invalid Ops grant request");
  const caller = await store.lifecycle.traceCaller(value.runId);
  if (
    (value.workspaceDelivery || value.actions.some((action) => fileActions.includes(action))) &&
    !workerPolicy
  )
    throw new ManagementError("INVALID_CONFIGURATION", "Worker policy is not configured");
  const taskResource = taskPolicyResourceId(caller);
  await store.authorization.registerResource({
    id: "agent-operations",
    kind: "ops",
    visibility: "public",
    ifAbsent: true,
  });
  await store.authorization.registerResource({
    id: taskResource,
    kind: "task-policy",
    visibility: caller.scope.chatType === "group" ? "public" : "private",
    ownerId: caller.principalId,
    ifAbsent: true,
  });
  if (
    workerPolicy &&
    (value.workspaceDelivery || value.actions.some((action) => fileActions.includes(action)))
  ) {
    await store.authorization.registerResource({
      id: workerPolicy.resourceId,
      kind: "worker-files",
      visibility: "private",
      ifAbsent: true,
    });
  }
  const grants: Array<{ id: string; resourceId: string; action: string }> = [];
  for (const action of new Set(value.actions as string[])) {
    const resources = [
      ...(collectionActions.includes(action) ? ["agent-operations"] : []),
      ...(taskActions.includes(action) ? [taskResource] : []),
      ...(fileActions.includes(action) ? [workerPolicy!.resourceId] : []),
    ];
    for (const resourceId of resources) {
      const id = await store.authorization.grant({
        principalId: caller.principalId,
        resourceId,
        action,
        scope: caller.scope,
        effect: "allow",
      });
      await store.tasks.recordTrace({
        type: "authorization.granted",
        principalId: caller.principalId,
        data: {
          grantId: id,
          resourceId,
          action,
          scopeKey: scopeKey(caller.scope),
          authority: "local-management",
        },
      });
      grants.push({ id, resourceId, action });
    }
  }
  if (value.workspaceDelivery) {
    const resourceId = workerPolicy!.resourceId;
    const id = await store.authorization.grant({
      principalId: caller.principalId,
      resourceId,
      action: "delivery:send",
      scope: caller.scope,
      effect: "allow",
    });
    await store.tasks.recordTrace({
      type: "authorization.granted",
      principalId: caller.principalId,
      data: {
        grantId: id,
        resourceId,
        action: "delivery:send",
        scopeKey: scopeKey(caller.scope),
        authority: "local-management",
      },
    });
    grants.push({ id, resourceId, action: "delivery:send" });
  }
  return { principalId: caller.principalId, grants };
}
