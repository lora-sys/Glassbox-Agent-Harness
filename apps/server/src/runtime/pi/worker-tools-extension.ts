import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openDomainStore, type CallerContext } from "../../persistence/index.js";
import { WorkerFiles } from "../../ops/worker-files.js";

export interface WorkerToolContext {
  databasePath: string;
  root: string;
  resourceId: string;
  taskId: string;
  attemptId: string;
  caller: CallerContext;
  allowedActions: string[];
}

let workerFileTail: Promise<unknown> = Promise.resolve();

export function executeWorkerFileTool(
  context: WorkerToolContext,
  callId: string,
  operation: "read" | "write" | "list",
  params: { path?: string; content?: string },
) {
  // The local libsql driver waits synchronously for locks. Concurrent clients in
  // this process must not block a transaction awaiting filesystem completion.
  const pending = workerFileTail.then(() =>
    executeWorkerFileOperation(context, callId, operation, params),
  );
  workerFileTail = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

async function executeWorkerFileOperation(
  context: WorkerToolContext,
  callId: string,
  operation: "read" | "write" | "list",
  params: { path?: string; content?: string },
) {
  if (!isAbsolute(context.databasePath) || !isAbsolute(context.root))
    throw new Error("worker_context_invalid");
  const store = await openDomainStore({ databasePath: context.databasePath });
  try {
    return await store.tasks.executeWorkerTool(
      {
        ...context,
        callId,
        action: operation === "write" ? "worker:file:write" : "worker:file:read",
      },
      async () => {
        const files = await WorkerFiles.open(context.root);
        if (operation === "list") return files.list();
        if (typeof params.path !== "string") throw new Error("worker_path_required");
        if (operation === "read") return files.read(params.path);
        if (typeof params.content !== "string") throw new Error("worker_content_required");
        await files.write(params.path, params.content);
        return { written: true };
      },
    );
  } finally {
    await store.close();
  }
}

/** Trusted per-attempt configuration lives outside the worker-readable tree. */
export default function workerTools(pi: ExtensionAPI) {
  const systemPrompt = process.env.GLASSBOX_WORKER_SYSTEM_PROMPT;
  pi.on("before_agent_start", () => ({
    systemPrompt: systemPrompt ?? "Worker configuration is unavailable. No tools are authorized.",
  }));
  const names = ["worker_read_file", "worker_write_file", "worker_list_files"];
  pi.on("tool_call", (event) =>
    systemPrompt && names.includes(event.toolName)
      ? undefined
      : { block: true, reason: "worker_tool_not_delegated" },
  );
  pi.on("session_start", async () => {
    pi.setActiveTools(names);
  });
  for (const operation of ["read", "write", "list"] as const) {
    const name = operation === "list" ? names[2]! : operation === "write" ? names[1]! : names[0]!;
    pi.registerTool({
      name,
      label: name,
      executionMode: "sequential",
      description: `${operation} files in the Glassbox-authorized worker directory. No shell or process execution.`,
      parameters:
        operation === "list"
          ? Type.Object({}, { additionalProperties: false })
          : Type.Object(
              {
                path: Type.String({ minLength: 1, maxLength: 1024 }),
                ...(operation === "write" ? { content: Type.String({ maxLength: 262144 }) } : {}),
              },
              { additionalProperties: false },
            ),
      async execute(callId, params, signal) {
        if (signal?.aborted) throw new Error("worker_tool_cancelled");
        try {
          const file = process.env.GLASSBOX_WORKER_CONTEXT;
          if (!file || !isAbsolute(file)) throw new Error("worker_context_missing");
          const context = JSON.parse(await readFile(file, "utf8")) as WorkerToolContext;
          const value = await executeWorkerFileTool(context, callId, operation, params);
          return {
            content: [
              { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
            ],
            details: {},
          };
        } catch {
          throw new Error("worker_tool_denied_or_failed");
        }
      },
    });
  }
}
