import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { digest, fail, toolManifestDigest } from "./core.mjs";
import { groupMembersPolicyStep } from "./group-members-policy-scenario.mjs";
import {
  verifyCaseWithLeaseCleanup,
  verifyLeaseTraceEvidence,
  verifyMessageBindings,
  verifyTraceEvidence,
  runtimeSnapshot,
} from "./product-evidence.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";
import { verifyGroupMembersPolicyFailureWithLeaseCleanup } from "./group-members-policy-case-evidence.mjs";
import {
  captureGroupMembersPolicyState,
  verifyGroupMembersPolicyTransition,
} from "./group-members-policy-state.mjs";
import {
  observeGroupMembersPolicyRun,
  verifyGroupMembersPolicyLeaseTrace,
} from "./group-members-policy-run-evidence.mjs";

const MESSAGE = "群成员权限 Run 的授权、Trace 与独立状态证据缺失或不一致。";
const TOKEN = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/iu;
const MESSAGE_ID = /^-?\d{1,20}$/u;
const TRACE_TYPES = [
  "message_received",
  "delivery_changed",
  "session_start",
  "tool_call",
  "tool_result",
  "group_capability_changed",
  "tool_evidence",
];
function inconclusive() {
  fail("GROUP_MEMBERS_POLICY_STEP_EVIDENCE", MESSAGE, "INCONCLUSIVE");
}
function exactCase(c, spec) {
  const startedAt = Date.parse(c?.startedAt ?? "");
  const expected = spec.expectContains.map((value) => value.replaceAll("{{nonce}}", c.token));
  const feature =
    spec.featureAssertions === undefined
      ? undefined
      : JSON.parse(JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", c.token));
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    !TOKEN.test(c.token ?? "") ||
    c.id !== spec.id ||
    c.route !== "private" ||
    c.status !== "PASS" ||
    c.code !== "REAL_REPLY_RECEIVED" ||
    c.sendAttempted !== true ||
    c.inputObserved !== true ||
    c.leaseRegistrationAttempted !== true ||
    c.leaseRevoked !== true ||
    c.prompt !==
      `GLASSBOX_ACCEPTANCE_V1 ${c.token}\n${spec.prompt.replaceAll("{{nonce}}", c.token).trim()}` ||
    !isDeepStrictEqual(c.expected, expected) ||
    (feature === undefined
      ? Object.hasOwn(c, "featureAssertions")
      : !isDeepStrictEqual(c.featureAssertions, feature)) ||
    !isDeepStrictEqual(
      c.leasedToolNames,
      spec.leaseTools.map((tool) => tool.name),
    ) ||
    !MESSAGE_ID.test(String(c.sentMessageId ?? "")) ||
    !Array.isArray(c.replies) ||
    c.replies.length !== 1 ||
    c.replies[0].route !== "private" ||
    c.replies[0].matches !== true ||
    (spec.requiredEvidenceFailure !== undefined &&
      (c.replies[0].textBytes !== Buffer.byteLength(spec.requiredEvidenceFailure.reply, "utf8") ||
        c.replies[0].textSha256 !== digest(spec.requiredEvidenceFailure.reply))) ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0
  )
    inconclusive();
  const lease = c.acceptanceLease;
  if (
    !lease ||
    !isDeepStrictEqual(Object.keys(lease).sort(), ["expiresAt", "leaseId", "toolsSha256"]) ||
    !UUID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isFinite(startedAt) ||
    lease.expiresAt <= startedAt ||
    lease.toolsSha256 !==
      toolManifestDigest(
        JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", c.token)),
      )
  )
    inconclusive();
}
export function readGroupMembersPolicyTraceEvents(
  checkout,
  dataDirectory,
  runId,
  capture = execFileSync,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId ?? "")) inconclusive();
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
export async function verifyGroupMembersPolicyStep(
  { config, clients, expectedRuntime, stage, spec, result, before, disabled, after } = {},
  deps = {},
) {
  let db;
  try {
    const groupId = config?.groups?.find((group) => group.alias === "B")?.id;
    const fixed = groupMembersPolicyStep(stage, groupId);
    if (!isDeepStrictEqual(spec, fixed)) inconclusive();
    exactCase(result?.transportCase, fixed);
    const readRuntime = deps.runtimeSnapshot ?? runtimeSnapshot;
    const runtimeBefore = await readRuntime(config.runtime);
    if (!expectedRuntime || !isDeepStrictEqual(runtimeBefore, expectedRuntime)) inconclusive();
    const proveCleanup =
      stage === "members-check"
        ? (deps.verifyGroupMembersPolicyFailureWithLeaseCleanup ??
          verifyGroupMembersPolicyFailureWithLeaseCleanup)
        : (deps.verifyCaseWithLeaseCleanup ?? verifyCaseWithLeaseCleanup);
    db = (deps.openReadOnlyDatabase ?? openReadOnlyDatabase)(
      join(runtimeBefore.dataDirectory, "glassbox.db"),
    );
    const verified = await proveCleanup(
      db,
      runtimeBefore.dataDirectory,
      result.transportCase,
      config,
      async (evidence) => {
        const messageBinding = await (deps.verifyMessageBindings ?? verifyMessageBindings)(
          result.transportCase,
          config,
          clients,
          evidence.delivery,
        );
        const trace = (deps.readGroupMembersPolicyTraceEvents ?? readGroupMembersPolicyTraceEvents)(
          runtimeBefore.checkout,
          runtimeBefore.dataDirectory,
          evidence.runId,
          deps.execFileSync ?? execFileSync,
        );
        const events = trace.events.map((row) => row.event);
        if (stage === "members-check")
          verifyGroupMembersPolicyLeaseTrace(events, result.transportCase, evidence.runId);
        (deps.verifyTraceEvidence ?? verifyTraceEvidence)(
          events,
          result.transportCase,
          config,
          evidence.delivery,
          evidence.authorizationProjectionReceipts ?? [],
          evidence.runId,
          evidence.principalId,
        );
        (deps.verifyLeaseTraceEvidence ?? verifyLeaseTraceEvidence)(
          events,
          result.transportCase,
          evidence.runId,
        );
        const state = (deps.captureGroupMembersPolicyState ?? captureGroupMembersPolicyState)(
          db,
          config,
          { originalMemberGrantId: before?.B?.memberGrants?.[0]?.id },
        );
        if (!isDeepStrictEqual(state, after)) inconclusive();
        const proof = (deps.observeGroupMembersPolicyRun ?? observeGroupMembersPolicyRun)({
          db,
          events,
          runId: evidence.runId,
          before,
          disabled,
          after: state,
          stage,
        });
        return { proof, messageBinding, events };
      },
    );
    if (verified?.cleanupVerified !== true) inconclusive();
    const finalState = (deps.captureGroupMembersPolicyState ?? captureGroupMembersPolicyState)(
      db,
      config,
      { originalMemberGrantId: before?.B?.memberGrants?.[0]?.id },
    );
    if (!isDeepStrictEqual(finalState, after)) inconclusive();
    if (
      stage === "members-check" &&
      verifyGroupMembersPolicyTransition(before, finalState, "disable").status !==
        "STATE_TRANSITION_VERIFIED"
    )
      inconclusive();
    const runtimeAfter = await readRuntime(config.runtime);
    if (!isDeepStrictEqual(runtimeAfter, expectedRuntime)) inconclusive();
    const proof = verified.result.proof;
    return {
      ...proof,
      status: proof.status,
      stage,
      policyVersion: after.B.version,
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
