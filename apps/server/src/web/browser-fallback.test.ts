import { describe, expect, it, vi } from "vite-plus/test";
import { GuardedBrowserFallback, parseBrowserSearchSnapshot } from "./browser-fallback.js";
import type { BrowserBridge } from "./browser-bridge.js";
import type { BrowserSessionBinding } from "./browser-session.js";

const binding: BrowserSessionBinding = {
  runId: "run-1",
  principalId: "owner-1",
  conversationId: "conversation-1",
  workspaceId: "web-public",
  policyVersion: "policy-1",
};

describe("browser search fallback", () => {
  it("extracts current snapshot refs, not untrusted link destinations", () => {
    const snapshot =
      `- link "DuckDuckGo home" [ref=@e1]\n` +
      `@e2 [link] "Official docs"\n` +
      `- link "Official docs" [ref=@e2]`;
    expect(parseBrowserSearchSnapshot(snapshot, 5)).toEqual([
      { ref: "@e1", title: "DuckDuckGo home" },
      { ref: "@e2", title: "Official docs" },
    ]);
  });

  it("normalizes refs from agent-browser's bracketed snapshot format", () => {
    const snapshot =
      '- searchbox "Enter your search here" [ref=e84]\n- link "Example result" [ref=e85]';
    expect(parseBrowserSearchSnapshot(snapshot, 5)).toEqual([
      { ref: "@e85", title: "Example result" },
    ]);
  });

  it("reads snapshots from the JSON output produced by BrowserBridge", () => {
    expect(
      parseBrowserSearchSnapshot(
        JSON.stringify({ snapshot: '- link "Official docs" [ref=e85]' }),
        5,
      ),
    ).toEqual([{ ref: "@e85", title: "Official docs" }]);
  });

  it("prefers search result landmarks over unrelated navigation links", () => {
    expect(
      parseBrowserSearchSnapshot(
        [
          '- link "Back to Bing search" [ref=e1]',
          '- main "Search Results" [ref=e2]',
          '  - link "example.com" [ref=e3]',
          '  - link "Example documentation" [ref=e4]',
        ].join("\n"),
        5,
      ),
    ).toEqual([
      { ref: "@e3", title: "example.com" },
      { ref: "@e4", title: "Example documentation" },
    ]);
  });

  it("opens the encoded query through the shared browser and extracts current snapshot refs", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async (_binding, action: Record<string, unknown>) => {
      actions.push(action);
      if (action.type === "snapshot")
        return {
          output: JSON.stringify({
            snapshot:
              '- link "Back to Bing search" [ref=e1]\n' +
              '- main "Search Results" [ref=e3]\n' +
              '  - link "example.com" [ref=e4]\n' +
              '  - link "Official docs" [ref=e5]\n' +
              '  - link "Read more" [ref=e6]',
          }),
          truncated: false,
        };
      if (action.type === "get" && action.ref === "@e1")
        return { output: "https://www.bing.com/search", truncated: false };
      if (action.type === "get" && action.ref === "@e4")
        return { output: "https://example.com/docs", truncated: false };
      if (action.type === "get" && action.ref === "@e5")
        return { output: "https://example.com/docs", truncated: false };
      if (action.type === "get" && action.ref === "@e6")
        return { output: "https://example.com/docs", truncated: false };
      return { output: "", truncated: false };
    });
    const cleanup = vi.fn(async () => undefined);
    const fallback = new GuardedBrowserFallback({
      bridge: { execute, cleanup } as unknown as BrowserBridge,
      binding: async () => binding,
      authorize: async () => true,
      resolveHost: async () => ["93.184.215.14"],
    });

    const result = await fallback.search("public query", 5);

    expect(result).toEqual({
      status: "succeeded",
      results: [{ url: "https://example.com/docs", title: "Official docs", highlights: [] }],
    });
    expect(actions[0]).toEqual({ type: "open", url: "https://www.bing.com/search?q=public+query" });
    expect(actions).toContainEqual({
      type: "wait",
      condition: "load",
      value: "domcontentloaded",
    });
    expect(actions).toContainEqual({ type: "get", kind: "attr", ref: "@e4", name: "href" });
    expect(actions).toContainEqual({ type: "get", kind: "attr", ref: "@e5", name: "href" });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("requires read authorization before opening a search URL", async () => {
    const execute = vi.fn();
    const fallback = new GuardedBrowserFallback({
      bridge: { execute, cleanup: vi.fn() } as unknown as BrowserBridge,
      binding: async () => binding,
      authorize: async () => false,
    });
    expect(await fallback.search("query", 5)).toEqual({ status: "fallback_denied", results: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports CAPTCHA as blocked and closes the session", async () => {
    const execute = vi.fn(async (_binding, action: Record<string, unknown>) => ({
      output: action.type === "snapshot" ? "Complete the CAPTCHA challenge" : "",
      truncated: false,
    }));
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const fallback = new GuardedBrowserFallback({
      bridge: { execute, cleanup } as unknown as BrowserBridge,
      binding: async () => binding,
      authorize: async () => true,
    });
    expect(await fallback.search("query", 5)).toEqual({ status: "blocked", results: [] });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports a missing shared executor as unavailable", async () => {
    const fallback = new GuardedBrowserFallback({
      binding: async () => binding,
      authorize: async () => true,
    });
    expect(await fallback.fetch("https://example.com/")).toEqual({ status: "unavailable" });
  });
});

describe("browser fallback content diagnostics", () => {
  function contentFallback(text: string, title = "Technical documentation", truncated = false) {
    const execute = vi.fn(async (_binding, action: Record<string, unknown>) => ({
      output:
        action.type === "read"
          ? text
          : action.kind === "title"
            ? title
            : action.kind === "url"
              ? "https://example.com/docs"
              : "",
      truncated: action.type === "read" && truncated,
    }));
    return new GuardedBrowserFallback({
      bridge: {
        execute,
        cleanup: vi.fn().mockResolvedValue(undefined),
      } as unknown as BrowserBridge,
      binding: async () => binding,
      authorize: async () => true,
    });
  }
  it.each(["challenge", "CAPTCHA", "rate limit", "too many requests"])(
    "reads ordinary articles discussing %s",
    async (word) => {
      const text = `This tutorial explains the ${word} mechanism and how to implement it safely.`;
      expect(await contentFallback(text).fetch("https://example.com/docs")).toMatchObject({
        status: "succeeded",
        text,
      });
    },
  );
  it("reads structured browser output without treating JSON wrapper length as clipping", async () => {
    const text = "A guide to CAPTCHA challenge design.";
    expect(
      await contentFallback(JSON.stringify({ text })).fetch("https://example.com/docs"),
    ).toMatchObject({ status: "succeeded", text, truncated: false });
    expect(
      await contentFallback(JSON.stringify({ text: "Verify you are human" })).fetch(
        "https://example.com/docs",
      ),
    ).toMatchObject({ status: "blocked" });
  });

  it.each([false, true])(
    "reports local clipping even when upstream truncated is %s",
    async (upstream) => {
      const result = await contentFallback("x".repeat(20001), "Large article", upstream).fetch(
        "https://example.com/docs",
      );
      expect(result).toMatchObject({
        status: "succeeded",
        truncated: true,
        text: "x".repeat(20000),
      });
    },
  );
  it.each(["Complete the CAPTCHA challenge", "Verify you are human", "Too many requests"])(
    "still blocks the actual interstitial %s",
    async (text) => {
      expect(await contentFallback(text, text).fetch("https://example.com/docs")).toMatchObject({
        status: "blocked",
      });
    },
  );
  it("does not mistake a CAPTCHA search result for an interstitial", async () => {
    const execute = vi.fn(async (_binding, action: Record<string, unknown>) => ({
      output:
        action.type === "snapshot"
          ? '- main "Search Results"\n  - link "CAPTCHA challenge implementation guide" [ref=e1]'
          : action.type === "get"
            ? "https://example.com/captcha-guide"
            : "",
      truncated: false,
    }));
    const fallback = new GuardedBrowserFallback({
      bridge: {
        execute,
        cleanup: vi.fn().mockResolvedValue(undefined),
      } as unknown as BrowserBridge,
      binding: async () => binding,
      authorize: async () => true,
      resolveHost: async () => ["93.184.215.14"],
    });
    expect(await fallback.search("CAPTCHA", 5)).toMatchObject({
      status: "succeeded",
      results: [{ url: "https://example.com/captcha-guide" }],
    });
  });
});
