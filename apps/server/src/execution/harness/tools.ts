import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionInput } from "../run-service/types.js";
import { HarnessFailure, type HarnessEvent, type ProtectedHarnessTool } from "./types.js";

/** Child exit cannot confirm cancellation while an in-process protected tool is still running. */
export class ProtectedToolActivity {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  async track<T>(start: () => Promise<T>): Promise<T> {
    if (this.closed) throw new HarnessFailure("ISOLATION_VIOLATION");
    const work = Promise.resolve().then(start);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }

  async closeAndWait(timeoutMs: number): Promise<boolean> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(this.pending).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function protectedToolNames(tools: readonly ProtectedHarnessTool[]): string[] {
  const names = tools.map((definition) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(definition.name)) throw new HarnessFailure("INVALID_INPUT");
    return `mcp__glassbox__${definition.name}`;
  });
  if (new Set(names).size !== names.length) throw new HarnessFailure("INVALID_INPUT");
  return names;
}

export async function executeProtectedTool(options: {
  definition: ProtectedHarnessTool;
  args: unknown;
  input: ExecutionInput;
  workspace: string;
  signal: AbortSignal;
  onEvent(event: HarnessEvent): Promise<void>;
  checkText(text: string): void;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { definition, input, args, signal } = options;
  const event = async (status: "started" | "completed" | "denied" | "failed") => {
    await options.onEvent({ type: "tool", runId: input.run.id, name: definition.name, status });
  };
  const denied = async () => {
    await event("denied");
    return { content: [{ type: "text" as const, text: "Tool access denied." }], isError: true };
  };
  try {
    if (signal.aborted || !(await definition.authorize(input, "execute", args)))
      return await denied();
    if (signal.aborted) return await denied();
    await event("started");
    const text = await definition.execute(args, { input, workspace: options.workspace, signal });
    // The output destination and current permission are checked again after execution.
    if (signal.aborted || !(await definition.authorize(input, "publish-result", args)))
      return await denied();
    options.checkText(text);
    await event("completed");
    return { content: [{ type: "text", text }] };
  } catch {
    await event("failed");
    return { content: [{ type: "text", text: "Tool execution failed." }], isError: true };
  }
}

export function createProtectedToolServer(options: {
  definitions: readonly ProtectedHarnessTool[];
  input: ExecutionInput;
  workspace: string;
  signal: AbortSignal;
  onEvent(event: HarnessEvent): Promise<void>;
  checkText(text: string): void;
  activity: ProtectedToolActivity;
}) {
  protectedToolNames(options.definitions);
  return createSdkMcpServer({
    name: "glassbox",
    version: "1.0.0",
    alwaysLoad: true,
    timeout: 30_000,
    tools: options.definitions.map((definition) =>
      tool(definition.name, definition.description, definition.inputSchema, async (args) =>
        options.activity.track(() => executeProtectedTool({ ...options, definition, args })),
      ),
    ),
  });
}
