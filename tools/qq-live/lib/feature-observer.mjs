import { fail } from "./core.mjs";

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
]);
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
        Object.entries(a.where).some(
          ([k, v]) => !FIELDS.has(k) || !["string", "number", "boolean"].includes(typeof v),
        ) ||
        !Number.isSafeInteger(a.count) ||
        a.count < 1 ||
        a.count > 32 ||
        Object.keys(a).some((k) => !["kind", "type", "where", "count"].includes(k))
      )
        fail("FEATURE_ASSERTIONS", "Trace 断言必须指定已支持的事件、字段和值及精确数量。");
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
              ? e.data[key] === value
              : Object.hasOwn(e, key) && e[key] === value,
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
      observations.push({ kind: "trace", type: assertion.type, count: matches.length });
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
