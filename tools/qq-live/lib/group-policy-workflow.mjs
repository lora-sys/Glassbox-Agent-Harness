import { isDeepStrictEqual } from "node:util";
import { digest, fail, safeError, toolManifestDigest } from "./core.mjs";
import { GROUP_POLICY_FAMILY_ID, groupPolicyStep } from "./group-policy-scenario.mjs";
import { verifyGroupPolicyPreSend, verifyGroupPolicyTransition } from "./group-policy-state.mjs";

const TOKEN = /^[a-f0-9]{32}$/u;
const RUN = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;

function invalid(code = "GROUP_POLICY_WORKFLOW") {
  fail(code, "群策略流程的状态、检查点或执行证据不完整。", "INCONCLUSIVE");
}
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort((a, b) => a.localeCompare(b)),
      [...keys].sort((a, b) => a.localeCompare(b)),
    )
  );
}
function runtimeValid(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.checkout === "string" &&
    value.checkout.length > 0 &&
    typeof value.dataDirectory === "string" &&
    value.dataDirectory.length > 0 &&
    /^[a-f0-9]{40}$/u.test(value.commit ?? "") &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.connectionId === "string" &&
    value.connectionId.length > 0
  );
}
function expectedPrepared(c, spec) {
  if (!TOKEN.test(c?.token ?? "") || c.id !== spec.id || c.route !== "private") invalid();
  const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", c.token));
  if (
    c.prompt !==
      `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${spec.prompt.replaceAll("{{nonce}}", c.token).trim()}` ||
    !isDeepStrictEqual(c.expected, replace(spec.expectContains)) ||
    !isDeepStrictEqual(c.featureAssertions, replace(spec.featureAssertions)) ||
    !isDeepStrictEqual(
      c.leasedToolNames,
      spec.leaseTools.map((t) => t.name),
    )
  )
    invalid();
  return {
    caseId: c.id,
    marker: c.token,
    textSha256: digest(c.prompt),
    route: c.route,
  };
}
function expectedLease(c, spec, lease) {
  const prepared = expectedPrepared(c, spec);
  if (
    !exact(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !UUID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isFinite(Date.parse(c.startedAt)) ||
    lease.expiresAt <= Date.parse(c.startedAt) ||
    lease.toolsSha256 !==
      toolManifestDigest(
        JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", c.token)),
      )
  )
    invalid();
  return { ...prepared, ...lease };
}

/**
 * Run the fixed disable, read-only history check, and restore sequence. The executor must
 * call hooks in the actual lease/send order. Uncertain execution keeps the guard and never
 * triggers a retry or restore; a bound feature failure may restore only after its cleanup proof.
 */
export async function runGroupPolicyWorkflow({
  groupId,
  captureState,
  readRuntime,
  checkpoint,
  executeStep,
  verifyStep,
  signal,
}) {
  const steps = [];
  let stage = "disable";
  let phase = "initial";
  let baseline;
  let durable = false;
  let originalId;
  let runtime;
  const seenStates = new WeakSet();
  const tokens = new Set();
  const leases = new Set();
  let prepared;
  let restoredFeatureFailed = false;
  let disabledState;
  try {
    if (
      ![captureState, readRuntime, checkpoint, executeStep, verifyStep].every(
        (fn) => typeof fn === "function",
      )
    )
      invalid();
    groupPolicyStep(stage, groupId);
    runtime = await readRuntime();
    if (!runtimeValid(runtime)) invalid("GROUP_POLICY_RUNTIME");
    runtime = structuredClone(runtime);
    const check = async () => {
      if (signal?.aborted) invalid("GROUP_POLICY_ABORTED");
      if (!isDeepStrictEqual(await readRuntime(), runtime)) invalid("GROUP_POLICY_RUNTIME_CHANGED");
    };
    const capture = async (includeOriginal = true) => {
      await check();
      const state = await captureState(
        includeOriginal && originalId ? { originalHistoryGrantId: originalId } : undefined,
      );
      if (!state || typeof state !== "object" || seenStates.has(state))
        invalid("GROUP_POLICY_STALE_CAPTURE");
      seenStates.add(state);
      await check();
      return state;
    };
    baseline = await capture(false);
    if (baseline.B?.groupId !== groupId || baseline.connectionId !== runtime.connectionId)
      invalid();
    // Captured state provenance is enforced by the state observer, even for the baseline.
    verifyGroupPolicyPreSend(baseline, baseline, "disable");
    originalId = baseline.B.historyGrants[0].id;
    const save = async (nextPhase, extra = {}) => {
      phase = nextPhase;
      const row = {
        familyId: GROUP_POLICY_FAMILY_ID,
        stage,
        phase,
        runtime,
        baseline,
        steps,
        prepared,
        ...extra,
      };
      // A write may reach storage before throwing. Keep its guard until independent cleanup.
      durable = true;
      if ((await checkpoint(structuredClone(row))) !== true) invalid("GROUP_POLICY_CHECKPOINT");
      await check();
    };
    const freshGuard = async () => {
      const fresh = await capture(stage !== "disable");
      if (stage === "history-check") {
        const disabled = steps.find((step) => step.stage === "disable");
        let proof;
        try {
          proof = verifyGroupPolicyTransition(baseline, fresh, "disable");
        } catch {
          invalid("GROUP_POLICY_HISTORY_GUARD");
        }
        if (!disabled || !isDeepStrictEqual(proof, disabled.proof.stateProof))
          invalid("GROUP_POLICY_HISTORY_STATE");
      } else {
        verifyGroupPolicyPreSend(baseline, fresh, stage);
      }
      await check();
    };
    for (stage of ["disable", "history-check", "restore"]) {
      const spec = groupPolicyStep(stage, groupId);
      prepared = undefined;
      await freshGuard();
      if (stage === "history-check") {
        const disabled = steps.find((step) => step.stage === "disable");
        if (!disabled || !disabledState) invalid("GROUP_POLICY_HISTORY_ORDER");
        const fresh = await capture();
        let disabledProof;
        try {
          disabledProof = verifyGroupPolicyTransition(baseline, fresh, "disable");
        } catch {
          invalid("GROUP_POLICY_HISTORY_DISABLED_STATE");
        }
        if (
          !isDeepStrictEqual(disabledProof, disabled.proof.stateProof) ||
          !isDeepStrictEqual(fresh, disabledState)
        )
          invalid("GROUP_POLICY_HISTORY_STATE");
      }
      await save("intent");
      let hookPhase = "initial";
      let sentMessageId;
      const hooks = {
        beforeRegister: async (c) => {
          if (hookPhase !== "initial") invalid("GROUP_POLICY_HOOK_ORDER");
          await freshGuard();
          prepared = expectedPrepared(c, spec);
          if (tokens.has(prepared.marker)) invalid("GROUP_POLICY_MARKER_REUSE");
          await save("lease_intent");
          hookPhase = "registered_intent";
        },
        beforeSend: async (c, lease) => {
          if (
            hookPhase !== "registered_intent" ||
            !isDeepStrictEqual(expectedPrepared(c, spec), prepared) ||
            !exact(c.acceptanceLease, ["leaseId", "expiresAt", "toolsSha256"]) ||
            !isDeepStrictEqual(c.acceptanceLease, lease)
          )
            invalid("GROUP_POLICY_HOOK_ORDER");
          await freshGuard();
          prepared = expectedLease(c, spec, lease);
          if (leases.has(prepared.leaseId)) invalid("GROUP_POLICY_LEASE_REUSE");
          await save("prepared");
          // Re-read after the prepared checkpoint. Drift during persistence must stop before
          // replyCase invokes sendCase, not merely be noticed after delivery.
          await freshGuard();
          hookPhase = "prepared";
        },
        afterSend: async (c) => {
          if (
            hookPhase !== "prepared" ||
            !isDeepStrictEqual(expectedPrepared(c, spec), {
              caseId: prepared.caseId,
              marker: prepared.marker,
              textSha256: prepared.textSha256,
              route: prepared.route,
            }) ||
            c.sendAttempted !== true ||
            !/^-?\d{1,20}$/u.test(String(c.sentMessageId ?? ""))
          )
            invalid("GROUP_POLICY_HOOK_ORDER");
          sentMessageId = String(c.sentMessageId);
          await save("sent", { driverMessageId: sentMessageId });
          hookPhase = "sent";
        },
      };
      const result = await executeStep(stage, structuredClone(spec), hooks);
      await check();
      const c = result?.transportCase;
      if (
        hookPhase !== "sent" ||
        c?.status !== "PASS" ||
        c.leaseRevoked !== true ||
        c.leaseRegistrationAttempted !== true ||
        c.sendAttempted !== true ||
        c.inputObserved !== true ||
        String(c.sentMessageId) !== sentMessageId ||
        !isDeepStrictEqual(expectedLease(c, spec, c.acceptanceLease), prepared)
      )
        invalid();
      const after = await capture();
      let stateProof;
      try {
        stateProof =
          stage === "history-check"
            ? verifyGroupPolicyTransition(baseline, after, "disable")
            : verifyGroupPolicyTransition(baseline, after, stage);
      } catch {
        invalid("GROUP_POLICY_POST_STATE");
      }
      if (stage === "disable") disabledState = structuredClone(after);
      const proof = await verifyStep({
        stage,
        spec: structuredClone(spec),
        result,
        before: baseline,
        disabled: disabledState,
        after,
      });
      await check();
      const historyCheck = stage === "history-check";
      if (
        (historyCheck
          ? !["HISTORY_REVOCATION_RESULT_VERIFIED", "HISTORY_REVOCATION_RESULT_FAILED"].includes(
              proof?.status,
            )
          : proof?.status !== "GROUP_POLICY_RUN_VERIFIED") ||
        proof.stage !== stage ||
        !RUN.test(proof.runId ?? "") ||
        steps.some((step) => step.runId === proof.runId) ||
        proof.policyVersion !== after.B.version ||
        typeof proof.toolCallId !== "string" ||
        !proof.toolCallId ||
        !HASH.test(proof.toolOutputSha256 ?? "") ||
        proof.actualQqDeliveryVerified !== true ||
        proof.cleanupVerified !== true ||
        !isDeepStrictEqual(proof.stateProof, stateProof)
      )
        invalid("GROUP_POLICY_STEP_EVIDENCE");
      if (proof.cleanupVerified !== true) invalid("GROUP_POLICY_STEP_EVIDENCE");
      if (historyCheck && proof.status === "HISTORY_REVOCATION_RESULT_FAILED")
        restoredFeatureFailed = true;
      steps.push({
        stage,
        runId: proof.runId,
        policyVersion: proof.policyVersion,
        token: c.token,
        leaseId: prepared.leaseId,
        proof,
      });
      tokens.add(c.token);
      leases.add(prepared.leaseId);
      await save("verified");
    }
    const finalState = await capture();
    const finalProof = verifyGroupPolicyTransition(baseline, finalState, "restore");
    await save("restored", { finalProof });
    const checkedFinalState = await capture();
    const checkedFinalProof = verifyGroupPolicyTransition(baseline, checkedFinalState, "restore");
    if (!isDeepStrictEqual(checkedFinalProof, finalProof))
      invalid("GROUP_POLICY_FINAL_STATE_CHANGED");
    return {
      status: restoredFeatureFailed
        ? "GROUP_POLICY_RESTORED_FEATURE_FAILED"
        : "GROUP_POLICY_WORKFLOW_VERIFIED",
      familyId: GROUP_POLICY_FAMILY_ID,
      steps,
      finalProof,
      requiresReconciliation: false,
      actualQqDeliveryVerified: true,
      cleanupVerified: true,
    };
  } catch (error) {
    return {
      status: "INCONCLUSIVE",
      familyId: GROUP_POLICY_FAMILY_ID,
      stage,
      phase,
      steps,
      requiresReconciliation: durable,
      actualQqDeliveryVerified: false,
      error: safeError(error),
    };
  }
}
