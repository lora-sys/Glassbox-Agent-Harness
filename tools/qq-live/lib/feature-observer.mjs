import { fail } from "./core.mjs";
import { createHash } from "node:crypto";

const TYPES = new Set([
  "tool_call",
  "tool_result",
  "history_retrieval",
  "media_generation_completed",
]);
const FIELDS = new Set([
  "name",
  "isError",
  "failureCode",
  "action",
  "status",
  "count",
  "candidateId",
  "memoryId",
  "taskId",
  "assetId",
  "query",
  "sourceKind",
  "retrievalMode",
]);
const ARRAY_FIELDS = new Set(["groups", "resources"]);
const validFilter = (key, value) =>
  ARRAY_FIELDS.has(key)
    ? Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 8 &&
      value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128) &&
      new Set(value).size === value.length
    : FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value);
const equalFilter = (actual, expected) =>
  Array.isArray(expected)
    ? Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    : actual === expected;
const STATES = {
  task: {
    sql: "SELECT id, status, run_id FROM tasks WHERE id=?",
    field: "status",
    statuses: [
      "NEW",
      "QUEUED",
      "ASSIGNED",
      "RUNNING",
      "WAITING_INPUT",
      "REVIEW",
      "ACCEPTED",
      "DONE",
      "FAILED",
      "CANCELED",
    ],
  },
  memory_candidate: {
    sql: "SELECT id, status, source_json FROM memory_candidates WHERE id=?",
    field: "status",
    statuses: ["pending", "promoted", "rejected"],
  },
  memory: {
    sql: "SELECT id, lifecycle_state, source_json FROM memories WHERE id=?",
    field: "lifecycle_state",
    statuses: ["active", "expired", "revoked", "retired"],
  },
};

export function validateFeatureAssertions(assertions) {
  if (!Array.isArray(assertions) || !assertions.length || assertions.length > 32)
    fail("FEATURE_ASSERTIONS", "功能用例需要 1 至 32 个结构化证据断言。");
  for (const a of assertions) {
    if (!a || typeof a !== "object" || Array.isArray(a))
      fail("FEATURE_ASSERTIONS", "证据断言无效。");
    if (a.kind === "trace") {
      if (
        !TYPES.has(a.type) ||
        !a.where ||
        Array.isArray(a.where) ||
        typeof a.where !== "object" ||
        !Object.keys(a.where).length ||
        Object.entries(a.where).some(([k, v]) => !validFilter(k, v)) ||
        !Number.isSafeInteger(a.count) ||
        a.count < 1 ||
        a.count > 32 ||
        Object.keys(a).some((k) => !["kind", "type", "where", "count"].includes(k))
      )
        fail("FEATURE_ASSERTIONS", "Trace 断言必须指定已支持的事件、字段和值及精确数量。");
    } else if (a.kind === "aggregate_projection") {
      if (
        a.tool !== "qq_group_members" ||
        a.count !== 1 ||
        Object.keys(a).some((k) => !["kind", "tool", "count"].includes(k))
      )
        fail("FEATURE_ASSERTIONS", "聚合投影断言必须绑定一次群成员数量读取。");
    } else if (a.kind === "state") {
      const definition = STATES[a.resource];
      if (
        !definition ||
        !/^[a-zA-Z0-9_-]{3,128}$/.test(a.id ?? "") ||
        !definition.statuses.includes(a.status) ||
        Object.keys(a).some((k) => !["kind", "resource", "id", "status"].includes(k))
      )
        fail("FEATURE_ASSERTIONS", "状态断言必须指定已支持的资源、固定 ID 和状态。");
    } else fail("FEATURE_ASSERTIONS", "该证据观察器尚未实现。");
  }
  return assertions;
}

export function observeFeature(assertions, { db, events, runId }) {
  validateFeatureAssertions(assertions);
  if (typeof runId !== "string" || !runId || !Array.isArray(events))
    fail("FEATURE_BINDING", "功能证据必须绑定唯一 Run。");
  const observations = [];
  for (const assertion of assertions) {
    if (assertion.kind === "trace") {
      const matches = events.filter(
        (e) =>
          e.runId === runId &&
          e.type === assertion.type &&
          Object.entries(assertion.where).every(([key, value]) =>
            Object.hasOwn(e.data ?? {}, key)
              ? equalFilter(e.data[key], value)
              : Object.hasOwn(e, key) && equalFilter(e[key], value),
          ),
      );
      if (matches.length !== assertion.count)
        fail("FEATURE_TRACE", "本轮 Trace 未满足功能事件断言。", "FAIL");
      if (assertion.type === "tool_result") {
        for (const result of matches) {
          if (
            !result.toolCallId ||
            !events.some(
              (e) =>
                e.runId === runId &&
                e.type === "tool_call" &&
                e.toolCallId === result.toolCallId &&
                e.data?.name === result.data?.name,
            )
          )
            fail("FEATURE_TOOL_BINDING", "工具结果缺少同一 Run 的对应调用。", "INCONCLUSIVE");
        }
      }
      observations.push({
        kind: "trace",
        type: assertion.type,
        count: matches.length,
      });
    } else if (assertion.kind === "aggregate_projection") {
      const matches = events.filter(
        (event) =>
          event.runId === runId &&
          event.type === "tool_result" &&
          event.data?.name === assertion.tool &&
          event.data?.isError === false,
      );
      if (matches.length !== assertion.count)
        fail("FEATURE_TRACE", "本轮 Trace 未满足聚合读取断言。", "FAIL");
      for (const result of matches) {
        const data = result.data;
        if (
          !result.toolCallId ||
          !events.some(
            (event) =>
              event.runId === runId &&
              event.type === "tool_call" &&
              event.toolCallId === result.toolCallId &&
              event.data?.name === assertion.tool,
          )
        )
          fail("FEATURE_TOOL_BINDING", "聚合工具结果缺少同一 Run 的对应调用。", "INCONCLUSIVE");
        if (
          data.outputTruncated !== false ||
          typeof data.outputHead !== "string" ||
          !Number.isSafeInteger(data.outputBytes) ||
          data.outputBytes > 512 ||
          data.outputBytes !== Buffer.byteLength(data.outputHead, "utf8") ||
          typeof data.outputSha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(data.outputSha256) ||
          createHash("sha256").update(data.outputHead, "utf8").digest("hex") !== data.outputSha256
        )
          fail(
            "FEATURE_AGGREGATE_TRACE",
            "聚合工具 Trace 未提供完整且可校验的输出证据。",
            "INCONCLUSIVE",
          );
        let projection;
        try {
          projection = JSON.parse(data.outputHead);
        } catch {
          fail("FEATURE_AGGREGATE_TRACE", "聚合工具 Trace 输出无法解析。", "INCONCLUSIVE");
        }
        const content = projection?.content;
        const details = projection?.details;
        let textProjection;
        try {
          if (
            !projection ||
            Array.isArray(projection) ||
            JSON.stringify(projection) !== data.outputHead ||
            Object.keys(projection).sort().join(",") !== "content,details" ||
            !Array.isArray(content) ||
            content.length !== 1 ||
            !content[0] ||
            Object.keys(content[0]).sort().join(",") !== "text,type" ||
            content[0].type !== "text" ||
            typeof content[0].text !== "string" ||
            !details ||
            Array.isArray(details) ||
            Object.keys(details).join(",") !== "memberCount" ||
            content[0].text !== JSON.stringify(details)
          )
            throw new Error("invalid projection");
          textProjection = JSON.parse(content[0].text);
        } catch {
          fail("FEATURE_AGGREGATE_PROJECTION", "工具输出不符合仅含成员数量的投影格式。", "FAIL");
        }
        if (
          !textProjection ||
          Array.isArray(textProjection) ||
          Object.keys(textProjection).join(",") !== "memberCount" ||
          !Number.isSafeInteger(textProjection.memberCount) ||
          textProjection.memberCount < 0 ||
          details.memberCount !== textProjection.memberCount
        )
          fail("FEATURE_AGGREGATE_PROJECTION", "工具输出包含非预期字段或无效成员数量。", "FAIL");
        observations.push({
          kind: "aggregate_projection",
          tool: assertion.tool,
          memberCount: textProjection.memberCount,
          identifiersExposed: false,
        });
      }
    } else {
      const definition = STATES[assertion.resource];
      const row = db.prepare(definition.sql).get(assertion.id);
      if (!row) fail("FEATURE_STATE", "指定功能资源不存在。", "FAIL");
      const sourceRun =
        assertion.resource === "task" ? row.run_id : JSON.parse(row.source_json).ref;
      const writtenHere =
        assertion.resource === "task"
          ? false
          : db
              .prepare(
                "SELECT id FROM memory_audit_events WHERE target_id=? AND run_id=? AND action='write' LIMIT 1",
              )
              .get(row.id, runId);
      if (sourceRun !== (assertion.resource === "task" ? runId : `run:${runId}`) && !writtenHere)
        fail("FEATURE_STATE_PROVENANCE", "状态资源并非由本轮 Run 创建。", "INCONCLUSIVE");
      if (row[definition.field] !== assertion.status)
        fail("FEATURE_STATE", "资源状态未满足功能断言。", "FAIL");
      observations.push({
        kind: "state",
        resource: assertion.resource,
        id: row.id,
        status: row[definition.field],
      });
    }
  }
  return { status: "PASS", runId, observations };
}
