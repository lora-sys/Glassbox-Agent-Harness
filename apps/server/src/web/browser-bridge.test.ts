import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserBridge,
  type BrowserAuthorizer,
  type BrowserCliExecutionContext,
  type BrowserCliRunner,
} from "./browser-bridge.js";
import type { BrowserSessionBinding } from "./browser-session.js";

const binding: BrowserSessionBinding = {
  runId: "run-1",
  principalId: "owner-1",
  conversationId: "conv-1",
};
const publicResolver = async () => ["93.184.215.14"];
const cleanupSessions: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupSessions.splice(0)) await cleanup();
});

function setup(allow = true) {
  const calls: string[][] = [];
  const contexts: BrowserCliExecutionContext[] = [];
  const runner: BrowserCliRunner = vi.fn(async (args, _timeoutMs, context) => {
    calls.push([...args]);
    contexts.push(context);
    return {
      code: 0,
      stdout: "snapshot result\n- Page URL: https://example.com/\n",
      stderr: "",
    };
  });
  const boundSessions = new Map<string, BrowserSessionBinding>();
  const authorize = vi.fn<BrowserAuthorizer>(async (session) => {
    boundSessions.set(JSON.stringify(session), session);
    return allow;
  });
  let proxyNumber = 0;
  const proxyFactory = vi.fn(() => {
    const proxyServer = `http://proxy:${++proxyNumber}`;
    return { start: async () => proxyServer, close: vi.fn(async () => undefined) };
  });
  const bridge = new BrowserBridge({
    authorize,
    runner,
    proxyFactory,
    resolveHost: publicResolver,
    maxOutputChars: 8,
  });
  cleanupSessions.push(async () => {
    for (const session of boundSessions.values()) await bridge.cleanup(session);
  });
  return { bridge, calls, contexts, authorize, runner, proxyFactory };
}

describe("Playwright CLI bridge", () => {
  it("builds argv from an action allowlist and bounds returned output", async () => {
    const { bridge, calls, contexts, authorize } = setup();
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const result = await bridge.execute(binding, {
      type: "fill",
      ref: "e4",
      value: "text; stays one argument",
    });
    expect(calls[0]).toEqual([
      expect.stringMatching(/^-s=gb-[a-f0-9]{24}$/u),
      "open",
      "https://example.com/",
    ]);
    expect(calls[1]).toEqual([calls[0]![0], "fill", "e4", "text; stays one argument"]);
    expect(contexts[0]).toEqual({ proxyServer: "http://proxy:1" });
    expect(contexts[1]).toEqual(contexts[0]);
    expect(result).toEqual({ output: "snapshot", truncated: true });
    expect(authorize.mock.calls.map((call) => call.slice(1))).toEqual([
      ["browser.read", "open"],
      ["browser.interact", "fill"],
    ]);
  });

  it("checks each explicit navigation target with the network guard", async () => {
    const { bridge, calls } = setup();
    await expect(
      bridge.execute(binding, { type: "open", url: "http://127.0.0.1/private" }),
    ).rejects.toThrow("web_target_non_public");
    expect(calls).toHaveLength(0);
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await expect(
      bridge.execute(binding, { type: "goto", url: "http://10.0.0.1/" }),
    ).rejects.toThrow("web_target_non_public");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["http://169.254.169.254/", "redirect target"],
    ["file:///etc/passwd", "file page"],
    ["javascript:alert(1)", "non-http page"],
  ])("rejects a successful CLI result that reports a %s", async (pageUrl) => {
    const runner: BrowserCliRunner = async () => ({
      code: 0,
      stdout: `### Page\n- Page URL: ${pageUrl}\n- Page Title: unsafe\n`,
      stderr: "",
    });
    const bridge = new BrowserBridge({
      authorize: async () => true,
      runner,
      proxyFactory: () => ({
        start: async () => "http://proxy:8765",
        close: async () => undefined,
      }),
      resolveHost: publicResolver,
    });
    await expect(
      bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_result_target_denied");
  });

  it("rejects private URLs reached by an interaction even when CLI returns code zero", async () => {
    let invocation = 0;
    const runner: BrowserCliRunner = async () => ({
      code: 0,
      stdout: `### Page\n- Page URL: ${++invocation === 1 ? "https://example.com/" : "http://10.0.0.8/admin"}\n`,
      stderr: "",
    });
    const bridge = new BrowserBridge({
      authorize: async () => true,
      runner,
      proxyFactory: () => ({
        start: async () => "http://proxy:8765",
        close: async () => undefined,
      }),
      resolveHost: publicResolver,
    });
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await expect(bridge.execute(binding, { type: "click", ref: "e2" })).rejects.toThrow(
      "browser_result_target_denied",
    );
  });

  it("allows the explicit about:blank state for a newly created tab", async () => {
    const runner: BrowserCliRunner = async () => ({
      code: 0,
      stdout: "### Page\n- Page URL: about:blank\n- Page Title: \n",
      stderr: "",
    });
    const bridge = new BrowserBridge({
      authorize: async () => true,
      runner,
      proxyFactory: () => ({
        start: async () => "http://proxy:8765",
        close: async () => undefined,
      }),
      resolveHost: publicResolver,
    });
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await expect(bridge.execute(binding, { type: "tab_new" })).resolves.toMatchObject({
      output: expect.stringContaining("about:blank"),
    });
  });

  it("fails closed when a successful page action omits its final Page URL", async () => {
    const runner: BrowserCliRunner = async () => ({
      code: 0,
      stdout: "action complete",
      stderr: "",
    });
    const bridge = new BrowserBridge({
      authorize: async () => true,
      runner,
      proxyFactory: () => ({
        start: async () => "http://proxy:8765",
        close: async () => undefined,
      }),
      resolveHost: publicResolver,
    });
    await expect(
      bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_result_page_url_missing");
  });

  it("requires a fresh session for every Run and Principal binding", async () => {
    const { bridge, calls } = setup();
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await bridge.execute(
      { ...binding, runId: "run-2" },
      { type: "open", url: "https://example.com/" },
    );
    await bridge.execute(
      { ...binding, principalId: "owner-2" },
      { type: "open", url: "https://example.com/" },
    );
    expect(new Set(calls.map((call) => call[0])).size).toBe(3);
  });

  it("denies actions before launching the CLI and separates read from interaction", async () => {
    const { bridge, calls, authorize } = setup(false);
    await expect(bridge.execute(binding, { type: "snapshot" })).rejects.toThrow("browser_denied");
    await expect(bridge.execute(binding, { type: "click", ref: "e2" })).rejects.toThrow(
      "browser_denied",
    );
    expect(authorize.mock.calls.map((call) => call[1])).toEqual([
      "browser.read",
      "browser.interact",
    ]);
    expect(calls).toHaveLength(0);
  });

  it("rejects unsupported payloads and action parameters before launch", async () => {
    const { bridge, calls } = setup();
    await expect(bridge.execute(binding, { type: "snapshot", depth: 99 })).rejects.toThrow(
      "browser_invalid_depth",
    );
    await expect(bridge.execute(binding, { type: "click", ref: "--help" })).rejects.toThrow(
      "browser_invalid_ref",
    );
    await expect(bridge.execute(binding, { type: "press", key: "Enter;run-code" })).rejects.toThrow(
      "browser_invalid_key",
    );
    await expect(
      bridge.execute(binding, { type: "fill", ref: "e2", value: "--submit" }),
    ).rejects.toThrow("browser_invalid_text");
    await expect(
      bridge.execute(binding, { type: "run-code", code: "page.goto('file:///')" } as never),
    ).rejects.toThrow("browser_action_not_allowed");
    await expect(bridge.execute(binding, { type: "screenshot" })).rejects.toThrow(
      "browser_action_unsupported_file_output",
    );
    await expect(bridge.execute(binding, { type: "response_body", index: 1 })).rejects.toThrow(
      "browser_action_unsupported_file_output",
    );
    await expect(bridge.execute(binding, { type: "request_body", index: 1 })).rejects.toThrow(
      "browser_action_unsupported_file_output",
    );
    await expect(bridge.execute(binding, { type: "download_observation" })).rejects.toThrow(
      "browser_action_unsupported_download_observation",
    );
    await expect(
      bridge.execute(binding, { type: "wait", condition: "selector", value: "#content" }),
    ).rejects.toThrow("browser_action_unsupported_wait");
    expect(calls).toHaveLength(0);
  });

  it("maps safe navigation, tab, console, request-header, and text actions to fixed argv", async () => {
    const { bridge, calls, authorize } = setup();
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const actions = [
      [{ type: "go_back" }, ["go-back"], "browser.read"],
      [{ type: "go_forward" }, ["go-forward"], "browser.read"],
      [{ type: "reload" }, ["reload"], "browser.read"],
      [{ type: "tab_list" }, ["tab-list"], "browser.read"],
      [{ type: "tab_new" }, ["tab-new"], "browser.interact"],
      [{ type: "tab_select", index: 2 }, ["tab-select", "2"], "browser.interact"],
      [{ type: "tab_close", index: 3 }, ["tab-close", "3"], "browser.interact"],
      [{ type: "console", level: "warning" }, ["console", "warning"], "browser.read"],
      [{ type: "requests" }, ["requests"], "browser.read"],
      [{ type: "request_headers", index: 4 }, ["request-headers", "4"], "browser.read"],
      [{ type: "response_headers", index: 5 }, ["response-headers", "5"], "browser.read"],
      [
        { type: "type", text: "hello; still one argument" },
        ["type", "hello; still one argument"],
        "browser.interact",
      ],
    ] as const;

    for (const [action, expectedArgs] of actions) {
      await bridge.execute(binding, action as never);
      expect(calls.at(-1)?.slice(1)).toEqual(expectedArgs);
    }
    expect(authorize.mock.calls.slice(1).map((call) => call[1])).toEqual(
      actions.map(([, , capability]) => capability),
    );
  });

  it("rejects invalid tab, request, and console parameters", async () => {
    const { bridge, calls } = setup();
    await expect(bridge.execute(binding, { type: "tab_select", index: 100 })).rejects.toThrow(
      "browser_invalid_tab_index",
    );
    await expect(bridge.execute(binding, { type: "request_headers", index: 1001 })).rejects.toThrow(
      "browser_invalid_request_index",
    );
    await expect(
      bridge.execute(binding, { type: "console", level: "--raw" } as never),
    ).rejects.toThrow("browser_invalid_console_level");
    expect(calls).toHaveLength(0);
  });

  it("requires an opened session for reads and interactions and closes only its session", async () => {
    const { bridge, calls } = setup();
    await expect(bridge.execute(binding, { type: "snapshot" })).rejects.toThrow(
      "browser_session_not_open",
    );
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const cliSession = calls[0]![0];
    await bridge.cleanup(binding);
    expect(calls[1]).toEqual([cliSession, "close"]);
    await expect(bridge.execute(binding, { type: "snapshot" })).rejects.toThrow(
      "browser_session_not_open",
    );
  });

  it("authorizes close as an interaction and releases the session resources", async () => {
    const { bridge, calls, authorize, proxyFactory } = setup();
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await bridge.execute(binding, { type: "close" });
    expect(calls.map((call) => call[1])).toEqual(["open", "close"]);
    expect(authorize.mock.calls.at(-1)?.slice(1)).toEqual(["browser.interact", "close"]);
    expect(proxyFactory.mock.results[0]?.value.close).toHaveBeenCalledOnce();
    await expect(bridge.execute(binding, { type: "snapshot" })).rejects.toThrow(
      "browser_session_not_open",
    );
  });

  it("keeps a possibly started session available for cleanup after CLI failure", async () => {
    let first = true;
    const runner: BrowserCliRunner = async () => {
      if (first) {
        first = false;
        return { code: 1, stdout: "", stderr: "failure" };
      }
      return { code: 0, stdout: "### Page\n- Page URL: https://example.com/\n", stderr: "" };
    };
    const bridge = new BrowserBridge({
      authorize: async () => true,
      runner,
      proxyFactory: () => ({
        start: async () => "http://proxy:8765",
        close: async () => undefined,
      }),
      resolveHost: publicResolver,
    });
    await expect(
      bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_cli_failed");
    await expect(
      bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_session_already_open");
    await bridge.cleanup(binding);
  });

  it("always releases proxy resources and forgets the session when cleanup fails", async () => {
    let failClose = true;
    const calls: string[][] = [];
    let proxyClosed = false;
    const runner: BrowserCliRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "close" && failClose) {
        failClose = false;
        return { code: 1, stdout: "", stderr: "failure" };
      }
      return { code: 0, stdout: "### Page\n- Page URL: https://example.com/\n", stderr: "" };
    };
    const bridge = new BrowserBridge({
      authorize: async () => true,
      runner,
      proxyFactory: () => ({
        start: async () => "http://proxy:8765",
        close: async () => {
          proxyClosed = true;
        },
      }),
      resolveHost: publicResolver,
    });
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await expect(bridge.cleanup(binding)).rejects.toThrow("browser_cleanup_failed");
    await bridge.cleanup(binding);
    expect(proxyClosed).toBe(true);
    expect(calls.map((call) => call[1])).toEqual(["open", "close"]);
  });

  it("releases proxy resources and forgets the session when the CLI close call throws", async () => {
    let proxyClosed = false;
    const runner: BrowserCliRunner = async (args) => {
      if (args[1] === "close") throw new Error("runner disconnected");
      return { code: 0, stdout: "### Page\n- Page URL: https://example.com/\n", stderr: "" };
    };
    const bridge = new BrowserBridge({
      authorize: async () => true,
      runner,
      proxyFactory: () => ({
        start: async () => "http://proxy:8765",
        close: async () => {
          proxyClosed = true;
        },
      }),
      resolveHost: publicResolver,
    });
    await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await expect(bridge.cleanup(binding)).rejects.toThrow("runner disconnected");
    expect(proxyClosed).toBe(true);
    await expect(bridge.execute(binding, { type: "snapshot" })).rejects.toThrow(
      "browser_session_not_open",
    );
  });
});
