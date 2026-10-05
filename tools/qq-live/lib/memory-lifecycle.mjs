import { fail, safeError } from "./core.mjs";
import { memoryFixtureProject, memoryFixtureStep } from "./memory-scenario.mjs";

const STAGES = ["feedback", "promote", "expire"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CANDIDATE_ID = /^candidate_[a-f0-9]{32}$/;
const MEMORY_ID = /^memory_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function clone(value) {
  return structuredClone(value);
}

function validAcceptance(result, expectedCaseId) {
  const c = result?.transportCase;
  const acceptance = result?.productAcceptance;
  if (
    c?.id !== expectedCaseId ||
    c.route !== "private" ||
    c.status !== "PASS" ||
    c.leaseRevoked !== true ||
    !c.inputBinding ||
    !ID.test(String(c.inputBinding.driverMessageId ?? "")) ||
    !ID.test(String(c.inputBinding.botMessageId ?? "")) ||
    !/^\d{1,30}$/.test(String(c.inputBinding.realSequence ?? "")) ||
    !Number.isSafeInteger(c.inputBinding.time) ||
    !SHA256.test(c.inputBinding.textSha256 ?? "") ||
    acceptance?.status !== "PASS" ||
    !acceptance.runtime ||
    typeof acceptance.runtime.checkout !== "string" ||
    !acceptance.runtime.checkout ||
    typeof acceptance.runtime.dataDirectory !== "string" ||
    !acceptance.runtime.dataDirectory ||
    !/^[a-f0-9]{40}$/.test(acceptance.runtime.commit ?? "") ||
    !Number.isSafeInteger(acceptance.runtime.pid) ||
    !Array.isArray(acceptance.cases) ||
    acceptance.cases.length !== 1
  )
    return null;
  const evidence = acceptance.cases[0];
  if (
    evidence?.caseId !== expectedCaseId ||
    !ID.test(String(evidence.runId ?? "")) ||
    evidence.feature?.runId !== evidence.runId ||
    evidence.traceVerified !== true ||
    evidence.feature?.status !== "PASS" ||
    evidence.scope?.chatType !== "private" ||
    !ID.test(String(evidence.scope?.chatId ?? "")) ||
    !evidence.messageBinding?.input ||
    String(evidence.messageBinding.input.realSequence) !== String(c.inputBinding.realSequence) ||
    evidence.messageBinding.input.time !== c.inputBinding.time ||
    evidence.messageBinding.input.textSha256 !== c.inputBinding.textSha256
  )
    return null;
  return { transportCase: c, acceptance, evidence, runId: evidence.runId };
}

function requireOwnerObservation(observation, projectId, principalId) {
  if (
    !observation ||
    observation.principalKind !== "owner" ||
    typeof observation.principalId !== "string" ||
    !ID.test(observation.principalId) ||
    observation.projectId !== projectId ||
    (principalId && observation.principalId !== principalId)
  )
    fail(
      "MEMORY_LIFECYCLE_OBSERVATION",
      "Readonly Memory 观察结果未能证明本轮 Owner 与项目来源。",
      "INCONCLUSIVE",
    );
}

function stageHandles(handles, stage, runId) {
  return { ...clone(handles), stepRunId: runId, stage };
}

function checkpointSnapshot(phase, stage, handles, steps) {
  return { phase, stage, handles: clone(handles), steps: clone(steps) };
}

async function persistCheckpoint(checkpoint, snapshot) {
  const result = await checkpoint(snapshot);
  if (result === false)
    fail(
      "MEMORY_LIFECYCLE_CHECKPOINT",
      "Durable lifecycle checkpoint was not confirmed.",
      "INCONCLUSIVE",
    );
}

function stopped(stage, handles, steps, code, message, status = "INCONCLUSIVE") {
  return {
    status,
    stage,
    handles: clone(handles),
    steps: clone(steps),
    requiresReconciliation: true,
    error: { code, message },
  };
}

/** Execute the fixed feedback → promote → expire acceptance lifecycle once. */
export async function runMemoryLifecycle({
  fixtureNonce,
  executeStep,
  observeStep,
  checkpoint,
  signal,
}) {
  let projectId;
  try {
    projectId = memoryFixtureProject(fixtureNonce);
  } catch (error) {
    const safe = safeError(error);
    return stopped(
      "feedback",
      { fixtureNonce, projectId: null },
      [],
      safe.code,
      safe.message,
      safe.status,
    );
  }
  if (![executeStep, observeStep, checkpoint].every((callback) => typeof callback === "function")) {
    return stopped(
      "feedback",
      { fixtureNonce, projectId },
      [],
      "MEMORY_LIFECYCLE_CALLBACKS",
      "Memory lifecycle callbacks are required.",
      "BLOCKED",
    );
  }

  const handles = { fixtureNonce, projectId };
  const steps = [];
  let runtimeSnapshot;
  for (const stage of STAGES) {
    if (signal?.aborted)
      return stopped(
        stage,
        handles,
        steps,
        "MEMORY_LIFECYCLE_ABORTED",
        "Lifecycle interrupted before this step.",
      );
    let spec;
    try {
      spec = memoryFixtureStep(stage, {
        nonce: fixtureNonce,
        candidateId: handles.candidateId,
        memoryId: handles.memoryId,
      });
      await persistCheckpoint(checkpoint, checkpointSnapshot("before_send", stage, handles, steps));
    } catch (error) {
      const safe = safeError(error);
      return stopped(stage, handles, steps, safe.code, safe.message, "INCONCLUSIVE");
    }
    if (signal?.aborted)
      return stopped(
        stage,
        handles,
        steps,
        "MEMORY_LIFECYCLE_ABORTED",
        "Lifecycle interrupted before this step.",
      );

    let executed;
    try {
      executed = await executeStep(stage, clone(spec));
    } catch (error) {
      const safe = safeError(error);
      return stopped(stage, handles, steps, safe.code, safe.message, "INCONCLUSIVE");
    }
    const verified = validAcceptance(executed, spec.id);
    if (!verified) {
      const attemptedRunId = executed?.productAcceptance?.cases?.[0]?.runId;
      const failedHandles = ID.test(String(attemptedRunId ?? ""))
        ? { ...handles, stepRunId: attemptedRunId }
        : handles;
      return stopped(
        stage,
        failedHandles,
        steps,
        "MEMORY_LIFECYCLE_ACCEPTANCE",
        "Step lacks complete transport and product evidence.",
      );
    }
    if (steps.some((step) => step.runId === verified.runId))
      return stopped(
        stage,
        { ...handles, stepRunId: verified.runId },
        steps,
        "MEMORY_LIFECYCLE_RUN",
        "Lifecycle steps must use distinct Runs.",
      );
    const currentRuntime = JSON.stringify(verified.acceptance.runtime);
    if (runtimeSnapshot !== undefined && currentRuntime !== runtimeSnapshot)
      return stopped(
        stage,
        { ...handles, stepRunId: verified.runId },
        steps,
        "MEMORY_LIFECYCLE_RUNTIME",
        "Runtime evidence changed during the lifecycle.",
      );
    runtimeSnapshot ??= currentRuntime;
    handles.stepRunId = verified.runId;

    const observationHandles = stageHandles(handles, stage, verified.runId);
    let observation;
    try {
      observation = await observeStep(stage, clone(observationHandles));
      requireOwnerObservation(observation, projectId, handles.principalId);
      if (observation.stepRunId !== verified.runId)
        fail(
          "MEMORY_LIFECYCLE_RUN",
          "Readonly observation belongs to a different Run.",
          "INCONCLUSIVE",
        );
      if (stage === "feedback") {
        if (
          observation.creationRunId !== verified.runId ||
          !CANDIDATE_ID.test(observation.candidateId ?? "") ||
          observation.candidateStatus !== "pending"
        )
          fail(
            "MEMORY_LIFECYCLE_FEEDBACK",
            "Feedback did not create one pending candidate in this Run.",
            "INCONCLUSIVE",
          );
        Object.assign(handles, {
          principalId: observation.principalId,
          creationRunId: verified.runId,
          candidateId: observation.candidateId,
        });
      } else if (stage === "promote") {
        if (
          observation.creationRunId !== handles.creationRunId ||
          observation.candidateId !== handles.candidateId ||
          observation.promoteRunId !== verified.runId ||
          !MEMORY_ID.test(observation.memoryId ?? "") ||
          observation.lifecycleState !== "active"
        )
          fail(
            "MEMORY_LIFECYCLE_PROMOTE",
            "Promote observation does not match the created candidate and current Run.",
            "INCONCLUSIVE",
          );
        Object.assign(handles, { promoteRunId: verified.runId, memoryId: observation.memoryId });
      } else {
        if (
          observation.status !== "expired" ||
          observation.creationRunId !== handles.creationRunId ||
          observation.promoteRunId !== handles.promoteRunId ||
          observation.cleanupRunId !== verified.runId ||
          observation.candidateId !== handles.candidateId ||
          observation.memoryId !== handles.memoryId
        )
          fail(
            "MEMORY_LIFECYCLE_CLEANUP",
            "Cleanup observation does not prove this fixture expired.",
            "INCONCLUSIVE",
          );
        handles.cleanupRunId = verified.runId;
        handles.cleanupStatus = observation.status;
      }
    } catch (error) {
      const safe = safeError(error);
      return stopped(stage, handles, steps, safe.code, safe.message, "INCONCLUSIVE");
    }

    const reportStep = {
      stage,
      currentRunId: verified.runId,
      runId: verified.runId,
      productAcceptance: {
        status: verified.acceptance.status,
        runtime: clone(verified.acceptance.runtime),
        caseId: verified.evidence.caseId,
        traceVerified: verified.evidence.traceVerified,
        featureStatus: verified.evidence.feature.status,
      },
    };
    steps.push(reportStep);
    try {
      await persistCheckpoint(checkpoint, checkpointSnapshot("observed", stage, handles, steps));
    } catch (error) {
      const safe = safeError(error);
      return stopped(stage, handles, steps, safe.code, safe.message, "INCONCLUSIVE");
    }
  }

  return {
    status: "PASS",
    stage: "expire",
    handles: clone(handles),
    steps: clone(steps),
    requiresReconciliation: false,
    cleanup: { status: "expired", runId: handles.cleanupRunId },
  };
}
