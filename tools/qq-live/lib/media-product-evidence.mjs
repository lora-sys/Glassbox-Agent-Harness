import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fail, toolManifestDigest, digest } from "./core.mjs";
import { mediaFixtureStep, mediaObservationFor } from "./media-scenario.mjs";
import {
  boundMediaMessage,
  compareSameMessage,
  messageReplyTimesFollowInput,
} from "./message-binding.mjs";
import {
  verifyCaseLeaseCleanupEvidence,
  verifyLeaseTraceEvidence,
  verifyTraceEvidence,
  verifyMessageBindings,
  filteredAuthorizationEvidence,
  runtimeSnapshot,
} from "./product-evidence.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";
import { inspectRetainedMediaAsset } from "./media-asset-evidence.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TOKEN = /^[a-f0-9]{32}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const LEASE_KEYS = ["expiresAt", "leaseId", "toolsSha256"];
// This reviewed runtime snapshot contains the lease gates, media mapper, Agnes registry, and
// pre-network reference rejection used to derive the witness below. New trees stay closed until
// those contracts are reviewed and this pin is deliberately advanced.
export const MEDIA_REQUEST_SOURCE_TREE_SHA256 =
  "1623ae6957dcf635b48cd5ef09f3c8057afe9ca0f62d9601f1f6fcc1d662300e";
const MEDIA_REQUEST_CONTRACT_ID = "frozen-v3-agnes-lease-request-v1";

function bad(code = "MEDIA_PRODUCT_EVIDENCE") {
  fail(code, "Media evidence does not match the fixed private media test.", "INCONCLUSIVE");
}
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) ===
      JSON.stringify([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  );
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function scopeFor(c, config) {
  return {
    connectionId: config.runtime.connectionId,
    botId: String(config.bot.qq),
    chatType: "private",
    chatId: String(config.driver.qq),
    senderId: String(config.driver.qq),
    threadId: config.runtime.threadId ?? null,
  };
}
function scopeKey(s) {
  return JSON.stringify([s.connectionId, s.botId, s.chatType, s.chatId, s.senderId, s.threadId]);
}
function scopeMatch(actual, expected) {
  return (
    actual?.connectionId === expected.connectionId &&
    String(actual?.botId) === expected.botId &&
    actual?.chatType === "private" &&
    String(actual?.chatId) === expected.chatId &&
    String(actual?.senderId) === expected.senderId &&
    (actual?.threadId ?? null) === expected.threadId
  );
}

const LEASE_REQUEST_WITNESS_V1_KEYS = [
  "schemaVersion",
  "derivation",
  "stage",
  "runId",
  "sessionId",
  "toolCallId",
  "assetId",
  "leaseId",
  "toolsSha256",
  "promptSha256",
  "promptBytes",
  "mode",
  "provider",
  "referenceInput",
  "sourceContractId",
  "sequences",
  "sourceIdentity",
  "proofSha256",
];
const LEASE_REQUEST_WITNESS_V2_KEYS = [
  "schemaVersion",
  "derivation",
  "stage",
  "runId",
  "sessionId",
  "toolCallId",
  "assetId",
  "leaseId",
  "toolsSha256",
  "promptSha256",
  "promptBytes",
  "mode",
  "provider",
  "referenceInput",
  "sourceContractId",
  "sourceIdentity",
  "providerInputSha256",
  "providerInputBytes",
  "admissionSeq",
  "sequences",
  "proofSha256",
];
const MEDIA_REQUEST_OBSERVED_CONTRACT_ID = "media-generation-request-admitted-v2";

function sourceIdentity(runtime, observedAdmission = false) {
  const sourceHashIsValid = observedAdmission
    ? HASH.test(runtime?.sourceTreeSha256 ?? "")
    : runtime?.sourceTreeSha256 === MEDIA_REQUEST_SOURCE_TREE_SHA256;
  if (
    typeof runtime?.checkout !== "string" ||
    !runtime.checkout.startsWith("/") ||
    !/^[a-f0-9]{40}$/u.test(runtime.commit ?? "") ||
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid < 1 ||
    typeof runtime.connectionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runtime.connectionId) ||
    (runtime.threadId !== undefined &&
      runtime.threadId !== null &&
      (typeof runtime.threadId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runtime.threadId))) ||
    !sourceHashIsValid
  )
    bad("MEDIA_REQUEST_SOURCE_UNSUPPORTED");
  return {
    contractId: observedAdmission ? MEDIA_REQUEST_OBSERVED_CONTRACT_ID : MEDIA_REQUEST_CONTRACT_ID,
    checkout: runtime.checkout,
    commit: runtime.commit,
    sourceTreeSha256: runtime.sourceTreeSha256,
    pid: runtime.pid,
    connectionId: runtime.connectionId,
    threadId: runtime.threadId ?? null,
  };
}

function fixedProviderInputs(stage, prompt, includeEmptyImages) {
  if (stage === "image-1k") {
    return [
      {
        mode: "text2image",
        prompt,
        size: "1K",
        ratio: "1:1",
        ...(includeEmptyImages ? { images: [] } : {}),
        output: "base64",
      },
    ];
  }
  if (stage === "video-4s") {
    return [
      {
        mode: "text",
        prompt,
        seconds: 4,
        ...(includeEmptyImages ? { images: [] } : {}),
      },
    ];
  }
  bad("MEDIA_LEASE_REQUEST_WITNESS");
}

/** Derive the fixed request from native admission evidence when present, preserving strict v1 history. */
export function deriveMediaLeaseRequestWitness({
  events,
  runId,
  principalId,
  caseRecord,
  stage,
  runtime,
}) {
  const spec = mediaFixtureStep(stage);
  const token = caseRecord?.token;
  if (!Array.isArray(events) || !RUN_ID.test(runId ?? "") || !TOKEN.test(token ?? ""))
    bad("MEDIA_LEASE_REQUEST_WITNESS");
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const toolsSha256 = toolManifestDigest(tools);
  const prompt = tools[0]?.operations?.[0]?.inputConstraint?.prompt;
  const runEvents = events.filter((event) => event.runId === runId);
  const sessions = runEvents.filter((event) => event.type === "session_start");
  const calls = runEvents.filter((event) => event.type === "tool_call");
  const results = runEvents.filter((event) => event.type === "tool_result");
  const completions = runEvents.filter((event) => event.type === "media_generation_completed");
  const admissions = runEvents.filter(
    (event) => event.type === "media_generation_request_admitted",
  );
  const session = sessions[0];
  const call = calls[0];
  const result = results[0];
  const completion = completions[0];
  const admission = admissions[0];
  const lease = session?.data?.acceptanceLease;
  const expectedMode = stage === "image-1k" ? "text2image" : "text";
  const expectedType = mediaObservationFor(stage).expectedType;
  const expectedInput =
    stage === "image-1k"
      ? { action: "image", mode: expectedMode, ratio: "1:1", size: "1K" }
      : { action: "video", mode: expectedMode, seconds: 4 };
  const sequence = (event) => event?.seq;
  const seq = {
    sessionStart: sequence(session),
    toolCall: sequence(call),
    mediaGenerationCompleted: sequence(completion),
    toolResult: sequence(result),
  };
  const mode = call?.data?.input?.mode;
  const provider = completion?.provider;
  const expectedSessionLease = {
    leaseId: caseRecord.acceptanceLease?.leaseId,
    marker: token,
    narrowedTools: ["media_generate"],
    toolsSha256,
  };
  const callInput = call?.data?.input;
  const callInputMatchesExpected = (candidate) =>
    exact(candidate, Object.keys(expectedInput)) &&
    Object.entries(expectedInput).every(([key, value]) => candidate[key] === value);
  const callInputValid =
    admissions.length === 0
      ? callInputMatchesExpected(callInput)
      : callInputMatchesExpected(callInput) ||
        (exact(callInput, [...Object.keys(expectedInput), "images"]) &&
          Array.isArray(callInput.images) &&
          callInput.images.length === 0 &&
          Object.entries(expectedInput).every(([key, value]) => callInput[key] === value));
  if (
    !HASH.test(toolsSha256) ||
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    !exact(caseRecord.acceptanceLease, LEASE_KEYS) ||
    caseRecord.acceptanceLease.toolsSha256 !== toolsSha256 ||
    sessions.length !== 1 ||
    calls.length !== 1 ||
    results.length !== 1 ||
    completions.length !== 1 ||
    admissions.length > 1 ||
    !exact(lease, ["leaseId", "marker", "narrowedTools", "toolsSha256"]) ||
    lease.leaseId !== expectedSessionLease.leaseId ||
    lease.marker !== expectedSessionLease.marker ||
    !same(lease.narrowedTools, expectedSessionLease.narrowedTools) ||
    lease.toolsSha256 !== expectedSessionLease.toolsSha256 ||
    !same(session.data?.authorizedTools, ["media_generate"]) ||
    call.data?.name !== "media_generate" ||
    result.data?.name !== "media_generate" ||
    typeof call.data?.toolCallId !== "string" ||
    !call.data.toolCallId ||
    call.data.toolCallId !== result.data?.toolCallId ||
    result.data?.isError !== false ||
    !callInputValid ||
    !principalId ||
    session.principalId !== principalId ||
    call.principalId !== principalId ||
    result.principalId !== principalId ||
    call.data?.runId !== runId ||
    result.data?.runId !== runId ||
    completion.type !== "media_generation_completed" ||
    completion.provider !== "agnes" ||
    completion.mediaType !== expectedType ||
    !Array.isArray(completion.assetIds) ||
    completion.assetIds.length !== 1 ||
    !UUID.test(completion.assetIds[0] ?? "") ||
    completion.provenance !== "glassbox-media" ||
    typeof session.sessionId !== "string" ||
    !session.sessionId ||
    !Object.values(seq).every(Number.isSafeInteger) ||
    !(
      seq.sessionStart < seq.toolCall &&
      seq.toolCall < seq.mediaGenerationCompleted &&
      seq.mediaGenerationCompleted < seq.toolResult
    ) ||
    (session.sessionId && call.sessionId !== session.sessionId) ||
    (call.sessionId && result.sessionId !== call.sessionId)
  )
    bad("MEDIA_LEASE_REQUEST_WITNESS");

  const base = {
    stage,
    runId,
    sessionId: session.sessionId,
    toolCallId: call.data.toolCallId,
    assetId: completion.assetIds[0],
    leaseId: lease.leaseId,
    toolsSha256,
    promptSha256: digest(prompt),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    mode,
    provider,
    referenceInput: "none",
  };
  if (admissions.length === 0) {
    const source = sourceIdentity(runtime);
    const witnessBase = {
      schemaVersion: 1,
      derivation: "derived_from_execution_lease",
      ...base,
      sourceContractId: MEDIA_REQUEST_CONTRACT_ID,
      sequences: seq,
      sourceIdentity: source,
    };
    return { ...witnessBase, proofSha256: digest(JSON.stringify(witnessBase)) };
  }

  const source = sourceIdentity(runtime, true);
  const providerInputs = [
    ...fixedProviderInputs(stage, prompt, false),
    ...fixedProviderInputs(stage, prompt, true),
  ];
  const matchingInputs = providerInputs
    .map((input) => {
      const json = JSON.stringify(input);
      return {
        sha256: digest(json),
        bytes: Buffer.byteLength(json, "utf8"),
      };
    })
    .filter(
      (input) =>
        input.sha256 === admission.providerInputSha256 &&
        input.bytes === admission.providerInputBytes,
    );
  const expectedAdmission = {
    type: "media_generation_request_admitted",
    schemaVersion: 1,
    runId,
    principalId,
    toolCallId: call.data.toolCallId,
    provider,
    mediaType: expectedType,
    providerInputSha256: admission.providerInputSha256,
    providerInputBytes: admission.providerInputBytes,
    promptSha256: digest(prompt),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    mode: expectedMode,
    ...(stage === "image-1k" ? { size: "1K", ratio: "1:1" } : { seconds: 4 }),
    referenceCount: 0,
    hasFirstFrame: false,
    hasLastFrame: false,
    seq: admission.seq,
    provenance: "glassbox-media",
  };
  if (
    !Number.isSafeInteger(admission.seq) ||
    !(seq.toolCall < admission.seq && admission.seq < seq.mediaGenerationCompleted) ||
    !exact(admission, Object.keys(expectedAdmission)) ||
    !Object.entries(expectedAdmission).every(([key, value]) => admission[key] === value) ||
    matchingInputs.length !== 1
  )
    bad("MEDIA_LEASE_REQUEST_WITNESS");
  const witnessBase = {
    schemaVersion: 2,
    derivation: "observed_logical_request",
    ...base,
    sourceContractId: MEDIA_REQUEST_OBSERVED_CONTRACT_ID,
    sourceIdentity: source,
    providerInputSha256: admission.providerInputSha256,
    providerInputBytes: admission.providerInputBytes,
    admissionSeq: admission.seq,
    sequences: {
      ...seq,
      requestAdmitted: admission.seq,
    },
  };
  return { ...witnessBase, proofSha256: digest(JSON.stringify(witnessBase)) };
}

export function verifyMediaLeaseRequestWitness(
  witness,
  { stage, runId, caseRecord, runtime, assetId },
) {
  const spec = mediaFixtureStep(stage);
  const token = caseRecord?.token;
  if (!TOKEN.test(token ?? "") || !RUN_ID.test(runId ?? "")) bad("MEDIA_LEASE_REQUEST_WITNESS");
  if (!UUID.test(assetId ?? "")) bad("MEDIA_LEASE_REQUEST_WITNESS");
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const prompt = tools[0]?.operations?.[0]?.inputConstraint?.prompt;
  const base = {
    stage,
    runId,
    sessionId: witness?.sessionId,
    toolCallId: witness?.toolCallId,
    assetId,
    leaseId: caseRecord.acceptanceLease?.leaseId,
    toolsSha256: toolManifestDigest(tools),
    promptSha256: digest(prompt),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    mode: stage === "image-1k" ? "text2image" : "text",
    provider: "agnes",
    referenceInput: "none",
  };
  if (witness?.schemaVersion === 1) {
    const expected = {
      schemaVersion: 1,
      derivation: "derived_from_execution_lease",
      ...base,
      sourceContractId: MEDIA_REQUEST_CONTRACT_ID,
      sequences: witness?.sequences,
      sourceIdentity: sourceIdentity(runtime),
    };
    const seq = witness?.sequences;
    if (
      !exact(witness, LEASE_REQUEST_WITNESS_V1_KEYS) ||
      !witness.sessionId ||
      !witness.toolCallId ||
      !exact(seq, ["sessionStart", "toolCall", "mediaGenerationCompleted", "toolResult"]) ||
      !Object.values(seq).every(Number.isSafeInteger) ||
      !(
        seq.sessionStart < seq.toolCall &&
        seq.toolCall < seq.mediaGenerationCompleted &&
        seq.mediaGenerationCompleted < seq.toolResult
      ) ||
      !same({ ...witness, proofSha256: undefined }, { ...expected, proofSha256: undefined }) ||
      witness.proofSha256 !== digest(JSON.stringify(expected))
    )
      bad("MEDIA_LEASE_REQUEST_WITNESS");
    return witness.proofSha256;
  }
  if (witness?.schemaVersion !== 2) bad("MEDIA_LEASE_REQUEST_WITNESS");
  const expected = {
    schemaVersion: 2,
    derivation: "observed_logical_request",
    ...base,
    sourceContractId: MEDIA_REQUEST_OBSERVED_CONTRACT_ID,
    sourceIdentity: sourceIdentity(runtime, true),
    providerInputSha256: witness?.providerInputSha256,
    providerInputBytes: witness?.providerInputBytes,
    admissionSeq: witness?.admissionSeq,
    sequences: witness?.sequences,
  };
  const seq = witness?.sequences;
  const validInputWitness =
    fixedProviderInputs(stage, prompt, false).some((input) => {
      const json = JSON.stringify(input);
      return (
        digest(json) === witness?.providerInputSha256 &&
        Buffer.byteLength(json, "utf8") === witness?.providerInputBytes
      );
    }) ||
    fixedProviderInputs(stage, prompt, true).some((input) => {
      const json = JSON.stringify(input);
      return (
        digest(json) === witness?.providerInputSha256 &&
        Buffer.byteLength(json, "utf8") === witness?.providerInputBytes
      );
    });
  if (
    !exact(witness, LEASE_REQUEST_WITNESS_V2_KEYS) ||
    !witness.sessionId ||
    !witness.toolCallId ||
    !HASH.test(witness.providerInputSha256 ?? "") ||
    !Number.isSafeInteger(witness.providerInputBytes) ||
    witness.providerInputBytes < 1 ||
    !validInputWitness ||
    witness.admissionSeq !== seq?.requestAdmitted ||
    !exact(seq, [
      "sessionStart",
      "toolCall",
      "requestAdmitted",
      "mediaGenerationCompleted",
      "toolResult",
    ]) ||
    !Object.values(seq).every(Number.isSafeInteger) ||
    !(
      seq.sessionStart < seq.toolCall &&
      seq.toolCall < seq.requestAdmitted &&
      seq.requestAdmitted < seq.mediaGenerationCompleted &&
      seq.mediaGenerationCompleted < seq.toolResult
    ) ||
    !same({ ...witness, proofSha256: undefined }, { ...expected, proofSha256: undefined }) ||
    witness.proofSha256 !== digest(JSON.stringify(expected))
  )
    bad("MEDIA_LEASE_REQUEST_WITNESS");
  return witness.proofSha256;
}

export function validateFixedMediaCaseRecord(c, stage) {
  const spec = mediaFixtureStep(stage);
  const token = c?.token;
  if (typeof token !== "string" || !TOKEN.test(token)) bad();
  const tools = JSON.parse(JSON.stringify(spec.leaseTools).replaceAll("{{nonce}}", token));
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\n${spec.prompt.replaceAll("{{nonce}}", token).trim()}`;
  if (
    c.id !== spec.id ||
    c.route !== "private" ||
    c.status !== "PASS" ||
    c.code !== "REAL_REPLY_RECEIVED" ||
    c.sendAttempted !== true ||
    c.inputObserved !== true ||
    c.leaseRegistrationAttempted !== true ||
    c.leaseRevoked !== true ||
    c.prompt !== prompt ||
    !same(
      c.expected,
      spec.expectContains.map((v) => v.replaceAll("{{nonce}}", token)),
    ) ||
    !same(c.featureAssertions, spec.featureAssertions) ||
    !same(c.leasedToolNames, ["media_generate"]) ||
    !exact(c.acceptanceLease, LEASE_KEYS) ||
    !UUID.test(c.acceptanceLease.leaseId ?? "") ||
    !HASH.test(c.acceptanceLease.toolsSha256 ?? "") ||
    toolManifestDigest(tools) !== c.acceptanceLease.toolsSha256 ||
    !Number.isSafeInteger(c.acceptanceLease.expiresAt) ||
    c.acceptanceLease.expiresAt <= Date.parse(c.startedAt) ||
    !Array.isArray(c.replies) ||
    c.replies.length !== 1 ||
    c.replies[0].route !== "private" ||
    c.replies[0].matches !== true ||
    !Array.isArray(c.anomalies) ||
    c.anomalies.length !== 0 ||
    !c.inputBinding ||
    typeof c.inputBinding.botMessageId !== "string" ||
    typeof c.inputBinding.driverMessageId !== "string" ||
    c.inputBinding.botMessageId === c.inputBinding.driverMessageId ||
    c.sentMessageId !== c.inputBinding.driverMessageId ||
    !HASH.test(c.inputBinding.textSha256 ?? "") ||
    !Number.isSafeInteger(c.inputBinding.time) ||
    !Number.isSafeInteger(c.inputBinding.driverTime) ||
    c.inputBinding.textSha256 !== digest(c.prompt)
  )
    bad();
  const observation = mediaObservationFor(stage);
  if (
    c.mediaObservationExpectedType !== observation.expectedType ||
    c.mediaObservationExpectedCaptionSha256 !== digest(observation.expectedCaption)
  )
    bad();
  return { spec, token, prompt, tools, observation };
}
function getRun(db, c, config) {
  const scope = scopeFor(c, config);
  const rows = db
    .prepare(
      "SELECT r.id,r.status,r.scope_json,r.created_at,r.principal_id,r.conversation_id,m.scope_key,m.text AS input_text,conversations.scope_json AS conversation_scope,p.kind AS principal_kind FROM runs r JOIN messages m ON m.id=r.message_id JOIN conversations ON conversations.id=r.conversation_id JOIN principals p ON p.id=r.principal_id WHERE m.external_id=? AND m.scope_key=?",
    )
    .all(c.inputBinding.botMessageId, scopeKey(scope));
  if (rows.length !== 1) bad("MEDIA_RUN_EVIDENCE");
  const row = rows[0];
  let sourceMatches = false;
  try {
    sourceMatches =
      scopeMatch(JSON.parse(row.scope_json), scope) &&
      scopeMatch(JSON.parse(row.conversation_scope), scope);
  } catch {}
  if (
    row.status !== "succeeded" ||
    Date.parse(row.created_at) < Date.parse(c.startedAt) - 2000 ||
    !sourceMatches ||
    row.input_text !== c.prompt ||
    typeof row.principal_id !== "string" ||
    typeof row.conversation_id !== "string" ||
    row.principal_kind !== "owner"
  )
    bad("MEDIA_RUN_EVIDENCE");
  return { ...row, scope };
}
function readDeliveries(db, run) {
  const rows = db
    .prepare(
      "SELECT id,status,external_id,destination_scope_key,payload_text,payload_kind FROM deliveries WHERE run_id=?",
    )
    .all(run.id);
  if (
    rows.length !== 2 ||
    rows.some(
      (r) =>
        r.status !== "sent" ||
        r.destination_scope_key !== scopeKey(run.scope) ||
        typeof r.external_id !== "string" ||
        !r.external_id,
    )
  )
    bad("MEDIA_DELIVERY_EVIDENCE");
  const result = rows.filter((r) => r.payload_kind === "result");
  const media = rows.filter((r) => r.payload_kind === "media_artifact");
  if (
    result.length !== 1 ||
    media.length !== 1 ||
    result[0].external_id === media[0].external_id ||
    !UUID.test(media[0].payload_text ?? "")
  )
    bad("MEDIA_DELIVERY_EVIDENCE");
  return { result: result[0], media: media[0] };
}
function checkTrace(trace, run, c, config, stage, delivery, asset, deliveryWitness, runtime) {
  const events = trace.events;
  const scoped = events.filter((e) => e.runId === run.id);
  const allCalls = scoped.filter((e) => e.type === "tool_call");
  const allResults = scoped.filter((e) => e.type === "tool_result");
  const calls = allCalls.filter((e) => e.data?.name === "media_generate");
  const results = allResults.filter((e) => e.data?.name === "media_generate");
  const complete = events.filter((e) => e.type === "media_generation_completed");
  const input =
    stage === "image-1k"
      ? { action: "image", mode: "text2image", size: "1K", ratio: "1:1" }
      : { action: "video", mode: "text", seconds: 4 };
  const callInput = calls[0]?.data?.input;
  const baseKeys =
    stage === "image-1k" ? ["action", "mode", "ratio", "size"] : ["action", "mode", "seconds"];
  const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const inputKeys = callInput && Object.keys(callInput).sort(compareKeys);
  const allowedInput = callInput && same(inputKeys, [...baseKeys].sort(compareKeys));
  const fixedInput = Object.entries(input).every(([key, value]) => callInput?.[key] === value);
  if (
    allCalls.length !== 1 ||
    allResults.length !== 1 ||
    calls.length !== 1 ||
    results.length !== 1 ||
    calls[0].data.toolCallId !== results[0].data.toolCallId ||
    results[0].data.isError !== false ||
    !allowedInput ||
    !fixedInput ||
    complete.length !== 1 ||
    !exact(
      Object.fromEntries(
        Object.entries(complete[0]).filter(
          ([key]) =>
            ![
              "runId",
              "seq",
              "ts",
              "conversationId",
              "sessionId",
              "timestamp",
              "provenance",
            ].includes(key),
        ),
      ),
      ["type", "provider", "mediaType", "assetIds"],
    ) ||
    complete[0].type !== "media_generation_completed" ||
    complete[0].mediaType !== asset.mediaType ||
    complete[0].provider !== "agnes" ||
    !same(complete[0].assetIds, [asset.assetId])
  )
    bad("MEDIA_TRACE_GENERATION");
  const leaseRequestWitness = deriveMediaLeaseRequestWitness({
    events,
    runId: run.id,
    principalId: run.principal_id,
    caseRecord: c,
    stage,
    runtime,
  });
  const witnessRows = trace.rows.filter((row) => row.event?.type === "media_delivery_sent");
  verifyLeaseTraceEvidence(events, c, run.id);
  verifyTraceEvidence(events, c, config, delivery);
  if (witnessRows.length === 0) bad("MEDIA_TRACE_DELIVERY_WITNESS_MISSING");
  if (
    witnessRows.length !== 1 ||
    !exact(
      Object.fromEntries(
        Object.entries(witnessRows[0].event).filter(
          ([key]) => !["seq", "ts", "conversationId", "sessionId", "timestamp"].includes(key),
        ),
      ),
      [
        "type",
        "schemaVersion",
        "runId",
        "deliveryId",
        "assetId",
        "externalId",
        "mimeType",
        "sizeBytes",
        "sha256",
      ],
    ) ||
    !Object.entries(deliveryWitness).every(([key, value]) => witnessRows[0].event[key] === value) ||
    witnessRows[0].provenance !== "glassbox-media-delivery"
  )
    bad("MEDIA_TRACE_WITNESS");
  return leaseRequestWitness;
}
export function readMediaTrace(checkout, dataDirectory, runId, capture = execFileSync) {
  const raw = capture(
    process.execPath,
    [
      join(checkout, ".agents/skills/glassbox-ops/scripts/gbxtrace.mjs"),
      "show",
      runId,
      "--json",
      "--data-dir",
      join(dataDirectory, "runs"),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const v = JSON.parse(raw);
  if (
    v.runId !== runId ||
    !Array.isArray(v.events) ||
    v.integrity?.malformed !== 0 ||
    !Array.isArray(v.integrity?.seqGaps) ||
    v.integrity.seqGaps.length !== 0 ||
    v.summary?.events !== v.events.length
  )
    bad("MEDIA_TRACE_EVIDENCE");
  for (const row of v.events) {
    const event = row?.event;
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      typeof row.provenance !== "string" ||
      row.provenance.length === 0 ||
      (event.runId !== undefined && event.runId !== runId) ||
      (event.seq !== undefined && event.seq !== row.seq) ||
      (event.provenance !== undefined && event.provenance !== row.provenance)
    )
      bad("MEDIA_TRACE_EVIDENCE");
  }
  return {
    rows: v.events,
    events: v.events.map((r) => ({
      ...r.event,
      runId,
      seq: r.seq,
      provenance: r.provenance,
    })),
  };
}
export async function verifyMediaCase(input, overrides = {}) {
  const d = {
    runtimeSnapshot,
    openReadOnlyDatabase,
    verifyCaseLeaseCleanupEvidence,
    verifyMessageBindings,
    boundMediaMessage,
    compareSameMessage,
    messageReplyTimesFollowInput,
    inspectRetainedMediaAsset,
    capture: execFileSync,
    ...overrides,
  };
  let db,
    runId,
    beforeRuntime,
    runtimeAfterChecked = false,
    cleanupVerified = false;
  try {
    const c = input.caseRecord,
      config = input.config,
      clients = input.clients,
      stage = input.stage;
    const f = validateFixedMediaCaseRecord(c, stage);
    const before = d.runtimeSnapshot(config.runtime, d.capture);
    beforeRuntime = before;
    if (
      !input.expectedRuntime ||
      !same(before, input.expectedRuntime) ||
      !input.mediaObservations ||
      typeof input.mediaObservations !== "object" ||
      Array.isArray(input.mediaObservations) ||
      input.mediaObservations.overflow !== false ||
      !Array.isArray(input.mediaObservations.candidates) ||
      input.mediaObservations.candidates.length !== 1
    )
      bad("RUNTIME_CHANGED");
    db = d.openReadOnlyDatabase(join(before.dataDirectory, "glassbox.db"));
    const run = getRun(db, c, config);
    runId = run.id;
    await d.verifyCaseLeaseCleanupEvidence(db, before.dataDirectory, c, {
      runId,
      scope: run.scope,
    });
    cleanupVerified = true;
    const deliveries = readDeliveries(db, run);
    const decisions = db
      .prepare(
        "SELECT id,action,resource_id,principal_id,scope_key,delivery_source,decision FROM authorization_decisions_all WHERE run_id=?",
      )
      .all(run.id);
    const mediaAllows = decisions.filter(
      (x) =>
        x.decision === "ALLOW" &&
        x.action === "media:generate" &&
        x.resource_id === "media-generation" &&
        x.principal_id === run.principal_id &&
        x.scope_key === scopeKey(run.scope) &&
        x.delivery_source === null,
    );
    if (mediaAllows.length !== 1) bad("MEDIA_AUTHORIZATION_EVIDENCE");
    filteredAuthorizationEvidence(db, run, scopeKey(run.scope), decisions);
    await d.verifyMessageBindings(c, config, clients, deliveries.result);
    const trace = readMediaTrace(before.checkout, before.dataDirectory, run.id, d.capture);
    const events = trace.events;
    const sessions = events.filter((e) => e.runId === run.id && e.type === "session_start");
    if (sessions.length !== 1) bad("MEDIA_TRACE_EVIDENCE");
    const assetId = deliveries.media.payload_text;
    const asset = await d.inspectRetainedMediaAsset(
      {
        dataDirectory: before.dataDirectory,
        assetId,
        binding: {
          principalId: run.principal_id,
          conversationId: run.conversation_id,
          runId: run.id,
        },
        stage,
      },
      { capture: d.capture },
    );
    const obs = input.mediaObservations.candidates[0];
    const expected = f.observation;
    if (
      !exact(obs, ["messageId", "mediaType", "captionSha256", "segmentCount", "receivedAt"]) ||
      typeof obs.messageId !== "string" ||
      obs.mediaType !== expected.expectedType ||
      obs.captionSha256 !== digest(expected.expectedCaption) ||
      obs.segmentCount !== 2 ||
      !/^-?\d{1,20}$/u.test(obs.messageId) ||
      !Number.isFinite(Date.parse(obs.receivedAt)) ||
      Date.parse(obs.receivedAt) < Date.parse(c.startedAt) - 2000 ||
      Date.parse(obs.receivedAt) > Date.now() + 5000
    )
      bad("MEDIA_RECEIVER_EVIDENCE");
    const deliveryWitness = {
      type: "media_delivery_sent",
      schemaVersion: 1,
      runId: run.id,
      deliveryId: deliveries.media.id,
      assetId,
      externalId: deliveries.media.external_id,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    };
    const leaseRequestWitness = checkTrace(
      trace,
      run,
      c,
      config,
      stage,
      deliveries.result,
      { ...asset, assetId, mediaType: expected.expectedType },
      deliveryWitness,
      before,
    );
    verifyMediaLeaseRequestWitness(leaseRequestWitness, {
      stage,
      runId: run.id,
      caseRecord: c,
      runtime: before,
      assetId: asset.assetId,
    });
    clients.bot.allowMessageRead(String(deliveries.media.external_id));
    clients.driver.allowMessageRead(String(obs.messageId));
    const bot = await d.boundMediaMessage(clients.bot, String(deliveries.media.external_id), {
      selfId: config.bot.qq,
      senderId: config.bot.qq,
      messageType: "private",
      mediaType: expected.expectedType,
      caption: expected.expectedCaption,
      afterTime: c.startedAt,
    });
    const driver = await d.boundMediaMessage(clients.driver, String(obs.messageId), {
      selfId: config.driver.qq,
      senderId: config.bot.qq,
      messageType: "private",
      mediaType: expected.expectedType,
      caption: expected.expectedCaption,
      afterTime: c.startedAt,
    });
    const receiver = d.compareSameMessage(bot, driver);
    if (
      bot.messageId === driver.messageId ||
      !d.messageReplyTimesFollowInput(c.inputBinding, {
        ...receiver,
        driverTime: driver.time,
      })
    )
      bad("MEDIA_RECEIVER_EVIDENCE");
    const after = d.runtimeSnapshot(config.runtime, d.capture);
    if (!same(after, before)) bad("RUNTIME_CHANGED");
    runtimeAfterChecked = true;
    return {
      status: "PASS",
      stage,
      runId: run.id,
      asset,
      receiverBinding: receiver,
      leaseRequestWitness,
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
      limitation: "QQ evidence binds the received attachment segment, not unchanged media bytes.",
    };
  } catch (error) {
    let failureCode = error?.code || "MEDIA_PRODUCT_EVIDENCE";
    if (beforeRuntime && !runtimeAfterChecked && input?.config?.runtime) {
      try {
        const after = d.runtimeSnapshot(input.config.runtime, d.capture);
        runtimeAfterChecked = true;
        if (!same(after, beforeRuntime)) failureCode = "RUNTIME_CHANGED";
      } catch {
        failureCode = "RUNTIME_CHANGED";
      }
    }
    const wrapped = new Error("Media product evidence is inconclusive.");
    wrapped.code = failureCode;
    wrapped.status = "INCONCLUSIVE";
    wrapped.cleanupVerified = cleanupVerified;
    throw wrapped;
  } finally {
    db?.close?.();
  }
}
