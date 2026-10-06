import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { observeFeature, validateFeatureAssertions } from "./feature-observer.mjs";
import {
  caseEvidence,
  readTraceEvents,
  runtimeInspectionSnapshot,
  verifyLeaseTraceEvidence,
  verifyTraceEvidence,
} from "./product-evidence.mjs";
import { verifyLeaseCleanupEvidence } from "./lease-cleanup-evidence.mjs";
import { HISTORY_FAMILY_ID, verifyHistoryFamilyReport } from "./history-family-evidence.mjs";
import {
  HISTORY_ISOLATION_FAMILY_ID,
  verifyHistoryIsolationFamilyReport,
} from "./history-isolation-family-evidence.mjs";

const OLD_FINAL_CASE = "history-seed-recall";
const NEW_FINAL_CASE = "history-cross-group-private-exclusion";
const HISTORY_CASES = new Set([OLD_FINAL_CASE, "history-cross-group-seed", NEW_FINAL_CASE]);

function invalid() {
  throw new Error("Archived history family evidence did not verify");
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function familyKind(report) {
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const hasHistoryCase = cases.some((item) => HISTORY_CASES.has(item?.id));
  const hasHistoryAssertion = cases.some(
    (item) =>
      Array.isArray(item?.featureAssertions) &&
      item.featureAssertions.some((assertion) =>
        ["history_seed_result", "history_exclusion_result"].includes(assertion?.kind),
      ),
  );
  const hasIsolationSentinel = cases.some(
    (item) =>
      typeof item?.prompt === "string" && /qq-isolation-secret-[a-f0-9]{32}/.test(item.prompt),
  );
  if (
    report?.historyFamily !== undefined ||
    report?.historyFamilyAcceptance !== undefined ||
    report?.historySeedWorkflow !== undefined ||
    report?.historyIsolationWorkflow !== undefined ||
    hasHistoryCase ||
    hasHistoryAssertion ||
    hasIsolationSentinel
  ) {
    if (report?.historyFamily?.caseId === HISTORY_FAMILY_ID) return "seed";
    if (report?.historyFamily?.caseId === HISTORY_ISOLATION_FAMILY_ID) return "isolation";
    invalid();
  }
  return null;
}

function buildConfig(report, familyCases) {
  const accepted = report.productAcceptance?.cases;
  if (!Array.isArray(accepted) || accepted.length !== 2) invalid();
  const scopes = familyCases.map((c) => {
    const matches = accepted.filter((item) => item?.caseId === c.id);
    if (matches.length !== 1) invalid();
    return matches[0].scope;
  });
  const [first, second] = scopes;
  if (
    !first ||
    !second ||
    first.connectionId !== second.connectionId ||
    first.botId !== second.botId ||
    first.senderId !== second.senderId ||
    (first.threadId ?? null) !== (second.threadId ?? null)
  )
    invalid();
  const seedGroup = familyCases[0].route;
  const secondGroup = familyCases[1].featureAssertions?.find(
    (a) => a.kind === "history_seed_result" || a.kind === "history_exclusion_result",
  )?.groupId;
  const groups =
    familyCases[0].id === "history-cross-group-seed"
      ? [
          { alias: "A", id: String(secondGroup ?? "") },
          { alias: "B", id: String(seedGroup ?? "") },
        ]
      : [{ alias: "A", id: String(seedGroup ?? "") }];
  if (
    !/^[1-9]\d{0,15}$/.test(groups[0].id) ||
    (groups.length === 2 &&
      (!/^[1-9]\d{0,15}$/.test(groups[1].id) || groups[0].id === groups[1].id))
  )
    invalid();
  return {
    runtime: {
      expectedCommit: report.runtime?.commit,
      connectionId: report.runtime?.connectionId,
      threadId: report.runtime?.threadId ?? null,
    },
    bot: { qq: first.botId },
    driver: { qq: first.senderId },
    groups,
  };
}

function exactInputTrace(
  events,
  caseRecord,
  scope,
  runId,
  messageId,
  conversationId,
  text,
  delivery,
) {
  const received = events.filter(
    (event) => event?.runId === runId && event.type === "message_received",
  );
  if (
    received.length !== 1 ||
    String(received[0].externalId) !== String(caseRecord.inputBinding?.botMessageId) ||
    received[0].messageId !== messageId ||
    received[0].conversationId !== conversationId ||
    received[0].connectionId !== scope.connectionId ||
    received[0].botId !== scope.botId ||
    received[0].chatType !== scope.chatType ||
    received[0].chatId !== scope.chatId ||
    received[0].senderId !== scope.senderId ||
    (received[0].threadId ?? null) !== (scope.threadId ?? null) ||
    received[0].textSha256 !== caseRecord.inputBinding?.textSha256 ||
    received[0].textBytes !== Buffer.byteLength(text, "utf8")
  )
    invalid();
  const sentEvents = events.filter(
    (event) =>
      event?.runId === runId && event.type === "delivery_changed" && event.status === "sent",
  );
  if (
    sentEvents.length !== 1 ||
    sentEvents[0].deliveryId !== delivery.id ||
    String(sentEvents[0].externalId) !== String(delivery.external_id)
  )
    invalid();
  return received[0];
}

async function observeArchivedCases(
  report,
  evidence,
  familyCases,
  config,
  capture,
  historyBindings,
) {
  const db = new DatabaseSync(join(evidence.dataDirectory, "glassbox.db"), {
    readOnly: true,
  });
  try {
    const freshCases = [];
    let ownerPrincipalId;
    let forbiddenSentinel;
    if (familyCases[0].id === "history-cross-group-seed") {
      const matches = familyCases[0].prompt?.match(/qq-isolation-secret-[a-f0-9]{32}/g) ?? [];
      if (matches.length !== 1) invalid();
      forbiddenSentinel = matches[0].toLocaleLowerCase("en-US");
    }

    for (const [index, caseRecord] of familyCases.entries()) {
      const acceptedMatches = report.productAcceptance.cases.filter(
        (item) => item?.caseId === caseRecord.id,
      );
      if (acceptedMatches.length !== 1) invalid();
      const accepted = acceptedMatches[0];
      const actual = caseEvidence(db, caseRecord, config);
      const actualDecisions = actual.decisions.map((item) => ({
        id: item.id,
        action: item.action,
        decision: item.decision,
      }));
      const delivery = {
        id: actual.delivery.id,
        status: actual.delivery.status,
        external_id: actual.delivery.external_id,
        destination_scope_key: actual.delivery.destination_scope_key,
      };
      const expectedRunId = (report.historySeedWorkflow ?? report.historyIsolationWorkflow)
        ?.stageRunIds?.[index];
      if (
        actual.runId !== expectedRunId ||
        accepted.runId !== actual.runId ||
        accepted.traceVerified !== true ||
        !isDeepStrictEqual(accepted.scope, actual.scope)
      )
        invalid();
      if (!isDeepStrictEqual(accepted.decisions, actualDecisions)) invalid();
      if (!isDeepStrictEqual(accepted.delivery, delivery)) invalid();

      const run = db
        .prepare(
          "SELECT r.principal_id, r.conversation_id, r.message_id, m.external_id, m.text, m.scope_key, c.principal_id AS conversation_principal_id, c.scope_key AS conversation_scope_key FROM runs r JOIN messages m ON m.id=r.message_id JOIN conversations c ON c.id=r.conversation_id WHERE r.id=?",
        )
        .get(actual.runId);
      const principal =
        run && db.prepare("SELECT kind FROM principals WHERE id=?").get(run.principal_id);
      if (
        !run ||
        principal?.kind !== "owner" ||
        (ownerPrincipalId !== undefined && run.principal_id !== ownerPrincipalId) ||
        run.conversation_principal_id !== run.principal_id ||
        run.scope_key !== actual.delivery.destination_scope_key ||
        run.conversation_scope_key !== run.scope_key ||
        String(run.external_id) !== String(caseRecord.inputBinding?.botMessageId) ||
        typeof run.text !== "string" ||
        run.text !== caseRecord.prompt ||
        hashText(run.text) !== caseRecord.inputBinding?.textSha256
      )
        invalid();
      ownerPrincipalId = run.principal_id;

      const allDeliveries = db
        .prepare(
          "SELECT id, status, external_id, destination_scope_key, payload_text, payload_kind FROM deliveries WHERE run_id=?",
        )
        .all(actual.runId);
      const sent = allDeliveries.filter((item) => item.status === "sent");
      if (
        sent.length !== 1 ||
        allDeliveries.some((item) => ["pending", "sending", "unknown"].includes(item.status)) ||
        sent[0].id !== actual.delivery.id ||
        sent[0].external_id !== actual.delivery.external_id ||
        sent[0].destination_scope_key !== actual.delivery.destination_scope_key ||
        !["text", "result"].includes(sent[0].payload_kind) ||
        typeof sent[0].payload_text !== "string" ||
        Buffer.byteLength(sent[0].payload_text, "utf8") === 0 ||
        [...sent[0].payload_text].length > 3500 ||
        sent[0].payload_text.includes("[CQ:")
      )
        invalid();

      const reply = accepted.messageBinding?.reply;
      if (
        !reply ||
        String(reply.botMessageId) !== String(sent[0].external_id) ||
        !/^[a-f0-9]{64}$/.test(reply.textSha256 ?? "") ||
        hashText(sent[0].payload_text) !== reply.textSha256 ||
        caseRecord.replies?.length !== 1 ||
        caseRecord.replies[0].textBytes !== Buffer.byteLength(sent[0].payload_text, "utf8") ||
        (index === 1 &&
          forbiddenSentinel &&
          sent[0].payload_text.toLocaleLowerCase("en-US").includes(forbiddenSentinel))
      )
        invalid();

      let actualMessageBinding;
      try {
        actualMessageBinding = await historyBindings(caseRecord, config, delivery);
      } catch {
        invalid();
      }
      if (!isDeepStrictEqual(actualMessageBinding, accepted.messageBinding)) invalid();

      const types =
        caseRecord.featureAssertions
          ?.filter((item) => item.kind === "trace")
          .map((item) => item.type) ?? [];
      types.push("tool_call", "tool_result", "history_retrieval");
      const trace = readTraceEvents(
        evidence.checkout,
        evidence.dataDirectory,
        actual.runId,
        capture,
        types,
      );
      if (trace.runId !== actual.runId || !Array.isArray(trace.events)) invalid();
      const events = trace.events.map((row) => row.event);
      exactInputTrace(
        events,
        caseRecord,
        actual.scope,
        actual.runId,
        run.message_id,
        run.conversation_id,
        run.text,
        delivery,
      );
      verifyTraceEvidence(events, caseRecord, config, delivery);
      verifyLeaseTraceEvidence(events, caseRecord, actual.runId);
      const promptHash = hashText(caseRecord.prompt);
      if (
        promptHash !== caseRecord.inputBinding.textSha256 ||
        accepted.messageBinding?.input?.textSha256 !== promptHash
      )
        invalid();

      const feature = observeFeature(validateFeatureAssertions(caseRecord.featureAssertions), {
        db,
        events,
        runId: actual.runId,
        inputBinding: caseRecord.inputBinding,
      });
      if (feature.status !== "PASS" || !isDeepStrictEqual(accepted.feature, feature)) invalid();
      const leaseCleanup = await verifyLeaseCleanupEvidence({
        dataDirectory: evidence.dataDirectory,
        caseRecord,
        runId: actual.runId,
        scope: actual.scope,
        principalId: run.principal_id,
      });
      if (leaseCleanup?.status !== "PASS" || leaseCleanup.runId !== actual.runId) invalid();

      freshCases.push({
        caseId: caseRecord.id,
        runId: actual.runId,
        scope: actual.scope,
        traceVerified: true,
        feature,
        delivery,
        messageBinding: accepted.messageBinding,
      });
    }
    return {
      status: "PASS",
      runtime: report.runtime,
      cases: freshCases,
    };
  } finally {
    db.close();
  }
}

/** Verify the archived evidence for a two-stage history lesson without replaying either Run. */
export async function verifyArchivedHistoryLesson(
  report,
  lesson,
  evidence,
  capture,
  { historyBindings } = {},
) {
  const kind = familyKind(report);
  if (!kind) return false;
  if (typeof historyBindings !== "function") invalid();
  const familyCases = report.cases;
  const workflow = kind === "seed" ? report.historySeedWorkflow : report.historyIsolationWorkflow;
  const finalCase = kind === "seed" ? OLD_FINAL_CASE : NEW_FINAL_CASE;
  if (
    lesson.case !== finalCase ||
    lesson.evidence?.runId !== workflow?.stageRunIds?.[1] ||
    !Array.isArray(familyCases) ||
    familyCases.length !== 2
  )
    invalid();
  const config = buildConfig(report, familyCases);
  config.runtime.checkout = report.runtime?.checkout;
  config.runtime.dataDirectory = report.runtime?.dataDirectory;
  const runtimeConfig = {
    checkout: report.runtime?.checkout,
    dataDirectory: report.runtime?.dataDirectory,
    expectedCommit: report.runtime?.commit,
    connectionId: report.runtime?.connectionId,
    threadId: report.runtime?.threadId ?? null,
  };
  const verifyProduct = async () => {
    let before;
    try {
      before = runtimeInspectionSnapshot(runtimeConfig, capture);
    } catch {
      invalid();
    }
    if (!isDeepStrictEqual(before, report.runtime)) invalid();
    let fresh;
    fresh = await observeArchivedCases(
      report,
      evidence,
      familyCases,
      config,
      capture,
      historyBindings,
    );
    let after;
    try {
      after = runtimeInspectionSnapshot(runtimeConfig, capture);
    } catch {
      invalid();
    }
    if (!isDeepStrictEqual(after, report.runtime)) invalid();
    return fresh;
  };
  let verifiedFamily;
  try {
    verifiedFamily =
      kind === "seed"
        ? await verifyHistoryFamilyReport(report, { config, verifyProduct })
        : await verifyHistoryIsolationFamilyReport(report, {
            config,
            verifyProduct,
          });
  } catch {
    invalid();
  }
  if (!isDeepStrictEqual(report.historyFamilyAcceptance, verifiedFamily)) invalid();
  return true;
}
