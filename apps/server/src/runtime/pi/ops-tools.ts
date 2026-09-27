import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import type { AuthorizedOpsService } from "../../ops/service.js";
import {
  consumeMutationIntent,
  createProtectedTool,
  type ProtectedToolContext,
} from "./protected-tools.js";
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
  "task_step_accept",
  "task_step_rework",
  "task_signal",
  "task_approve",
  "task_cancel",
  "task_steps",
  "task_events",
  "task_plan",
  "task_link_child",
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
      ? {
          caller: value.caller,
          conversationId: value.conversationId,
          runId: value.runId,
          requiredToolName: value.requiredToolName,
          requiredToolInput: value.requiredToolInput,
        }
      : undefined;
  };
  const common = { authService: options.store.authorization, getContext };
  const taskId = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$",
  });
  const text = Type.String({ minLength: 1, maxLength: 16000 });
  const stepId = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$",
  });
  const dependencyIds = Type.Array(stepId, { maxItems: 8 });
  const plannedStep = Type.Object(
    {
      id: stepId,
      kind: Type.Union([
        Type.Literal("timer_wait"),
        Type.Literal("signal_wait"),
        Type.Literal("approval_wait"),
        Type.Literal("join"),
        Type.Literal("model"),
        Type.Literal("tool"),
        Type.Literal("herdr_worker"),
        Type.Literal("child_task"),
      ]),
      title: Type.String({ minLength: 1, maxLength: 256 }),
      dependencyIds,
      instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_592_000_000 })),
      signalKey: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$",
        }),
      ),
      targetTaskId: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" }),
      ),
      workerAccess: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
    },
    { additionalProperties: false },
  );
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
    createProtectedTool<{
      title: string;
      description?: string;
      acceptanceCriteria?: string[];
    }>({
      ...common,
      name: "task_create",
      description: "Create durable work without starting a worker.",
      parameters: Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 256 }),
          description: Type.Optional(text),
          acceptanceCriteria: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
              minItems: 1,
              maxItems: 16,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      action: "task:create",
      resourceId: "agent-operations",
      execute: async (params, context) =>
        options.service.create(context.caller, {
          title: params.title,
          description: params.description,
          acceptanceCriteria: params.acceptanceCriteria,
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
    createProtectedTool<{ taskId: string; stepId: string; expectedStepVersion: number }>({
      ...common,
      name: "task_step_accept",
      description: "Accept one reviewed durable Step. Task acceptance remains separate.",
      parameters: Type.Object(
        { taskId, stepId, expectedStepVersion: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
      action: "task:accept",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => {
        consumeMutationIntent(context, "task_step_accept", params);
        const step = await options.service.acceptStep(
          context.caller,
          params.taskId,
          params.stepId,
          params.expectedStepVersion,
          { runId: context.runId },
        );
        return { stepId: step.id, status: step.status, version: step.version };
      },
    }),
    createProtectedTool<{
      parentTaskId: string;
      parentStepId: string;
      expectedStepVersion: number;
      childTaskId: string;
      acceptanceCriteria: string[];
      cancellationPolicy: "cancel_child" | "keep_child";
      failurePolicy: "block_parent" | "fail_parent" | "review_parent";
    }>({
      ...common,
      name: "task_link_child",
      description:
        "Link a new same-owner child Task to a ready parent child_task Step. The child receives only the Step's delegated permissions.",
      parameters: Type.Object(
        {
          parentTaskId: taskId,
          parentStepId: stepId,
          expectedStepVersion: Type.Integer({ minimum: 1 }),
          childTaskId: taskId,
          acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
            minItems: 1,
            maxItems: 16,
          }),
          cancellationPolicy: Type.Union([
            Type.Literal("cancel_child"),
            Type.Literal("keep_child"),
          ]),
          failurePolicy: Type.Union([
            Type.Literal("block_parent"),
            Type.Literal("fail_parent"),
            Type.Literal("review_parent"),
          ]),
        },
        { additionalProperties: false },
      ),
      action: "task:delegate",
      resourceId: (params) => `task-${params.parentTaskId}`,
      execute: async (params, context) => {
        const link = await options.service.linkChildTask(context.caller, params, {
          runId: context.runId,
          conversationId: context.conversationId,
        });
        return {
          parentTaskId: link.parentTaskId,
          parentStepId: link.parentStepId,
          childTaskId: link.childTaskId,
        };
      },
    }),
    createProtectedTool<{
      taskId: string;
      stepId: string;
      expectedStepVersion: number;
      reason: string;
    }>({
      ...common,
      name: "task_step_rework",
      description: "Request a fresh attempt for one reviewed durable Step.",
      parameters: Type.Object(
        {
          taskId,
          stepId,
          expectedStepVersion: Type.Integer({ minimum: 1 }),
          reason: Type.String({ minLength: 1, maxLength: 512 }),
        },
        { additionalProperties: false },
      ),
      action: "task:rework",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => {
        consumeMutationIntent(context, "task_step_rework", params);
        const step = await options.service.reworkStep(
          context.caller,
          params.taskId,
          params.stepId,
          params.expectedStepVersion,
          params.reason,
          { runId: context.runId },
        );
        return { stepId: step.id, status: step.status, version: step.version };
      },
    }),
    ...([false, true] as const).map((approval) =>
      createProtectedTool<{
        taskId: string;
        stepId: string;
        targetStepVersion: number;
        type: string;
      }>({
        ...common,
        name: approval ? "task_approve" : "task_signal",
        description: approval
          ? "Approve a currently waiting durable Step with the caller's current authority."
          : "Send a named signal to a currently waiting durable Step.",
        parameters: Type.Object(
          {
            taskId,
            stepId,
            targetStepVersion: Type.Integer({ minimum: 1 }),
            type: Type.String({
              minLength: 1,
              maxLength: 128,
              pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$",
            }),
          },
          { additionalProperties: false },
        ),
        action: approval ? "task:approve" : "task:signal",
        resourceId: (params) => `task-${params.taskId}`,
        execute: async (params, context) => {
          consumeMutationIntent(context, approval ? "task_approve" : "task_signal", params);
          const signal = await options.service.signal(
            context.caller,
            {
              taskId: params.taskId,
              stepId: params.stepId,
              targetStepVersion: params.targetStepVersion,
              type: params.type,
              approval,
              idempotencyKey: `${context.runId}:${approval ? "approval" : "signal"}:${params.stepId}:${params.targetStepVersion}:${params.type}`,
            },
            { runId: context.runId },
          );
          return { stepId: signal.stepId, disposition: signal.disposition };
        },
      }),
    ),
    createProtectedTool<{ taskId: string }>({
      ...common,
      name: "task_cancel",
      description: "Cancel an authorized Task and stop its worker.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }),
      action: "task:cancel",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => {
        const canceled = await options.service.cancel(context.caller, params.taskId);
        return { canceled, cancellationRequested: !canceled };
      },
    }),
    createProtectedTool<{ taskId: string }>({
      ...common,
      name: "task_steps",
      description: "Inspect the bounded durable step list for an authorized Task.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }),
      action: "task:read",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => options.service.steps(context.caller, params.taskId),
    }),
    createProtectedTool<{ taskId: string; afterSequence?: number }>({
      ...common,
      name: "task_events",
      description: "Inspect append-only events for an authorized Task from a sequence cursor.",
      parameters: Type.Object(
        {
          taskId,
          afterSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
        },
        { additionalProperties: false },
      ),
      action: "task:read",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) =>
        options.service.taskEvents(context.caller, params.taskId, params.afterSequence),
    }),
    createProtectedTool<{
      taskId: string;
      rootStepId: string;
      steps: Array<{
        id: string;
        kind:
          | "timer_wait"
          | "signal_wait"
          | "approval_wait"
          | "join"
          | "model"
          | "tool"
          | "herdr_worker"
          | "child_task";
        title: string;
        dependencyIds: string[];
        instructions?: string;
        durationMs?: number;
        signalKey?: string;
        targetTaskId?: string;
        workerAccess?: "read" | "write";
      }>;
    }>({
      ...common,
      name: "task_plan",
      description:
        "Plan bounded timer, signal, approval, join, text-only model, read-only task_get Tool, configured Pi Herdr Worker, and child Task steps. Link child Tasks separately before planning their graphs. Shell steps are unavailable.",
      parameters: Type.Object(
        {
          taskId,
          rootStepId: stepId,
          steps: Type.Array(plannedStep, { minItems: 1, maxItems: 64 }),
        },
        { additionalProperties: false },
      ),
      action: "task:plan",
      resourceId: (params) => `task-${params.taskId}`,
      execute: async (params, context) => {
        for (const step of params.steps) {
          if (
            (!["herdr_worker", "child_task"].includes(step.kind) &&
              step.workerAccess !== undefined) ||
            (step.kind === "timer_wait" &&
              (step.durationMs === undefined ||
                step.signalKey !== undefined ||
                step.instructions !== undefined ||
                step.targetTaskId !== undefined)) ||
            (["signal_wait", "approval_wait"].includes(step.kind) &&
              (step.signalKey === undefined ||
                step.durationMs !== undefined ||
                step.instructions !== undefined ||
                step.targetTaskId !== undefined)) ||
            (step.kind === "join" &&
              (step.signalKey !== undefined ||
                step.durationMs !== undefined ||
                step.instructions !== undefined ||
                step.targetTaskId !== undefined ||
                step.dependencyIds.length === 0)) ||
            (step.kind === "model" &&
              (!step.instructions?.trim() ||
                step.durationMs !== undefined ||
                step.signalKey !== undefined ||
                step.targetTaskId !== undefined)) ||
            (step.kind === "tool" &&
              (!step.targetTaskId ||
                !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(step.targetTaskId) ||
                step.instructions !== undefined ||
                step.durationMs !== undefined ||
                step.signalKey !== undefined)) ||
            (step.kind === "herdr_worker" &&
              (!step.instructions?.trim() ||
                !step.workerAccess ||
                step.durationMs !== undefined ||
                step.signalKey !== undefined ||
                step.targetTaskId !== undefined)) ||
            (step.kind === "child_task" &&
              (!step.instructions?.trim() ||
                step.durationMs !== undefined ||
                step.signalKey !== undefined ||
                step.targetTaskId !== undefined))
          )
            throw new Error(`Invalid fields for planned ${step.kind} step ${step.id}`);
        }
        const sourceRun = params.steps.some((step) => step.kind === "model")
          ? await options.store.conversations.getRun(context.caller, context.runId)
          : undefined;
        if (sourceRun && sourceRun.source !== "external")
          throw new Error("Model Step planning requires an external Run");
        const executionRef = sourceRun?.executionRef;
        if (executionRef !== undefined && !/^(?:model|pi):.+$/u.test(executionRef))
          throw new Error("Model Step requires a configured model Run");
        const workerPermissions = new Map<
          string,
          Awaited<ReturnType<AuthorizedOpsService["plannedWorkerPermissions"]>>
        >();
        for (const step of params.steps) {
          if (step.kind !== "herdr_worker" && (step.kind !== "child_task" || !step.workerAccess))
            continue;
          if (options.workerTarget.agentKind !== "pi" || !options.workerTarget.worktreePath)
            throw new Error("Configured Pi Herdr Worker is unavailable");
          workerPermissions.set(
            step.id,
            await options.service.plannedWorkerPermissions(
              context.caller,
              params.taskId,
              options.workerTarget.worktreePath,
              step.workerAccess!,
              { runId: context.runId, conversationId: context.conversationId },
            ),
          );
        }
        const steps = params.steps.map((step) => {
          const waitPolicy =
            step.kind === "timer_wait"
              ? {
                  version: 1,
                  kind: "duration" as const,
                  durationMs: step.durationMs,
                  overdue: "resume" as const,
                }
              : step.kind === "signal_wait"
                ? {
                    version: 1,
                    kind: "signal" as const,
                    signalKey: step.signalKey,
                    overdue: "stale" as const,
                  }
                : step.kind === "approval_wait"
                  ? {
                      version: 1,
                      kind: "approval" as const,
                      signalKey: step.signalKey,
                      overdue: "stale" as const,
                    }
                  : undefined;
          return {
            id: step.id,
            taskId: params.taskId,
            kind: step.kind,
            title: step.title,
            ...(step.kind === "model"
              ? { instructions: step.instructions, specRef: executionRef }
              : step.kind === "tool"
                ? { specRef: `tool:task_get:${step.targetTaskId}` }
                : step.kind === "herdr_worker" || step.kind === "child_task"
                  ? { instructions: step.instructions }
                  : {}),
            status: "pending" as const,
            dependencyIds: step.dependencyIds,
            dependencyPolicy: {
              failed: "block" as const,
              cancelled: "cancel" as const,
              skipped: "skip" as const,
            },
            maxAttempts: 3,
            waitPolicy,
            requiredCapabilities: step.kind === "model" ? ["text"] : [],
            delegatedPermissionSet: workerPermissions.get(step.id) ?? [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1,
          };
        });
        await options.service.planExistingTask(
          context.caller,
          params.taskId,
          steps,
          params.rootStepId,
          { runId: context.runId, conversationId: context.conversationId },
        );
        return { planned: true, stepCount: steps.length };
      },
    }),
  ];
}
