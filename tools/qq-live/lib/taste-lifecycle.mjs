import { fail, safeError } from "./core.mjs";
import {
  messageReplyTimesFollowInput,
  messageTimeBindingKeys,
  messageTimesMatch,
  validMessageTimeBinding,
} from "./message-binding.mjs";
import { tasteFixtureStep } from "./taste-scenario.mjs";

const STAGES = ["feedback", "promote", "negative-feedback", "retire"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CANDIDATE = /^candidate_[a-f0-9]{32}$/;
const MEMORY = /^memory_[a-f0-9]{32}$/;

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function requireStep(result, spec) {
  const c = result?.transportCase;
  const a = result?.productAcceptance;
  const e = a?.cases?.length === 1 ? a.cases[0] : undefined;
  const input = c?.inputBinding;
  const reply = e?.messageBinding?.reply;
  if (
    c?.id !== spec.id ||
    c.route !== "private" ||
    c.status !== "PASS" ||
    c.leaseRevoked !== true ||
    !input ||
    !exactKeys(
      input,
      messageTimeBindingKeys(input, [
        "driverMessageId",
        "botMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !/^[a-f0-9]{64}$/.test(input.textSha256 ?? "") ||
    !/^\d{1,30}$/.test(String(input.realSequence ?? "")) ||
    !validMessageTimeBinding(input) ||
    a?.status !== "PASS" ||
    !a.runtime ||
    e?.caseId !== spec.id ||
    !ID.test(e.runId ?? "") ||
    e.traceVerified !== true ||
    e.cleanupVerified !== true ||
    e.feature?.status !== "PASS" ||
    e.feature.runId !== e.runId ||
    e.scope?.chatType !== "private" ||
    !ID.test(e.scope?.chatId ?? "") ||
    !exactKeys(
      e.messageBinding?.input,
      messageTimeBindingKeys(e.messageBinding?.input, ["realSequence", "time", "textSha256"]),
    ) ||
    !Object.hasOwn(e.messageBinding?.input ?? {}, "driverTime") ||
    !validMessageTimeBinding(e.messageBinding?.input) ||
    e.messageBinding?.input?.textSha256 !== input.textSha256 ||
    String(e.messageBinding.input.realSequence) !== String(input.realSequence) ||
    !messageTimesMatch(input, e.messageBinding.input) ||
    !exactKeys(
      reply,
      messageTimeBindingKeys(reply, [
        "botMessageId",
        "driverMessageId",
        "realSequence",
        "time",
        "textSha256",
      ]),
    ) ||
    !Object.hasOwn(reply, "driverTime") ||
    !validMessageTimeBinding(reply) ||
    !messageReplyTimesFollowInput(e.messageBinding.input, reply)
  )
    fail("TASTE_STEP_EVIDENCE", "偏好步骤缺少独立消息、Run 或许可清理证据。", "INCONCLUSIVE");
  return e;
}

/** No CLI entry exists until checkpoint recovery and whole-family revalidation are wired. */
export async function runTasteLifecycle({
  fixtureNonce,
  executeStep,
  confirmKnownFailure,
  observeStep,
  checkpoint,
  readRuntime,
  signal,
}) {
  const handles = { fixtureNonce, projectId: `qqtest-${fixtureNonce}` };
  const steps = [];
  let stage = STAGES[0];
  let currentSpec;
  let currentResult;
  let currentTransportCase;
  let runtime;
  try {
    if (!/^[a-f0-9]{32}$/.test(fixtureNonce ?? ""))
      fail("TASTE_FIXTURE_NONCE", "偏好测试需要唯一的本轮编号。");
    if (
      ![executeStep, observeStep, checkpoint, readRuntime].every(
        (callback) => typeof callback === "function",
      )
    )
      fail("TASTE_CALLBACKS", "偏好流程需要执行、独立观察和持久检查点。");
    const initialRuntime = await readRuntime();
    if (
      !initialRuntime ||
      !/^[a-f0-9]{40}$/.test(initialRuntime.commit ?? "") ||
      !Number.isSafeInteger(initialRuntime.pid) ||
      initialRuntime.pid <= 0 ||
      typeof initialRuntime.checkout !== "string" ||
      !initialRuntime.checkout ||
      typeof initialRuntime.dataDirectory !== "string" ||
      !initialRuntime.dataDirectory
    )
      fail("TASTE_RUNTIME", "偏好流程需要独立确认的服务身份。", "INCONCLUSIVE");
    runtime = JSON.stringify(initialRuntime);
    const checkRuntime = async () => {
      if (JSON.stringify(await readRuntime()) !== runtime)
        fail("TASTE_RUNTIME_CHANGED", "偏好流程中的服务版本或进程发生变化。", "INCONCLUSIVE");
    };
    const save = async (phase) => {
      if ((await checkpoint(structuredClone({ phase, stage, handles, steps }))) === false)
        fail("TASTE_CHECKPOINT", "偏好检查点未确认持久保存。", "INCONCLUSIVE");
    };
    for (stage of STAGES) {
      if (signal?.aborted) fail("TASTE_ABORTED", "偏好流程已停止。", "INCONCLUSIVE");
      await checkRuntime();
      const spec = tasteFixtureStep(stage, { nonce: fixtureNonce, ...handles });
      currentSpec = spec;
      await save("before_send");
      if (signal?.aborted) fail("TASTE_ABORTED", "偏好流程已停止。", "INCONCLUSIVE");
      await checkRuntime();
      const result = await executeStep(stage, structuredClone(spec));
      currentResult = result;
      currentTransportCase = result?.transportCase;
      if (
        result?.transportCase?.status === "FAIL" &&
        result.transportCase.code === "REPLY_ASSERTION_FAILED"
      ) {
        return await confirmFailure(
          stage,
          spec,
          result.transportCase,
          "REPLY_ASSERTION_FAILED",
          handles,
        );
      }
      const evidence = requireStep(result, spec);
      if (steps.some((step) => step.runId === evidence.runId))
        fail("TASTE_RUN_REUSE", "偏好步骤必须使用不同 Run。", "INCONCLUSIVE");
      const currentRuntime = JSON.stringify(result.productAcceptance.runtime);
      if (runtime !== currentRuntime)
        fail("TASTE_RUNTIME_CHANGED", "偏好流程中的服务版本或进程发生变化。", "INCONCLUSIVE");
      handles.stepRunId = evidence.runId;
      const observed = await observeStep(stage, structuredClone(handles));
      await checkRuntime();
      if (
        observed?.principalKind !== "owner" ||
        !ID.test(observed.principalId ?? "") ||
        observed.projectId !== handles.projectId ||
        observed.stepRunId !== evidence.runId ||
        (handles.principalId && observed.principalId !== handles.principalId)
      )
        fail("TASTE_OBSERVATION", "独立观察未证明本轮 Owner、项目和 Run。", "INCONCLUSIVE");
      handles.principalId ??= observed.principalId;
      if (stage === "feedback") {
        if (
          observed.creationRunId !== evidence.runId ||
          !CANDIDATE.test(observed.candidateId ?? "") ||
          observed.candidateStatus !== "pending"
        )
          fail("TASTE_FEEDBACK", "正反馈未创建本轮待确认候选。", "FAIL");
        Object.assign(handles, {
          creationRunId: evidence.runId,
          candidateId: observed.candidateId,
        });
      } else {
        if (
          observed.creationRunId !== handles.creationRunId ||
          observed.candidateId !== handles.candidateId
        )
          fail("TASTE_ORIGIN", "偏好观察与原始候选来源不一致。", "INCONCLUSIVE");
        if (stage === "promote") {
          if (
            observed.promotionRunId !== evidence.runId ||
            !MEMORY.test(observed.memoryId ?? "") ||
            observed.lifecycleState !== "active"
          )
            fail("TASTE_PROMOTE", "偏好确认未创建本轮有效记录。", "FAIL");
          Object.assign(handles, { promotionRunId: evidence.runId, memoryId: observed.memoryId });
        } else {
          if (
            observed.promotionRunId !== handles.promotionRunId ||
            observed.memoryId !== handles.memoryId
          )
            fail("TASTE_MEMORY", "偏好观察与原始记录不一致。", "INCONCLUSIVE");
          if (stage === "negative-feedback") {
            if (
              observed.negativeRunId !== evidence.runId ||
              !CANDIDATE.test(observed.correctionCandidateId ?? "") ||
              observed.correctionCandidateId === handles.candidateId ||
              observed.correctionStatus !== "pending" ||
              observed.lifecycleState !== "active"
            )
              fail("TASTE_NEGATIVE", "负反馈未创建独立修正候选或提前改变偏好。", "FAIL");
            Object.assign(handles, {
              negativeRunId: evidence.runId,
              correctionCandidateId: observed.correctionCandidateId,
            });
          } else if (
            observed.negativeRunId !== handles.negativeRunId ||
            observed.correctionCandidateId !== handles.correctionCandidateId ||
            observed.cleanupRunId !== evidence.runId ||
            observed.lifecycleState !== "retired" ||
            observed.correctionStatus !== "promoted" ||
            observed.activeCount !== 0 ||
            observed.pendingCount !== 0
          ) {
            fail("TASTE_RETIRE", "偏好退役或完整测试资源清理未获证明。", "FAIL");
          } else handles.cleanupRunId = evidence.runId;
        }
      }
      steps.push({
        stage,
        runId: evidence.runId,
        transportCase: structuredClone(result.transportCase),
        productAcceptance: structuredClone(result.productAcceptance),
        observation: structuredClone(observed),
      });
      await save("observed");
    }
    await checkRuntime();
    return {
      status: "PASS",
      handles,
      steps,
      requiresReconciliation: false,
      cleanup: { status: "retired", runId: handles.cleanupRunId },
    };
  } catch (error) {
    let terminalError = error;
    const safe = safeError(error);
    if (
      safe.status === "FAIL" &&
      [
        "TASTE_FEEDBACK",
        "TASTE_PROMOTE",
        "TASTE_NEGATIVE",
        "TASTE_MEMORY",
        "TASTE_RETIRE",
        "TASTE_FIXTURE_FEEDBACK",
        "TASTE_FIXTURE_PROMOTE",
        "TASTE_FIXTURE_NEGATIVE",
        "TASTE_FIXTURE_CLEANUP",
      ].includes(safe.code) &&
      currentTransportCase?.status === "PASS" &&
      currentResult?.productAcceptance?.status === "PASS"
    ) {
      try {
        return await confirmFailure(stage, currentSpec, currentTransportCase, safe.code, handles);
      } catch (confirmationError) {
        terminalError = confirmationError;
      }
    }
    return {
      status: "INCONCLUSIVE",
      stage,
      handles,
      steps,
      requiresReconciliation: true,
      error: safeError(terminalError),
    };
  }

  async function confirmFailure(failedStage, spec, transportCase, failureCode, currentHandles) {
    if (typeof confirmKnownFailure !== "function")
      fail("TASTE_FAILURE_CLEANUP", "已发送的偏好用例缺少失败清理核验。", "INCONCLUSIVE");
    const proof = await confirmKnownFailure(
      failedStage,
      structuredClone(spec),
      structuredClone(transportCase),
      failureCode,
      structuredClone(currentHandles),
    );
    if (
      proof?.cleanupVerified !== true ||
      !ID.test(proof.runId ?? "") ||
      proof.caseId !== transportCase.id ||
      proof.failureCode !== failureCode ||
      !/^[a-f0-9]{64}$/.test(proof.toolOutputSha256 ?? "")
    )
      fail(
        "TASTE_FAILURE_CLEANUP",
        "已发送的偏好用例缺少终态 Run 或许可清理证据。",
        "INCONCLUSIVE",
      );
    const knownFailure = {
      failureCode,
      sourceCase: structuredClone(transportCase),
      terminalProof: structuredClone(proof),
    };
    await checkpoint({
      phase: "cleanup_confirmed",
      stage: failedStage,
      handles: structuredClone(currentHandles),
      knownFailure,
    });
    return {
      status: "FAIL",
      stage: failedStage,
      handles: currentHandles,
      steps,
      requiresReconciliation: true,
      cleanupConfirmed: true,
      knownFailure,
      error: { code: failureCode, status: "FAIL" },
    };
  }
}
