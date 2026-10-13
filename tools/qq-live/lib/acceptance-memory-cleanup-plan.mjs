import { digest, toolManifestDigest } from "./core.mjs";
import { resolve } from "node:path";

const CANDIDATE = /^candidate_[a-f0-9]{32}$/u;
const RUN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MESSAGE = /^-?\d{1,20}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CLEAN_RUNTIME_KEYS = [
  "checkout",
  "dataDirectory",
  "commit",
  "pid",
  "connectionId",
  "threadId",
];
const DEVELOPMENT_RUNTIME_KEYS = [...CLEAN_RUNTIME_KEYS, "development", "sourceTreeSha256"];
const INVENTORY_KEYS = ["schemaVersion", "candidates"];
const CANDIDATE_ENTRY_KEYS = [
  "candidateId",
  "status",
  "promotedMemoryId",
  "candidateKind",
  "createdAt",
  "scopeSha256",
  "subjectSha256",
  "statementSha256",
  "sourceSha256",
  "principalId",
  "sourceRunId",
  "auditWrite",
  "sourceFeedback",
];
const AUDIT_KEYS = [
  "id",
  "sequence",
  "principalId",
  "action",
  "targetId",
  "runId",
  "lineage",
  "createdAt",
  "rowSha256",
];
const FEEDBACK_KEYS = ["id", "candidateId", "runId", "signalType", "createdAt", "rowSha256"];
const ORIGIN_KEYS = ["reportSha256", "guardSha256", "sourceAuditSha256"];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  return (
    record(value) &&
    Object.keys(value).sort(compare).join("\0") === [...keys].sort(compare).join("\0")
  );
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("Invalid cleanup evidence.");
  if (value === undefined || typeof value === "function" || typeof value === "symbol")
    throw new TypeError("Invalid cleanup evidence.");
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Invalid cleanup evidence.");
  return result;
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function hash(value) {
  return digest(canonical(value));
}

function validTime(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validIdentifier(value) {
  return typeof value === "string" && ID.test(value);
}

function validateRuntime(runtime) {
  if (!record(runtime)) throw new TypeError("Cleanup Runtime is invalid.");
  const dev = Object.hasOwn(runtime, "development");
  const expectedKeys = dev ? DEVELOPMENT_RUNTIME_KEYS : CLEAN_RUNTIME_KEYS;
  if (
    !exactKeys(runtime, expectedKeys) ||
    typeof runtime.checkout !== "string" ||
    !runtime.checkout.startsWith("/") ||
    resolve(runtime.checkout) !== runtime.checkout ||
    typeof runtime.dataDirectory !== "string" ||
    !runtime.dataDirectory.startsWith("/") ||
    resolve(runtime.dataDirectory) !== runtime.dataDirectory ||
    !/^[a-f0-9]{40}$/u.test(runtime.commit ?? "") ||
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid < 1 ||
    typeof runtime.connectionId !== "string" ||
    runtime.connectionId.length < 1 ||
    runtime.connectionId.length > 512 ||
    !(runtime.threadId === null || validIdentifier(runtime.threadId)) ||
    (dev && (runtime.development !== true || !SHA256.test(runtime.sourceTreeSha256 ?? "")))
  )
    throw new TypeError("Cleanup Runtime is invalid.");
  return structuredClone(runtime);
}

function validateOrigin(origin) {
  if (
    !exactKeys(origin, ORIGIN_KEYS) ||
    !SHA256.test(origin.reportSha256 ?? "") ||
    !SHA256.test(origin.guardSha256 ?? "") ||
    !SHA256.test(origin.sourceAuditSha256 ?? "")
  )
    throw new TypeError("Cleanup origin evidence is invalid.");
  return structuredClone(origin);
}

function validateAuditWrite(audit, entry) {
  if (
    !exactKeys(audit, AUDIT_KEYS) ||
    !validIdentifier(audit.id) ||
    !Number.isSafeInteger(audit.sequence) ||
    audit.sequence < 1 ||
    audit.principalId !== entry.principalId ||
    audit.action !== "write" ||
    !validIdentifier(audit.targetId) ||
    audit.runId !== entry.sourceRunId ||
    !Array.isArray(audit.lineage) ||
    audit.lineage.some((part) => typeof part !== "string" || part.length > 256) ||
    !validTime(audit.createdAt) ||
    !SHA256.test(audit.rowSha256 ?? "")
  )
    throw new TypeError("Cleanup candidate provenance is invalid.");
  if (Date.parse(audit.createdAt) < Date.parse(entry.createdAt))
    throw new TypeError("Cleanup candidate audit predates its source.");
  if (entry.sourceFeedback) {
    const feedback = entry.sourceFeedback;
    if (
      !exactKeys(feedback, FEEDBACK_KEYS) ||
      !validIdentifier(feedback.id) ||
      feedback.candidateId !== entry.candidateId ||
      feedback.runId !== entry.sourceRunId ||
      feedback.signalType !== "explicit_positive" ||
      !validTime(feedback.createdAt) ||
      !SHA256.test(feedback.rowSha256 ?? "") ||
      audit.targetId !== feedback.id ||
      Date.parse(audit.createdAt) < Date.parse(feedback.createdAt) ||
      !same(audit.lineage, [entry.candidateId, "run:" + entry.sourceRunId])
    )
      throw new TypeError("Cleanup feedback provenance is invalid.");
  } else if (
    audit.targetId !== entry.candidateId ||
    !same(audit.lineage, ["run:" + entry.sourceRunId])
  ) {
    throw new TypeError("Cleanup candidate provenance is invalid.");
  }
}

function validateInventory(inventory, { allowRejected = false } = {}) {
  if (
    !exactKeys(inventory, INVENTORY_KEYS) ||
    inventory.schemaVersion !== 1 ||
    !Array.isArray(inventory.candidates) ||
    inventory.candidates.length < 2 ||
    inventory.candidates.length > 20
  )
    throw new TypeError("Cleanup inventory is invalid.");
  let previous = "";
  let principalId;
  const seen = new Set();
  const auditIds = new Set();
  const auditSequences = new Set();
  const candidates = inventory.candidates.map((entry) => {
    if (
      !exactKeys(entry, CANDIDATE_ENTRY_KEYS) ||
      !CANDIDATE.test(entry.candidateId ?? "") ||
      seen.has(entry.candidateId) ||
      !(entry.status === "pending" || (allowRejected && entry.status === "rejected")) ||
      entry.promotedMemoryId !== null ||
      !["assertion", "confirmation", "correction", "derived"].includes(entry.candidateKind) ||
      !validTime(entry.createdAt) ||
      !SHA256.test(entry.scopeSha256 ?? "") ||
      !SHA256.test(entry.subjectSha256 ?? "") ||
      !SHA256.test(entry.statementSha256 ?? "") ||
      !SHA256.test(entry.sourceSha256 ?? "") ||
      !validIdentifier(entry.principalId) ||
      !RUN.test(entry.sourceRunId ?? "")
    )
      throw new TypeError("Cleanup inventory candidate is invalid.");
    if (entry.candidateId < previous)
      throw new TypeError("Cleanup inventory candidates must be sorted by ID.");
    previous = entry.candidateId;
    seen.add(entry.candidateId);
    principalId ??= entry.principalId;
    if (entry.principalId !== principalId)
      throw new TypeError("Cleanup inventory spans principals.");
    validateAuditWrite(entry.auditWrite, entry);
    if (auditIds.has(entry.auditWrite.id) || auditSequences.has(entry.auditWrite.sequence))
      throw new TypeError("Cleanup inventory repeats an audit row.");
    auditIds.add(entry.auditWrite.id);
    auditSequences.add(entry.auditWrite.sequence);
    return structuredClone(entry);
  });
  return { inventory: { schemaVersion: 1, candidates }, principalId };
}

function expectedCommand(candidateIds) {
  return "/memory reject " + candidateIds.join(" ");
}

function expectedPrompt(candidateIds) {
  return (
    expectedCommand(candidateIds) +
    "\n请只处理本计划列出的候选，并在回复中包含本轮测试编号 {{nonce}}。"
  );
}

function expectedInput(candidateIds) {
  return { action: "reject", candidateIds: [...candidateIds] };
}

function expectedLease(candidateIds) {
  return [
    {
      name: "owner_memory_admin",
      operations: [
        {
          action: "memory:govern",
          resourceId: "owner-memory",
          inputConstraint: expectedInput(candidateIds),
        },
      ],
    },
  ];
}

function validatePlan(plan) {
  const planKeys = [
    "schemaVersion",
    "kind",
    "cleanupOnly",
    "featurePass",
    "runtime",
    "origin",
    "inventory",
    "inventorySha256",
    "principalId",
    "candidateIds",
    "ownerCommand",
    "prompt",
    "leaseTools",
    "toolsSha256",
  ];
  if (
    !exactKeys(plan, planKeys) ||
    plan.schemaVersion !== 1 ||
    plan.kind !== "acceptance-memory-candidate-cleanup" ||
    plan.cleanupOnly !== true ||
    plan.featurePass !== false ||
    !SHA256.test(plan.inventorySha256 ?? "") ||
    !SHA256.test(plan.toolsSha256 ?? "")
  )
    throw new TypeError("Cleanup plan is invalid.");
  const runtime = validateRuntime(plan.runtime);
  const origin = validateOrigin(plan.origin);
  const { inventory, principalId } = validateInventory(plan.inventory);
  if (
    !same(inventory, plan.inventory) ||
    hash(inventory) !== plan.inventorySha256 ||
    principalId !== plan.principalId
  )
    throw new TypeError("Cleanup plan inventory binding is invalid.");
  const candidateIds = inventory.candidates.map((candidate) => candidate.candidateId);
  if (
    !same(plan.candidateIds, candidateIds) ||
    plan.ownerCommand !== expectedCommand(candidateIds) ||
    plan.prompt !== expectedPrompt(candidateIds)
  )
    throw new TypeError("Cleanup plan command is invalid.");
  const leaseTools = expectedLease(candidateIds);
  if (!same(plan.leaseTools, leaseTools) || toolManifestDigest(leaseTools) !== plan.toolsSha256)
    throw new TypeError("Cleanup plan lease is invalid.");
  return { runtime, origin, inventory, principalId, candidateIds, leaseTools };
}

/** Hashes the strict, statement-free inventory accepted by this cleanup planner. */
export function acceptanceMemoryInventorySha256(inventory) {
  const { inventory: normalized } = validateInventory(inventory, { allowRejected: true });
  return hash(normalized);
}

/**
 * Build a fixed Owner-private reject batch from an independently observed pending inventory.
 * The plan is cleanup-only and cannot constitute a feature-pass result.
 */
export function buildAcceptanceMemoryCleanupPlan({
  inventory,
  inventorySha256,
  runtime,
  origin,
} = {}) {
  const { inventory: normalized, principalId } = validateInventory(inventory);
  const normalizedRuntime = validateRuntime(runtime);
  const normalizedOrigin = validateOrigin(origin);
  if (!SHA256.test(inventorySha256 ?? "") || hash(normalized) !== inventorySha256)
    throw new TypeError("Cleanup inventory hash does not match.");
  const candidateIds = normalized.candidates.map((candidate) => candidate.candidateId);
  const leaseTools = expectedLease(candidateIds);
  const plan = {
    schemaVersion: 1,
    kind: "acceptance-memory-candidate-cleanup",
    cleanupOnly: true,
    featurePass: false,
    runtime: normalizedRuntime,
    origin: normalizedOrigin,
    inventory: normalized,
    inventorySha256,
    principalId,
    candidateIds,
    ownerCommand: expectedCommand(candidateIds),
    prompt: expectedPrompt(candidateIds),
    leaseTools,
    toolsSha256: toolManifestDigest(leaseTools),
  };
  validatePlan(plan);
  return { plan, sha256: hash(plan) };
}

function validateBinding(binding, plan, cleanupRunId, principalId, token) {
  if (
    !exactKeys(binding, [
      "internalMessageId",
      "externalMessageId",
      "runId",
      "principalId",
      "textSha256",
    ]) ||
    !validIdentifier(binding.internalMessageId) ||
    !MESSAGE.test(String(binding.externalMessageId ?? "")) ||
    binding.runId !== cleanupRunId ||
    binding.principalId !== principalId ||
    !SHA256.test(binding.textSha256 ?? "") ||
    !/^[a-f0-9]{32}$/u.test(token ?? "")
  )
    throw new TypeError("Cleanup input binding is invalid.");
  const renderedPrompt =
    "GLASSBOX_ACCEPTANCE_V1 " + token + "\n" + plan.prompt.replaceAll("{{nonce}}", token).trim();
  if (digest(renderedPrompt) !== binding.textSha256)
    throw new TypeError("Cleanup input binding does not match the fixed Owner request.");
}

function expectedResults(candidateIds) {
  return candidateIds.map((candidateId) => ({ candidateId, status: "rejected" }));
}

/** Exact adapter-safe wrapper emitted by owner_memory_admin for a successful reject batch. */
export function acceptanceMemoryCleanupExpectedOutput(candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length < 2 || candidateIds.length > 20)
    throw new TypeError("Cleanup candidate list is invalid.");
  const results = expectedResults(candidateIds);
  const serialized = JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ results }) }],
    details: { results },
  });
  return {
    results,
    outputBytes: Buffer.byteLength(serialized, "utf8"),
    outputSha256: digest(serialized),
  };
}

function validateCleanup(planContext, cleanup) {
  const { plan, principalId, candidateIds } = planContext;
  const cleanupKeys = [
    "runId",
    "principalId",
    "token",
    "runtime",
    "run",
    "binding",
    "lease",
    "authorization",
    "delivery",
    "toolCall",
    "toolResult",
    "rejectionAudits",
    "learningWrites",
  ];
  if (
    !exactKeys(cleanup, cleanupKeys) ||
    !RUN.test(cleanup.runId ?? "") ||
    cleanup.principalId !== principalId ||
    !/^[a-f0-9]{32}$/u.test(cleanup.token ?? "") ||
    plan.inventory.candidates.some((candidate) => candidate.sourceRunId === cleanup.runId)
  )
    throw new TypeError("Cleanup execution evidence is invalid.");
  if (
    !exactKeys(cleanup.run, ["runId", "principalId", "internalMessageId", "externalMessageId"]) ||
    cleanup.run.runId !== cleanup.runId ||
    cleanup.run.principalId !== principalId ||
    !validIdentifier(cleanup.run.internalMessageId) ||
    !MESSAGE.test(String(cleanup.run.externalMessageId ?? ""))
  )
    throw new TypeError("Cleanup Run binding is invalid.");
  if (!same(validateRuntime(cleanup.runtime), plan.runtime))
    throw new TypeError("Cleanup Runtime changed after planning.");
  validateBinding(cleanup.binding, plan, cleanup.runId, principalId, cleanup.token);
  if (
    cleanup.binding.internalMessageId !== cleanup.run.internalMessageId ||
    String(cleanup.binding.externalMessageId) !== String(cleanup.run.externalMessageId)
  )
    throw new TypeError("Cleanup input binding does not match its Run.");
  const { lease, authorization, delivery, toolCall, toolResult } = cleanup;
  if (
    !exactKeys(lease, ["runId", "principalId", "registered", "revoked", "toolsSha256"]) ||
    lease.runId !== cleanup.runId ||
    lease.principalId !== principalId ||
    lease.registered !== true ||
    lease.revoked !== true ||
    lease.toolsSha256 !== plan.toolsSha256
  )
    throw new TypeError("Cleanup lease evidence is invalid.");
  if (
    !exactKeys(authorization, [
      "runId",
      "principalId",
      "decisionId",
      "decision",
      "action",
      "resourceId",
    ]) ||
    authorization.runId !== cleanup.runId ||
    authorization.principalId !== principalId ||
    !validIdentifier(authorization.decisionId) ||
    authorization.decision !== "ALLOW" ||
    authorization.action !== "memory:govern" ||
    authorization.resourceId !== "owner-memory"
  )
    throw new TypeError("Cleanup authorization evidence is invalid.");
  if (
    !exactKeys(delivery, [
      "runId",
      "principalId",
      "decisionId",
      "decision",
      "route",
      "recipientPrincipalId",
      "externalMessageId",
      "delivered",
    ]) ||
    delivery.runId !== cleanup.runId ||
    delivery.principalId !== principalId ||
    !validIdentifier(delivery.decisionId) ||
    delivery.decision !== "ALLOW" ||
    delivery.route !== "private" ||
    delivery.recipientPrincipalId !== principalId ||
    !MESSAGE.test(String(delivery.externalMessageId ?? "")) ||
    delivery.delivered !== true
  )
    throw new TypeError("Cleanup delivery evidence is invalid.");
  const inputProjection = toolCall.inputProjection ?? "full";
  const inputSha256 =
    inputProjection === "full"
      ? hash(expectedInput(candidateIds))
      : inputProjection === "array-values-omitted"
        ? hash({ action: "reject" })
        : null;
  if (
    !(
      exactKeys(toolCall, [
        "runId",
        "principalId",
        "toolCallId",
        "name",
        "inputSha256",
        "sequence",
      ]) ||
      exactKeys(toolCall, [
        "runId",
        "principalId",
        "toolCallId",
        "name",
        "inputSha256",
        "inputProjection",
        "sequence",
      ])
    ) ||
    toolCall.runId !== cleanup.runId ||
    toolCall.principalId !== principalId ||
    !validIdentifier(toolCall.toolCallId) ||
    toolCall.name !== "owner_memory_admin" ||
    inputSha256 === null ||
    toolCall.inputSha256 !== inputSha256 ||
    !Number.isSafeInteger(toolCall.sequence) ||
    toolCall.sequence < 1
  )
    throw new TypeError("Cleanup tool call evidence is invalid.");
  const expectedOutput = acceptanceMemoryCleanupExpectedOutput(candidateIds);
  if (
    !exactKeys(toolResult, [
      "runId",
      "principalId",
      "toolCallId",
      "name",
      "isError",
      "sequence",
      "results",
      "outputBytes",
      "outputSha256",
    ]) ||
    toolResult.runId !== cleanup.runId ||
    toolResult.principalId !== principalId ||
    toolResult.toolCallId !== toolCall.toolCallId ||
    toolResult.name !== "owner_memory_admin" ||
    toolResult.isError !== false ||
    !Number.isSafeInteger(toolResult.sequence) ||
    toolResult.sequence <= toolCall.sequence ||
    !same(toolResult.results, expectedOutput.results) ||
    toolResult.outputBytes !== expectedOutput.outputBytes ||
    toolResult.outputSha256 !== expectedOutput.outputSha256
  )
    throw new TypeError("Cleanup tool result evidence is invalid.");
  if (
    !exactKeys(cleanup.learningWrites, [
      "runId",
      "principalId",
      "candidateWriteAuditCount",
      "feedbackWriteCount",
      "candidateSourceCount",
    ]) ||
    cleanup.learningWrites.runId !== cleanup.runId ||
    cleanup.learningWrites.principalId !== principalId ||
    cleanup.learningWrites.candidateWriteAuditCount !== 0 ||
    cleanup.learningWrites.feedbackWriteCount !== 0 ||
    cleanup.learningWrites.candidateSourceCount !== 0
  )
    throw new TypeError("Cleanup learning write isolation evidence is invalid.");
  if (
    !Array.isArray(cleanup.rejectionAudits) ||
    cleanup.rejectionAudits.length !== candidateIds.length
  )
    throw new TypeError("Cleanup rejection audit evidence is incomplete.");
  let previousSequence = 0;
  const audits = cleanup.rejectionAudits.map((audit, index) => {
    if (
      !exactKeys(audit, [
        "id",
        "sequence",
        "action",
        "targetId",
        "runId",
        "principalId",
        "decisionId",
        "rowSha256",
      ]) ||
      !validIdentifier(audit.id) ||
      !Number.isSafeInteger(audit.sequence) ||
      audit.sequence <= previousSequence ||
      audit.action !== "reject" ||
      audit.targetId !== candidateIds[index] ||
      audit.runId !== cleanup.runId ||
      audit.principalId !== principalId ||
      !validIdentifier(audit.decisionId) ||
      !SHA256.test(audit.rowSha256 ?? "")
    )
      throw new TypeError("Cleanup rejection audit evidence is invalid.");
    previousSequence = audit.sequence;
    return structuredClone(audit);
  });
  if (
    authorization.decisionId !== audits[0]?.decisionId ||
    new Set(audits.map((audit) => audit.decisionId)).size !== audits.length
  )
    throw new TypeError("Cleanup rejection authorization bindings are invalid.");
  return { runId: cleanup.runId, principalId, audits };
}

function validateFinalInventory(plan, finalInventory) {
  if (
    !exactKeys(finalInventory, INVENTORY_KEYS) ||
    finalInventory.schemaVersion !== 1 ||
    !Array.isArray(finalInventory.candidates)
  )
    throw new TypeError("Final cleanup inventory is invalid.");
  const expected = new Map(plan.inventory.candidates.map((entry) => [entry.candidateId, entry]));
  if (finalInventory.candidates.length !== expected.size)
    throw new TypeError("Cleanup changed the candidate inventory.");
  let previous = "";
  const candidates = finalInventory.candidates.map((current) => {
    if (!exactKeys(current, CANDIDATE_ENTRY_KEYS) || current.candidateId < previous)
      throw new TypeError("Final cleanup inventory is invalid.");
    previous = current.candidateId;
    const source = expected.get(current.candidateId);
    if (!source) throw new TypeError("Cleanup introduced or removed candidate rows.");
    const rejected = { ...source, status: "rejected" };
    if (!same(current, rejected) || current.promotedMemoryId !== null)
      throw new TypeError("Cleanup changed candidate provenance or did not reject it.");
    return structuredClone(current);
  });
  return { schemaVersion: 1, candidates };
}

/** Verify independent after-run evidence without deleting or rewriting any STOP or guard. */
export function verifyAcceptanceMemoryCleanup({
  plan,
  planSha256,
  cleanup,
  finalInventory,
  finalInventorySha256,
} = {}) {
  const context = validatePlan(plan);
  if (!SHA256.test(planSha256 ?? "") || hash(plan) !== planSha256)
    throw new TypeError("Cleanup plan hash does not match.");
  const execution = validateCleanup({ ...context, plan }, cleanup);
  const final = validateFinalInventory(plan, finalInventory);
  const actualFinalSha256 = hash(final);
  if (actualFinalSha256 !== finalInventorySha256)
    throw new TypeError("Final cleanup inventory hash does not match.");
  return {
    status: "CLEANUP_VERIFIED",
    cleanupOnly: true,
    featurePass: false,
    planSha256,
    inventorySha256: plan.inventorySha256,
    finalInventorySha256: actualFinalSha256,
    origin: structuredClone(context.origin),
    runtime: structuredClone(context.runtime),
    cleanupRunId: execution.runId,
    principalId: execution.principalId,
    candidateIds: [...context.candidateIds],
    rejectedCount: execution.audits.length,
    rejectionAuditIds: execution.audits.map((row) => row.id),
  };
}
