import { fail } from "./core.mjs";

const MARKER = /^[a-f0-9]{32}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GROUP_ID = /^[1-9]\d{0,15}$/;
const QUERY_PREFIX = "gbxhistory1-";

function queryForMarker(marker) {
  return `${QUERY_PREFIX}${marker}`;
}

function invalid() {
  fail("HISTORY_SCENARIO_INPUT", "固定历史场景需要本轮群 A 输入的有效证据。", "BLOCKED");
}

function configuredGroupA(config) {
  const groups = config?.groups?.filter((group) => group?.alias === "A") ?? [];
  if (groups.length !== 1 || !GROUP_ID.test(groups[0]?.id ?? "")) invalid();
  return groups[0].id;
}

function untilFromUnixSeconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Date.now() / 1000) + 5)
    invalid();
  const milliseconds = value * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || date.getTime() !== milliseconds) invalid();
  return date.toISOString();
}

function seedSpecForGroup(groupId) {
  return {
    id: "history-current-group-hit",
    chat: "A",
    prompt: "请搜索本群历史，查找编号 gbxhistory1-{{nonce}}，说明结果并回复本轮编号 {{nonce}}。",
    expectContains: ["{{nonce}}"],
    sideEffect: "none",
    leaseTools: [
      {
        name: "group_history_search",
        operations: [
          {
            action: "history:read",
            resourceId: `group:${groupId}`,
            inputConstraint: { query: "gbxhistory1-{{nonce}}", limit: 1 },
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
          query: "gbxhistory1-{{nonce}}",
          groups: [groupId],
          resources: [`group:${groupId}`],
          sourceKind: "channel_message",
          retrievalMode: "lexical",
        },
        count: 1,
      },
      { kind: "history_coverage", query: "gbxhistory1-{{nonce}}", groupId, count: 1 },
      {
        kind: "history_result",
        tool: "group_history_search",
        query: "gbxhistory1-{{nonce}}",
        groupId,
        result: "hit",
        count: 1,
      },
    ],
  };
}

/** Build the fixed seed spec before a seed Run exists. */
export function historySeedSpec(config) {
  return seedSpecForGroup(configuredGroupA(config));
}

/** Build an Owner-private recall spec from independently observed seed evidence. */
export function historyRecallSpec(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "config,groupId,seedInputTime,seedMarker,seedRunId"
  )
    invalid();
  const { config, groupId, seedMarker, seedRunId, seedInputTime } = input;
  const configuredId = configuredGroupA(config);
  const until = untilFromUnixSeconds(seedInputTime);
  if (groupId !== configuredId || !MARKER.test(seedMarker ?? "") || !RUN_ID.test(seedRunId ?? ""))
    invalid();
  const query = queryForMarker(seedMarker);

  const recall = {
    id: "history-seed-recall",
    chat: "private",
    prompt: `请搜索群 ${configuredId} 的历史记录，查找编号 ${query}。检索截止时间为 ${until}，最多查询 1 条。只说明是否找到这条种子编号，并回复本轮编号 {{nonce}}。`,
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
              query,
              groupIds: [configuredId],
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
          query,
          groups: [configuredId],
          resources: [`group:${configuredId}`],
          sourceKind: "channel_message",
          retrievalMode: "lexical",
        },
        count: 1,
      },
      { kind: "history_coverage", query, groupId: configuredId, count: 1 },
      {
        kind: "history_seed_result",
        tool: "owner_history_search",
        query,
        groupId: configuredId,
        result: "hit",
        count: 1,
        sourceRunId: seedRunId,
        until,
      },
    ],
  };

  return recall;
}

/** Compose both fixed specs after seed evidence is available. */
export function historyScenarioSteps(input) {
  return {
    seed: historySeedSpec(input?.config),
    recall: historyRecallSpec(input),
  };
}
