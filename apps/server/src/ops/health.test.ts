import { describe, expect, it } from "vitest";
import type { AgentTask, TaskAttempt, WorkerBinding } from "@glassbox/contracts";
import { buildOpsHealthSnapshot, type OpsHealthInput } from "./health.js";

const now = "2026-09-24T12:00:00.000Z";
const recent = "2026-09-24T11:59:50.000Z";

function task(id: string, status: AgentTask["status"], updatedAt = recent): AgentTask {
  return {
    id,
    title: id,
    status,
    priority: "normal",
    creatorPrincipalId: "owner",
    activeAttemptId: `${id}-attempt`,
    createdAt: recent,
    updatedAt,
  };
}

function attempt(
  id: string,
  taskId: string,
  attemptNumber: number,
  completedAt: string | null,
): TaskAttempt {
  return {
    id,
    taskId,
    attemptNumber,
    status: completedAt ? "succeeded" : "running",
    startedAt: recent,
    completedAt,
  };
}

function binding(taskAttemptId: string): WorkerBinding {
  return {
    id: `${taskAttemptId}-binding`,
    taskAttemptId,
    herdrSession: "session-1",
    workspaceId: "workspace-1",
    paneId: `pane-${taskAttemptId}`,
    agentKind: "coding",
    lastObservedAgentState: "working",
    updatedAt: recent,
  };
}

function input(overrides: Partial<OpsHealthInput> = {}): OpsHealthInput {
  return {
    tasks: [],
    attempts: [],
    bindings: [],
    herdr: {
      bridgeState: "connected",
      eventsLost: false,
      lastSuccessfulReconciliationAt: recent,
      observations: [],
    },
    now,
    windowStart: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildOpsHealthSnapshot", () => {
  it("counts durable acceptance and throughput separately from Herdr done observations", () => {
    const snapshot = buildOpsHealthSnapshot(
      input({
        tasks: [task("accepted", "DONE", now), task("in-review", "REVIEW", now)],
        attempts: [
          attempt("accepted-attempt", "accepted", 1, recent),
          attempt("review-attempt", "in-review", 1, recent),
        ],
        bindings: [binding("review-attempt")],
        herdr: {
          bridgeState: "connected",
          eventsLost: false,
          lastSuccessfulReconciliationAt: recent,
          observations: [{ taskAttemptId: "review-attempt", state: "done", observedAt: recent }],
        },
      }),
    );

    expect(snapshot.durable.acceptedTasksInWindow).toBe(1);
    expect(snapshot.durable.waitingReviewTasks).toBe(1);
    expect(snapshot.durable.attemptsInWindow).toBe(2);
    expect(snapshot.workers.done).toBe(1);
  });

  it("marks cached workers unknown after events_lost until snapshot reconciliation", () => {
    const snapshot = buildOpsHealthSnapshot(
      input({
        bindings: [binding("attempt-1")],
        herdr: {
          bridgeState: "connected",
          eventsLost: true,
          lastSuccessfulReconciliationAt: recent,
          observations: [{ taskAttemptId: "attempt-1", state: "working", observedAt: recent }],
        },
      }),
    );

    expect(snapshot.herdr).toMatchObject({ state: "degraded", stale: true, reason: "events_lost" });
    expect(snapshot.workers).toMatchObject({ working: 0, unknown: 1 });
  });

  it("keeps workers unknown while reconnecting or when live observations expire", () => {
    const reconnecting = buildOpsHealthSnapshot(
      input({
        bindings: [binding("attempt-1")],
        herdr: {
          bridgeState: "reconnecting",
          eventsLost: false,
          lastSuccessfulReconciliationAt: recent,
          observations: [{ taskAttemptId: "attempt-1", state: "working", observedAt: recent }],
        },
      }),
    );
    const observationExpired = buildOpsHealthSnapshot(
      input({
        bindings: [binding("attempt-1")],
        herdr: {
          bridgeState: "connected",
          eventsLost: false,
          lastSuccessfulReconciliationAt: recent,
          observations: [
            {
              taskAttemptId: "attempt-1",
              state: "working",
              observedAt: "2026-09-24T11:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(reconnecting.herdr).toMatchObject({
      state: "unknown",
      stale: true,
      reason: "reconnecting",
    });
    expect(reconnecting.workers.unknown).toBe(1);
    expect(observationExpired.herdr).toMatchObject({ state: "healthy", stale: false });
    expect(observationExpired.workers.unknown).toBe(1);
  });
});
