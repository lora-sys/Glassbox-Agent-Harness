import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { groupFilesEvidence } from "../../../apps/server/src/runtime/pi/group-files-evidence.ts";
import { safeToolOutput } from "../../../apps/server/src/runtime/pi/tool-output-evidence.ts";
import {
  observeGroupFilesResult,
  projectGroupFiles,
  verifyGroupFilesEvidence,
} from "../lib/group-files-evidence.mjs";
import { observeFeature } from "../lib/feature-observer.mjs";

const runId = "run-group-files-1";
const groupId = "20001";
const fileName = "验收.pdf";
const fileId = "f1";
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const providerResult = () => ({
  files: [
    {
      group_id: Number(groupId),
      file_id: fileId,
      file_name: fileName,
      file_size: 412,
    },
  ],
  folders: [
    {
      group_id: groupId,
      folder_id: "d1",
      folder_name: "资料",
      total_file_count: 2,
    },
  ],
});

function fixture({ result = providerResult(), params, inputGroupId = groupId } = {}) {
  const input = { groupId: inputGroupId, operation: "get_group_root_files" };
  if (params !== undefined) input.params = params;
  const providerEnvelope = { status: "ok", data: result };
  const wrapper = {
    content: [{ type: "text", text: JSON.stringify(providerEnvelope) }],
    details: providerEnvelope,
  };
  const outputHead = JSON.stringify(wrapper);
  const callId = "call-group-files-1";
  const projection = projectGroupFiles(result, groupId);
  const events = [
    {
      type: "tool_call",
      runId,
      toolCallId: callId,
      data: { toolCallId: callId, name: "qq_group_files", input },
    },
    {
      type: "tool_result",
      runId,
      toolCallId: callId,
      data: {
        toolCallId: callId,
        name: "qq_group_files",
        isError: false,
        groupFiles: { schemaVersion: 2, ...projection },
        outputHead:
          Buffer.byteLength(outputHead, "utf8") > 512
            ? Buffer.from(outputHead, "utf8").subarray(0, 512).toString("utf8")
            : outputHead,
        outputTruncated: Buffer.byteLength(outputHead, "utf8") > 512,
        outputBytes: Buffer.byteLength(outputHead, "utf8"),
        outputSha256: hash(outputHead),
      },
    },
  ];
  const traceAssertion = {
    kind: "trace",
    type: "tool_result",
    where: { name: "qq_group_files", isError: false },
    count: 1,
  };
  const groupFilesAssertion = {
    kind: "group_files",
    tool: "qq_group_files",
    groupId,
    count: 1,
  };
  const assertions = [traceAssertion, groupFilesAssertion];
  const feature = observeFeature(assertions, { events, runId });
  const c = { route: "private", featureAssertions: assertions };
  const config = { groups: [{ alias: "A", id: groupId }] };
  const clients = { bot: { readGroupRootFiles: async () => projectGroupFiles(result, groupId) } };
  const witness = { fileCount: projection.fileCount, folderCount: projection.folderCount };
  return {
    events,
    assertion: groupFilesAssertion,
    projection,
    feature,
    c,
    config,
    clients,
    witness,
    result,
  };
}

const verify = (f, overrides = {}) =>
  verifyGroupFilesEvidence(
    overrides.c ?? f.c,
    overrides.feature ?? f.feature,
    overrides.config ?? f.config,
    overrides.clients ?? f.clients,
    overrides.events ?? f.events,
    runId,
    Object.hasOwn(overrides, "witness") ? overrides.witness : f.witness,
  );

function replaceHead(events, head, overrides = {}) {
  const changed = structuredClone(events);
  Object.assign(changed[1].data, {
    outputHead: head,
    outputBytes: Buffer.byteLength(head, "utf8"),
    outputSha256: hash(head),
    ...overrides,
  });
  return changed;
}

function withRejectedPrefix(
  events,
  { failureCode = "input_validation_failed", overlap = false } = {},
) {
  const invalidCall = structuredClone(events[0]);
  invalidCall.toolCallId = "call-group-files-invalid";
  invalidCall.data.toolCallId = invalidCall.toolCallId;
  invalidCall.data.input.params = { unsupported_offset: 1 };
  const invalidResult = {
    type: "tool_result",
    runId,
    toolCallId: invalidCall.toolCallId,
    data: {
      toolCallId: invalidCall.toolCallId,
      name: "qq_group_files",
      isError: true,
      failureCode,
    },
  };
  return overlap
    ? [invalidCall, events[0], invalidResult, events[1]]
    : [invalidCall, invalidResult, ...events];
}

function expectInconclusive(operation, code = "GROUP_FILES_EVIDENCE") {
  assert.throws(operation, (error) => {
    if (code !== null) assert.equal(error.code, code);
    assert.equal(error.status, "INCONCLUSIVE");
    assert.equal(error.message.includes(fileName), false);
    assert.equal(error.message.includes(fileId), false);
    return true;
  });
}

test("group file projection keeps counts and canonical digest without exposing row values", () => {
  const result = providerResult();
  const projected = projectGroupFiles(result, groupId);
  assert.deepEqual(projected, {
    fileCount: 1,
    folderCount: 1,
    listingSha256: hash(
      JSON.stringify({
        files: [
          {
            file_id: fileId,
            file_name: fileName,
            file_size: 412,
            group_id: Number(groupId),
          },
        ],
        folders: [
          {
            folder_id: "d1",
            folder_name: "资料",
            group_id: groupId,
            total_file_count: 2,
          },
        ],
      }),
    ),
    metadataSha256: hash(
      JSON.stringify({
        files: [
          {
            file_name: fileName,
            file_size: 412,
            group_id: Number(groupId),
          },
        ],
        folders: [
          {
            folder_id: "d1",
            folder_name: "资料",
            group_id: groupId,
            total_file_count: 2,
          },
        ],
      }),
    ),
  });
  assert.equal(JSON.stringify(projected).includes(fileName), false);
  assert.equal(JSON.stringify(projected).includes(fileId), false);

  const reordered = {
    folders: [
      {
        total_file_count: 2,
        folder_name: "资料",
        folder_id: "d1",
        group_id: groupId,
      },
    ],
    files: [
      {
        file_size: 412,
        file_name: fileName,
        file_id: fileId,
        group_id: Number(groupId),
      },
    ],
  };
  assert.equal(projectGroupFiles(reordered, groupId).listingSha256, projected.listingSha256);
  const secondFile = { ...result.files[0], file_id: "f2", file_name: "第二.pdf" };
  const ordered = { ...result, files: [...result.files, secondFile] };
  const reversed = { ...result, files: [secondFile, ...result.files] };
  assert.notEqual(
    projectGroupFiles(ordered, groupId).listingSha256,
    projectGroupFiles(reversed, groupId).listingSha256,
  );
  const changed = {
    ...result,
    folders: [...result.folders, { ...result.folders[0], folder_id: "d2" }],
  };
  assert.notEqual(projectGroupFiles(changed, groupId).listingSha256, projected.listingSha256);
});

test("Pi result producer, bounded output evidence and independent OneBot read share schema v2", async () => {
  const runId = "run-cross-module-group-files-v2";
  const groupId = "20001";
  const details = {
    status: "ok",
    data: {
      files: [
        {
          group_id: 20001,
          file_id: "ephemeral-cache-key-a",
          file_name: "x".repeat(900),
          file_size: 12,
          busid: 5,
        },
      ],
      folders: [],
    },
  };
  const piResult = {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
  const groupFiles = groupFilesEvidence(piResult);
  const output = safeToolOutput("qq_group_files", piResult);
  assert.deepEqual(Object.keys(groupFiles ?? {}).sort(), [
    "fileCount",
    "folderCount",
    "listingSha256",
    "metadataSha256",
    "schemaVersion",
  ]);
  assert.equal(groupFiles?.schemaVersion, 2);
  assert.equal(output.outputTruncated, true);
  assert.equal(output.outputBytes, Buffer.byteLength(JSON.stringify(piResult)));
  assert.equal(output.outputSha256, hash(JSON.stringify(piResult)));

  const callId = "call-cross-module-group-files-v2";
  const events = [
    {
      type: "tool_call",
      runId,
      toolCallId: callId,
      data: {
        toolCallId: callId,
        name: "qq_group_files",
        input: { groupId, operation: "get_group_root_files" },
      },
    },
    {
      type: "tool_result",
      runId,
      toolCallId: callId,
      data: {
        toolCallId: callId,
        name: "qq_group_files",
        isError: false,
        ...output,
        groupFiles,
      },
    },
  ];
  const assertion = {
    kind: "group_files",
    tool: "qq_group_files",
    groupId,
    count: 1,
  };
  const observed = observeGroupFilesResult(assertion, { events, runId });
  const regeneratedNativeRead = {
    files: [{ ...details.data.files[0], file_id: "ephemeral-cache-key-b" }],
    folders: [],
  };
  const independent = projectGroupFiles(regeneratedNativeRead, groupId);
  assert.notEqual(independent.listingSha256, groupFiles?.listingSha256);
  assert.equal(independent.metadataSha256, groupFiles?.metadataSha256);

  const featureAssertions = [
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "qq_group_files", isError: false },
      count: 1,
    },
    assertion,
  ];
  const feature = observeFeature(featureAssertions, { events, runId });
  assert.deepEqual(
    await verifyGroupFilesEvidence(
      { route: "private", featureAssertions },
      feature,
      { groups: [{ alias: "A", id: groupId }] },
      { bot: { readGroupRootFiles: async () => independent } },
      events,
      runId,
      { fileCount: observed.fileCount, folderCount: observed.folderCount },
    ),
    { status: "PASS", fileCount: 1, folderCount: 0 },
  );
});

test("group file observer parses the actual status/data provider envelope when complete", () => {
  const f = fixture({ result: { files: [], folders: [] } });
  assert.equal(f.events[1].data.outputTruncated, false);
  assert.deepEqual(observeGroupFilesResult(f.assertion, { events: f.events, runId }), {
    kind: "group_files",
    tool: "qq_group_files",
    ...f.projection,
  });
});

test("group file verifier passes real observer output, private Owner route and independent snapshot", async () => {
  const f = fixture();
  assert.deepEqual(f.feature.observations, [
    { kind: "trace", type: "tool_result", count: 1 },
    { kind: "group_files", tool: "qq_group_files", ...f.projection },
  ]);
  assert.deepEqual(await verify(f), {
    status: "PASS",
    fileCount: 1,
    folderCount: 1,
  });
});

test("group file projection rejects scope, malformed rows, duplicates, count bounds and oversized JSON", () => {
  const base = providerResult();
  const malformed = [
    [{ ...base.files[0], group_id: 20002 }],
    [{ ...base.files[0], group_id: "020001" }],
    [{ ...base.files[0], file_id: "   " }],
    [
      {
        group_id: base.files[0].group_id,
        file_name: base.files[0].file_name,
        file_size: base.files[0].file_size,
      },
    ],
    [{ ...base.files[0], file_name: "\t " }],
    [{ ...base.files[0], file_name: "x".repeat(2049) }],
    [{ ...base.files[0], file_id: "x".repeat(4097) }],
    [{ ...base.files[0], file_size: -1 }],
    [{ ...base.files[0], file_size: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...base.files[0], provider_extra: "x".repeat(256 * 1024) }],
    [base.files[0], { ...base.files[0] }],
  ];
  for (const files of malformed)
    expectInconclusive(
      () => projectGroupFiles({ ...base, files }, groupId),
      "GROUP_FILES_PROJECTION",
    );
  for (const folder of [
    { ...base.folders[0], group_id: 20002 },
    { ...base.folders[0], folder_id: "  " },
    { ...base.folders[0], folder_name: "\n" },
    { ...base.folders[0], folder_name: "x".repeat(2049) },
    { ...base.folders[0], total_file_count: -1 },
    { ...base.folders[0], total_file_count: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expectInconclusive(
      () => projectGroupFiles({ ...base, folders: [folder] }, groupId),
      "GROUP_FILES_PROJECTION",
    );
  expectInconclusive(
    () =>
      projectGroupFiles({ ...base, folders: [base.folders[0], { ...base.folders[0] }] }, groupId),
    "GROUP_FILES_PROJECTION",
  );
  expectInconclusive(
    () =>
      projectGroupFiles(
        { ...base, folders: Array.from({ length: 50 }, () => base.folders[0]) },
        groupId,
      ),
    "GROUP_FILES_PROJECTION",
  );
  expectInconclusive(
    () => projectGroupFiles({ ...base, unexpected: true }, groupId),
    "GROUP_FILES_PROJECTION",
  );
});

test("group file projection rejects non-JSON accessors, symbols, sparse arrays and cycles", () => {
  const base = providerResult();
  const accessor = { ...base, files: [{ ...base.files[0] }] };
  Object.defineProperty(accessor.files[0], "extra", { enumerable: true, get: () => fileName });
  const hidden = { ...base, files: [{ ...base.files[0] }] };
  Object.defineProperty(hidden.files[0], "extra", { enumerable: false, value: 1 });
  const withSymbol = { ...base, files: [{ ...base.files[0], [Symbol("extra")]: 1 }] };
  const nonPlain = Object.assign(Object.create({ inherited: true }), base);
  const sparse = { ...base, files: [] };
  sparse.files.length = 1;
  const cyclic = { ...base };
  cyclic.files = [{ ...base.files[0], extra: cyclic }];
  for (const invalid of [accessor, hidden, withSymbol, nonPlain, sparse, cyclic])
    expectInconclusive(() => projectGroupFiles(invalid, groupId), "GROUP_FILES_PROJECTION");
});

test("group file observer rejects malformed wrapper hashes, call bindings and input", () => {
  const f = fixture();
  expectInconclusive(() =>
    observeGroupFilesResult(f.assertion, {
      events: replaceHead(f.events, f.events[1].data.outputHead, { outputSha256: "0".repeat(64) }),
      runId,
    }),
  );
  const wrongId = structuredClone(f.events);
  wrongId[1].toolCallId = "different";
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: wrongId, runId }));
  expectInconclusive(() =>
    observeGroupFilesResult(f.assertion, {
      events: [...structuredClone(f.events)].reverse(),
      runId,
    }),
  );
  for (const params of [{ file_count: 2 }, { startIndex: 1 }]) {
    const changed = structuredClone(f.events);
    changed[0].data.input.params = params;
    expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: changed, runId }));
  }
  const extraCall = structuredClone(f.events);
  extraCall.splice(1, 0, structuredClone(f.events[0]));
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: extraCall, runId }));
});

test("group file observer rejects duplicate keys and disagreement between details and content", () => {
  const f = fixture();
  const duplicateDetails = `{"files":[],"files":[],"folders":[]}`;
  const duplicateWrapper = `{"content":[{"type":"text","text":${JSON.stringify(duplicateDetails)}}],"details":{"files":[],"folders":[]}}`;
  const repeated = replaceHead(f.events, duplicateWrapper);
  repeated[1].data.groupFiles = {
    schemaVersion: 2,
    fileCount: 0,
    folderCount: 0,
    listingSha256: hash('{"files":[],"folders":[]}'),
    metadataSha256: hash('{"files":[],"folders":[]}'),
  };
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: repeated, runId }));

  const mismatch = structuredClone(f.events);
  const parsed = JSON.parse(mismatch[1].data.outputHead);
  parsed.content[0].text = JSON.stringify({ files: [], folders: [] });
  mismatch[1].data.outputHead = JSON.stringify(parsed);
  mismatch[1].data.outputBytes = Buffer.byteLength(mismatch[1].data.outputHead, "utf8");
  mismatch[1].data.outputSha256 = hash(mismatch[1].data.outputHead);
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: mismatch, runId }));
});

test("group file observer accepts a bounded input-validation rejection before the one fixed successful read", () => {
  const f = fixture();
  const events = withRejectedPrefix(f.events);
  assert.deepEqual(observeGroupFilesResult(f.assertion, { events, runId }), {
    kind: "group_files",
    tool: "qq_group_files",
    ...f.projection,
  });
  assert.deepEqual(
    observeFeature(f.c.featureAssertions, { events, runId }).observations,
    f.feature.observations,
  );
});

test("group files observer binds a malformed prefix to the later successful exact request", async () => {
  const f = fixture();
  const malformedCall = {
    type: "tool_call",
    runId,
    toolCallId: "call-group-files-malformed",
    data: { toolCallId: "call-group-files-malformed", name: "qq_group_files" },
  };
  const malformedResult = {
    type: "tool_result",
    runId,
    toolCallId: malformedCall.toolCallId,
    data: {
      toolCallId: malformedCall.toolCallId,
      name: "qq_group_files",
      isError: true,
      failureCode: "input_validation_failed",
    },
  };
  const events = [malformedCall, malformedResult, ...f.events];
  assert.deepEqual(observeGroupFilesResult(f.assertion, { events, runId }), {
    kind: "group_files",
    tool: "qq_group_files",
    ...f.projection,
  });
  assert.deepEqual(
    await verifyGroupFilesEvidence(f.c, f.feature, f.config, f.clients, events, runId, f.witness),
    { status: "PASS", fileCount: 1, folderCount: 1 },
  );
});

test("group files observer rejects multiple successful requests even when the first failed", () => {
  const f = fixture();
  const call = structuredClone(f.events[0]);
  const result = structuredClone(f.events[1]);
  call.toolCallId = "call-group-files-other";
  call.data.toolCallId = call.toolCallId;
  call.data.input.groupId = "20002";
  result.toolCallId = call.toolCallId;
  result.data.toolCallId = call.toolCallId;
  result.data.groupFiles = {
    schemaVersion: 2,
    ...projectGroupFiles(
      {
        files: providerResult().files.map((item) => ({ ...item, group_id: 20002 })),
        folders: providerResult().folders.map((item) => ({ ...item, group_id: "20002" })),
      },
      "20002",
    ),
  };
  const events = withRejectedPrefix(f.events);
  events.push(call, result);
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events, runId }));
});

test("group files v2 distinguishes regenerated file IDs while binding all other metadata", () => {
  const first = providerResult();
  const second = structuredClone(first);
  second.files[0].file_id = "fresh-cache-key";
  const a = projectGroupFiles(first, groupId);
  const b = projectGroupFiles(second, groupId);
  assert.notEqual(a.listingSha256, b.listingSha256);
  assert.equal(a.metadataSha256, b.metadataSha256);

  const changedMetadata = structuredClone(second);
  changedMetadata.files[0].file_name = "different.pdf";
  assert.notEqual(projectGroupFiles(changedMetadata, groupId).metadataSha256, a.metadataSha256);
  const changedFolder = structuredClone(first);
  changedFolder.folders[0].total_file_count += 1;
  assert.notEqual(projectGroupFiles(changedFolder, groupId).metadataSha256, a.metadataSha256);
});

test("group files v2 rejects a historical schema-1 trace", () => {
  const f = fixture();
  const events = structuredClone(f.events);
  events[1].data.groupFiles = {
    schemaVersion: 1,
    fileCount: f.projection.fileCount,
    folderCount: f.projection.folderCount,
    listingSha256: f.projection.listingSha256,
  };
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events, runId }));
});

test("group files observer accepts only paired fixed pre-provider lease denial before success", () => {
  const f = fixture();
  const events = withRejectedPrefix(f.events, { failureCode: "acceptance_lease_input_mismatch" });
  assert.deepEqual(observeGroupFilesResult(f.assertion, { events, runId }), {
    kind: "group_files",
    tool: "qq_group_files",
    ...f.projection,
  });
  const unknown = withRejectedPrefix(f.events, { failureCode: "provider_failed" });
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: unknown, runId }));
});

test("group file observer rejects untyped, overlapping, duplicate-ID and excessive rejected attempts", () => {
  const f = fixture();
  expectInconclusive(() =>
    observeGroupFilesResult(f.assertion, {
      events: withRejectedPrefix(f.events, { failureCode: "authorization_denied" }),
      runId,
    }),
  );
  expectInconclusive(() =>
    observeGroupFilesResult(f.assertion, {
      events: withRejectedPrefix(f.events, { overlap: true }),
      runId,
    }),
  );

  const duplicateId = withRejectedPrefix(f.events);
  duplicateId[0].toolCallId = f.events[0].toolCallId;
  duplicateId[0].data.toolCallId = f.events[0].toolCallId;
  duplicateId[1].toolCallId = f.events[0].toolCallId;
  duplicateId[1].data.toolCallId = f.events[0].toolCallId;
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: duplicateId, runId }));

  const tooMany = [];
  for (let index = 0; index < 4; index += 1) {
    const failedCall = structuredClone(f.events[0]);
    failedCall.toolCallId = `call-invalid-${index}`;
    failedCall.data.toolCallId = failedCall.toolCallId;
    failedCall.data.input.params = { unsupported_offset: index + 1 };
    tooMany.push(failedCall, {
      type: "tool_result",
      runId,
      toolCallId: failedCall.toolCallId,
      data: {
        toolCallId: failedCall.toolCallId,
        name: "qq_group_files",
        isError: true,
        failureCode: "input_validation_failed",
      },
    });
  }
  tooMany.push(...f.events);
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: tooMany, runId }));

  const validInputFailed = withRejectedPrefix(f.events);
  validInputFailed[0].data.input.params = {};
  expectInconclusive(() =>
    observeGroupFilesResult(f.assertion, { events: validInputFailed, runId }),
  );
});

test("group file observer accepts UTF-8 truncated head only with a valid fixed summary", () => {
  const f = fixture();
  let details;
  let serialized;
  let head;
  for (let size = 300; size < 500; size += 1) {
    details = {
      status: "ok",
      data: {
        ...providerResult(),
        files: [{ ...providerResult().files[0], provider_extension: `${"a".repeat(size)}中tail` }],
      },
    };
    serialized = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
    });
    head = Buffer.from(serialized, "utf8").subarray(0, 512).toString("utf8");
    if (Buffer.byteLength(head, "utf8") > 512) break;
  }
  assert.ok(Buffer.byteLength(head, "utf8") >= 512 && Buffer.byteLength(head, "utf8") <= 514);
  const projected = projectGroupFiles(details.data, groupId);
  const truncated = structuredClone(f.events);
  Object.assign(truncated[1].data, {
    groupFiles: { schemaVersion: 2, ...projected },
    outputHead: head,
    outputTruncated: true,
    outputBytes: Buffer.byteLength(serialized, "utf8"),
    outputSha256: hash(serialized),
  });
  assert.deepEqual(observeGroupFilesResult(f.assertion, { events: truncated, runId }), {
    kind: "group_files",
    tool: "qq_group_files",
    ...projected,
  });
  for (const badHead of ["", "short"]) {
    const invalidEvents = structuredClone(truncated);
    invalidEvents[1].data.outputHead = badHead;
    expectInconclusive(() =>
      observeGroupFilesResult(f.assertion, { events: invalidEvents, runId }),
    );
  }
  const badEvidence = structuredClone(truncated);
  badEvidence[1].data.groupFiles.listingSha256 = "not-a-hash";
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: badEvidence, runId }));
});

test("group file verifier fails closed on missing assertions, reply mismatch and independent read failure", async () => {
  const f = fixture();
  assert.deepEqual(await verify(f), {
    status: "PASS",
    fileCount: 1,
    folderCount: 1,
  });
  await assert.rejects(
    verify(f, { c: { route: "private", featureAssertions: [f.c.featureAssertions[1]] } }),
    (error) => error.code === "GROUP_FILES_SCOPE" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, { witness: { fileCount: 0, folderCount: 1 } }),
    (error) => error.code === "GROUP_FILES_REPLY" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, {
      witness: { fileCount: 1, folderCount: 1, listingSha256: f.projection.listingSha256 },
    }),
    (error) => error.code === "GROUP_FILES_REPLY" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, {
      clients: {
        bot: {
          readGroupRootFiles: async () => {
            throw new Error(fileName);
          },
        },
      },
    }),
    (error) => error.code === "GROUP_FILES_UNAVAILABLE" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, {
      clients: { bot: { readGroupRootFiles: async () => ({ ...f.projection, extra: 1 }) } },
    }),
    (error) => error.code === "GROUP_FILES_MISMATCH" && error.status === "INCONCLUSIVE",
  );
});

test("group file verifier compares repeated reads by metadata rather than file IDs", async () => {
  const f = fixture();
  const nextRead = structuredClone(f.result);
  nextRead.files[0].file_id = "new-napcat-cache-key";
  const independent = projectGroupFiles(nextRead, groupId);
  assert.notEqual(independent.listingSha256, f.projection.listingSha256);
  assert.equal(independent.metadataSha256, f.projection.metadataSha256);
  const clients = { bot: { readGroupRootFiles: async () => independent } };
  assert.deepEqual(await verify(f, { clients }), {
    status: "PASS",
    fileCount: f.projection.fileCount,
    folderCount: f.projection.folderCount,
  });
});

test("group file verifier rejects independent metadata and count mismatches", async () => {
  const f = fixture();
  const changedRow = structuredClone(f.result);
  changedRow.files[0].file_size += 1;
  const changedMetadata = projectGroupFiles(changedRow, groupId);
  assert.notEqual(changedMetadata.metadataSha256, f.projection.metadataSha256);
  await assert.rejects(
    verify(f, {
      clients: { bot: { readGroupRootFiles: async () => changedMetadata } },
    }),
    (error) => error.code === "GROUP_FILES_MISMATCH" && error.status === "INCONCLUSIVE",
  );

  const wrongHash = { ...f.projection, metadataSha256: "0".repeat(64) };
  await assert.rejects(
    verify(f, { clients: { bot: { readGroupRootFiles: async () => wrongHash } } }),
    (error) => error.code === "GROUP_FILES_MISMATCH" && error.status === "INCONCLUSIVE",
  );
  const wrongCounts = { ...f.projection, fileCount: 0 };
  await assert.rejects(
    verify(f, { clients: { bot: { readGroupRootFiles: async () => wrongCounts } } }),
    (error) => error.code === "GROUP_FILES_MISMATCH" && error.status === "INCONCLUSIVE",
  );
});
