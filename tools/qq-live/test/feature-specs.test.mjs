import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveReadFeatureCase,
  resolveReadFeatureSpecs,
  validateReadFeatureSpecs,
} from "../lib/feature-specs.mjs";
const config = {
  bot: { qq: "10003" },
  groups: [
    { alias: "A", id: "20001" },
    { alias: "B", id: "20002" },
  ],
};

test("Bot group-role case binds only configured Bot identity and B self-role lookup", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const source = raw.cases.find((entry) => entry.id === "qq-bot-group-role-read");
  const roleConfig = {
    bot: { qq: "10003" },
    groups: [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20002" },
    ],
  };
  assert.equal(
    validateReadFeatureSpecs({ schemaVersion: 2, cases: [source] }, roleConfig).length,
    1,
  );
  const [resolved] = resolveReadFeatureSpecs({ schemaVersion: 2, cases: [source] }, roleConfig);
  assert.deepEqual(resolved.leaseTools[0].operations[0], {
    action: "group:members:read",
    resourceId: "group:20002",
    inputConstraint: {
      groupId: "20002",
      operation: "get_group_member_info",
      params: { user_id: "10003" },
    },
  });
  assert.deepEqual(resolved.featureAssertions[1], {
    kind: "group_member_role",
    tool: "qq_group_members",
    groupId: "20002",
    userId: "10003",
    count: 1,
  });
  for (const mutate of [
    (c) => {
      c.chat = "B";
    },
    (c) => {
      c.leaseTools[0].operations[0].resourceId = "group:20001";
    },
    (c) => {
      c.leaseTools[0].operations[0].inputConstraint.params.user_id = "10002";
    },
    (c) => {
      c.leaseTools[0].operations[0].inputConstraint.operation = "get_group_member_list";
    },
    (c) => {
      c.leaseTools[0].operations[0].inputConstraint.params.no_cache = true;
    },
    (c) => {
      c.featureAssertions[1].userId = "10002";
    },
    (c) => {
      c.prompt = "Read arbitrary group role {{nonce}}";
    },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() =>
      validateReadFeatureSpecs({ schemaVersion: 2, cases: [changed] }, roleConfig),
    );
  }
  assert.throws(() =>
    validateReadFeatureSpecs(
      { schemaVersion: 2, cases: [source] },
      {
        bot: { qq: "10003" },
        groups: [{ alias: "A", id: "20001" }],
      },
    ),
  );
});

test("group info case binds exact private A operation and refuses weaker or extra capabilities", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-baseline.example.json", import.meta.url), "utf8"),
  );
  const source = raw.cases.find((c) => c.id === "qq-group-a-info-read");
  assert.equal(validateReadFeatureSpecs({ schemaVersion: 2, cases: [source] }, config).length, 1);
  const [resolved] = resolveReadFeatureSpecs({ schemaVersion: 2, cases: [source] }, config);
  assert.equal(resolved.featureAssertions[1].groupId, "20001");
  for (const change of [
    (c) => {
      c.chat = "A";
    },
    (c) => {
      c.leaseTools[0].operations[0].resourceId = "group:20002";
    },
    (c) => {
      c.leaseTools[0].operations[0].inputConstraint.groupId = "20002";
    },
    (c) => {
      c.leaseTools[0].operations[0].inputConstraint.params = { no_cache: true };
    },
    (c) => {
      c.featureAssertions.pop();
    },
    (c) => {
      c.featureAssertions[1].groupId = "{{group:B}}";
    },
    (c) => {
      c.leaseTools[0].operations.push(structuredClone(c.leaseTools[0].operations[0]));
    },
  ]) {
    const changed = structuredClone(source);
    change(changed);
    assert.throws(() => validateReadFeatureSpecs({ schemaVersion: 2, cases: [changed] }, config));
  }
});
test("group root page case binds exact private A operation and refuses weaker or extra capabilities", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-baseline.example.json", import.meta.url), "utf8"),
  );
  const source = raw.cases.find((c) => c.id === "qq-group-a-root-files-read");
  assert.equal(validateReadFeatureSpecs({ schemaVersion: 2, cases: [source] }, config).length, 1);
  const [resolved] = resolveReadFeatureSpecs({ schemaVersion: 2, cases: [source] }, config);
  assert.equal(resolved.featureAssertions[1].groupId, "20001");
  for (const change of [
    (c) => {
      c.chat = "A";
    },
    (c) => {
      c.leaseTools[0].operations[0].resourceId = "group:20002";
    },
    (c) => {
      c.leaseTools[0].operations[0].inputConstraint.groupId = "20002";
    },
    (c) => {
      c.leaseTools[0].operations[0].inputConstraint.params = { no_cache: true };
    },
    (c) => {
      c.featureAssertions.pop();
    },
    (c) => {
      c.featureAssertions[1].groupId = "{{group:B}}";
    },
    (c) => {
      c.leaseTools[0].operations.push(structuredClone(c.leaseTools[0].operations[0]));
    },
  ]) {
    const changed = structuredClone(source);
    change(changed);
    assert.throws(() => validateReadFeatureSpecs({ schemaVersion: 2, cases: [changed] }, config));
  }
});
function suite() {
  return {
    schemaVersion: 2,
    cases: [
      {
        id: "ops-read",
        chat: "private",
        prompt: "Read counts and reply {{nonce}}",
        expectContains: ["{{nonce}}"],
        sideEffect: "none",
        leaseTools: [
          {
            name: "ops_status",
            operations: [
              { action: "ops:status", resourceId: "agent-operations", inputConstraint: {} },
            ],
          },
        ],
        featureAssertions: [
          {
            kind: "trace",
            type: "tool_result",
            where: { name: "ops_status", isError: false },
            count: 1,
          },
        ],
      },
    ],
  };
}
test("structured feature cases require actual permitted tool execution", () => {
  assert.equal(validateReadFeatureSpecs(suite(), config).length, 1);
  for (const change of [
    (s) => (s.cases[0].sideEffect = "reversible"),
    (s) => (s.cases[0].leaseTools[0].name = "task_create"),
    (s) => (s.cases[0].leaseTools[0].operations[0].action = "task:create"),
    (s) => (s.cases[0].featureAssertions[0].where.isError = true),
    (s) => (s.cases[0].chat = "unconfigured"),
    (s) => (s.cases[0].script = "arbitrary"),
    (s) => s.cases.push(structuredClone(s.cases[0])),
  ]) {
    const raw = suite();
    change(raw);
    assert.throws(() => validateReadFeatureSpecs(raw, config));
  }
});

test("history cases resolve only the exact A-group nonce search scope", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const resolved = resolveReadFeatureSpecs(raw, config);
  assert.match(resolved.find((entry) => entry.id === "ops-status-read").prompt, /\{\{nonce\}\}/u);
  const groupCase = resolved.find((entry) => entry.id === "history-current-group-nonce");
  const ownerCase = resolved.find((entry) => entry.id === "history-owner-group-a-nonce");
  assert.equal(groupCase.leaseTools[0].operations[0].resourceId, "group:20001");
  assert.deepEqual(groupCase.leaseTools[0].operations[0].inputConstraint, {
    query: "gbxhistory1-{{nonce}}",
    limit: 1,
  });
  assert.deepEqual(groupCase.featureAssertions[1].where, {
    query: "gbxhistory1-{{nonce}}",
    groups: ["20001"],
    resources: ["group:20001"],
    sourceKind: "channel_message",
    retrievalMode: "lexical",
  });
  assert.equal(ownerCase.leaseTools[0].operations[0].resourceId, "owner-history");
  const complete = resolved.find((entry) => entry.id === "history-current-group-complete");
  assert.deepEqual(complete.featureAssertions[2], {
    kind: "history_coverage",
    query: "gbxhistory1-{{nonce}}",
    groupId: "20001",
    count: 1,
  });
  for (const change of [
    { groupId: "20002" },
    { count: 0 },
    { query: "unbounded" },
    { coverage: "complete" },
  ]) {
    const bad = structuredClone(complete);
    Object.assign(bad.featureAssertions[2], change);
    assert.throws(() => validateReadFeatureSpecs({ schemaVersion: 2, cases: [bad] }, config));
  }
  assert.deepEqual(ownerCase.leaseTools[0].operations[0].inputConstraint, {
    query: "gbxhistory1-{{nonce}}",
    groupIds: ["20001"],
    limit: 1,
  });
});

test("history lease rejects broad searches, other resources, and wrong trace scopes", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  for (const mutate of [
    (suite) =>
      (suite.cases.find(
        (c) => c.id === "history-current-group-nonce",
      ).leaseTools[0].operations[0].inputConstraint.query = "deploy"),
    (suite) =>
      (suite.cases.find(
        (c) => c.id === "history-current-group-nonce",
      ).leaseTools[0].operations[0].inputConstraint.limit = 8),
    (suite) =>
      (suite.cases.find(
        (c) => c.id === "history-current-group-nonce",
      ).leaseTools[0].operations[0].resourceId = "group:20002"),
    (suite) =>
      (suite.cases.find(
        (c) => c.id === "history-owner-group-a-nonce",
      ).leaseTools[0].operations[0].inputConstraint.groupIds = undefined),
    (suite) =>
      (suite.cases.find(
        (c) => c.id === "history-owner-group-a-nonce",
      ).featureAssertions[1].where.resources = ["group:20002"]),
  ]) {
    const changed = structuredClone(raw);
    mutate(changed);
    assert.throws(() => validateReadFeatureSpecs(changed, config));
  }
});

test("group member case is Owner-private, group A list-only, and independently observes its safe projection", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const sourceCase = raw.cases.find((entry) => entry.id === "qq-group-member-count-read");
  assert.ok(sourceCase);
  assert.deepEqual(sourceCase.leaseTools, [
    {
      name: "qq_group_members",
      operations: [
        {
          action: "group:members:read",
          resourceId: "group:{{group:A}}",
          inputConstraint: {
            groupId: "{{group:A}}",
            operation: "get_group_member_list",
          },
        },
      ],
    },
  ]);
  assert.deepEqual(sourceCase.featureAssertions[1], {
    kind: "aggregate_projection",
    tool: "qq_group_members",
    count: 1,
  });
  const resolved = resolveReadFeatureSpecs(raw, config).find((entry) => entry.id === sourceCase.id);
  assert.equal(resolved.chat, "private");
  assert.equal(resolved.leaseTools[0].operations[0].resourceId, "group:20001");
  assert.deepEqual(resolved.leaseTools[0].operations[0].inputConstraint, {
    groupId: "20001",
    operation: "get_group_member_list",
  });

  for (const mutate of [
    (entry) => (entry.chat = "A"),
    (entry) =>
      (entry.authorization = {
        action: "group:members:read",
        resource: "group:20001",
      }),
    (entry) => (entry.leaseTools[0].operations[0].action = "group:read"),
    (entry) => (entry.leaseTools[0].operations[0].resourceId = "group:{{group:B}}"),
    (entry) =>
      (entry.leaseTools[0].operations[0].inputConstraint.operation = "get_group_member_info"),
    (entry) => (entry.leaseTools[0].operations[0].inputConstraint.groupId = "{{group:B}}"),
    (entry) =>
      entry.leaseTools[0].operations.push({
        ...entry.leaseTools[0].operations[0],
      }),
    (entry) => (entry.featureAssertions[1].kind = "trace"),
    (entry) => (entry.featureAssertions[1].tool = "qq_group_members_extra"),
  ]) {
    const changed = structuredClone(raw);
    mutate(changed.cases.find((entry) => entry.id === sourceCase.id));
    assert.throws(() => validateReadFeatureSpecs(changed, config));
  }
});

test("history result cases preserve exact four-assertion scope and allow the expanded bounded baseline", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const resolved = resolveReadFeatureSpecs(raw, config);
  assert.equal(resolved.length, 14);
  for (const [id, result, tool] of [
    ["history-current-group-hit", "hit", "group_history_search"],
    ["history-owner-group-a-no-match", "no_match", "owner_history_search"],
  ]) {
    const source = resolved.find((item) => item.id === id);
    assert.deepEqual(source.featureAssertions[3], {
      kind: "history_result",
      tool,
      query: "gbxhistory1-{{nonce}}",
      groupId: "20001",
      result,
      count: 1,
    });
    for (const change of [
      { groupId: "20002" },
      { result: result === "hit" ? "no_match" : "hit" },
      { count: 2 },
      { tool: "task_get" },
    ]) {
      const bad = structuredClone(source);
      Object.assign(bad.featureAssertions[3], change);
      assert.throws(() => validateReadFeatureSpecs({ schemaVersion: 2, cases: [bad] }, config));
    }
  }
  assert.throws(
    () =>
      validateReadFeatureSpecs({ schemaVersion: 2, cases: Array(17).fill(raw.cases[0]) }, config),
    { code: "FEATURE_SUITE" },
  );
});

test("fixed read examples use natural requests and parser-aligned history markers", async () => {
  for (const filename of [
    "feature-read.example.json",
    "feature-memory.example.json",
    "feature-baseline.example.json",
  ]) {
    const suite = JSON.parse(
      await readFile(new URL(`../examples/${filename}`, import.meta.url), "utf8"),
    );
    const memberCount = suite.cases.find((item) => item.id === "qq-group-member-count-read");
    assert.match(memberCount.prompt, /测试群 \{\{group:A\}\}/u);
    assert.doesNotMatch(memberCount.prompt, /qq_group_members|get_group_member_list|limit=/u);

    for (const item of suite.cases.filter((entry) => entry.id.startsWith("history-"))) {
      if (!item.prompt) continue;
      assert.match(item.prompt, /gbxhistory1-\{\{nonce\}\}/u, `${filename}:${item.id}`);
      assert.doesNotMatch(
        item.prompt,
        /group_history_search|owner_history_search|query=|limit=/u,
        `${filename}:${item.id}`,
      );
      const expectedQuery = "gbxhistory1-{{nonce}}";
      const operation = item.leaseTools?.[0]?.operations?.[0];
      if (operation) assert.equal(operation.inputConstraint.query, expectedQuery);
      for (const assertion of item.featureAssertions ?? []) {
        if (assertion.kind === "trace" && assertion.type === "history_retrieval")
          assert.equal(assertion.where.query, expectedQuery);
        if (assertion.kind === "history_coverage" || assertion.kind === "history_result")
          assert.equal(assertion.query, expectedQuery);
      }
    }

    for (const item of suite.cases.filter((entry) => entry.prompt)) {
      assert.doesNotMatch(
        item.prompt,
        /(?:qq_group_|qq_account_|qq_capability_search|owner_history_search|group_history_search|ops_status|get_group_[a-z_]+|query=|limit=)/u,
        `${filename}:${item.id} should read as a request, not a Tool instruction`,
      );
    }
  }
});

test("legacy bare-nonce history lease templates are rejected instead of upgraded", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const legacy = structuredClone(raw);
  for (const item of legacy.cases.filter((entry) => entry.id.startsWith("history-"))) {
    for (const operation of item.leaseTools?.flatMap((tool) => tool.operations) ?? [])
      if (operation.inputConstraint.query === "gbxhistory1-{{nonce}}")
        operation.inputConstraint.query = "{{nonce}}";
    for (const assertion of item.featureAssertions ?? []) {
      if (assertion.kind === "trace" && assertion.type === "history_retrieval")
        assertion.where.query = "{{nonce}}";
      if (assertion.kind === "history_coverage" || assertion.kind === "history_result")
        assertion.query = "{{nonce}}";
    }
  }
  assert.throws(() => validateReadFeatureSpecs(legacy, config), { code: "FEATURE_HISTORY_SCOPE" });
});

test("resolver preserves nonce and rejects unknown group or arbitrary templates", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const unknownGroup = structuredClone(raw);
  unknownGroup.cases[4].prompt += " {{group:C}}";
  assert.throws(() => resolveReadFeatureSpecs(unknownGroup, config), { code: "FEATURE_TEMPLATE" });
  const arbitrary = structuredClone(raw);
  arbitrary.cases[0].prompt += " {{shell:whoami}}";
  assert.throws(() => resolveReadFeatureSpecs(arbitrary, config), { code: "FEATURE_TEMPLATE" });
  assert.throws(() => resolveReadFeatureCase({ prompt: "{{group:C}}" }, () => "20001"), {
    code: "FEATURE_TEMPLATE",
  });
});
