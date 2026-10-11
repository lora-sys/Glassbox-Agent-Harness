import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { fail, toolManifestDigest } from "./core.mjs";
import { groupPolicyStep } from "./group-policy-scenario.mjs";
import { captureGroupPolicyState, verifyGroupPolicyTransition } from "./group-policy-state.mjs";
import {
  verifyCaseWithLeaseCleanup,
  verifyLeaseTraceEvidence,
  verifyMessageBindings,
  verifyTraceEvidence,
  runtimeSnapshot,
} from "./product-evidence.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";
import { observeGroupPolicyRun } from "./group-policy-run-evidence.mjs";
import { observeHistoryRevocationResult } from "./history-revocation-result.mjs";

const MESSAGE = "群策略 Run 的授权、Trace 与独立状态证据缺失或不一致。";
const TOKEN = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const RUN = /^[A-Za-z0-9_-]{1,128}$/u;
const MESSAGE_ID = /^-?\d{1,20}$/u;
const TRACE_TYPES = [
  "message_received",
  "delivery_changed",
  "session_start",
  "tool_call",
  "tool_result",
  "group_history_changed",
  "history_retrieval",
];

function inconclusive() {
  fail("GROUP_POLICY_STEP_EVIDENCE", MESSAGE, "INCONCLUSIVE");
}

function exactCase(caseRecord, spec) {
  const startedAt = Date.parse(caseRecord?.startedAt ?? "");
  if (
    !caseRecord ||
    typeof caseRecord !== "object" ||
    Array.isArray(caseRecord) ||
    !TOKEN.test(caseRecord.token ?? "") ||
    caseRecord.id !== spec.id ||
    caseRecord.route !== "private" ||
    caseRecord.status !== "PASS" ||
    caseRecord.code !== "REAL_REPLY_RECEIVED" ||
    caseRecord.sendAttempted !== true ||
    caseRecord.inputObserved !== true ||
    caseRecord.leaseRegistrationAttempted !== true ||
    caseRecord.leaseRevoked !== true ||
    caseRecord.prompt !==
      `GLASSBOX_ACCEPTANCE_V1 ${caseRecord.token}\n${spec.prompt.replaceAll("{{nonce}}", caseRecord.token).trim()}` ||
    !isDeepStrictEqual(
      caseRecord.expected,
      spec.expectContains.map((value) => value.replaceAll("{{nonce}}", caseRecord.token)),
    ) ||
    !isDeepStrictEqual(
      caseRecord.featureAssertions,
      JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", caseRecord.token)),
    ) ||
    !isDeepStrictEqual(
      caseRecord.leasedToolNames,
      spec.leaseTools.map((tool) => tool.name),
    ) ||
    !MESSAGE_ID.test(String(caseRecord.sentMessageId ?? "")) ||
    !Array.isArray(caseRecord.replies) ||
    caseRecord.replies.length !== 1 ||
    caseRecord.replies[0]?.route !== "private" ||
    caseRecord.replies[0]?.matches !== true ||
    !MESSAGE_ID.test(String(caseRecord.replies[0]?.messageId ?? "")) ||
    !Array.isArray(caseRecord.anomalies) ||
    caseRecord.anomalies.length !== 0
  )
    inconclusive();

  const lease = caseRecord.acceptanceLease;
  const leasedTools = JSON.parse(
    JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", caseRecord.token),
  );
  if (
    !lease ||
    typeof lease !== "object" ||
    Array.isArray(lease) ||
    !isDeepStrictEqual(Object.keys(lease).sort(), ["expiresAt", "leaseId", "toolsSha256"]) ||
    !UUID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isFinite(startedAt) ||
    lease.expiresAt <= startedAt ||
    lease.toolsSha256 !== toolManifestDigest(leasedTools)
  )
    inconclusive();
}

export function readGroupPolicyTraceEvents(checkout, dataDirectory, runId, capture = execFileSync) {
  if (!RUN.test(runId ?? "")) inconclusive();
  try {
    const args = [
      join(checkout, ".agents/skills/glassbox-ops/scripts/gbxtrace.mjs"),
      "events",
      runId,
      ...TRACE_TYPES.flatMap((type) => ["--type", type]),
      "--json",
      "--data-dir",
      join(dataDirectory, "runs"),
    ];
    const parsed = JSON.parse(
      capture(process.execPath, args, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (!Array.isArray(parsed?.events)) inconclusive();
    return parsed;
  } catch {
    inconclusive();
  }
}

/** Verify one fixed Owner-private group-policy mutation and its exact Run evidence. */
export async function verifyGroupPolicyStep(
  { config, clients, expectedRuntime, stage, spec, result, before, after } = {},
  deps = {},
) {
  let db;
  try {
    const fixedSpec = groupPolicyStep(
      stage,
      config?.groups?.find((group) => group.alias === "B")?.id,
    );
    if (!isDeepStrictEqual(spec, fixedSpec)) inconclusive();
    const transportCase = result?.transportCase;
    exactCase(transportCase, fixedSpec);

    const readRuntime = deps.runtimeSnapshot ?? runtimeSnapshot;
    const runtimeBefore = await readRuntime(config.runtime);
    if (!expectedRuntime || !isDeepStrictEqual(runtimeBefore, expectedRuntime)) inconclusive();

    const proveLeaseCleanup = deps.verifyCaseWithLeaseCleanup ?? verifyCaseWithLeaseCleanup;
    const openDatabase = deps.openReadOnlyDatabase ?? openReadOnlyDatabase;
    const freshState = deps.captureGroupPolicyState ?? captureGroupPolicyState;
    const readTrace = deps.readGroupPolicyTraceEvents ?? readGroupPolicyTraceEvents;
    const bindMessages = deps.verifyMessageBindings ?? verifyMessageBindings;
    const checkTrace = deps.verifyTraceEvidence ?? verifyTraceEvidence;
    const checkLeaseTrace = deps.verifyLeaseTraceEvidence ?? verifyLeaseTraceEvidence;
    const observeRun = deps.observeGroupPolicyRun ?? observeGroupPolicyRun;

    db = openDatabase(join(runtimeBefore.dataDirectory, "glassbox.db"));
    const verified = await proveLeaseCleanup(
      db,
      runtimeBefore.dataDirectory,
      transportCase,
      config,
      async (evidence) => {
        const messageBinding = await bindMessages(
          transportCase,
          config,
          clients,
          evidence.delivery,
        );
        const trace = readTrace(
          runtimeBefore.checkout,
          runtimeBefore.dataDirectory,
          evidence.runId,
          deps.execFileSync ?? execFileSync,
        );
        const events = trace.events.map((row) => row.event);
        checkTrace(events, transportCase, config, evidence.delivery);
        checkLeaseTrace(events, transportCase, evidence.runId);
        const independentlyRead = freshState(db, config, {
          originalHistoryGrantId: before?.B?.historyGrants?.[0]?.id,
        });
        if (!isDeepStrictEqual(independentlyRead, after)) inconclusive();
        const proof = observeRun({
          db,
          events,
          runId: evidence.runId,
          before,
          after: independentlyRead,
          stage,
        });
        return { proof, messageBinding };
      },
    );
    if (verified?.cleanupVerified !== true) inconclusive();

    const finalState = freshState(db, config, {
      originalHistoryGrantId: before?.B?.historyGrants?.[0]?.id,
    });
    if (!isDeepStrictEqual(finalState, after)) inconclusive();
    const runtimeAfter = await readRuntime(config.runtime);
    if (!isDeepStrictEqual(runtimeAfter, expectedRuntime)) inconclusive();

    return {
      ...verified.result.proof,
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
      messageBinding: verified.result.messageBinding,
    };
  } catch {
    inconclusive();
  } finally {
    try {
      db?.close();
    } catch {
      inconclusive();
    }
  }
}

/** Verify the fixed read-only history check and its exact zero-source projection. */
export async function verifyGroupPolicyHistoryStep(
  { config, clients, expectedRuntime, stage, spec, result, before, disabled, after } = {},
  deps = {},
) {
  let db;
  try {
    const groupId = config?.groups?.find((group) => group.alias === "B")?.id;
    const fixedSpec = groupPolicyStep("history-check", groupId);
    if (
      stage !== "history-check" ||
      !isDeepStrictEqual(spec, fixedSpec) ||
      disabled?.B?.policy?.categories?.["group.history"] !== false ||
      disabled?.B?.policy?.memorySources?.history !== false ||
      disabled?.B?.historyGrants?.length !== 0 ||
      !isDeepStrictEqual(disabled, after)
    )
      inconclusive();
    const transportCase = result?.transportCase;
    exactCase(transportCase, fixedSpec);

    const readRuntime = deps.runtimeSnapshot ?? runtimeSnapshot;
    const runtimeBefore = await readRuntime(config.runtime);
    if (!expectedRuntime || !isDeepStrictEqual(runtimeBefore, expectedRuntime)) inconclusive();

    const proveLeaseCleanup = deps.verifyCaseWithLeaseCleanup ?? verifyCaseWithLeaseCleanup;
    const openDatabase = deps.openReadOnlyDatabase ?? openReadOnlyDatabase;
    const freshState = deps.captureGroupPolicyState ?? captureGroupPolicyState;
    const readTrace = deps.readGroupPolicyTraceEvents ?? readGroupPolicyTraceEvents;
    const bindMessages = deps.verifyMessageBindings ?? verifyMessageBindings;
    const checkTrace = deps.verifyTraceEvidence ?? verifyTraceEvidence;
    const checkLeaseTrace = deps.verifyLeaseTraceEvidence ?? verifyLeaseTraceEvidence;

    db = openDatabase(join(runtimeBefore.dataDirectory, "glassbox.db"));
    const verified = await proveLeaseCleanup(
      db,
      runtimeBefore.dataDirectory,
      transportCase,
      config,
      async (evidence) => {
        const messageBinding = await bindMessages(
          transportCase,
          config,
          clients,
          evidence.delivery,
        );
        const trace = readTrace(
          runtimeBefore.checkout,
          runtimeBefore.dataDirectory,
          evidence.runId,
          deps.execFileSync ?? execFileSync,
        );
        const events = trace.events.map((row) => row.event);
        checkTrace(events, transportCase, config, evidence.delivery);
        checkLeaseTrace(events, transportCase, evidence.runId);
        const independentlyRead = freshState(db, config, {
          originalHistoryGrantId: before?.B?.historyGrants?.[0]?.id,
        });
        if (!isDeepStrictEqual(independentlyRead, after)) inconclusive();
        const assertion = {
          ...fixedSpec.historyRevocationResult,
          query: transportCase.token,
        };
        const projection = observeHistoryRevocationResult(assertion, {
          db,
          config,
          before,
          disabled,
          events,
          runId: evidence.runId,
        });
        return { projection, events, messageBinding, runId: evidence.runId };
      },
    );
    if (verified?.cleanupVerified !== true) inconclusive();

    const finalState = freshState(db, config, {
      originalHistoryGrantId: before?.B?.historyGrants?.[0]?.id,
    });
    if (!isDeepStrictEqual(finalState, after)) inconclusive();
    const runtimeAfter = await readRuntime(config.runtime);
    if (!isDeepStrictEqual(runtimeAfter, expectedRuntime)) inconclusive();

    const projection = verified.result.projection;
    return {
      ...projection,
      status:
        projection.status === "FAIL"
          ? "HISTORY_REVOCATION_RESULT_FAILED"
          : "HISTORY_REVOCATION_RESULT_VERIFIED",
      stage: "history-check",
      runId: verified.result.runId,
      policyVersion: after.B.version,
      toolCallId: verified.result.events.find((event) => event.type === "tool_call")?.toolCallId,
      toolOutputSha256: verified.result.events.find((event) => event.type === "tool_result")?.data
        ?.outputSha256,
      stateProof: verifyGroupPolicyTransition(before, after, "disable"),
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
      messageBinding: verified.result.messageBinding,
    };
  } catch {
    inconclusive();
  } finally {
    try {
      db?.close();
    } catch {
      inconclusive();
    }
  }
}
