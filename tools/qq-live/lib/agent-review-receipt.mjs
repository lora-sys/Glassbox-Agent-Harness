import { createHash } from "node:crypto";
import { digest, fail } from "./core.mjs";

export const AGENT_REVIEW_SCHEMA_VERSION = 2;
export const AGENT_REVIEW_SCOPES = Object.freeze([
  "authorization",
  "correctness",
  "data-integrity",
  "delivery",
  "privacy",
  "security",
  "tests",
]);

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS = 200;
const MAX_TEXT = 4096;
const FINDING_SEVERITIES = new Set(["blocker", "high", "medium", "low", "info"]);
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function invalid(message = "Agent review receipt is invalid.") {
  fail("AGENT_REVIEW_RECEIPT", message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort(compareText).join("\0") === [...expected].sort(compareText).join("\0")
  );
}

function text(value, max = MAX_TEXT) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function hashArtifact(artifactBytes) {
  if (!(typeof artifactBytes === "string" || artifactBytes instanceof Uint8Array)) invalid();
  const bytes = Buffer.isBuffer(artifactBytes)
    ? artifactBytes
    : Buffer.from(artifactBytes, typeof artifactBytes === "string" ? "utf8" : undefined);
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) invalid();
  const decoded = bytes.toString("utf8");
  if (decoded.includes("\uFFFD")) invalid();
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function validateBinding(binding) {
  if (
    !exactKeys(binding, [
      "repository",
      "pullRequestNumber",
      "pullRequestUrl",
      "baseCommit",
      "candidateCommit",
      "candidateTree",
      "diffSha256",
      "changedPaths",
      "pullRequestAuthorLogin",
    ]) ||
    !text(binding.repository, 512) ||
    !Number.isSafeInteger(binding.pullRequestNumber) ||
    binding.pullRequestNumber <= 0 ||
    !text(binding.pullRequestUrl, 2048) ||
    !COMMIT.test(binding.baseCommit ?? "") ||
    !COMMIT.test(binding.candidateCommit ?? "") ||
    !COMMIT.test(binding.candidateTree ?? "") ||
    !SHA256.test(binding.diffSha256 ?? "") ||
    !text(binding.pullRequestAuthorLogin, 256) ||
    !Array.isArray(binding.changedPaths) ||
    binding.changedPaths.length > 10000 ||
    binding.changedPaths.some((path) => !text(path, 2048) || path.includes("\\")) ||
    new Set(binding.changedPaths).size !== binding.changedPaths.length ||
    JSON.stringify(binding.changedPaths) !==
      JSON.stringify([...binding.changedPaths].sort(compareText))
  )
    invalid();
  return binding;
}

function validateFindings(findings) {
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) invalid();
  const ids = new Set();
  return findings.map((finding) => {
    if (
      !exactKeys(finding, ["id", "severity", "summary", "resolution", "resolutionNote"]) ||
      !text(finding.id, 128) ||
      ids.has(finding.id) ||
      !FINDING_SEVERITIES.has(finding.severity) ||
      !text(finding.summary, 1000) ||
      !["fixed", "accepted"].includes(finding.resolution) ||
      !text(finding.resolutionNote, 2000)
    )
      invalid("Every review finding must have a unique ID and an explicit resolution.");
    ids.add(finding.id);
    return {
      id: finding.id,
      severity: finding.severity,
      summary: finding.summary.trim(),
      resolution: finding.resolution,
      resolutionNote: finding.resolutionNote.trim(),
    };
  });
}

function validateImplementationAgentIds(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100 ||
    value.some((id) => !text(id, 256) || id !== id.trim()) ||
    new Set(value).size !== value.length ||
    JSON.stringify(value) !== JSON.stringify([...value].sort(compareText))
  )
    invalid("The review artifact must list each implementation Agent identity once.");
  return [...value];
}

function parseReviewArtifact(artifactBytes) {
  const artifact = hashArtifact(artifactBytes);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(artifactBytes).toString("utf8"));
  } catch {
    invalid("The review artifact must be strict JSON with no status field.");
  }
  if (
    !exactKeys(parsed, ["schemaVersion", "binding", "review"]) ||
    parsed.schemaVersion !== AGENT_REVIEW_SCHEMA_VERSION
  )
    invalid("The review artifact schema is invalid or contains untrusted promotion fields.");
  const binding = validateBinding(parsed.binding);
  const review = parsed.review;
  if (
    !exactKeys(review, [
      "reviewerId",
      "implementationAgentIds",
      "reviewerScope",
      "coverage",
      "reviewedPaths",
      "findings",
    ]) ||
    !text(review.reviewerId, 256) ||
    review.reviewerId !== review.reviewerId.trim() ||
    !Array.isArray(review.reviewerScope) ||
    !review.reviewerScope.length ||
    review.reviewerScope.some((scope) => !AGENT_REVIEW_SCOPES.includes(scope)) ||
    new Set(review.reviewerScope).size !== review.reviewerScope.length ||
    JSON.stringify(review.reviewerScope) !==
      JSON.stringify([...review.reviewerScope].sort(compareText)) ||
    review.coverage !== "full-diff" ||
    !Array.isArray(review.reviewedPaths) ||
    JSON.stringify(review.reviewedPaths) !== JSON.stringify(binding.changedPaths)
  )
    invalid("The review artifact must attest to the full changed-file set.");
  const implementationAgentIds = validateImplementationAgentIds(review.implementationAgentIds);
  if (implementationAgentIds.includes(review.reviewerId))
    invalid("The reviewer must differ from every listed implementation Agent.");
  const findings = validateFindings(review.findings);
  return {
    artifact,
    binding,
    review: {
      reviewerId: review.reviewerId,
      implementationAgentIds,
      reviewerScope: [...review.reviewerScope],
      coverage: "full-diff",
      reviewedPaths: [...review.reviewedPaths],
      findings,
    },
  };
}

function receiptDigest(receipt) {
  const { receiptSha256: _receiptSha256, ...unsigned } = receipt;
  return digest(JSON.stringify(canonical(unsigned)));
}

export function reviewBindingSha256(binding) {
  validateBinding(binding);
  return digest(JSON.stringify(canonical(binding)));
}

/** Create only from the explicit Record Agent Review action and its full-diff artifact. */
export function buildAgentReviewReceipt(input) {
  if (
    !exactKeys(input, [
      "action",
      "binding",
      "artifactBytes",
      "expectedReviewBindingSha256",
      "hostOperatorIdentityAttested",
      "recordedAt",
    ]) ||
    input.action !== "record-agent-review" ||
    input.hostOperatorIdentityAttested !== true
  )
    invalid("A receipt can only be created by the explicit Record Agent Review action.");

  const binding = validateBinding(input.binding);
  const bindingHash = reviewBindingSha256(binding);
  if (
    !SHA256.test(input.expectedReviewBindingSha256 ?? "") ||
    bindingHash !== input.expectedReviewBindingSha256
  )
    fail(
      "AGENT_REVIEW_BINDING",
      "Review binding confirmation does not match the complete current change.",
    );

  const parsed = parseReviewArtifact(input.artifactBytes);
  if (
    JSON.stringify(canonical(parsed.binding)) !== JSON.stringify(canonical(binding)) ||
    parsed.review.implementationAgentIds.includes(parsed.review.reviewerId)
  )
    invalid("The review artifact is not independent or does not match the exact reviewed change.");
  const recordedAt = Date.parse(input.recordedAt);
  if (typeof input.recordedAt !== "string" || !Number.isFinite(recordedAt)) invalid();

  const receipt = {
    schemaVersion: AGENT_REVIEW_SCHEMA_VERSION,
    action: "record-agent-review",
    status: "PASS",
    recordedAt: new Date(recordedAt).toISOString(),
    binding: structuredClone(binding),
    bindingSha256: bindingHash,
    review: parsed.review,
    hostOperatorIdentityAttested: true,
    artifact: parsed.artifact,
  };
  return { ...receipt, receiptSha256: receiptDigest(receipt) };
}

/** Recheck the receipt, embedded review artifact and current GitHub/Git binding. */
export function verifyAgentReviewReceipt({ receipt, artifactBytes, expected }) {
  if (
    !exactKeys(receipt, [
      "schemaVersion",
      "action",
      "status",
      "recordedAt",
      "binding",
      "bindingSha256",
      "review",
      "hostOperatorIdentityAttested",
      "artifact",
      "receiptSha256",
    ]) ||
    receipt.schemaVersion !== AGENT_REVIEW_SCHEMA_VERSION ||
    receipt.action !== "record-agent-review" ||
    receipt.status !== "PASS" ||
    !SHA256.test(receipt.receiptSha256 ?? "") ||
    receipt.receiptSha256 !== receiptDigest(receipt)
  )
    invalid();

  const binding = validateBinding(receipt.binding);
  if (receipt.bindingSha256 !== reviewBindingSha256(binding)) invalid();
  const parsed = parseReviewArtifact(artifactBytes);
  if (
    JSON.stringify(canonical(parsed.binding)) !== JSON.stringify(canonical(binding)) ||
    JSON.stringify(canonical(parsed.review)) !== JSON.stringify(canonical(receipt.review)) ||
    receipt.artifact?.bytes !== parsed.artifact.bytes ||
    receipt.artifact?.sha256 !== parsed.artifact.sha256 ||
    !exactKeys(receipt.artifact, ["bytes", "sha256"]) ||
    receipt.hostOperatorIdentityAttested !== true ||
    !Array.isArray(receipt.review.implementationAgentIds) ||
    receipt.review.implementationAgentIds.includes(receipt.review.reviewerId)
  )
    invalid("The receipt no longer matches its raw full-diff review artifact.");

  const current = validateBinding(expected);
  if (
    JSON.stringify(canonical(binding)) !== JSON.stringify(canonical(current)) ||
    receipt.bindingSha256 !== reviewBindingSha256(current)
  )
    fail(
      "AGENT_REVIEW_STALE",
      "Agent review receipt does not match the current PR, base, tree, paths or diff.",
    );
  if (!Number.isFinite(Date.parse(receipt.recordedAt))) invalid();

  return {
    status: "PASS",
    candidateCommit: binding.candidateCommit,
    hostOperatorIdentityAttested: true,
    receiptSha256: receipt.receiptSha256,
    bindingSha256: receipt.bindingSha256,
    reviewerId: parsed.review.reviewerId,
    implementationAgentIds: parsed.review.implementationAgentIds,
    reviewerScope: parsed.review.reviewerScope,
    artifactSha256: parsed.artifact.sha256,
  };
}
