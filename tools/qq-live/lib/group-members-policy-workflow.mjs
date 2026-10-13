import { isDeepStrictEqual } from "node:util";
import { digest, fail, safeError, toolManifestDigest } from "./core.mjs";
import {
  GROUP_MEMBERS_POLICY_FAMILY_ID,
  groupMembersPolicyStep,
} from "./group-members-policy-scenario.mjs";
import {
  verifyGroupMembersPolicyPreSend,
  verifyGroupMembersPolicyTransition,
} from "./group-members-policy-state.mjs";

const TOKEN = /^[a-f0-9]{32}$/u;
const RUN = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
function invalid(code = "GROUP_MEMBERS_POLICY_WORKFLOW") {
  fail(code, "群成员权限流程的状态、检查点或执行证据不完整。", "INCONCLUSIVE");
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
    value &&
    typeof value === "object" &&
    typeof value.checkout === "string" &&
    value.checkout &&
    typeof value.dataDirectory === "string" &&
    value.dataDirectory &&
    /^[a-f0-9]{40}$/u.test(value.commit ?? "") &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.connectionId === "string" &&
    value.connectionId
  );
}
function preparedCase(c, spec) {
  if (!TOKEN.test(c?.token ?? "") || c.id !== spec.id || c.route !== "private") invalid();
  const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", c.token));
  if (
    c.prompt !==
      `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${spec.prompt.replaceAll("{{nonce}}", c.token).trim()}` ||
    !isDeepStrictEqual(c.expected, replace(spec.expectContains)) ||
    (spec.featureAssertions !== undefined &&
      !isDeepStrictEqual(c.featureAssertions, replace(spec.featureAssertions))) ||
    !isDeepStrictEqual(
      c.leasedToolNames,
      spec.leaseTools.map((tool) => tool.name),
    )
  )
    invalid();
  return { caseId: c.id, marker: c.token, textSha256: digest(c.prompt), route: c.route };
}
function expectedLease(c, spec, lease) {
  const prepared = preparedCase(c, spec);
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

/** Run the fixed disable, fail-closed Owner-private check, and restore flow. */
export async function runGroupMembersPolicyWorkflow({
  groupId,
  captureState,
  readRuntime,
  checkpoint,
  executeStep,
  verifyStep,
  signal,
} = {}) {
  const steps = [];
  let stage = "disable",
    phase = "initial",
    baseline,
    originalId,
    runtime,
    durable = false;
  let prepared, disabledState;
  const snapshots = new WeakSet(),
    tokens = new Set(),
    leases = new Set();
  try {
    if (
      ![captureState, readRuntime, checkpoint, executeStep, verifyStep].every(
        (fn) => typeof fn === "function",
      )
    )
      invalid();
    groupMembersPolicyStep(stage, groupId);
    runtime = await readRuntime();
    if (!runtimeValid(runtime)) invalid("GROUP_MEMBERS_POLICY_RUNTIME");
    runtime = structuredClone(runtime);
    const check = async () => {
      if (signal?.aborted) invalid("GROUP_MEMBERS_POLICY_ABORTED");
      if (!isDeepStrictEqual(await readRuntime(), runtime))
        invalid("GROUP_MEMBERS_POLICY_RUNTIME_CHANGED");
    };
    const capture = async (withOriginal = true) => {
      await check();
      const state = await captureState(
        withOriginal && originalId ? { originalMemberGrantId: originalId } : undefined,
      );
      if (!state || typeof state !== "object" || snapshots.has(state))
        invalid("GROUP_MEMBERS_POLICY_STALE_CAPTURE");
      snapshots.add(state);
      await check();
      return state;
    };
    baseline = await capture(false);
    if (baseline.B?.groupId !== groupId || baseline.connectionId !== runtime.connectionId)
      invalid();
    verifyGroupMembersPolicyPreSend(baseline, baseline, "disable");
    originalId = baseline.B.memberGrants[0].id;
    const save = async (nextPhase, extra = {}) => {
      phase = nextPhase;
      const row = {
        familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
        stage,
        phase,
        runtime,
        baseline,
        steps,
        prepared,
        ...extra,
      };
      durable = true;
      if ((await checkpoint(structuredClone(row))) !== true)
        invalid("GROUP_MEMBERS_POLICY_CHECKPOINT");
      await check();
    };
    const freshGuard = async () => {
      const fresh = await capture(stage !== "disable");
      if (stage === "disable") verifyGroupMembersPolicyPreSend(baseline, fresh, stage);
      else {
        const disabledStep = steps.find((step) => step.stage === "disable");
        let observed;
        try {
          observed = verifyGroupMembersPolicyTransition(baseline, fresh, "disable");
        } catch {
          invalid("GROUP_MEMBERS_POLICY_DISABLED_STATE");
        }
        if (!disabledStep || !isDeepStrictEqual(observed, disabledStep.proof.stateProof))
          invalid("GROUP_MEMBERS_POLICY_DISABLED_STATE");
      }
    };
    for (stage of ["disable", "members-check", "restore"]) {
      const spec = groupMembersPolicyStep(stage, groupId);
      prepared = undefined;
      await freshGuard();
      if (stage === "members-check") {
        const disabled = steps.find((step) => step.stage === "disable");
        const fresh = await capture();
        if (
          !disabled ||
          !disabledState ||
          !isDeepStrictEqual(
            verifyGroupMembersPolicyTransition(baseline, fresh, "disable"),
            disabled.proof.stateProof,
          ) ||
          !isDeepStrictEqual(fresh, disabledState)
        )
          invalid("GROUP_MEMBERS_POLICY_ORDER");
      }
      await save("intent");
      let hookPhase = "initial",
        sentMessageId;
      const hooks = {
        beforeRegister: async (c) => {
          if (hookPhase !== "initial") invalid("GROUP_MEMBERS_POLICY_HOOK_ORDER");
          await freshGuard();
          prepared = preparedCase(c, spec);
          if (tokens.has(prepared.marker)) invalid("GROUP_MEMBERS_POLICY_MARKER_REUSE");
          await save("lease_intent");
          hookPhase = "registered_intent";
        },
        beforeSend: async (c, lease) => {
          if (
            hookPhase !== "registered_intent" ||
            !isDeepStrictEqual(preparedCase(c, spec), prepared) ||
            !exact(c.acceptanceLease, ["leaseId", "expiresAt", "toolsSha256"]) ||
            !isDeepStrictEqual(c.acceptanceLease, lease)
          )
            invalid("GROUP_MEMBERS_POLICY_HOOK_ORDER");
          await freshGuard();
          prepared = expectedLease(c, spec, lease);
          if (leases.has(prepared.leaseId)) invalid("GROUP_MEMBERS_POLICY_LEASE_REUSE");
          await save("prepared");
          await freshGuard();
          hookPhase = "prepared";
        },
        afterSend: async (c) => {
          if (
            hookPhase !== "prepared" ||
            c.sendAttempted !== true ||
            !isDeepStrictEqual(preparedCase(c, spec), {
              caseId: prepared.caseId,
              marker: prepared.marker,
              textSha256: prepared.textSha256,
              route: prepared.route,
            }) ||
            !/^-?\d{1,20}$/u.test(String(c.sentMessageId ?? ""))
          )
            invalid("GROUP_MEMBERS_POLICY_HOOK_ORDER");
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
          stage === "members-check"
            ? verifyGroupMembersPolicyTransition(baseline, after, "disable")
            : verifyGroupMembersPolicyTransition(baseline, after, stage);
      } catch {
        invalid("GROUP_MEMBERS_POLICY_POST_STATE");
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
      const checkStage = stage === "members-check";
      const checkStatus = proof?.status === "GROUP_MEMBERS_POLICY_REQUIRED_EVIDENCE_MISSING";
      if (
        (checkStage ? !checkStatus : proof?.status !== "GROUP_MEMBERS_POLICY_RUN_VERIFIED") ||
        proof.stage !== stage ||
        !RUN.test(proof.runId ?? "") ||
        steps.some((s) => s.runId === proof.runId) ||
        proof.policyVersion !== after.B.version ||
        (checkStage
          ? proof.toolCallId !== null || proof.toolOutputSha256 !== null
          : typeof proof.toolCallId !== "string" ||
            !proof.toolCallId ||
            !HASH.test(proof.toolOutputSha256 ?? "")) ||
        proof.actualQqDeliveryVerified !== true ||
        proof.cleanupVerified !== true ||
        !isDeepStrictEqual(proof.stateProof, stateProof)
      )
        invalid("GROUP_MEMBERS_POLICY_STEP_EVIDENCE");
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
    const finalProof = verifyGroupMembersPolicyTransition(baseline, finalState, "restore");
    await save("restored", { finalProof });
    const checkedFinal = await capture();
    if (
      !isDeepStrictEqual(
        verifyGroupMembersPolicyTransition(baseline, checkedFinal, "restore"),
        finalProof,
      )
    )
      invalid("GROUP_MEMBERS_POLICY_FINAL_STATE_CHANGED");
    return {
      status: "GROUP_MEMBERS_POLICY_BOUNDARY_VERIFIED",
      familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
      steps,
      finalProof,
      requiresReconciliation: false,
      actualQqDeliveryVerified: true,
      cleanupVerified: true,
    };
  } catch (error) {
    return {
      status: "INCONCLUSIVE",
      familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
      stage,
      phase,
      steps,
      requiresReconciliation: durable,
      actualQqDeliveryVerified: false,
      error: safeError(error),
    };
  }
}
