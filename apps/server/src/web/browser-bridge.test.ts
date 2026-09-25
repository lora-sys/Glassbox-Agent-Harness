import { describe, expect, it, vi } from "vitest";
import { BrowserBridge, type BrowserAction, type BrowserAuthorizer } from "./browser-bridge.js";
import type {
  BrowserExecutionSession,
  BrowserExecutorPort,
  BrowserExecutorResult,
} from "./browser-executor-port.js";
import type { BrowserSessionBinding } from "./browser-session.js";

const binding: BrowserSessionBinding = {
  runId: "run-1",
  principalId: "owner-1",
  conversationId: "conv-1",
  workspaceId: "workspace-1",
  policyVersion: "policy-4",
};
const publicResolver = async () => ["93.184.215.14"];

function setup(
  options: {
    allow?: boolean;
    result?: (args: readonly string[]) => BrowserExecutorResult | undefined;
  } = {},
) {
  const calls: string[][] = [];
  const openedBindings: Array<{ binding: BrowserSessionBinding; sessionId: string }> = [];
  const authorize = vi.fn<BrowserAuthorizer>(async () => options.allow ?? true);
  let closeCount = 0;
  let cancelCount = 0;
  const execution: BrowserExecutionSession = {
    execute: vi.fn(async (args) => {
      calls.push([...args]);
      const overridden = options.result?.(args);
      if (overridden) return overridden;
      if (args[3] === "get" && args[4] === "url")
        return {
          exitCode: 0,
          stdout: JSON.stringify({ success: true, data: "https://example.com/" }),
          stderr: "",
        };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          data: { text: "ok", url: "https://example.com/" },
        }),
        stderr: "",
      };
    }),
    cancel: vi.fn(async () => {
      cancelCount++;
    }),
    close: vi.fn(async () => {
      closeCount++;
    }),
  };
  const executorOpen = vi.fn(async (sessionBinding: BrowserSessionBinding, sessionId: string) => {
    openedBindings.push({ binding: sessionBinding, sessionId });
    return execution;
  });
  const executor: BrowserExecutorPort = { open: executorOpen };
  const bridge = new BrowserBridge({
    authorize,
    executor,
    resolveHost: publicResolver,
    maxOutputChars: 80,
  });
  return {
    bridge,
    calls,
    authorize,
    executor,
    executorOpen,
    execution,
    openedBindings,
    get closeCount() {
      return closeCount;
    },
    get cancelCount() {
      return cancelCount;
    },
  };
}

describe("agent-browser 0.38.1 bridge", () => {
  it("maps product actions to fixed JSON argv and binds the executor to workspace policy", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const snapshot = await state.bridge.execute(binding, {
      type: "snapshot",
      interactive: true,
      depth: 4,
    });
    expect(state.calls[0]).toEqual([
      "--json",
      "--session",
      expect.stringMatching(/^gb-[a-f0-9]{24}$/u),
      "open",
      "https://example.com/",
    ]);
    expect(state.calls[3]?.slice(0, 3)).toEqual(["--json", "--session", state.calls[0]?.[2]]);
    expect(state.calls[3]?.slice(3)).toEqual(["snapshot", "-i", "-d", "4"]);
    expect(state.openedBindings[0]).toMatchObject({ binding, sessionId: state.calls[0]?.[2] });
    expect(snapshot.output).toBe(JSON.stringify({ text: "ok", url: "https://example.com/" }));
  });

  it("separates tool and fallback sessions under the same run and workspace", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await state.bridge.execute(
      { ...binding, purpose: "fallback" },
      { type: "open", url: "https://example.com/" },
    );
    expect(state.calls[0]?.[2]).not.toBe(state.calls[2]?.[2]);
    expect(state.openedBindings.map(({ binding: opened }) => opened.purpose)).toEqual([
      "tool",
      "fallback",
    ]);
    await state.bridge.cleanup(binding);
    await state.bridge.cleanup({ ...binding, purpose: "fallback" });
  });

  it("isolates browser sessions and snapshot refs across principals", async () => {
    const principalB = { ...binding, principalId: "owner-2" };
    const state = setup({
      result: (args) => {
        const sessionId = args[2];
        if (args[3] === "get" && args[4] === "url")
          return {
            exitCode: 0,
            stdout: JSON.stringify({ success: true, data: "https://example.com/" }),
            stderr: "",
          };
        if (args[3] === "snapshot") {
          const principalId = state.openedBindings.find((opened) => opened.sessionId === sessionId)
            ?.binding.principalId;
          const page = principalId === "owner-1" ? "Owner A private page" : "Owner B page";
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              success: true,
              data: { snapshot: `${page} button [ref=e1]`, url: "https://example.com/" },
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ success: true, data: { url: "https://example.com/" } }),
          stderr: "",
        };
      },
    });

    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const ownerASnapshot = await state.bridge.execute(binding, { type: "snapshot" });
    const ownerASessionId = state.openedBindings[0]?.sessionId;
    expect(ownerASnapshot.output).toContain("Owner A private page");

    await expect(state.bridge.execute(principalB, { type: "snapshot" })).rejects.toThrow(
      "browser_session_not_open",
    );
    await expect(state.bridge.execute(principalB, { type: "click", ref: "@e1" })).rejects.toThrow(
      "browser_session_not_open",
    );
    expect(state.calls.some((args) => args[3] === "snapshot" && args[2] !== ownerASessionId)).toBe(
      false,
    );

    await state.bridge.execute(principalB, { type: "open", url: "https://example.com/" });
    await expect(state.bridge.execute(principalB, { type: "click", ref: "@e1" })).rejects.toThrow(
      "browser_stale_ref",
    );
    const ownerBSnapshot = await state.bridge.execute(principalB, { type: "snapshot" });
    expect(state.openedBindings[1]?.sessionId).not.toBe(ownerASessionId);
    expect(ownerBSnapshot.output).toContain("Owner B page");
    expect(ownerBSnapshot.output).not.toContain("Owner A private page");
    await state.bridge.cleanup(binding);
    await state.bridge.cleanup(principalB);
  });

  it("requires a successful versioned JSON envelope even when the executor exits zero", async () => {
    let getUrlCount = 0;
    const state = setup({
      result: (args) => {
        if (args[3] === "open" || (args[3] === "get" && args[4] === "url" && getUrlCount++ < 2))
          return {
            exitCode: 0,
            stdout: JSON.stringify({ success: true, data: { url: "https://example.com/" } }),
            stderr: "",
          };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            success: false,
            error: "bad selector",
            code: "selector_not_found",
          }),
          stderr: "",
        };
      },
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await expect(state.bridge.execute(binding, { type: "get", kind: "url" })).rejects.toThrow(
      "browser_cli_selector_not_found",
    );
    const invalid = setup({ result: () => ({ exitCode: 0, stdout: "not json", stderr: "" }) });
    await expect(
      invalid.bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_cli_invalid_json");
  });

  it("rejects CLI escapes and parameters outside the fixed product action set", async () => {
    const state = setup();
    for (const action of [
      { type: "eval", code: "document.cookie" },
      { type: "network_route", url: "*" },
      { type: "config", args: ["--headed"] },
    ] as unknown as BrowserAction[]) {
      await expect(state.bridge.execute(binding, action)).rejects.toThrow(
        "browser_action_not_allowed",
      );
    }
    await expect(
      state.bridge.execute(binding, { type: "press", key: "Enter;eval" }),
    ).rejects.toThrow("browser_invalid_key");
    await expect(
      state.bridge.execute(binding, { type: "open", url: "file:///etc/passwd" }),
    ).rejects.toThrow();
    expect(state.executorOpen).not.toHaveBeenCalled();
  });

  it("rejects direct URL reads so redirects cannot bypass the active-page guard", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const before = state.calls.length;
    await expect(
      state.bridge.execute(binding, {
        type: "read",
        url: "https://example.com/redirect",
      } as BrowserAction),
    ).rejects.toThrow("browser_action_not_allowed");
    expect(state.calls).toHaveLength(before);
  });

  it("checks the actual active URL after mutations and closes a failed initial open", async () => {
    let currentUrl = "https://example.com/";
    const state = setup({
      result: (args) => {
        if (args[3] === "get" && args[4] === "url")
          return {
            exitCode: 0,
            stdout: JSON.stringify({ success: true, data: currentUrl }),
            stderr: "",
          };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: args[3] === "snapshot" ? "@e1 button" : {},
          }),
          stderr: "",
        };
      },
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await state.bridge.execute(binding, { type: "snapshot" });
    currentUrl = "http://10.0.0.8/admin";
    await expect(state.bridge.execute(binding, { type: "click", ref: "@e1" })).rejects.toThrow(
      "browser_result_target_denied",
    );
    expect(state.cancelCount).toBe(1);
    expect(state.closeCount).toBe(1);
    await expect(state.bridge.execute(binding, { type: "read" })).rejects.toThrow(
      "browser_session_not_open",
    );

    const failed = setup({ result: () => ({ exitCode: 0, stdout: "invalid", stderr: "" }) });
    await expect(
      failed.bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_cli_invalid_json");
    expect(failed.closeCount).toBe(1);
    expect(failed.cancelCount).toBe(1);
    await expect(
      failed.bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_cli_invalid_json");
  });

  it("closes the session when a navigation redirects to a private target", async () => {
    let currentUrl = "https://example.com/";
    let navigationCount = 0;
    const state = setup({
      result: (args) => {
        if (args[3] === "open" && navigationCount++ > 0)
          currentUrl = "http://169.254.169.254/latest/meta-data/";
        return {
          exitCode: 0,
          stdout: JSON.stringify({ success: true, data: args[3] === "get" ? currentUrl : {} }),
          stderr: "",
        };
      },
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });

    await expect(
      state.bridge.execute(binding, { type: "goto", url: "https://example.com/redirect" }),
    ).rejects.toThrow("browser_result_target_denied");
    expect(state.cancelCount).toBe(1);
    expect(state.closeCount).toBe(1);
    await expect(state.bridge.execute(binding, { type: "read" })).rejects.toThrow(
      "browser_session_not_open",
    );
  });

  it("requires current snapshot refs and expires refs after mutation, navigation, and tab switch", async () => {
    const state = setup({
      result: (args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          data: args[3] === "snapshot" ? "@e1 [button] Submit" : { url: "https://example.com/" },
        }),
        stderr: "",
      }),
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await expect(state.bridge.execute(binding, { type: "click", ref: "@e1" })).rejects.toThrow(
      "browser_stale_ref",
    );
    await state.bridge.execute(binding, { type: "snapshot" });
    await state.bridge.execute(binding, { type: "click", ref: "@e1" });
    await expect(state.bridge.execute(binding, { type: "click", ref: "@e1" })).rejects.toThrow(
      "browser_stale_ref",
    );
    await state.bridge.execute(binding, { type: "snapshot" });
    await state.bridge.execute(binding, { type: "tab_select", tabId: "t2" });
    await expect(state.bridge.execute(binding, { type: "click", ref: "@e1" })).rejects.toThrow(
      "browser_stale_ref",
    );
  });

  it("normalizes a bare snapshot ref while still requiring that exact current ref", async () => {
    const state = setup({
      result: (args) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          data:
            args[3] === "snapshot"
              ? {
                  snapshot: 'textbox "Text input" [ref=e3]\\nbutton "Submit" [ref=e2]',
                  text: "Page copy may mention @e4, but it is not a snapshot reference.",
                  refs: {
                    e3: { role: "textbox", name: "Text input" },
                    e2: { role: "button", name: "Submit" },
                  },
                }
              : { url: "https://example.com/" },
        }),
        stderr: "",
      }),
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await state.bridge.execute(binding, { type: "snapshot", interactive: true });

    await state.bridge.execute(binding, { type: "fill", ref: "e3", text: "form value" });
    expect(state.calls.some((args) => args.slice(3).join(" ") === "fill @e3 form value")).toBe(
      true,
    );
    await expect(
      state.bridge.execute(binding, { type: "fill", ref: "e4", text: "form value" }),
    ).rejects.toThrow("browser_stale_ref");
  });

  it("denies before opening the bound executor session", async () => {
    const state = setup({ allow: false });
    await expect(
      state.bridge.execute(binding, { type: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_denied");
    expect(state.executorOpen).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });

  it("cancels the live executor session when authorization is revoked", async () => {
    const state = setup();
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    state.authorize.mockResolvedValue(false);

    await expect(state.bridge.execute(binding, { type: "snapshot" })).rejects.toThrow(
      "browser_denied",
    );
    expect(state.cancelCount).toBe(1);
    expect(state.closeCount).toBe(1);
    expect(state.calls.some((args) => args[3] === "snapshot")).toBe(false);
  });

  it("withholds a completed browser result when permission is revoked during the call", async () => {
    const state = setup({
      result: (args) => {
        if (args[3] !== "snapshot") return undefined;
        state.authorize.mockResolvedValue(false);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ success: true, data: { text: "private result" } }),
          stderr: "",
        };
      },
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });

    await expect(state.bridge.execute(binding, { type: "snapshot" })).rejects.toThrow(
      "browser_denied",
    );
    expect(state.cancelCount).toBe(1);
    expect(state.closeCount).toBe(1);
  });

  it("returns screenshot artifacts by reference without exposing executor host paths", async () => {
    const state = setup({
      result: (args) =>
        args[3] === "get" && args[4] === "url"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ success: true, data: "https://example.com/" }),
              stderr: "",
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                success: true,
                data: { path: "/private/host/tmp/capture.png" },
              }),
              stderr: "",
              artifact: { id: "artifact-22", mimeType: "image/png", sizeBytes: 1234 },
            },
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const result = await state.bridge.execute(binding, { type: "screenshot" });
    expect(result.artifact).toEqual({ id: "artifact-22", mimeType: "image/png", sizeBytes: 1234 });
    expect(result.output).not.toContain("/private/host");
  });

  it("redacts credential headers and bounds network inspection output", async () => {
    const state = setup({
      result: (args) =>
        args[3] === "network"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                success: true,
                data: {
                  headers: [
                    { name: "Authorization", value: "Bearer secret" },
                    { name: "Cookie", value: "sid=private" },
                    { name: "Accept", value: "*/*" },
                  ],
                  body: "x".repeat(300),
                },
              }),
              stderr: "",
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify({ success: true, data: "https://example.com/" }),
              stderr: "",
            },
    });
    await state.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const result = await state.bridge.execute(binding, {
      type: "network_request",
      requestId: "req-1",
    });
    expect(result.output).toContain("[redacted]");
    expect(result.output).not.toContain("Bearer secret");
    expect(result.output.length).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
  });

  it("closes and forgets its bound executor session during explicit close and cleanup", async () => {
    const explicit = setup();
    await explicit.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await explicit.bridge.execute(binding, { type: "close" });
    expect(explicit.closeCount).toBe(1);

    const cleanup = setup();
    await cleanup.bridge.execute(binding, { type: "open", url: "https://example.com/" });
    await cleanup.bridge.cleanup(binding);
    expect(cleanup.cancelCount).toBe(1);
    expect(cleanup.closeCount).toBe(1);
    await expect(cleanup.bridge.execute(binding, { type: "snapshot" })).rejects.toThrow(
      "browser_session_not_open",
    );
  });
});
