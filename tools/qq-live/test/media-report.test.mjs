import test from "node:test";
import assert from "node:assert/strict";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { mediaFamilyPlan } from "../lib/media-scenario.mjs";
import { validateMediaWorkflowEvidence } from "../lib/media-workflow.mjs";
import { verifyMediaHistoricalReport } from "../lib/media-report.mjs";

function fixture() {
  const runtime = {
    checkout: "/fixture",
    dataDirectory: "/fixture-data",
    commit: "a".repeat(40),
    pid: 123,
    connectionId: "qq-test",
  };
  const rows = mediaFamilyPlan().stages.map(({ stage, spec, observation }, index) => {
    const token = String(index + 1).repeat(32);
    const runId = `${index + 1}`.repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const asset = {
      assetId: `${index + 3}`.repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      mimeType: index === 0 ? "image/png" : "video/mp4",
      sizeBytes: 4096,
      sha256: digest(stage),
      width: 1024,
      height: 1024,
      fullDecodeVerified: true,
      retained: true,
      ...(index === 1
        ? { durationSeconds: 4, framesPerSecond: 30, durationToleranceSeconds: 1 / 30 }
        : {}),
    };
    const c = {
      id: spec.id,
      token,
      runId,
      status: "PASS",
      route: "private",
      sendAttempted: true,
      sentMessageId: String(100 + index),
      inputObserved: true,
      leaseRegistrationAttempted: true,
      leaseRevoked: true,
      startedAt: `2026-10-07T00:00:0${index}.000Z`,
      prompt: `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`,
      expected: [token],
      featureAssertions: spec.featureAssertions,
      leasedToolNames: ["media_generate"],
      acceptanceLease: {
        leaseId: `${index + 5}`.repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expiresAt: Date.now() + 60000,
        toolsSha256: toolManifestDigest(spec.leaseTools),
      },
      mediaObservationExpectedType: observation.expectedType,
      mediaObservationExpectedCaptionSha256: digest(observation.expectedCaption),
      mediaObservationClosed: true,
      mediaObservationOverflow: false,
      mediaObservations: [
        {
          messageId: String(200 + index),
          mediaType: observation.expectedType,
          captionSha256: digest(observation.expectedCaption),
          segmentCount: 2,
          receivedAt: `2026-10-07T00:00:0${index}.500Z`,
        },
      ],
    };
    const fresh = {
      status: "PASS",
      stage,
      runId,
      runCreatedAt: c.startedAt,
      messageBinding: {
        input: {
          realSequence: String(300 + index),
          time: 1791324000 + index,
          driverTime: 1791324000 + index,
          textSha256: digest(c.prompt),
        },
      },
      asset,
      receiverBinding: { realSequence: String(400 + index) },
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
    };
    return { c, fresh };
  });
  const family = validateMediaWorkflowEvidence(
    rows.map(({ c, fresh }) => ({ transportCase: c, mediaAcceptance: fresh })),
  );
  const approvedSuiteSha256 = "b".repeat(64);
  const report = {
    mode: "run",
    status: "PASS",
    suiteSha256: approvedSuiteSha256,
    runtime,
    plannedCaseCount: 2,
    executedCaseCount: 2,
    cases: rows.map(({ c }) => c),
    productAcceptance: {
      status: "PASS",
      runtime,
      cleanupVerified: true,
      cases: rows.map(({ c, fresh }) => ({ caseId: c.id, ...fresh })),
    },
    mediaFamilyAcceptance: family,
  };
  const input = {
    report,
    expectedRuntime: runtime,
    approvedSuiteSha256,
    config: { runtime },
    clients: { bot: {}, driver: {} },
  };
  const calls = [];
  const dependencies = {
    verifyCase: async ({ stage, caseRecord, mediaObservations }) => {
      calls.push(stage);
      assert.deepEqual(mediaObservations, {
        candidates: caseRecord.mediaObservations,
        overflow: false,
      });
      return structuredClone(rows.find(({ fresh }) => fresh.stage === stage).fresh);
    },
  };
  return { input, rows, calls, dependencies };
}

test("historical media rechecks both retained stages without generation or checkpoints", async () => {
  const f = fixture();
  const receipt = await verifyMediaHistoricalReport(f.input, f.dependencies);
  assert.deepEqual(f.calls, ["image-1k", "video-4s"]);
  assert.deepEqual(
    receipt.stageRunIds,
    f.rows.map(({ fresh }) => fresh.runId),
  );
  assert.equal(receipt.actualQqDeliveryVerified, true);
  assert.equal(receipt.cleanupVerified, true);
  assert.equal(receipt.stages.length, 2);
});

test("historical media rejects altered approval, stage, observation, receipt and retained family", async () => {
  for (const mutate of [
    (f) => {
      f.input.report.suiteSha256 = "c".repeat(64);
    },
    (f) => {
      f.input.report.cases.reverse();
    },
    (f) => {
      f.input.report.cases[0].mediaObservationClosed = false;
    },
    (f) => {
      f.input.report.cases[0].mediaObservations.push({});
    },
    (f) => {
      f.input.report.productAcceptance.cases[0].asset.sha256 = "d".repeat(64);
    },
    (f) => {
      f.input.report.mediaFamilyAcceptance.cleanup.leaseRevoked = false;
    },
    (f) => {
      f.input.report.runtime = { ...f.input.report.runtime, pid: 999 };
    },
  ]) {
    const f = fixture();
    // Serialized records must be independent of the verifier's retained fixture.
    f.input.report = structuredClone(f.input.report);
    mutate(f);
    await assert.rejects(verifyMediaHistoricalReport(f.input, f.dependencies), {
      code: "MEDIA_REPORT_EVIDENCE",
    });
  }
});

test("fresh media evidence cannot reuse a Run or Asset, reverse chronology or hide failed delivery", async () => {
  for (const mutate of [
    (r) => {
      r[1].fresh.runCreatedAt = r[0].fresh.runCreatedAt;
    },
    (r) => {
      r[1].fresh.runCreatedAt = "invalid-date";
    },
    (r) => {
      r[1].fresh.runId = r[0].fresh.runId;
    },
    (r) => {
      r[1].fresh.asset.assetId = r[0].fresh.asset.assetId;
    },
    (r) => {
      r[1].fresh.actualQqDeliveryVerified = false;
    },
  ]) {
    const f = fixture();
    f.input.report = structuredClone(f.input.report);
    mutate(f.rows);
    await assert.rejects(verifyMediaHistoricalReport(f.input, f.dependencies));
  }
  const f = fixture();
  await assert.rejects(
    verifyMediaHistoricalReport(f.input, {
      verifyCase: async () => {
        throw new Error("private-provider-detail");
      },
    }),
    (error) =>
      error.code === "MEDIA_REPORT_EVIDENCE" && !error.message.includes("private-provider-detail"),
  );
});
