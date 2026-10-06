import { digest, fail } from "./core.mjs";

const MESSAGE = "群文件 Trace 与独立读取证据不一致。";
const GROUP_ID = /^[1-9]\d{4,15}$/u;
const ASSERTION_GROUP_ID = /^(?:[1-9]\d{4,15}|\{\{group:A\}\})$/u;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(code = "GROUP_FILES_EVIDENCE", status = "INCONCLUSIVE") {
  fail(code, MESSAGE, status);
}

export function validateGroupFilesAssertion(assertion) {
  if (
    !isRecord(assertion) ||
    Object.keys(assertion).sort().join(",") !== "count,groupId,kind,tool" ||
    assertion.kind !== "group_files" ||
    assertion.tool !== "qq_group_files" ||
    assertion.count !== 1 ||
    typeof assertion.groupId !== "string" ||
    !ASSERTION_GROUP_ID.test(assertion.groupId)
  )
    invalid("GROUP_FILES_ASSERTION", "BLOCKED");
  return assertion;
}

function pureJsonCanonical(value, seen = new WeakSet(), depth = 0) {
  if (depth > 128) invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
  if (seen.has(value)) invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
  seen.add(value);
  let serialized;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid("GROUP_FILES_PROJECTION");
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key === "symbol") ||
      keys.length !== value.length + 1 ||
      !keys.includes("length")
    )
      invalid("GROUP_FILES_PROJECTION");
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        invalid("GROUP_FILES_PROJECTION");
      parts.push(pureJsonCanonical(descriptor.value, seen, depth + 1));
    }
    serialized = `[${parts.join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("GROUP_FILES_PROJECTION");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) invalid("GROUP_FILES_PROJECTION");
    const entries = [];
    for (const key of keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        invalid("GROUP_FILES_PROJECTION");
      entries.push(
        `${JSON.stringify(key)}:${pureJsonCanonical(descriptor.value, seen, depth + 1)}`,
      );
    }
    serialized = `{${entries.join(",")}}`;
  }
  seen.delete(value);
  return serialized;
}

function nonEmptyString(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function rowGroupId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return "";
    value = String(value);
  }
  return typeof value === "string" && GROUP_ID.test(value) ? value : "";
}

export function projectGroupFiles(details, expectedGroupId) {
  if (
    !isRecord(details) ||
    Object.keys(details).sort().join(",") !== "files,folders" ||
    typeof expectedGroupId !== "string" ||
    !GROUP_ID.test(expectedGroupId)
  )
    invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
  const canonicalDetails = pureJsonCanonical(details);
  if (Buffer.byteLength(canonicalDetails, "utf8") > 256 * 1024)
    invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
  const files = details.files;
  const folders = details.folders;
  if (!Array.isArray(files) || !Array.isArray(folders) || files.length + folders.length > 50)
    invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");

  const seenFiles = new Set();
  for (const file of files) {
    if (
      !isRecord(file) ||
      rowGroupId(file.group_id) !== expectedGroupId ||
      !nonEmptyString(file.file_id, 4096) ||
      !nonEmptyString(file.file_name, 2048) ||
      !Number.isSafeInteger(file.file_size) ||
      file.file_size < 0 ||
      seenFiles.has(file.file_id)
    )
      invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
    seenFiles.add(file.file_id);
  }

  const seenFolders = new Set();
  for (const folder of folders) {
    if (
      !isRecord(folder) ||
      rowGroupId(folder.group_id) !== expectedGroupId ||
      !nonEmptyString(folder.folder_id, 4096) ||
      !nonEmptyString(folder.folder_name, 2048) ||
      !Number.isSafeInteger(folder.total_file_count) ||
      folder.total_file_count < 0 ||
      seenFolders.has(folder.folder_id)
    )
      invalid("GROUP_FILES_PROJECTION", "INCONCLUSIVE");
    seenFolders.add(folder.folder_id);
  }

  return {
    fileCount: files.length,
    folderCount: folders.length,
    listingSha256: digest(Buffer.from(canonicalDetails, "utf8")),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function parseCanonicalJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid();
  }
  if (JSON.stringify(parsed) !== value) invalid();
  return parsed;
}

function validateSafeGroupFiles(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "fileCount,folderCount,listingSha256" ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    !Number.isSafeInteger(value.folderCount) ||
    value.folderCount < 0 ||
    value.fileCount + value.folderCount > 50 ||
    !/^[0-9a-f]{64}$/u.test(value.listingSha256 ?? "")
  )
    invalid("GROUP_FILES_EVIDENCE", "INCONCLUSIVE");
  return {
    fileCount: value.fileCount,
    folderCount: value.folderCount,
    listingSha256: value.listingSha256,
  };
}

function validateTraceGroupFiles(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "fileCount,folderCount,listingSha256,schemaVersion" ||
    value.schemaVersion !== 1
  )
    invalid();
  return validateSafeGroupFiles({
    fileCount: value.fileCount,
    folderCount: value.folderCount,
    listingSha256: value.listingSha256,
  });
}

function groupFilesEvents(events, runId) {
  if (!Array.isArray(events) || typeof runId !== "string" || !runId) invalid();
  const calls = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_call" &&
      (event.data?.name === "qq_group_files" || event.name === "qq_group_files"),
  );
  const results = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_result" &&
      (event.data?.name === "qq_group_files" || event.name === "qq_group_files"),
  );
  const fileCalls = calls.filter(
    (event) => event.data?.input?.operation === "get_group_root_files",
  );
  if (fileCalls.length !== 1 || calls.length !== 1 || results.length !== 1) invalid();
  const [call] = fileCalls;
  const [result] = results;
  if (
    events.indexOf(call) >= events.indexOf(result) ||
    typeof call.toolCallId !== "string" ||
    !call.toolCallId ||
    call.data?.toolCallId !== call.toolCallId ||
    result.toolCallId !== call.toolCallId ||
    result.data?.toolCallId !== call.toolCallId ||
    result.data?.isError !== false
  )
    invalid();
  return { call, result };
}

export function observeGroupFilesResult(assertion, { events, runId }) {
  validateGroupFilesAssertion(assertion);
  const { call, result } = groupFilesEvents(events, runId);
  const input = call.data.input;
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["groupId", "operation", "params"].includes(key)) ||
    input.groupId !== assertion.groupId ||
    input.operation !== "get_group_root_files" ||
    (input.params !== undefined &&
      (!isRecord(input.params) || Object.keys(input.params).length !== 0))
  )
    invalid();

  const data = result.data;
  const head = data.outputHead;
  if (
    typeof head !== "string" ||
    !Number.isSafeInteger(data.outputBytes) ||
    typeof data.outputSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(data.outputSha256) ||
    !isRecord(data.groupFiles) ||
    Object.keys(data.groupFiles).sort().join(",") !==
      "fileCount,folderCount,listingSha256,schemaVersion" ||
    data.groupFiles.schemaVersion !== 1
  )
    invalid();
  const safe = validateTraceGroupFiles(data.groupFiles);
  const headBytes = Buffer.byteLength(head, "utf8");
  if (data.outputTruncated === false) {
    if (
      headBytes > 512 ||
      data.outputBytes !== headBytes ||
      digest(Buffer.from(head, "utf8")) !== data.outputSha256
    )
      invalid();
    const wrapper = parseCanonicalJson(head);
    if (
      !isRecord(wrapper) ||
      Object.keys(wrapper).sort().join(",") !== "content,details" ||
      !Array.isArray(wrapper.content) ||
      wrapper.content.length !== 1 ||
      !isRecord(wrapper.content[0]) ||
      Object.keys(wrapper.content[0]).sort().join(",") !== "text,type" ||
      wrapper.content[0].type !== "text" ||
      typeof wrapper.content[0].text !== "string" ||
      !isRecord(wrapper.details) ||
      wrapper.content[0].text !== JSON.stringify(wrapper.details) ||
      canonical(projectGroupFiles(wrapper.details, assertion.groupId)) !== canonical(safe)
    )
      invalid();
  } else if (data.outputTruncated === true) {
    if (data.outputBytes <= 512 || headBytes < 512 || headBytes > 514) invalid();
  } else invalid();

  return { kind: "group_files", tool: "qq_group_files", ...safe };
}

function expectedAssertion(groupId) {
  return { kind: "group_files", tool: "qq_group_files", groupId, count: 1 };
}

export async function verifyGroupFilesEvidence(
  c,
  feature,
  config,
  clients,
  events,
  runId,
  actualReplyWitness,
) {
  if (!Array.isArray(events) || typeof runId !== "string" || !runId) invalid();
  const fileCalls = events.filter(
    (event) =>
      event?.runId === runId &&
      event.type === "tool_call" &&
      (event.data?.name === "qq_group_files" || event.name === "qq_group_files") &&
      event.data?.input?.operation === "get_group_root_files",
  );
  const assertionRequested =
    c?.featureAssertions?.some((assertion) => assertion?.kind === "group_files") === true ||
    feature?.observations?.some((observation) => observation?.kind === "group_files") === true;
  if (fileCalls.length === 0 && !assertionRequested) return undefined;
  const { call } = groupFilesEvents(events, runId);
  const groups = config?.groups?.filter((group) => group.alias === "A") ?? [];
  const groupId = groups.length === 1 ? groups[0].id : "";
  if (
    !GROUP_ID.test(groupId) ||
    c?.route !== "private" ||
    !Array.isArray(c?.featureAssertions) ||
    c.featureAssertions.length !== 2 ||
    !Array.isArray(feature?.observations) ||
    feature.observations.length !== 2
  )
    invalid("GROUP_FILES_SCOPE", "INCONCLUSIVE");

  const rawAssertion = expectedAssertion("{{group:A}}");
  const resolvedAssertion = expectedAssertion(groupId);
  const groupAssertions = c.featureAssertions.filter(
    (assertion) => assertion?.kind === "group_files",
  );
  const traceAssertions = c.featureAssertions.filter((assertion) => assertion?.kind === "trace");
  const expectedTraceAssertion = {
    kind: "trace",
    type: "tool_result",
    where: { name: "qq_group_files", isError: false },
    count: 1,
  };
  if (
    groupAssertions.length !== 1 ||
    traceAssertions.length !== 1 ||
    ![canonical(rawAssertion), canonical(resolvedAssertion)].includes(
      canonical(groupAssertions[0]),
    ) ||
    canonical(traceAssertions[0]) !== canonical(expectedTraceAssertion)
  )
    invalid("GROUP_FILES_SCOPE", "INCONCLUSIVE");

  const input = call.data.input;
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["groupId", "operation", "params"].includes(key)) ||
    input.groupId !== groupId ||
    input.operation !== "get_group_root_files" ||
    (input.params !== undefined &&
      (!isRecord(input.params) || Object.keys(input.params).length !== 0))
  )
    invalid("GROUP_FILES_SCOPE", "INCONCLUSIVE");

  const observed = observeGroupFilesResult(resolvedAssertion, { events, runId });
  const groupObservations = feature.observations.filter(
    (observation) => observation?.kind === "group_files",
  );
  const traceObservations = feature.observations.filter(
    (observation) => observation?.kind === "trace",
  );
  if (
    feature.observations.length !== 2 ||
    groupObservations.length !== 1 ||
    traceObservations.length !== 1 ||
    canonical(traceObservations[0]) !==
      canonical({ kind: "trace", type: "tool_result", count: 1 }) ||
    canonical(groupObservations[0]) !== canonical(observed)
  )
    invalid("GROUP_FILES_OBSERVATION", "INCONCLUSIVE");

  if (
    !isRecord(actualReplyWitness) ||
    Object.keys(actualReplyWitness).sort().join(",") !== "fileCount,folderCount" ||
    actualReplyWitness.fileCount !== observed.fileCount ||
    actualReplyWitness.folderCount !== observed.folderCount
  )
    invalid("GROUP_FILES_REPLY", "INCONCLUSIVE");
  if (typeof clients?.bot?.readGroupRootFiles !== "function")
    invalid("GROUP_FILES_UNAVAILABLE", "INCONCLUSIVE");
  let independentResult;
  try {
    independentResult = await clients.bot.readGroupRootFiles();
  } catch {
    invalid("GROUP_FILES_UNAVAILABLE", "INCONCLUSIVE");
  }
  let independent;
  try {
    independent = validateSafeGroupFiles(independentResult);
  } catch {
    invalid("GROUP_FILES_MISMATCH", "INCONCLUSIVE");
  }
  if (canonical(independent) !== canonical(safeObserved(observed)))
    invalid("GROUP_FILES_MISMATCH", "INCONCLUSIVE");
  return { status: "PASS", fileCount: observed.fileCount, folderCount: observed.folderCount };
}

function safeObserved(observed) {
  return {
    fileCount: observed.fileCount,
    folderCount: observed.folderCount,
    listingSha256: observed.listingSha256,
  };
}
