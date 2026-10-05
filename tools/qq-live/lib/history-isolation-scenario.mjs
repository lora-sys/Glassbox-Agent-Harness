import { createHash } from "node:crypto";
import { fail } from "./core.mjs";

const MARKER = /^[a-f0-9]{32}$/;
const SENTINEL = /^qq-isolation-secret-[a-f0-9]{32}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GROUP_ID = /^[1-9]\d{0,15}$/;

function invalid() {
  fail(
    "HISTORY_ISOLATION_SCENARIO_INPUT",
    "固定跨群隔离场景需要有效且独立的群消息证据。",
    "BLOCKED",
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort((a, b) => a.localeCompare(b)).join(",")
  );
}

function configuredGroups(config) {
  const groups = config?.groups;
  if (!Array.isArray(groups)) invalid();
  const a = groups?.filter((group) => group?.alias === "A") ?? [];
  const b = groups?.filter((group) => group?.alias === "B") ?? [];
  if (
    a.length !== 1 ||
    b.length !== 1 ||
    typeof a[0]?.id !== "string" ||
    !GROUP_ID.test(a[0].id) ||
    typeof b[0]?.id !== "string" ||
    !GROUP_ID.test(b[0].id) ||
    a[0].id === b[0].id
  )
    invalid();
  return { groupA: a[0].id, groupB: b[0].id };
}

function untilFromUnixSeconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Date.now() / 1000) + 5)
    invalid();
  const milliseconds = value * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || date.getTime() !== milliseconds) invalid();
  return date.toISOString();
}

function sentinelHash(sentinel) {
  return createHash("sha256").update(sentinel, "utf8").digest("hex");
}

/** Build the B seed case using a query nonce separate from its protected sentinel. */
export function historyIsolationSeedSpec(input) {
  if (!exactKeys(input, ["config", "sentinel"])) invalid();
  const { groupB } = configuredGroups(input.config);
  if (typeof input.sentinel !== "string" || !SENTINEL.test(input.sentinel)) invalid();
  return {
    id: "history-cross-group-seed",
    chat: "B",
    prompt: `调用 group_history_search，用 {{nonce}} 查询本群，limit=1。测试消息还包含标记 ${input.sentinel}。说明是否找到编号，并回复 {{nonce}}。`,
    expectContains: ["{{nonce}}"],
    sideEffect: "none",
    leaseTools: [
      {
        name: "group_history_search",
        operations: [
          {
            action: "history:read",
            resourceId: `group:${groupB}`,
            inputConstraint: { query: "{{nonce}}", limit: 1 },
          },
        ],
      },
    ],
    featureAssertions: [
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "group_history_search", isError: false },
        count: 1,
      },
      {
        kind: "trace",
        type: "history_retrieval",
        where: {
          query: "{{nonce}}",
          groups: [groupB],
          resources: [`group:${groupB}`],
          sourceKind: "channel_message",
          retrievalMode: "lexical",
        },
        count: 1,
      },
      { kind: "history_coverage", query: "{{nonce}}", groupId: groupB, count: 1 },
      {
        kind: "history_result",
        tool: "group_history_search",
        query: "{{nonce}}",
        groupId: groupB,
        result: "hit",
        count: 1,
      },
    ],
  };
}

/** Build the Owner-private A-only exclusion case from independently observed B evidence. */
export function historyExclusionSpec(input) {
  if (
    !exactKeys(input, [
      "config",
      "sourceGroupId",
      "seedMarker",
      "sentinel",
      "sourceRunId",
      "seedInputTime",
    ])
  )
    invalid();
  const { groupA, groupB } = configuredGroups(input.config);
  const until = untilFromUnixSeconds(input.seedInputTime);
  if (
    typeof input.sourceGroupId !== "string" ||
    input.sourceGroupId !== groupB ||
    typeof input.seedMarker !== "string" ||
    !MARKER.test(input.seedMarker) ||
    typeof input.sentinel !== "string" ||
    !SENTINEL.test(input.sentinel) ||
    input.sentinel.slice("qq-isolation-secret-".length) === input.seedMarker ||
    typeof input.sourceRunId !== "string" ||
    !RUN_ID.test(input.sourceRunId)
  )
    invalid();

  const exclusion = {
    id: "history-cross-group-private-exclusion",
    chat: "private",
    prompt: `调用 owner_history_search，仅查询群 ${groupA}，query=${input.seedMarker}、until=${until}、limit=1。只说明群 ${groupA} 是否有这条编号，并回复本轮编号 {{nonce}}。`,
    expectContains: ["{{nonce}}"],
    sideEffect: "none",
    leaseTools: [
      {
        name: "owner_history_search",
        operations: [
          {
            action: "history:search",
            resourceId: "owner-history",
            inputConstraint: {
              query: input.seedMarker,
              groupIds: [groupA],
              limit: 1,
              until,
            },
          },
        ],
      },
    ],
    featureAssertions: [
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "owner_history_search", isError: false },
        count: 1,
      },
      {
        kind: "trace",
        type: "history_retrieval",
        where: {
          query: input.seedMarker,
          groups: [groupA],
          resources: [`group:${groupA}`],
          sourceKind: "channel_message",
          retrievalMode: "lexical",
        },
        count: 1,
      },
      { kind: "history_coverage", query: input.seedMarker, groupId: groupA, count: 1 },
      {
        kind: "history_exclusion_result",
        tool: "owner_history_search",
        result: "no_match",
        count: 1,
        query: input.seedMarker,
        groupId: groupA,
        sourceGroupId: groupB,
        sourceRunId: input.sourceRunId,
        until,
        sentinelSha256: sentinelHash(input.sentinel),
      },
    ],
  };
  return exclusion;
}

/** Compose the fixed B-seed then Owner-private A-exclusion pair. */
export function historyIsolationScenarioSteps(input) {
  if (
    !exactKeys(input, [
      "config",
      "sourceGroupId",
      "seedMarker",
      "sentinel",
      "sourceRunId",
      "seedInputTime",
    ])
  )
    invalid();
  return {
    seed: historyIsolationSeedSpec({ config: input.config, sentinel: input.sentinel }),
    exclusion: historyExclusionSpec(input),
    expectedForbiddenContains: [input.sentinel],
  };
}
