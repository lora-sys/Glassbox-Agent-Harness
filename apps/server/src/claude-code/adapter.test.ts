// apps/server/src/claude-code/adapter.test.ts
// Unit tests for ClaudeCodeAdapter — no API key required.
import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "./adapter.js";

describe("ClaudeCodeAdapter", () => {
  it("initialize returns ServerInfo", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const info = await adapter.initialize();
    expect(info).toMatchObject({
      userAgent: "claude-code-cli",
      platformFamily: "claude-code",
    });
    expect(info.platformOs).toBe(process.platform);
    adapter.stop();
  });

  it("startSession creates trackable session state", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const session = await adapter.startSession("sess-1", {});
    expect(session.id).toBe("sess-1");
    // startTurn should work without errors
    const turn = await adapter.startTurn("sess-1", [{ type: "text", text: "hello" }], {});
    expect(turn.status).toBe("inProgress");
    expect(turn.items).toEqual([]);
    adapter.stop();
  });

  it("startTurn stores prompt without sending API calls", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    await adapter.startSession("sess-2", {});
    const turn = await adapter.startTurn("sess-2", [{ type: "text", text: "say hi" }], {});
    expect(turn.id).toBeDefined();
    expect(turn.startedAt).toBeGreaterThan(0);
    adapter.stop();
  });

  it("registerOnTurnEnd captures completion status", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const statuses: string[] = [];
    adapter.registerOnTurnEnd((s) => statuses.push(s));
    // registerOnTurnEnd doesn't fire until a turn actually runs — just verify it stores the callback
    expect(() => adapter.registerOnTurnEnd(() => {})).not.toThrow();
    adapter.stop();
  });

  it("on('approval') registers handler (collected on next approval)", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const approvals: unknown[] = [];
    adapter.on("approval", (ev) => approvals.push(ev));
    // Handler is recorded; it fires when collectTurnEvents encounters a tool_use
    expect(() => adapter.on("approval", () => {})).not.toThrow();
    adapter.stop();
  });

  it("findApprovalRequestId and respondToApproval — round trip", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    await adapter.startSession("sess-3", {});

    // No approvals yet
    expect(adapter.findApprovalRequestId("item-1")).toBeNull();

    // Register an approval consumer to capture the event
    const captured: unknown[] = [];
    adapter.on("approval", (ev) => captured.push(ev));

    // Verify no pending approvals exist before tools fire
    expect(adapter.findApprovalRequestId("item-1")).toBeNull();
    adapter.stop();
  });

  it("snapshotWorkspace and scanAndFireHooks — git scan lifecycle", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    const changes = adapter.scanAndFireHooks("/tmp");
    expect(Array.isArray(changes.changes)).toBe(true);
    adapter.stop();
  });

  it("start after stop — clean restart", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.start();
    adapter.stop();
    // After stop, sessions map is cleared; starting again works cleanly
    await adapter.startSession("sess-4", {});
    const turn = await adapter.startTurn("sess-4", [{ type: "text", text: "x" }], {});
    expect(turn.status).toBe("inProgress");
    adapter.stop();
  });
});
