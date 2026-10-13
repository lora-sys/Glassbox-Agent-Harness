import { isDeepStrictEqual } from "node:util";
import { digest, fail, toolManifestDigest } from "./core.mjs";
import { mediaFamilyPlan, mediaObservationFor, MEDIA_FAMILY_ID } from "./media-scenario.mjs";

const TOKEN = /^[a-f0-9]{32}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const LEASE_ID = /^[a-f0-9-]{36}$/iu;
const MESSAGE_ID = /^-?\d{1,20}$/u;
const ASSET_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function invalid() {
  fail("MEDIA_WORKFLOW", "Fixed media workflow evidence is incomplete.", "INCONCLUSIVE");
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort((a, b) => a.localeCompare(b)),
      [...expected].sort((a, b) => a.localeCompare(b)),
    )
  );
}

function replace(value, token) {
  return JSON.parse(JSON.stringify(value).replaceAll("{{nonce}}", token));
}

function validateTransportCase(testCase, stage, spec, previousToken, previousLeaseId) {
  const token = testCase?.token;
  if (!TOKEN.test(token ?? "") || token === previousToken) invalid();
  const expectedTools = replace(spec.leaseTools, token);
  const lease = testCase.acceptanceLease;
  const startedAt = Date.parse(testCase.startedAt);
  if (
    testCase.id !== spec.id ||
    testCase.status !== "PASS" ||
    testCase.route !== "private" ||
    testCase.sendAttempted !== true ||
    !MESSAGE_ID.test(String(testCase.sentMessageId ?? "")) ||
    testCase.inputObserved !== true ||
    testCase.leaseRegistrationAttempted !== true ||
    testCase.leaseRevoked !== true ||
    testCase.prompt !==
      "GLASSBOX_ACCEPTANCE_V1 " +
        token +
        "\n" +
        spec.prompt.replaceAll("{{nonce}}", token).trim() ||
    !isDeepStrictEqual(testCase.expected, replace(spec.expectContains, token)) ||
    !isDeepStrictEqual(testCase.featureAssertions, replace(spec.featureAssertions, token)) ||
    !isDeepStrictEqual(
      testCase.leasedToolNames,
      expectedTools.map((tool) => tool.name),
    ) ||
    !exactKeys(lease, ["leaseId", "expiresAt", "toolsSha256"]) ||
    !LEASE_ID.test(lease.leaseId ?? "") ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isFinite(startedAt) ||
    lease.expiresAt <= startedAt ||
    lease.toolsSha256 !== toolManifestDigest(expectedTools) ||
    lease.leaseId === previousLeaseId ||
    testCase.mediaObservationExpectedType !== mediaObservationFor(stage).expectedType ||
    testCase.mediaObservationExpectedCaptionSha256 !==
      digest(mediaObservationFor(stage).expectedCaption)
  )
    invalid();
  return token;
}

function validateAsset(asset, stage) {
  const imageKeys = [
    "assetId",
    "mimeType",
    "sizeBytes",
    "sha256",
    "width",
    "height",
    "fullDecodeVerified",
    "retained",
  ];
  const videoKeys = [
    ...imageKeys,
    "durationSeconds",
    "framesPerSecond",
    "durationToleranceSeconds",
  ];
  if (
    !exactKeys(asset, stage === "video-4s" ? videoKeys : imageKeys) ||
    !ASSET_ID.test(asset.assetId ?? "") ||
    !SHA256.test(asset.sha256 ?? "") ||
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes <= 0 ||
    asset.retained !== true ||
    asset.fullDecodeVerified !== true
  )
    invalid();
  if (stage === "image-1k") {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType) ||
      asset.width !== 1024 ||
      asset.height !== 1024
    )
      invalid();
  } else {
    const fps = asset.framesPerSecond;
    const duration = asset.durationSeconds;
    const tolerance = asset.durationToleranceSeconds;
    if (
      asset.mimeType !== "video/mp4" ||
      !Number.isSafeInteger(asset.width) ||
      asset.width <= 0 ||
      !Number.isSafeInteger(asset.height) ||
      asset.height <= 0 ||
      !Number.isFinite(fps) ||
      fps < 1 ||
      fps > 120 ||
      !Number.isFinite(duration) ||
      !Number.isFinite(tolerance) ||
      Math.abs(tolerance - 1 / fps) > 1e-9 ||
      Math.abs(duration - 4) > tolerance
    )
      invalid();
  }
  return structuredClone(asset);
}

function validateStep(result, planned, previous) {
  if (!exactKeys(result, ["mediaAcceptance", "transportCase"])) invalid();
  const { stage, spec } = planned;
  const testCase = result.transportCase;
  const token = validateTransportCase(testCase, stage, spec, previous?.token, previous?.leaseId);
  const receipt = result.mediaAcceptance;
  const runId = receipt?.runId;
  if (
    receipt?.status !== "PASS" ||
    receipt.stage !== stage ||
    !RUN_ID.test(runId ?? "") ||
    runId === previous?.runId ||
    receipt.cleanupVerified !== true ||
    receipt.actualQqDeliveryVerified !== true
  )
    invalid();
  const asset = validateAsset(receipt.asset, stage);
  return {
    stage,
    token,
    runId,
    leaseId: testCase.acceptanceLease.leaseId,
    transportCase: testCase,
    asset,
  };
}

function validateVerifiedPrefix(prefix) {
  if (
    !exactKeys(prefix, [
      "schemaVersion",
      "familyId",
      "stage",
      "token",
      "runId",
      "leaseId",
      "asset",
      "planSha256",
      "proofSha256",
    ]) ||
    prefix.schemaVersion !== 1 ||
    prefix.familyId !== MEDIA_FAMILY_ID ||
    prefix.stage !== "image-1k" ||
    !TOKEN.test(prefix.token ?? "") ||
    !RUN_ID.test(prefix.runId ?? "") ||
    !LEASE_ID.test(prefix.leaseId ?? "") ||
    !SHA256.test(prefix.planSha256 ?? "") ||
    !SHA256.test(prefix.proofSha256 ?? "")
  )
    invalid();
  return {
    stage: "image-1k",
    token: prefix.token,
    runId: prefix.runId,
    leaseId: prefix.leaseId,
    asset: validateAsset(prefix.asset, "image-1k"),
  };
}

function aborted(signal) {
  if (signal?.aborted) fail("CANCELLED", "Media workflow cancelled.", "INCONCLUSIVE");
}

/** Validate retained stage evidence without executing or checkpointing another generation. */
export function validateMediaWorkflowEvidence(results) {
  if (!Array.isArray(results) || results.length !== 2) invalid();
  const verified = [];
  for (const [index, planned] of mediaFamilyPlan().stages.entries())
    verified.push(validateStep(results[index], planned, verified.at(-1)));
  return completedEvidence(verified);
}

function completedEvidence(verified) {
  if (
    verified.length !== 2 ||
    new Set(verified.map((stage) => stage.runId)).size !== 2 ||
    new Set(verified.map((stage) => stage.leaseId)).size !== 2 ||
    new Set(verified.map((stage) => stage.asset.assetId)).size !== 2
  )
    invalid();
  return {
    status: "PASS",
    familyId: MEDIA_FAMILY_ID,
    stageRunIds: verified.map((stage) => stage.runId),
    retainedAssets: verified.map((stage) => stage.asset),
    cleanup: { required: true, leaseRevoked: true, assetsRetained: true },
    limitation: mediaFamilyPlan().limitation,
  };
}

async function confirmedCheckpoint(checkpoint, signal, evidence) {
  aborted(signal);
  let confirmed;
  try {
    confirmed = await checkpoint({ familyId: MEDIA_FAMILY_ID, ...evidence });
  } catch {
    invalid();
  }
  aborted(signal);
  if (confirmed !== true) invalid();
}

/** Execute each fixed private media stage once, or resume after a revalidated image prefix. */
export async function runMediaWorkflow({
  executeStep,
  checkpoint,
  signal,
  verifiedPrefix,
  revalidatePrefix,
}) {
  if (typeof executeStep !== "function" || typeof checkpoint !== "function") invalid();
  const plannedStages = mediaFamilyPlan().stages.map(({ stage, spec }) => ({
    stage,
    spec: structuredClone(spec),
  }));
  const verified = [];
  if (verifiedPrefix !== undefined) {
    const prior = validateVerifiedPrefix(verifiedPrefix);
    if (typeof revalidatePrefix !== "function") invalid();
    aborted(signal);
    let freshProof;
    try {
      freshProof = await revalidatePrefix(structuredClone(verifiedPrefix));
    } catch {
      invalid();
    }
    aborted(signal);
    if (freshProof !== verifiedPrefix.proofSha256) invalid();
    verified.push(prior);
  }
  for (const planned of plannedStages.slice(verified.length)) {
    aborted(signal);
    await confirmedCheckpoint(checkpoint, signal, {
      stage: planned.stage,
      phase: "intent",
    });
    aborted(signal);
    const result = await executeStep(planned.stage, structuredClone(planned.spec));
    aborted(signal);
    const stageResult = validateStep(result, planned, verified.at(-1));
    await confirmedCheckpoint(checkpoint, signal, {
      stage: planned.stage,
      phase: "verified",
      runId: stageResult.runId,
      assetId: stageResult.asset.assetId,
    });
    verified.push(stageResult);
  }
  return completedEvidence(verified);
}
