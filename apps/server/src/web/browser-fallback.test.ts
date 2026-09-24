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
    const snapshot = `- link "DuckDuckGo home" [ref=@e1]\n- link "Official docs" [ref=@e2]\n- link "Official docs" [ref=@e2]`;
    expect(parseBrowserSearchSnapshot(snapshot, 5)).toEqual([
      { ref: "@e1", title: "DuckDuckGo home" },
      { ref: "@e2", title: "Official docs" },
    ]);
  });

  it("requires both read and interaction before filling the search form", async () => {
    const execute = vi.fn();
    const fallback = new GuardedBrowserFallback({
      bridge: { execute, cleanup: vi.fn() } as unknown as BrowserBridge,
      binding: async () => binding,
      authorize: async (_binding, capability) => capability === "browser.read",
    });
    expect(await fallback.search("query", 5)).toEqual({ status: "fallback_denied", results: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports CAPTCHA as blocked and closes the session", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ output: "", truncated: false })
      .mockResolvedValueOnce({ output: "Complete the CAPTCHA challenge", truncated: false });
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
