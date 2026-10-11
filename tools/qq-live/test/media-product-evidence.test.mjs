import assert from "node:assert/strict";
import test from "node:test";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import {
  deriveMediaLeaseRequestWitness,
  MEDIA_REQUEST_SOURCE_TREE_SHA256,
  validateFixedMediaCaseRecord,
  verifyMediaLeaseRequestWitness,
} from "../lib/media-product-evidence.mjs";
import { mediaFixtureStep, mediaObservationFor } from "../lib/media-scenario.mjs";

const token = "a".repeat(32);
const runId = "12345678-1234-4234-8234-123456789abc";
const principalId = "owner-principal";
const leaseId = "87654321-4321-4321-8321-cba987654321";
const assetId = "fedcba98-7654-4321-8765-abcdefabcdef";
const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${mediaFixtureStep("image-1k")
  .prompt.replaceAll("{{nonce}}", token)
  .trim()}`;
const spec = mediaFixtureStep("image-1k");
const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
const runtime = {
  checkout: "/fixture/checkout",
  commit: "b".repeat(40),
  sourceTreeSha256: MEDIA_REQUEST_SOURCE_TREE_SHA256,
  pid: 4812,
  connectionId: "qq-live-fixture",
  threadId: null,
};

function caseRecord(stage = "image-1k") {
  const stageSpec = mediaFixtureStep(stage);
  const stageTools = JSON.parse(
    JSON.stringify(stageSpec.leaseTools).replaceAll("{{nonce}}", token),
  );
  const stagePrompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${stageSpec.prompt
    .replaceAll("{{nonce}}", token)
    .trim()}`;
  const observation = mediaObservationFor(stage);
  return {
    id: stageSpec.id,
    route: "private",
    status: "PASS",
    code: "REAL_REPLY_RECEIVED",
    sendAttempted: true,
    inputObserved: true,
    leaseRegistrationAttempted: true,
    leaseRevoked: true,
    token,
    startedAt: "2026-10-08T00:00:00.000Z",
    prompt: stagePrompt,
    expected: [token],
    featureAssertions: JSON.parse(
      JSON.stringify(stageSpec.featureAssertions).replaceAll("{{nonce}}", token),
    ),
    leasedToolNames: ["media_generate"],
    acceptanceLease: {
      leaseId,
      expiresAt: Date.parse("2026-10-08T00:10:00.000Z"),
      toolsSha256: toolManifestDigest(stageTools),
    },
    replies: [{ route: "private", matches: true }],
    anomalies: [],
    sentMessageId: "900001",
    inputBinding: {
      driverMessageId: "900001",
      botMessageId: "800001",
      textSha256: digest(stagePrompt),
      time: 1791417600,
      driverTime: 1791417600,
    },
    mediaObservationExpectedType: observation.expectedType,
    mediaObservationExpectedCaptionSha256: digest(observation.expectedCaption),
  };
}

function traceEvents(transform = (events) => events, stage = "image-1k") {
  const c = caseRecord(stage);
  const stageSpec = mediaFixtureStep(stage);
  const stageTools = JSON.parse(
    JSON.stringify(stageSpec.leaseTools).replaceAll("{{nonce}}", token),
  );
  const toolInput = { ...stageTools[0].operations[0].inputConstraint };
  delete toolInput.prompt;
  toolInput.mode = stage === "image-1k" ? "text2image" : "text";
  const lease = {
    leaseId,
    marker: token,
    narrowedTools: ["media_generate"],
    toolsSha256: c.acceptanceLease.toolsSha256,
  };
  const events = [
    {
      type: "session_start",
      seq: 10,
      runId,
      principalId,
      sessionId: "session-1",
      data: { acceptanceLease: lease, authorizedTools: ["media_generate"] },
    },
    {
      type: "tool_call",
      seq: 11,
      runId,
      principalId,
      sessionId: "session-1",
      data: {
        name: "media_generate",
        runId,
        toolCallId: "call-1",
        input: toolInput,
      },
    },
    {
      type: "media_generation_completed",
      seq: 12,
      provenance: "glassbox-media",
      runId,
      provider: "agnes",
      mediaType: mediaObservationFor(stage).expectedType,
      assetIds: [assetId],
    },
    {
      type: "tool_result",
      seq: 13,
      runId,
      principalId,
      sessionId: "session-1",
      data: {
        name: "media_generate",
        runId,
        toolCallId: "call-1",
        isError: false,
      },
    },
  ];
  return transform(events, c);
}

function derive(events, c = caseRecord(), actualRuntime = runtime, stage = "image-1k") {
  return deriveMediaLeaseRequestWitness({
    events,
    runId,
    principalId,
    caseRecord: c,
    stage,
    runtime: actualRuntime,
  });
}

function nativeAdmissionTraceEvents({ stage = "image-1k", emptyImages = false, mutate } = {}) {
  const events = traceEvents(undefined, stage);
  const stageSpec = mediaFixtureStep(stage);
  const stageTools = JSON.parse(
    JSON.stringify(stageSpec.leaseTools).replaceAll("{{nonce}}", token),
  );
  const operation = stageTools[0].operations[0].inputConstraint;
  const prompt = operation.prompt;
  const providerMode = stage === "image-1k" ? "text2image" : "text";
  const providerInput =
    stage === "image-1k"
      ? {
          mode: providerMode,
          prompt,
          size: operation.size,
          ratio: operation.ratio,
          ...(emptyImages ? { images: [] } : {}),
          output: "base64",
        }
      : {
          mode: providerMode,
          prompt,
          seconds: operation.seconds,
          ...(emptyImages ? { images: [] } : {}),
        };
  const providerInputJson = JSON.stringify(providerInput);
  const observation = mediaObservationFor(stage);
  const admission = {
    type: "media_generation_request_admitted",
    schemaVersion: 1,
    runId,
    principalId,
    toolCallId: "call-1",
    provider: "agnes",
    mediaType: observation.expectedType,
    providerInputSha256: digest(providerInputJson),
    providerInputBytes: Buffer.byteLength(providerInputJson, "utf8"),
    promptSha256: digest(prompt),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    mode: providerMode,
    ...(stage === "image-1k"
      ? { size: operation.size, ratio: operation.ratio }
      : { seconds: operation.seconds }),
    referenceCount: 0,
    hasFirstFrame: false,
    hasLastFrame: false,
    seq: 12,
    provenance: "glassbox-media",
  };
  events[2].seq = 13;
  events[3].seq = 14;
  events.splice(2, 0, admission);
  return mutate ? (mutate(events, admission) ?? events) : events;
}

test("fixed media case binds sent ID to Driver ID and allows distinct account-local IDs", () => {
  const c = caseRecord();
  assert.notEqual(c.inputBinding.driverMessageId, c.inputBinding.botMessageId);
  assert.equal(validateFixedMediaCaseRecord(c, "image-1k").prompt, prompt);

  assert.throws(
    () =>
      validateFixedMediaCaseRecord(
        { ...c, sentMessageId: c.inputBinding.botMessageId },
        "image-1k",
      ),
    { code: "MEDIA_PRODUCT_EVIDENCE" },
  );
});

test("derives a redacted canonical prompt witness from the admitted fixed lease and successful request", () => {
  const events = traceEvents();
  const witness = derive(events);
  const fixedPrompt = tools[0].operations[0].inputConstraint.prompt;
  assert.equal(witness.derivation, "derived_from_execution_lease");
  assert.equal(witness.promptSha256, digest(fixedPrompt));
  assert.equal(witness.promptBytes, Buffer.byteLength(fixedPrompt, "utf8"));
  assert.equal(witness.referenceInput, "none");
  assert.equal(witness.provider, "agnes");
  assert.equal(witness.mode, "text2image");
  assert.deepEqual(witness.sourceIdentity, {
    contractId: "frozen-v3-agnes-lease-request-v1",
    checkout: runtime.checkout,
    commit: runtime.commit,
    sourceTreeSha256: runtime.sourceTreeSha256,
    pid: runtime.pid,
    connectionId: runtime.connectionId,
    threadId: null,
  });
  assert.equal(Object.hasOwn(events[1].data.input, "prompt"), false);
  assert.equal(JSON.stringify(witness).includes(fixedPrompt), false);
  assert.equal(
    verifyMediaLeaseRequestWitness(witness, {
      stage: "image-1k",
      runId,
      caseRecord: caseRecord(),
      runtime,
      assetId,
    }),
    witness.proofSha256,
  );
});

test("derives and verifies v2 from one native logical-request admission event", () => {
  const events = nativeAdmissionTraceEvents();
  const actualRuntime = { ...runtime, sourceTreeSha256: "c".repeat(64) };
  const witness = derive(events, caseRecord(), actualRuntime);
  const reordered = nativeAdmissionTraceEvents({
    mutate: (rows) => {
      rows[2] = Object.fromEntries(Object.entries(rows[2]).reverse());
      return rows;
    },
  });
  assert.equal(derive(reordered, caseRecord(), actualRuntime).schemaVersion, 2);
  assert.equal(witness.schemaVersion, 2);
  assert.equal(witness.derivation, "observed_logical_request");
  assert.equal(witness.admissionSeq, 12);
  assert.equal(witness.sequences.requestAdmitted, 12);
  assert.equal(witness.providerInputSha256, events[2].providerInputSha256);
  assert.equal(witness.providerInputBytes, events[2].providerInputBytes);
  assert.equal(witness.sourceIdentity.sourceTreeSha256, actualRuntime.sourceTreeSha256);
  assert.equal(witness.sourceIdentity.contractId, "media-generation-request-admitted-v2");
  assert.equal(
    JSON.stringify(witness).includes(tools[0].operations[0].inputConstraint.prompt),
    false,
  );
  assert.equal(
    verifyMediaLeaseRequestWitness(witness, {
      stage: "image-1k",
      runId,
      caseRecord: caseRecord(),
      runtime: actualRuntime,
      assetId,
    }),
    witness.proofSha256,
  );
});

test("reconstructs the fixed video provider request from its native admission event", () => {
  const events = nativeAdmissionTraceEvents({ stage: "video-4s" });
  const actualRuntime = { ...runtime, sourceTreeSha256: "9".repeat(64) };
  const c = caseRecord("video-4s");
  const witness = derive(events, c, actualRuntime, "video-4s");
  assert.equal(witness.schemaVersion, 2);
  assert.equal(witness.mode, "text");
  assert.equal(witness.providerInputSha256, events[2].providerInputSha256);
  assert.equal(
    verifyMediaLeaseRequestWitness(witness, {
      stage: "video-4s",
      runId,
      caseRecord: c,
      runtime: actualRuntime,
      assetId,
    }),
    witness.proofSha256,
  );
});

test("accepts an empty image reference list only when its native provider hash matches", () => {
  const events = nativeAdmissionTraceEvents({ emptyImages: true });
  assert.equal(Object.hasOwn(events[1].data.input, "images"), false);
  const witness = derive(events, caseRecord(), {
    ...runtime,
    sourceTreeSha256: "d".repeat(64),
  });
  assert.equal(witness.providerInputSha256, events[2].providerInputSha256);
  assert.equal(witness.providerInputBytes, events[2].providerInputBytes);
});

test("rejects malformed, duplicate, misbound, or unordered native admission evidence", () => {
  const mutations = [
    (rows) => rows.push({ ...rows[2] }),
    (_rows, admission) => {
      admission.providerInputSha256 = "e".repeat(64);
    },
    (_rows, admission) => {
      admission.promptSha256 = "e".repeat(64);
    },
    (_rows, admission) => {
      admission.principalId = "other-principal";
    },
    (_rows, admission) => {
      admission.provenance = "untrusted-media";
    },
    (_rows, admission) => {
      admission.seq = 14;
    },
    (_rows, admission) => {
      admission.rawPrompt = "should-not-be-accepted";
    },
    (_rows, admission) => {
      admission.schemaVersion = 2;
    },
  ];
  for (const mutate of mutations) {
    assert.throws(() => derive(nativeAdmissionTraceEvents({ mutate })), {
      code: "MEDIA_LEASE_REQUEST_WITNESS",
    });
  }
  const unsupported = { ...runtime, sourceTreeSha256: "not-a-hash" };
  assert.throws(() => derive(nativeAdmissionTraceEvents(), caseRecord(), unsupported), {
    code: "MEDIA_REQUEST_SOURCE_UNSUPPORTED",
  });
  const actualRuntime = { ...runtime, sourceTreeSha256: "c".repeat(64) };
  const witness = derive(nativeAdmissionTraceEvents(), caseRecord(), actualRuntime);
  for (const tampered of [
    { ...witness, providerInputSha256: "f".repeat(64) },
    { ...witness, admissionSeq: witness.admissionSeq + 1 },
    {
      ...witness,
      sourceIdentity: {
        ...witness.sourceIdentity,
        sourceTreeSha256: "e".repeat(64),
      },
    },
  ]) {
    assert.throws(
      () =>
        verifyMediaLeaseRequestWitness(tampered, {
          stage: "image-1k",
          runId,
          caseRecord: caseRecord(),
          runtime: actualRuntime,
          assetId,
        }),
      { code: "MEDIA_LEASE_REQUEST_WITNESS" },
    );
  }
});

test("rejects missing, duplicate, mismatched, out-of-order, or untrusted request evidence", () => {
  const mutations = [
    (events) => events.splice(0, 1),
    (events) => events.push({ ...events[1] }),
    (events) => {
      events[0].data.acceptanceLease.toolsSha256 = "d".repeat(64);
    },
    (events) => events.push({ ...events[2] }),
    (events) => {
      events[1].data.input.prompt = tools[0].operations[0].inputConstraint.prompt;
    },
    (events) => {
      events[1].data.input.mode = "img2img";
    },
    (events) => {
      events[2].provider = "unknown";
    },
    (events) => {
      events[2].seq = 10;
    },
    (events) => {
      events[3].data.toolCallId = "other-call";
    },
    (events) => {
      events[3].data.isError = true;
    },
    (events) => {
      events[1].principalId = "other-principal";
    },
    (events) => {
      events[1].data.runId = "other-run";
    },
  ];
  for (const mutate of mutations) {
    assert.throws(() => derive(traceEvents((events) => mutate(events))), {
      code: "MEDIA_LEASE_REQUEST_WITNESS",
    });
  }

  const wrongManifest = caseRecord();
  wrongManifest.acceptanceLease.toolsSha256 = "d".repeat(64);
  assert.throws(() => derive(traceEvents(), wrongManifest), {
    code: "MEDIA_LEASE_REQUEST_WITNESS",
  });

  const witness = derive(traceEvents());
  assert.throws(
    () =>
      verifyMediaLeaseRequestWitness(witness, {
        stage: "image-1k",
        runId,
        caseRecord: caseRecord(),
        runtime: { ...runtime, sourceTreeSha256: "e".repeat(64) },
        assetId,
      }),
    { code: "MEDIA_REQUEST_SOURCE_UNSUPPORTED" },
  );
  assert.throws(
    () =>
      verifyMediaLeaseRequestWitness(
        { ...witness, promptSha256: "f".repeat(64) },
        {
          stage: "image-1k",
          runId,
          caseRecord: caseRecord(),
          runtime,
          assetId,
        },
      ),
    { code: "MEDIA_LEASE_REQUEST_WITNESS" },
  );
});
