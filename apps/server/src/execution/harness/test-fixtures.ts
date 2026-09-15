import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Options, SDKMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionInput } from "../run-service/types.js";
import type { ClaudeHarnessOptions, HarnessQueryFactory } from "./types.js";

export function executionInput(overrides: Partial<ExecutionInput> = {}): ExecutionInput {
  const scope = {
    connectionId: "qq-test",
    botId: "bot",
    chatType: "private" as const,
    chatId: "owner-chat",
    senderId: "owner",
  };
  return {
    caller: { principalId: "owner", scope },
    conversation: {
      id: "conversation",
      agentId: "agent",
      principalId: "owner",
      scope,
      providerKind: null,
      providerSessionId: null,
      createdAt: "2026-01-01",
    },
    run: {
      id: "run",
      conversationId: "conversation",
      messageId: "message",
      executionRef: "claude-local",
      status: "running",
      resultText: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
    text: "Reply with a greeting.",
    history: [{ role: "user", text: "Previously authorized message." }],
    providerSessionId: "untrusted-old-session",
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Fixture wire messages intentionally omit irrelevant SDK metadata. */
export const sdkMessage = (input: unknown): SDKMessage => input as SDKMessage;

export function initMessage(options: Options, extra: Record<string, unknown> = {}): SDKMessage {
  return sdkMessage({
    type: "system",
    subtype: "init",
    cwd: options.cwd,
    permissionMode: "dontAsk",
    tools: [],
    skills: [],
    agents: [],
    plugins: [],
    mcp_servers: [],
    session_id: "provider-session",
    ...extra,
  });
}

export function resultMessage(extra: Record<string, unknown> = {}): SDKMessage {
  return sdkMessage({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Hello.",
    session_id: "provider-session",
    modelUsage: {},
    ...extra,
  });
}

export async function harnessFixture() {
  const tempRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, "glassbox harness-"));
  const executablePath = path.join(directory, "installed claude.js");
  await writeFile(
    executablePath,
    "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('ready');",
    "utf8",
  );
  const config: ClaudeHarnessOptions = {
    dataDirectory: path.join(directory, "data"),
    executablePath,
    executionRef: "claude-local",
    credentials: async () => ({ ANTHROPIC_API_KEY: "fixture-api-secret-canary" }),
    hostEnvironment: { SystemRoot: process.env.SystemRoot },
    exitTimeoutMs: 300,
  };
  const dispose = async () => {
    if (
      !path.isAbsolute(directory) ||
      !directory.startsWith(path.join(tempRoot, "glassbox harness-"))
    )
      throw new Error("Invalid fixture cleanup path");
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, executablePath, config, dispose };
}

export function fakeQuery(
  options: {
    messages?: (options: Options) => Iterable<SDKMessage>;
    inspect?: (options: Options, prompt: string, child: SpawnedProcess) => void;
    hang?: boolean;
  } = {},
): HarnessQueryFactory {
  return ({ prompt, options: queryOptions }) => {
    const child = queryOptions.spawnClaudeCodeProcess!({
      command: "node",
      args: [queryOptions.pathToClaudeCodeExecutable!],
      env: queryOptions.env ?? {},
      cwd: queryOptions.cwd,
      signal: new AbortController().signal,
    });
    child.stdin.on("error", () => {});
    options.inspect?.(queryOptions, prompt, child);
    return {
      close() {
        if (!child.stdin.writableEnded) child.stdin.end();
      },
      async *[Symbol.asyncIterator]() {
        yield* options.messages?.(queryOptions) ?? [initMessage(queryOptions), resultMessage()];
        if (options.hang) await new Promise<never>(() => {});
      },
    };
  };
}
