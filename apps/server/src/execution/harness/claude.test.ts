import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Options, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeHarnessAdapter, executableSha256 } from "./claude.js";
import { InstalledProcess } from "./process.js";
import {
  executionInput,
  fakeQuery,
  harnessFixture,
  initMessage,
  resultMessage,
  sdkMessage,
} from "./test-fixtures.js";
import type { HarnessEvent } from "./types.js";

const fixtures: Array<Awaited<ReturnType<typeof harnessFixture>>> = [];
async function fixture() {
  const item = await harnessFixture();
  fixtures.push(item);
  return item;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((item) => item.dispose()));
});

describe("installed Claude execution boundary", () => {
  it.each([
    {
      version: "2.1.268",
      skills: ["doctor"],
      agents: ["Explore", "general-purpose", "Plan", "statusline-setup"],
      status: "succeeded",
    },
    { version: "2.1.268", skills: ["owner-private"], agents: [], status: "failed" },
    { version: "2.1.268", skills: [], agents: ["owner-agent"], status: "failed" },
    { version: "future-version", skills: ["doctor"], agents: [], status: "failed" },
  ])(
    "accepts only verified inert builtin metadata: $version/$skills/$agents",
    async ({ version, skills, agents, status }) => {
      const item = await fixture();
      const adapter = createClaudeHarnessAdapter({
        ...item.config,
        query: fakeQuery({
          messages: (options) => [
            initMessage(options, { claude_code_version: version, skills, agents }),
            resultMessage(),
          ],
        }),
      });
      expect((await adapter.execute(executionInput())).status).toBe(status);
    },
  );
  it("passes isolation flags through the real SDK to a disposable protocol process", async () => {
    const item = await fixture();
    const proofPath = path.join(item.directory, "launch-proof.json");
    await writeFile(
      item.executablePath,
      `
      const fs = require('node:fs');
      const readline = require('node:readline');
      fs.writeFileSync(${JSON.stringify(proofPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), hasOwnerCanary: Object.hasOwn(process.env, 'OWNER_PRIVATE_CANARY'), home: process.env.HOME }));
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], output_style: 'default', available_output_styles: [], models: [] } } });
        if (message.type === 'user') {
          send({ type: 'system', subtype: 'init', cwd: process.cwd(), permissionMode: 'dontAsk', tools: [], skills: [], plugins: [], agents: [], mcp_servers: [], session_id: 'fixture-session' });
          send({ type: 'result', subtype: 'success', is_error: false, result: 'Hello.', modelUsage: {}, session_id: 'fixture-session' });
        }
      });
      rl.on('close', () => process.exit(0));
    `,
      "utf8",
    );
    const adapter = createClaudeHarnessAdapter({ ...item.config, executionTimeoutMs: 3000 });
    expect(await adapter.execute(executionInput())).toEqual({
      status: "succeeded",
      text: "Hello.",
      usage: null,
    });
    const proof = JSON.parse(await readFile(proofPath, "utf8")) as {
      args: string[];
      cwd: string;
      home: string;
      hasOwnerCanary: boolean;
    };
    expect(proof.args).toContain("--strict-mcp-config");
    expect(proof.args).toContain("--setting-sources=");
    expect(proof.args).toContain("--tools");
    expect(proof.args[proof.args.indexOf("--tools") + 1]).toBe("");
    expect(proof.args).toContain("--no-session-persistence");
    expect(proof.hasOwnerCanary).toBe(false);
    expect(proof.home).toContain(item.config.dataDirectory);
  });

  it("uses the explicit installed path, no builtin tools, fresh context and replaced environment", async () => {
    const item = await fixture();
    const events: HarnessEvent[] = [];
    const inspect = vi.fn<(options: Options, prompt: string, child: SpawnedProcess) => void>();
    const assertOptions = (options: Options, prompt: string) => {
      expect(options).toMatchObject({
        pathToClaudeCodeExecutable: item.executablePath,
        tools: [],
        skills: [],
        agents: {},
        plugins: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        additionalDirectories: [],
        permissionMode: "dontAsk",
        persistSession: false,
        settings: { disableAllHooks: true, autoMemoryEnabled: false },
      });
      expect(options).not.toHaveProperty("resume");
      expect(options.env).not.toHaveProperty("OWNER_PRIVATE_CANARY");
      expect(options.env).not.toHaveProperty("NODE_OPTIONS");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(options.env?.HOME).toContain(item.directory);
      expect(options.env?.CLAUDE_CONFIG_DIR).toContain(item.directory);
      expect(options.cwd).toContain(path.join("runs"));
      expect(JSON.parse(prompt)).toEqual({
        history: executionInput().history,
        input: executionInput().text,
      });
      expect(prompt).not.toContain("fixture-api-secret-canary");
      expect(options.systemPrompt).not.toEqual(expect.objectContaining({ preset: "claude_code" }));
    };
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      hostEnvironment: {
        ...item.config.hostEnvironment,
        OWNER_PRIVATE_CANARY: "owner-secret",
        NODE_OPTIONS: "--require owner.js",
      },
      query: fakeQuery({ inspect }),
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(adapter.supportsGroup).toBe(false);
    expect(adapter.capabilities.resume).toBe(false);
    expect(await adapter.execute(executionInput())).toEqual({
      status: "succeeded",
      text: "Hello.",
      usage: null,
    });
    expect(inspect).toHaveBeenCalledOnce();
    assertOptions(inspect.mock.calls[0]![0], inspect.mock.calls[0]![1]);
    expect(events.at(-1)).toMatchObject({ type: "finished", status: "succeeded", usage: null });
  });

  it("rejects group execution until the exact binary and tool mode have been verified", async () => {
    const item = await fixture();
    const query = vi.fn(fakeQuery());
    const input = executionInput();
    input.caller.scope.chatType = "group";
    const adapter = createClaudeHarnessAdapter({ ...item.config, query });
    expect(await adapter.execute(input)).toMatchObject({
      status: "failed",
      code: "GROUP_ISOLATION_UNVERIFIED",
    });
    expect(query).not.toHaveBeenCalled();
    const verified = createClaudeHarnessAdapter({
      ...item.config,
      query,
      groupIsolation: {
        executableSha256: await executableSha256(item.executablePath),
        toolMode: "none",
      },
    });
    expect(verified.supportsGroup).toBe(true);
    expect((await verified.execute(input)).status).toBe("succeeded");
    await writeFile(item.executablePath, "process.exit(0)", "utf8");
    expect(await verified.execute(input)).toMatchObject({
      status: "failed",
      code: "EXECUTABLE_CHANGED",
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("does not fall back to the SDK bundled CLI or install when the path is missing", async () => {
    const item = await fixture();
    const query = vi.fn(fakeQuery());
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      executablePath: path.join(item.directory, "missing.exe"),
      query,
    });
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "failed",
      code: "EXECUTABLE_MISSING",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { tools: ["Read"] },
    { skills: ["private-memory"] },
    { plugins: [{ name: "private-plugin" }] },
    { agents: ["owner-agent"] },
    { mcp_servers: [{ name: "owner-mcp", status: "connected" }] },
    { permissionMode: "bypassPermissions" },
    { cwd: "owner-private-path" },
  ])("withholds output when the init contradicts isolation %j", async (extra) => {
    const item = await fixture();
    const events: HarnessEvent[] = [];
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      query: fakeQuery({
        messages: (options) => [
          initMessage(options, extra),
          resultMessage({ result: "private-context-canary" }),
        ],
      }),
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "failed",
      code: "ISOLATION_VIOLATION",
    });
    expect(JSON.stringify(events)).not.toContain("private-context-canary");
  });

  it("never returns provider error strings or credential echoes", async () => {
    const item = await fixture();
    for (const message of [
      resultMessage({ is_error: true, result: "credential=fixture-api-secret-canary" }),
      resultMessage({ result: "fixture-api-secret-canary" }),
    ]) {
      const adapter = createClaudeHarnessAdapter({
        ...item.config,
        query: fakeQuery({ messages: (options) => [initMessage(options), message] }),
      });
      const result = await adapter.execute(executionInput());
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("fixture-api-secret-canary");
      expect(result.usage).toBeNull();
    }
  });

  it("captures text and reported model usage without inventing missing statistics", async () => {
    const item = await fixture();
    const events: HarnessEvent[] = [];
    const modelUsage = {
      model: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
      },
    };
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      query: fakeQuery({
        messages: (options) => [
          initMessage(options),
          sdkMessage({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "Hello." }] },
          }),
          resultMessage({ modelUsage }),
        ],
      }),
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "succeeded",
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
      },
    });
    expect(events).toContainEqual({ type: "text", runId: "run", text: "Hello." });
  });

  it("fails closed on unexpected builtin calls and bounded output", async () => {
    const item = await fixture();
    const toolAdapter = createClaudeHarnessAdapter({
      ...item.config,
      query: fakeQuery({
        messages: (options) => [
          initMessage(options),
          sdkMessage({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", name: "Bash" }] },
          }),
        ],
      }),
    });
    expect(await toolAdapter.execute(executionInput())).toMatchObject({
      status: "failed",
      code: "ISOLATION_VIOLATION",
    });
    const outputAdapter = createClaudeHarnessAdapter({
      ...item.config,
      maxOutputBytes: 3,
      query: fakeQuery(),
    });
    expect(await outputAdapter.execute(executionInput())).toMatchObject({
      status: "failed",
      code: "OUTPUT_LIMIT",
    });
  });

  it("waits for actual child exit before confirming cancellation", async () => {
    const item = await fixture();
    const controller = new AbortController();
    let exited = false;
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      query: fakeQuery({
        messages: (options) => [initMessage(options)],
        hang: true,
        inspect: (_options, _prompt, child) =>
          child.once("exit", () => {
            exited = true;
          }),
      }),
      onEvent: (event) => {
        if (event.type === "started") controller.abort();
      },
    });
    const result = await adapter.execute(executionInput({ signal: controller.signal }));
    expect(result.status).toBe("cancelled");
    expect(exited).toBe(true);
  });

  it("does not resolve credentials or start a process for an already cancelled input", async () => {
    const item = await fixture();
    const controller = new AbortController();
    controller.abort();
    const credentials = vi.fn((input: Parameters<typeof item.config.credentials>[0]) =>
      item.config.credentials(input),
    );
    const query = vi.fn(fakeQuery());
    const adapter = createClaudeHarnessAdapter({ ...item.config, credentials, query });
    expect(await adapter.execute(executionInput({ signal: controller.signal }))).toEqual({
      status: "cancelled",
      usage: null,
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("can cancel while an injected credential resolver is pending", async () => {
    const item = await fixture();
    const controller = new AbortController();
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const query = vi.fn(fakeQuery());
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      credentials: () => {
        started();
        return new Promise<never>(() => {});
      },
      query,
    });
    const pending = adapter.execute(executionInput({ signal: controller.signal }));
    await ready;
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    expect(query).not.toHaveBeenCalled();
  });

  it("marks a timed out execution interrupted only after the child exits", async () => {
    const item = await fixture();
    let exited = false;
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      executionTimeoutMs: 1000,
      query: fakeQuery({
        messages: (options) => [initMessage(options)],
        hang: true,
        inspect: (_options, _prompt, child) =>
          child.once("exit", () => {
            exited = true;
          }),
      }),
    });
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "interrupted",
      code: "TIMED_OUT",
    });
    expect(exited).toBe(true);
  });

  it("allows only named protected MCP entry points and never enables builtin tools", async () => {
    const item = await fixture();
    let options: Options | undefined;
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      protectedTools: [
        {
          name: "read_workspace",
          description: "Read authorized files.",
          inputSchema: {},
          authorize: async () => false,
          execute: async () => "never executed",
        },
      ],
      query: fakeQuery({
        inspect: (value) => {
          options = value;
        },
        messages: (value) => [
          initMessage(value, {
            tools: ["mcp__glassbox__read_workspace"],
            mcp_servers: [{ name: "glassbox", status: "connected" }],
          }),
          resultMessage(),
        ],
      }),
    });
    expect((await adapter.execute(executionInput())).status).toBe("succeeded");
    expect(adapter.capabilities.tools).toBe("protected-mcp");
    expect(adapter.supportsGroup).toBe(false);
    expect(options?.tools).toEqual([]);
    expect(options?.allowedTools).toEqual(["mcp__glassbox__read_workspace"]);
    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "fixture-tool",
      requestId: "fixture-request",
    };
    expect(await options?.canUseTool?.("Bash", {}, permissionOptions)).toMatchObject({
      behavior: "deny",
      interrupt: true,
    });
    expect(
      await options?.canUseTool?.("mcp__owner__private_read", {}, permissionOptions),
    ).toMatchObject({ behavior: "deny" });
  });

  it("reports unknown if actual exit could not be confirmed", async () => {
    const item = await fixture();
    vi.spyOn(InstalledProcess.prototype, "finish").mockResolvedValue(null);
    let exit: Promise<void> = Promise.resolve();
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      query: fakeQuery({
        inspect: (_options, _prompt, child) => {
          exit = new Promise((resolve) => child.once("exit", () => resolve()));
        },
      }),
    });
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "unknown",
      code: "EXIT_UNCONFIRMED",
    });
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "failed",
      code: "INVALID_INPUT",
    });
    await exit;
  });

  it("reconstructs an authorized history after reopen without loading provider sessions", async () => {
    const item = await fixture();
    const workspaces: string[] = [];
    const prompts: string[] = [];
    const query = fakeQuery({
      inspect: (options, prompt) => {
        workspaces.push(options.cwd!);
        prompts.push(prompt);
        expect(options.resume).toBeUndefined();
      },
    });
    expect(
      (await createClaudeHarnessAdapter({ ...item.config, query }).execute(executionInput()))
        .status,
    ).toBe("succeeded");
    const next = executionInput({ history: [] });
    next.run.id = "new-run";
    expect((await createClaudeHarnessAdapter({ ...item.config, query }).execute(next)).status).toBe(
      "succeeded",
    );
    expect(workspaces[0]).not.toBe(workspaces[1]);
    expect(prompts[1]).not.toContain("Previously authorized");
  });

  it("rejects spoofed context and concurrent execution without releasing the first lock", async () => {
    const item = await fixture();
    const controller = new AbortController();
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = createClaudeHarnessAdapter({
      ...item.config,
      query: fakeQuery({ messages: (options) => [initMessage(options)], hang: true }),
      onEvent: (event) => {
        if (event.type === "started") started();
      },
    });
    const first = adapter.execute(executionInput({ signal: controller.signal }));
    await ready;
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "failed",
      code: "INVALID_INPUT",
    });
    expect(await adapter.execute(executionInput())).toMatchObject({
      status: "failed",
      code: "INVALID_INPUT",
    });
    controller.abort();
    expect((await first).status).toBe("cancelled");
    const spoofed = executionInput();
    spoofed.caller.principalId = "visitor";
    expect(await adapter.execute(spoofed)).toMatchObject({
      status: "failed",
      code: "INVALID_INPUT",
    });
  });
});
