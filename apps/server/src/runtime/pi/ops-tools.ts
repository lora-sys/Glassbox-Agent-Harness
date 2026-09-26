import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import type { AuthorizedOpsService } from "../../ops/service.js";
import { createProtectedTool, type ProtectedToolContext } from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export interface WorkerTarget {
  workspaceId: string;
  agentKind: string;
  worktreePath?: string;
  branch?: string;
}

export const OPS_TOOL_NAMES = Object.freeze([
  "ops_status",
  "task_list",
  "task_get",
  "task_create",
  "worker_status",
  "task_delegate",
  "worker_read",
  "worker_prompt",
  "task_accept",
  "task_rework",
  "task_cancel",
] as const);

/** The model never supplies routing, Principal, filesystem paths or worker kind. */
export function createOpsTools(options: {
  store: DomainStore;
  service: AuthorizedOpsService;
  getContext: () => PiRunContext | undefined;
  workerTarget: WorkerTarget;
}): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
      : undefined;
  };
  const common = { authService: options.store.authorization, getContext };
  const taskId = Type.String({ minLength: 1, maxLength: 128 });
  const text = Type.String({ minLength: 1, maxLength: 16000 });
  return [
    createProtectedTool({
      ...common,
      name: "ops_status",
      description: "Read authorized Task and Worker counts.",
      parameters: Type.Object({}, { additionalProperties: false }),
      action: "ops:status",
      deliverySource: "content_source",
      resourceId: "agent-operations",
      execute: async (_params, context) => options.service.status(context.caller, context),
    }),
    createProtectedTool({
      ...common,
      name: "task_list",
      description: "List Tasks readable by the current Principal.",
      parameters: Type.Object({}, { additionalProperties: false }),
      action: "task:list",
      deliverySource: "content_source",
      resourceId: "agent-operations",
      execute: async (_params, context) => options.service.list(context.caller, context),
    }),
    createProtectedTool<{ taskId: string }>({
      ...common,
      name: "task_get",
      description: "Read an authorized durable Task.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }),
      action: "task:read",
      deliverySource: "content_source",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => options.service.get(context.caller, params.taskId),
    }),
    createProtectedTool<{ title: string; description?: string }>({
      ...common,
      name: "task_create",
      description: "Create durable work without starting a worker.",
      parameters: Type.Object(
        { title: Type.String({ minLength: 1, maxLength: 256 }), description: Type.Optional(text) },
        { additionalProperties: false },
      ),
      action: "task:create",
      resourceId: "agent-operations",
      execute: async (params, context) =>
        options.service.create(context.caller, {
          title: params.title,
          description: params.description,
          runId: context.runId,
          conversationId: context.conversationId,
        }),
    }),
    createProtectedTool<{ taskId: string }>({
      ...common,
      name: "worker_status",
      description:
        "Read the durable observation of a Task worker. Unknown means observation was lost.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }),
      action: "worker:status",
      deliverySource: "content_source",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) =>
        options.service.workerStatus(context.caller, params.taskId),
    }),
    createProtectedTool<{ taskId?: string; title?: string; prompt: string }>({
      ...common,
      name: "task_delegate",
      description:
        "Delegate an existing unstarted Task by taskId, or create and delegate a new Task with a title. Uses the configured coding worker.",
      parameters: Type.Object(
        {
          taskId: Type.Optional(taskId),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          prompt: text,
        },
        { additionalProperties: false },
      ),
      action: "task:delegate",
      resourceId: (params) => (params.taskId ? `task-${params.taskId}` : "agent-operations"),
      execute: async (params, context) =>
        options.service.delegate(context.caller, {
          ...options.workerTarget,
          taskId: params.taskId,
          title: params.title,
          prompt: params.prompt,
          conversationId: context.conversationId,
          runId: context.runId,
        }),
    }),
    createProtectedTool<{ taskId: string }>({
      ...common,
      name: "worker_read",
      description: "Read an authorized Task worker output.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }),
      action: "worker:read",
      deliverySource: "content_source",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) =>
        options.service.readWorker(context.caller, params.taskId, context),
    }),
    createProtectedTool<{ taskId: string; prompt: string }>({
      ...common,
      name: "worker_prompt",
      description: "Send an instruction to an authorized Task worker.",
      parameters: Type.Object({ taskId, prompt: text }, { additionalProperties: false }),
      action: "worker:prompt",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => {
        await options.service.promptWorker(context.caller, params.taskId, params.prompt);
        return { prompted: true };
      },
    }),
    createProtectedTool<{ taskId: string }>({
      ...common,
      name: "task_accept",
      description: "Accept a reviewed Task. Worker done alone is not acceptance.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }),
      action: "task:accept",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => {
        await options.service.accept(context.caller, params.taskId);
        return { accepted: true };
      },
    }),
    createProtectedTool<{ taskId: string; reason: string; prompt: string }>({
      ...common,
      name: "task_rework",
      description: "Request a new execution attempt for a reviewed Task.",
      parameters: Type.Object(
        { taskId, reason: text, prompt: text },
        { additionalProperties: false },
      ),
      action: "task:rework",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) =>
        options.service.rework(context.caller, params.taskId, params.reason, params.prompt),
    }),
    createProtectedTool<{ taskId: string }>({
      ...common,
      name: "task_cancel",
      description: "Cancel an authorized Task and stop its worker.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }),
      action: "task:cancel",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => {
        await options.service.cancel(context.caller, params.taskId);
        return { canceled: true };
      },
    }),
  ];
}
