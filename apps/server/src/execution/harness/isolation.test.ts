import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createHarnessEnvironment } from "./environment.js";
import { conversationNamespace, createHarnessLayout } from "./layout.js";
import { observeProcess } from "./process.js";
import { executeProtectedTool, ProtectedToolActivity, protectedToolNames } from "./tools.js";
import { executionInput, harnessFixture } from "./test-fixtures.js";
import type { HarnessEvent, ProtectedHarnessTool } from "./types.js";

const fixtures: Array<Awaited<ReturnType<typeof harnessFixture>>> = [];
async function fixture() {
  const item = await harnessFixture();
  fixtures.push(item);
  return item;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.dispose()));
});

describe("isolated homes and explicit environment", () => {
  it("keeps Windows paths with spaces and excludes inherited configuration and credentials", () => {
    const root = "C:\\Disposable State\\harness";
    const layout = {
      root,
      workspace: `${root}\\workspace`,
      home: `${root}\\home`,
      config: `${root}\\config`,
      temp: `${root}\\temp`,
    };
    const env = createHarnessEnvironment({
      layout,
      executablePath: "C:\\Program Files\\Claude\\claude.exe",
      platform: "win32",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: "explicit-credential" },
      hostEnvironment: {
        SystemRoot: "C:\\Windows",
        HOME: "C:\\Owner",
        ANTHROPIC_API_KEY: "must-not-copy",
        NODE_OPTIONS: "owner-module",
        CLAUDE_CONFIG_DIR: "owner-config",
        HTTP_PROXY: "private-proxy",
      },
    });
    expect(env.PATH).toBe(
      "C:\\Program Files\\Claude;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("explicit-credential");
    expect(env.HOME).toBe(layout.home);
    expect(env.USERPROFILE).toBe(layout.home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(layout.config);
    expect(env.APPDATA).toBe(`${layout.home}\\AppData\\Roaming`);
    expect(JSON.stringify(env)).not.toContain("must-not-copy");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("HTTP_PROXY");
  });

  it("rejects empty, conflicting or injected credential environment", () => {
    const base = {
      layout: {
        root: "/tmp/test",
        workspace: "/tmp/test/work",
        home: "/tmp/test/home",
        config: "/tmp/test/config",
        temp: "/tmp/test/temp",
      },
      executablePath: "/bin/claude",
    };
    for (const credentials of [
      {},
      { ANTHROPIC_API_KEY: "" },
      { ANTHROPIC_API_KEY: "key\nother" },
      { ANTHROPIC_API_KEY: "one", CLAUDE_CODE_OAUTH_TOKEN: "two" },
      { ANTHROPIC_API_KEY: "key", NODE_OPTIONS: "--import=owner" },
    ]) {
      expect(() => createHarnessEnvironment({ ...base, credentials })).toThrow(
        "CREDENTIAL_UNAVAILABLE",
      );
    }
  });

  it("rejects endpoint credentials and allows explicit local endpoints", () => {
    const base = {
      layout: {
        root: "/tmp/test",
        workspace: "/tmp/test/work",
        home: "/tmp/test/home",
        config: "/tmp/test/config",
        temp: "/tmp/test/temp",
      },
      executablePath: "/bin/claude",
      credentials: { ANTHROPIC_API_KEY: "key" },
    };
    for (const apiBaseUrl of [
      "http://remote.example/api",
      "https://user:key@example.org",
      "https://example.org?key=secret",
    ])
      expect(() => createHarnessEnvironment({ ...base, apiBaseUrl })).toThrow();
    expect(
      createHarnessEnvironment({ ...base, apiBaseUrl: "http://127.0.0.1:1234" }).ANTHROPIC_BASE_URL,
    ).toBe("http://127.0.0.1:1234/");
  });

  it("namespaces conversations, principals, connections and execution references", () => {
    const input = executionInput();
    const initial = conversationNamespace(input);
    const next = structuredClone({ ...input, signal: undefined });
    next.run.executionRef = "other-execution";
    expect(conversationNamespace({ ...next, signal: input.signal })).not.toBe(initial);
    input.caller.scope.chatType = "group";
    expect(conversationNamespace(input)).not.toBe(initial);
    input.caller.scope.connectionId = "other-connection";
    expect(conversationNamespace(input)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a symlink beneath the trusted data root", async () => {
    const item = await fixture();
    const outside = path.join(item.directory, "outside");
    await mkdir(item.config.dataDirectory);
    await mkdir(outside);
    await symlink(
      outside,
      path.join(item.config.dataDirectory, "harness"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(createHarnessLayout(item.config.dataDirectory, executionInput())).rejects.toThrow(
      "ISOLATION_VIOLATION",
    );
  });
});

describe("protected MCP authorization", () => {
  function setup(overrides: Partial<ProtectedHarnessTool> = {}) {
    const authorize = vi.fn<ProtectedHarnessTool["authorize"]>(async () => true);
    const execute = vi.fn(async () => "authorized output");
    const definition: ProtectedHarnessTool = {
      name: "read_workspace",
      description: "Read explicitly authorized workspace data.",
      inputSchema: {},
      authorize,
      execute,
      ...overrides,
    };
    const onEvent = vi.fn<(event: HarnessEvent) => Promise<void>>(async () => {});
    const signal = new AbortController().signal;
    return {
      definition,
      authorize,
      execute,
      args: { path: "allowed.txt" },
      input: executionInput(),
      workspace: "/disposable/workspace",
      onEvent,
      signal,
      checkText: (_text: string) => {},
    };
  }

  it("checks execution and result authorization on every tool invocation", async () => {
    const options = setup();
    expect(await executeProtectedTool(options)).toEqual({
      content: [{ type: "text", text: "authorized output" }],
    });
    expect(options.authorize.mock.calls.map((call) => call[1])).toEqual([
      "execute",
      "publish-result",
    ]);
    await executeProtectedTool(options);
    expect(options.authorize).toHaveBeenCalledTimes(4);
    expect(
      options.onEvent.mock.calls.map((call) => (call[0].type === "tool" ? call[0].status : null)),
    ).toEqual(["started", "completed", "started", "completed"]);
  });

  it("does not execute a denied tool", async () => {
    const options = setup({ authorize: async () => false });
    expect(await executeProtectedTool(options)).toMatchObject({ isError: true });
    expect(options.execute).not.toHaveBeenCalled();
  });

  it("withholds results when authorization is revoked during execution", async () => {
    const options = setup({
      authorize: async (_input, phase) => phase === "execute",
      execute: async () => "owner-private-canary",
    });
    const result = await executeProtectedTool(options);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("owner-private-canary");
    expect(JSON.stringify(options.onEvent.mock.calls)).not.toContain("owner-private-canary");
  });

  it("withholds output after abort and never returns raw tool exceptions", async () => {
    const controller = new AbortController();
    const options = setup({
      execute: async () => {
        controller.abort();
        return "private-output";
      },
    });
    expect(await executeProtectedTool({ ...options, signal: controller.signal })).toMatchObject({
      isError: true,
    });
    const failed = await executeProtectedTool(
      setup({
        execute: async () => {
          throw new Error("secret=private-output");
        },
      }),
    );
    expect(JSON.stringify(failed)).not.toContain("private-output");
  });

  it("rejects duplicate and arbitrary MCP tool names", () => {
    const { definition } = setup();
    expect(protectedToolNames([definition])).toEqual(["mcp__glassbox__read_workspace"]);
    expect(() => protectedToolNames([definition, definition])).toThrow("INVALID_INPUT");
    expect(() => protectedToolNames([{ ...definition, name: "Bash(*)" }])).toThrow("INVALID_INPUT");
  });

  it("does not confirm tool shutdown until pending protected work settles", async () => {
    const activity = new ProtectedToolActivity();
    let settle: () => void = () => {};
    const pending = activity.track(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    await Promise.resolve();
    expect(await activity.closeAndWait(1)).toBe(false);
    await expect(activity.track(async () => {})).rejects.toThrow("ISOLATION_VIOLATION");
    settle();
    await pending;
    expect(await activity.closeAndWait(1)).toBe(true);
  });
});

describe("process exit evidence", () => {
  function child() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      killed: true,
      exitCode: null,
      signalCode: null,
      pid: 42,
      kill: () => true,
    });
  }
  it("does not mistake killed, kill success or a running-child error for exit", async () => {
    const process = child();
    let observed = false;
    const promise = observeProcess(process).then((value) => {
      observed = true;
      return value;
    });
    process.emit("error", new Error("secret-provider-error"));
    await Promise.resolve();
    expect(observed).toBe(false);
    process.emit("exit", null, "SIGTERM");
    expect(await promise).toEqual({ kind: "exit", code: null, signal: "SIGTERM" });
  });

  it("distinguishes a failed spawn from an exited process", async () => {
    const process = child();
    const failed = {
      stdin: process.stdin,
      stdout: process.stdout,
      killed: process.killed,
      exitCode: process.exitCode,
      signalCode: process.signalCode,
      kill: process.kill,
      pid: undefined,
      on: process.on.bind(process),
      once: process.once.bind(process),
      off: process.off.bind(process),
    };
    const promise = observeProcess(failed);
    process.emit("error", new Error("spawn ENOENT"));
    expect(await promise).toEqual({ kind: "spawn-error" });
  });
});
