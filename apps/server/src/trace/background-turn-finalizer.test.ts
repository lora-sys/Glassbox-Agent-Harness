import { describe, expect, it, vi } from "vitest";
import { finalizeBackgroundTurn } from "./background-turn-finalizer.js";

describe("finalizeBackgroundTurn", () => {
  it("records workspace changes once through the trace collector before projection", () => {
    const events: string[] = [];
    const traceCollector = vi.fn((method: string) => events.push("trace:" + method));
    const replayTrace = vi.fn(() => {
      events.push("replay");
      return { state: { sessionId: "session-1" } };
    });

    const result = finalizeBackgroundTurn({
      sessionId: "session-1",
      turnId: "turn-123456789",
      workspace: "/workspace",
      adapter: {
        scanAndFireHooks: vi.fn((workspace) => {
          events.push("scan:" + workspace);
          return { changes: [{ path: "src/file.ts", kind: "modified" }] };
        }),
      },
      result: { turnStatus: "completed" },
      traceCollector,
      reportBackgroundEvidenceFailure: vi.fn(),
      replayTrace,
      broadcastDerivedState: vi.fn((sessionId) => events.push("derived:" + sessionId)),
      broadcastSessionEnded: vi.fn((sessionId) => events.push("ended:" + sessionId)),
      settleSessionTurn: vi.fn((sessionId, turnId) =>
        events.push("settled:" + sessionId + ":" + turnId),
      ),
    });

    expect(result.backgroundEvidence).toEqual({ status: "recorded" });
    expect(traceCollector).toHaveBeenCalledTimes(1);
    expect(traceCollector).toHaveBeenCalledWith("item/fileChange", {
      itemId: "git-turn-123",
      turnId: "turn-123456789",
      changes: [{ path: "src/file.ts", kind: "modified" }],
    });
    expect(events).toEqual([
      "scan:/workspace",
      "trace:item/fileChange",
      "replay",
      "derived:session-1",
      "ended:session-1",
      "settled:session-1:turn-123456789",
    ]);
  });

  it("reports a workspace scan failure and still settles an active turn", () => {
    const events: string[] = [];
    const reportBackgroundEvidenceFailure = vi.fn((_sessionId, outcome) =>
      events.push("scan-failed:" + outcome.errorName),
    );
    const broadcastSessionEnded = vi.fn(() => events.push("ended"));

    const result = finalizeBackgroundTurn({
      sessionId: "session-1",
      turnId: "turn-2",
      workspace: "/workspace",
      adapter: {
        scanAndFireHooks: () => {
          throw Object.assign(new Error("scan failed"), { code: "EACCES" });
        },
      },
      result: { turnStatus: "inProgress" },
      traceCollector: vi.fn(),
      reportBackgroundEvidenceFailure,
      replayTrace: () => {
        events.push("replay");
        return { state: {} };
      },
      broadcastDerivedState: () => events.push("derived"),
      broadcastSessionEnded,
      settleSessionTurn: () => events.push("settled"),
    });

    expect(result.backgroundEvidence).toEqual({
      status: "failed",
      stage: "workspace-scan",
      errorName: "Error",
      errorCode: "EACCES",
    });
    expect(reportBackgroundEvidenceFailure).toHaveBeenCalledWith(
      "session-1",
      result.backgroundEvidence,
    );
    expect(events).toEqual(["scan-failed:Error", "replay", "derived", "settled"]);
    expect(broadcastSessionEnded).not.toHaveBeenCalled();
  });

  it("reports a trace failure without skipping turn settlement", () => {
    const events: string[] = [];
    const reportBackgroundEvidenceFailure = vi.fn((_sessionId, outcome) =>
      events.push("trace-failed:" + outcome.stage),
    );

    const result = finalizeBackgroundTurn({
      sessionId: "session-1",
      turnId: "turn-3",
      workspace: "/workspace",
      adapter: {
        scanAndFireHooks: () => ({
          changes: [{ path: "src/file.ts", kind: "modified" }],
        }),
      },
      result: { turnStatus: "completed" },
      traceCollector: () => {
        throw new Error("trace failed");
      },
      reportBackgroundEvidenceFailure,
      replayTrace: () => {
        events.push("replay");
        return { state: {} };
      },
      broadcastDerivedState: () => events.push("derived"),
      broadcastSessionEnded: () => events.push("ended"),
      settleSessionTurn: () => events.push("settled"),
    });

    expect(result.backgroundEvidence).toEqual({
      status: "failed",
      stage: "trace-collector",
      errorName: "Error",
    });
    expect(events).toEqual([
      "trace-failed:trace-collector",
      "replay",
      "derived",
      "ended",
      "settled",
    ]);
  });
});
