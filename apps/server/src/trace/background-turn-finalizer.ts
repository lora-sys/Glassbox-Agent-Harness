import type { ProviderAdapter, RunResult } from "../provider/types.js";

type TraceCollector = (method: string, params: Record<string, unknown>) => void;
type FailureStage = "workspace-scan" | "trace-collector";

export type BackgroundEvidenceOutcome =
  | { status: "recorded" | "unchanged" }
  | {
      status: "failed";
      stage: FailureStage;
      errorName: string;
      errorCode?: string;
    };

export interface BackgroundTurnFinalizationResult {
  backgroundEvidence: BackgroundEvidenceOutcome;
}

export interface BackgroundTurnFinalizerInput {
  sessionId: string;
  turnId: string;
  workspace: string;
  adapter: Pick<ProviderAdapter, "scanAndFireHooks">;
  result: Pick<RunResult, "turnStatus">;
  traceCollector: TraceCollector;
  reportBackgroundEvidenceFailure: (
    sessionId: string,
    outcome: Extract<BackgroundEvidenceOutcome, { status: "failed" }>,
  ) => void;
  replayTrace: (sessionId: string) => { state: unknown };
  broadcastDerivedState: (sessionId: string, state: Record<string, unknown>) => void;
  broadcastSessionEnded: (sessionId: string) => void;
  settleSessionTurn: (sessionId: string, turnId: string, status: RunResult["turnStatus"]) => void;
}

function failureOutcome(
  stage: FailureStage,
  error: unknown,
): Extract<BackgroundEvidenceOutcome, { status: "failed" }> {
  const errorName = error instanceof Error ? error.name : typeof error;
  const errorCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    status: "failed",
    stage,
    errorName,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function finalizeBackgroundTurn(
  input: BackgroundTurnFinalizerInput,
): BackgroundTurnFinalizationResult {
  let backgroundEvidence: BackgroundEvidenceOutcome = { status: "unchanged" };
  let changes: ReturnType<ProviderAdapter["scanAndFireHooks"]>["changes"] | undefined;
  try {
    changes = input.adapter.scanAndFireHooks(input.workspace).changes;
    if (changes.length > 0) backgroundEvidence = { status: "recorded" };
  } catch (error) {
    backgroundEvidence = failureOutcome("workspace-scan", error);
    input.reportBackgroundEvidenceFailure(input.sessionId, backgroundEvidence);
  }

  if (changes && changes.length > 0) {
    try {
      input.traceCollector("item/fileChange", {
        itemId: "git-" + input.turnId.slice(0, 8),
        turnId: input.turnId,
        changes,
      });
    } catch (error) {
      backgroundEvidence = failureOutcome("trace-collector", error);
      input.reportBackgroundEvidenceFailure(input.sessionId, backgroundEvidence);
    }
  }

  const replayResult = input.replayTrace(input.sessionId);
  input.broadcastDerivedState(input.sessionId, replayResult.state as Record<string, unknown>);
  if (input.result.turnStatus !== "inProgress") input.broadcastSessionEnded(input.sessionId);
  input.settleSessionTurn(input.sessionId, input.turnId, input.result.turnStatus);
  return { backgroundEvidence };
}
