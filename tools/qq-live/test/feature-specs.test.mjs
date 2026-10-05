import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveReadFeatureCase,
  resolveReadFeatureSpecs,
  validateReadFeatureSpecs,
} from "../lib/feature-specs.mjs";
const config = { groups: [{ alias: "A", id: "20001" }] };
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
    query: "{{nonce}}",
    limit: 1,
  });
  assert.deepEqual(groupCase.featureAssertions[1].where, {
    query: "{{nonce}}",
    groups: ["20001"],
    resources: ["group:20001"],
    sourceKind: "channel_message",
    retrievalMode: "lexical",
  });
  assert.equal(ownerCase.leaseTools[0].operations[0].resourceId, "owner-history");
  assert.deepEqual(ownerCase.leaseTools[0].operations[0].inputConstraint, {
    query: "{{nonce}}",
    groupIds: ["20001"],
    limit: 1,
  });
});

test("history lease rejects broad searches, other resources, and wrong trace scopes", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  for (const mutate of [
    (suite) => (suite.cases[5].leaseTools[0].operations[0].inputConstraint.query = "deploy"),
    (suite) => (suite.cases[5].leaseTools[0].operations[0].inputConstraint.limit = 8),
    (suite) => (suite.cases[5].leaseTools[0].operations[0].resourceId = "group:20002"),
    (suite) => (suite.cases[6].leaseTools[0].operations[0].inputConstraint.groupIds = undefined),
    (suite) => (suite.cases[6].featureAssertions[1].where.resources = ["group:20002"]),
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
