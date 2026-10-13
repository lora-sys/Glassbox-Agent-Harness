import assert from "node:assert/strict";
import test from "node:test";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { mediaFamilyPlan, mediaObservationFor, MEDIA_FAMILY_ID } from "../lib/media-scenario.mjs";
import { runMediaWorkflow } from "../lib/media-workflow.mjs";

const ids = {
  "image-1k": {
    token: "1".repeat(32),
    runId: "image-run",
    leaseId: "11111111-1111-4111-8111-111111111111",
    assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
  "video-4s": {
    token: "2".repeat(32),
    runId: "video-run",
    leaseId: "22222222-2222-4222-8222-222222222222",
    assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  },
};

function stageResult(stage) {
  const { token, runId, leaseId, assetId } = ids[stage];
  const spec = mediaFamilyPlan().stages.find((item) => item.stage === stage).spec;
  const leaseTools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const observation = mediaObservationFor(stage);
  const testCase = {
    id: spec.id,
    status: "PASS",
    route: "private",
    token,
    startedAt: "2026-10-07T00:00:00.000Z",
    sendAttempted: true,
    sentMessageId: `1${stage === "image-1k" ? "1" : "2"}`,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`,
    expected: spec.expectContains.map((item) => item.replaceAll("{{nonce}}", token)),
    featureAssertions: JSON.parse(
      JSON.stringify(spec.featureAssertions).replaceAll("{{nonce}}", token),
    ),
    leasedToolNames: leaseTools.map((tool) => tool.name),
    acceptanceLease: {
      leaseId,
      expiresAt: Date.parse("2026-10-07T00:10:00.000Z"),
      toolsSha256: toolManifestDigest(leaseTools),
    },
    mediaObservationExpectedType: observation.expectedType,
    mediaObservationExpectedCaptionSha256: digest(observation.expectedCaption),
  };
  return {
    transportCase: testCase,
    mediaAcceptance: {
      status: "PASS",
      stage,
      runId,
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
      asset:
        stage === "image-1k"
          ? {
              assetId,
              mimeType: "image/png",
              sizeBytes: 1200,
              sha256: "a".repeat(64),
              width: 1024,
              height: 1024,
              fullDecodeVerified: true,
              retained: true,
            }
          : {
              assetId,
              mimeType: "video/mp4",
              sizeBytes: 2400,
              sha256: "b".repeat(64),
              width: 640,
              height: 360,
              fullDecodeVerified: true,
              retained: true,
              durationSeconds: 4,
              framesPerSecond: 30,
              durationToleranceSeconds: 1 / 30,
            },
    },
  };
}

const prefix = {
  schemaVersion: 1,
  familyId: MEDIA_FAMILY_ID,
  stage: "image-1k",
  token: ids["image-1k"].token,
  runId: ids["image-1k"].runId,
  leaseId: ids["image-1k"].leaseId,
  asset: stageResult("image-1k").mediaAcceptance.asset,
  planSha256: "c".repeat(64),
  proofSha256: "d".repeat(64),
};

test("verified image prefix resumes only the pending video stage", async () => {
  const executed = [];
  const checkpoints = [];
  const result = await runMediaWorkflow({
    verifiedPrefix: prefix,
    revalidatePrefix: async (fresh) => fresh.proofSha256,
    executeStep: async (stage) => {
      executed.push(stage);
      return stageResult(stage);
    },
    checkpoint: async (row) => {
      checkpoints.push(row);
      return true;
    },
  });

  assert.deepEqual(executed, ["video-4s"]);
  assert.deepEqual(
    checkpoints.map((row) => [row.stage, row.phase]),
    [
      ["video-4s", "intent"],
      ["video-4s", "verified"],
    ],
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.stageRunIds, [ids["image-1k"].runId, ids["video-4s"].runId]);
});

test("a missing or changed image-prefix proof fails before checkpoint or send", async () => {
  for (const revalidatePrefix of [undefined, async () => "e".repeat(64)]) {
    const executed = [];
    const checkpoints = [];
    await assert.rejects(
      runMediaWorkflow({
        verifiedPrefix: prefix,
        revalidatePrefix,
        executeStep: async (stage) => {
          executed.push(stage);
          return stageResult(stage);
        },
        checkpoint: async (row) => {
          checkpoints.push(row);
          return true;
        },
      }),
    );
    assert.deepEqual(executed, []);
    assert.deepEqual(checkpoints, []);
  }
});

test("a malformed prefix is rejected without running either media stage", async () => {
  const executed = [];
  await assert.rejects(
    runMediaWorkflow({
      verifiedPrefix: { ...prefix, stage: "video-4s" },
      revalidatePrefix: async () => prefix.proofSha256,
      executeStep: async (stage) => {
        executed.push(stage);
        return stageResult(stage);
      },
      checkpoint: async () => true,
    }),
  );
  assert.deepEqual(executed, []);
});

test("ordinary workflow still executes image then video", async () => {
  const executed = [];
  const result = await runMediaWorkflow({
    executeStep: async (stage) => {
      executed.push(stage);
      return stageResult(stage);
    },
    checkpoint: async () => true,
  });
  assert.deepEqual(executed, ["image-1k", "video-4s"]);
  assert.equal(result.status, "PASS");
});
