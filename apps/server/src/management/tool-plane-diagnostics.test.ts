import { describe, expect, it } from "vite-plus/test";
import type { TraceEntry } from "../trace/store.js";
import {
  projectToolPlaneDiagnostics,
  TOOL_PLANE_DIAGNOSTIC_RECORD_CAP,
} from "./tool-plane-diagnostics.js";

function trace(type: string, data: Record<string, unknown>, seq: number): TraceEntry<unknown> {
  return {
    seq,
    ts: `2026-09-23T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    provenance: "pi",
    event: { type, timestamp: `2026-09-23T00:00:${String(seq % 60).padStart(2, "0")}.000Z`, data },
  };
}

const surfaceEvent = (providerReadiness: "ready" | "unavailable" | "unknown" = "unknown") =>
  trace(
    "session_start",
    {
      privatePrompt: "do not expose",
      toolSurface: {
        profileName: "qq-group",
        generatedAt: "2026-09-23T00:00:00.000Z",
        selected: [{ name: "qq_groups", provider: "qq-napcat", providerReadiness }],
        excluded: [
          {
            name: "owner_group_admin",
            provider: "local",
            providerReadiness: "unknown",
            reason: "scope_not_permitted",
          },
        ],
        undescribed: ["unmapped-secret-tool"],
      },
    },
    1,
  );

describe("Owner Tool-plane diagnostic projection", () => {
  it("reports readiness as unknown and records a complete no-call trace without inventing success", () => {
    const report = projectToolPlaneDiagnostics({
      runId: "run-a",
      records: [surfaceEvent()],
      complete: true,
    });
    expect(report.surface).toMatchObject({
      observed: true,
      selectedCount: 1,
      excludedCount: 1,
      undescribedCount: 1,
      tools: [
        {
          name: "qq_groups",
          providerReadiness: "unknown",
          lastExecution: { outcome: "not_called" },
        },
        {
          name: "owner_group_admin",
          exclusionReason: "scope_not_permitted",
          lastExecution: { outcome: "not_called" },
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("privatePrompt");
    expect(JSON.stringify(report)).not.toContain("unmapped-secret-tool");
  });

  it("preserves unavailable provider readiness and leaves no-call unknown when the trace is incomplete", () => {
    const report = projectToolPlaneDiagnostics({
      runId: "run-a",
      records: [surfaceEvent("unavailable")],
      complete: false,
    });
    expect(report.trace.complete).toBe(false);
    expect(report.surface.tools[0]).toMatchObject({
      providerReadiness: "unavailable",
      lastExecution: null,
    });
  });

  it("reports only the last call outcome and never includes tool input or result content", () => {
    const report = projectToolPlaneDiagnostics({
      runId: "run-a",
      records: [
        surfaceEvent("ready"),
        trace(
          "tool_call",
          { name: "qq_groups", toolCallId: "call-1", input: { canary: "private-input" } },
          2,
        ),
        trace(
          "tool_result",
          {
            name: "qq_groups",
            toolCallId: "call-1",
            isError: true,
            failureCode: "provider_failed",
            result: "private-result",
          },
          3,
        ),
        trace(
          "tool_call",
          { name: "qq_groups", toolCallId: "call-2", input: { canary: "private-input-2" } },
          4,
        ),
        trace(
          "tool_result",
          { name: "qq_groups", toolCallId: "call-2", isError: false, result: "private-result-2" },
          5,
        ),
      ],
      complete: true,
    });
    expect(report.surface.tools[0]?.lastExecution).toMatchObject({
      outcome: "success",
      calledAt: "2026-09-23T00:00:04.000Z",
      completedAt: "2026-09-23T00:00:05.000Z",
    });
    expect(JSON.stringify(report)).not.toContain("private-input");
    expect(JSON.stringify(report)).not.toContain("private-result");
  });

  it("caps the trace slice and marks a no-call result unknown when later evidence may be truncated", () => {
    const records = [
      surfaceEvent("ready"),
      ...Array.from({ length: TOOL_PLANE_DIAGNOSTIC_RECORD_CAP }, (_, index) =>
        trace("message_chunk", { text: "private body" }, index + 2),
      ),
    ];
    const report = projectToolPlaneDiagnostics({ runId: "run-a", records, complete: false });
    expect(report.trace).toEqual({
      complete: false,
      recordsRead: TOOL_PLANE_DIAGNOSTIC_RECORD_CAP,
      recordCap: TOOL_PLANE_DIAGNOSTIC_RECORD_CAP,
    });
    expect(report.surface.tools[0]?.lastExecution).toBeNull();
    expect(JSON.stringify(report)).not.toContain("private body");
  });
});
