import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FEATURE_CATALOG,
  checkFeatureCoverage,
  checkRepositoryFeatureCoverage,
  readImplementedToolDescriptors,
} from "../feature-catalog.mjs";
import { validateReadFeatureSpecs } from "../lib/feature-specs.mjs";

function minimalCatalog(overrides = {}) {
  return {
    schemaVersion: 1,
    descriptorBaseline: ["ops_status"],
    requiredDomains: ["base"],
    cases: [
      {
        id: "base-read",
        domain: "base",
        tools: ["ops_status"],
        executionStatus: "executable",
        suiteCaseId: "private",
        assertions: [
          {
            kind: "trace",
            type: "tool_result",
            where: { name: "ops_status", isError: false },
            count: 1,
          },
        ],
        mutation: "none",
      },
    ],
    ...overrides,
  };
}

const oneDescriptor = [{ name: "ops_status" }];
const privateSuiteCase = {
  id: "private",
  chat: "private",
  prompt: "Check the test marker {{nonce}} and report the result.",
  expectContains: ["{{nonce}}"],
  sideEffect: "none",
  leaseTools: [
    {
      name: "ops_status",
      operations: [{ action: "ops:status", resourceId: "test", inputConstraint: {} }],
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
};
const valid = (overrides = {}) =>
  checkFeatureCoverage({
    catalog: minimalCatalog(overrides.catalog),
    descriptors: overrides.descriptors ?? oneDescriptor,
    changedTools: overrides.changedTools ?? [],
    prerequisites: overrides.prerequisites ?? [],
    executableSuiteCases: overrides.executableSuiteCases ?? [privateSuiteCase],
  });

test("catalog reads static descriptors and leaves planned domains blocked", async () => {
  const descriptors = await readImplementedToolDescriptors();
  const names = new Set(descriptors.map(({ name }) => name));
  assert.ok(names.has("owner_memory_admin"));
  assert.ok(names.has("group_history_search"));
  assert.ok(names.has("media_generate"));
  assert.ok(names.has("task_delegate"));
  assert.ok(!names.has("group_assignment_create"));
  assert.ok(!names.has("owner_schedule_create"));
  const result = await checkRepositoryFeatureCoverage();
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.gaps.some((gap) => gap.code === "CASE_NOT_EXECUTABLE"));
  assert.deepEqual(result.coveredDomains, []);
});

test("read-only example binds only the implemented Ops and QQ inventory cases", async () => {
  const source = JSON.parse(
    await readFile(new URL("../examples/feature-read.example.json", import.meta.url), "utf8"),
  );
  const suiteCases = validateReadFeatureSpecs(source, { groups: [] });
  const executableCatalogCases = FEATURE_CATALOG.cases.filter(
    (testCase) => testCase.executionStatus === "executable",
  );
  assert.equal(
    FEATURE_CATALOG.coverageNotice,
    "Executable cases are a limited read-only seed, not complete descriptor or domain coverage.",
  );
  for (const testCase of executableCatalogCases) {
    const suiteCase = suiteCases.find((candidate) => candidate.id === testCase.suiteCaseId);
    assert.ok(suiteCase, `${testCase.id} must map to a real example case`);
    assert.deepEqual(
      testCase.tools,
      suiteCase.leaseTools.map((tool) => tool.name),
    );
    assert.deepEqual(testCase.assertions, suiteCase.featureAssertions);
  }

  const descriptors = await readImplementedToolDescriptors();
  const result = checkFeatureCoverage({
    descriptors,
    executableSuiteCases: suiteCases,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.coveredTools, [
    "ops_status",
    "qq_account_status",
    "qq_capability_search",
    "qq_groups",
  ]);
  assert.deepEqual(result.coveredDomains, []);
  assert.ok(
    result.gaps.some(
      (gap) =>
        gap.code === "CASE_NOT_EXECUTABLE" && gap.caseId === "qq-group-member-directory-read",
    ),
  );
  assert.ok(
    result.gaps.some((gap) => gap.code === "MISSING_DOMAIN_COVERAGE" && gap.domain === "qq_read"),
  );
  assert.ok(
    result.gaps.some(
      (gap) => gap.code === "MISSING_DOMAIN_COVERAGE" && gap.domain === "agent_operations",
    ),
  );
});

test("new static descriptor blocks until a case covers it", () => {
  const result = valid({
    descriptors: [...oneDescriptor, { name: "task_list" }],
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(
    result.gaps.some((gap) => gap.code === "NEW_TOOL_UNCOVERED" && gap.tool === "task_list"),
  );
  const covered = valid({
    descriptors: [...oneDescriptor, { name: "task_list" }],
    catalog: {
      cases: [
        ...minimalCatalog().cases,
        {
          id: "task-list-check",
          domain: "base",
          tools: ["task_list"],
          executionStatus: "executable",
          suiteCaseId: "task-list",
          assertions: [
            {
              kind: "trace",
              type: "tool_result",
              where: { name: "task_list", isError: false },
              count: 1,
            },
          ],
          mutation: "none",
        },
      ],
    },
    executableSuiteCases: [
      privateSuiteCase,
      {
        id: "task-list",
        chat: "private",
        prompt: "Check the test marker {{nonce}} and report the result.",
        expectContains: ["{{nonce}}"],
        sideEffect: "none",
        leaseTools: [
          {
            name: "task_list",
            operations: [{ action: "task:list", resourceId: "test", inputConstraint: {} }],
          },
        ],
        featureAssertions: [
          {
            kind: "trace",
            type: "tool_result",
            where: { name: "task_list", isError: false },
            count: 1,
          },
        ],
      },
    ],
  });
  assert.equal(covered.status, "PASS", JSON.stringify(covered.gaps));
});

test("changed descriptor requires an explicit case mapping", () => {
  const result = valid({ changedTools: ["ops_status"] });
  assert.equal(result.status, "PASS");
  const changedButUncovered = valid({
    changedTools: ["ops_status"],
    catalog: { cases: [] },
  });
  assert.equal(changedButUncovered.status, "BLOCKED");
  assert.ok(changedButUncovered.gaps.some((gap) => gap.code === "CHANGED_TOOL_UNCOVERED"));
});

test("executable case must reference a full validated suite case object", () => {
  const result = valid({ executableSuiteCases: [] });
  assert.equal(result.status, "BLOCKED");
  assert.ok(
    result.gaps.some(
      (gap) => gap.code === "SUITE_CASE_NOT_AVAILABLE" && gap.suiteCaseId === "private",
    ),
  );
});

test("missing baseline domain coverage is a gap", () => {
  const catalog = minimalCatalog({
    requiredDomains: ["base", "shipping_feature"],
  });
  const result = checkFeatureCoverage({
    catalog,
    descriptors: oneDescriptor,
    executableSuiteCases: [privateSuiteCase],
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(
    result.gaps.some(
      (gap) => gap.code === "MISSING_DOMAIN_COVERAGE" && gap.domain === "shipping_feature",
    ),
  );
});

test("mutation cases require an isolated fixture and cleanup", () => {
  const catalog = minimalCatalog({
    cases: [
      {
        id: "mutating-case",
        domain: "base",
        tools: ["ops_status"],
        executionStatus: "executable",
        suiteCaseId: "private",
        assertions: [{ kind: "state", resource: "task", id: "task-test", status: "NEW" }],
        mutation: "isolated",
        fixture: "disposable fixture",
      },
    ],
  });
  const result = checkFeatureCoverage({
    catalog,
    descriptors: oneDescriptor,
    executableSuiteCases: [privateSuiteCase],
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.gaps.some((gap) => gap.code === "MUTATION_CLEANUP_REQUIRED"));
});

test("unsupported observer kinds and missing assertions fail closed", () => {
  const catalog = minimalCatalog({
    cases: [
      {
        id: "unsafe-observer",
        domain: "base",
        tools: ["ops_status"],
        executionStatus: "executable",
        suiteCaseId: "private",
        assertions: [{ kind: "shell", command: "echo unsafe" }],
        mutation: "none",
      },
      {
        id: "missing-assertion",
        domain: "base",
        tools: ["ops_status"],
        executionStatus: "executable",
        suiteCaseId: "private",
        mutation: "none",
      },
    ],
  });
  const result = checkFeatureCoverage({
    catalog,
    descriptors: oneDescriptor,
    executableSuiteCases: [privateSuiteCase],
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.gaps.some((gap) => gap.code === "INVALID_EXECUTION_ASSERTIONS"));
  assert.ok(result.gaps.some((gap) => gap.code === "MISSING_EXPECTED_ASSERTION"));
});

test("catalog schema rejects executable observer fields", () => {
  const catalog = minimalCatalog({
    cases: [
      {
        ...minimalCatalog().cases[0],
        sql: "SELECT * FROM messages",
      },
    ],
  });
  const result = checkFeatureCoverage({
    catalog,
    descriptors: oneDescriptor,
    executableSuiteCases: [privateSuiteCase],
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.gaps.some((gap) => gap.code === "UNSUPPORTED_CASE_FIELD"));
});

test("unknown tools and duplicate case IDs fail closed", () => {
  const catalog = minimalCatalog({
    cases: [...minimalCatalog().cases, { ...minimalCatalog().cases[0], tools: ["ghost_tool"] }],
  });
  const duplicateIds = minimalCatalog({
    cases: [...minimalCatalog().cases, { ...minimalCatalog().cases[0] }],
  });
  const unknownResult = checkFeatureCoverage({
    catalog,
    descriptors: oneDescriptor,
  });
  const duplicateResult = checkFeatureCoverage({
    catalog: duplicateIds,
    descriptors: oneDescriptor,
  });
  assert.ok(
    unknownResult.gaps.some((gap) => gap.code === "UNKNOWN_TOOL" && gap.tool === "ghost_tool"),
  );
  assert.ok(duplicateResult.gaps.some((gap) => gap.code === "DUPLICATE_CASE_ID"));
});

test("unmet prerequisites remain BLOCKED, never PASS", () => {
  const result = valid({
    prerequisites: [{ id: "qq-account-online", status: "UNKNOWN" }],
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.blockers, [
    {
      code: "PREREQUISITE_BLOCKED",
      id: "qq-account-online",
      status: "UNKNOWN",
    },
  ]);
});

test("an ops status case cannot cover Memory or media by reusing its suite case ID", () => {
  for (const claimedTool of ["media_generate", "owner_memory_admin"]) {
    const wrongToolCatalog = minimalCatalog({
      descriptorBaseline: ["ops_status", claimedTool],
      cases: [
        {
          ...minimalCatalog().cases[0],
          id: `false-${claimedTool}`,
          tools: [claimedTool],
          suiteCaseId: "private",
        },
      ],
    });
    const wrongTool = checkFeatureCoverage({
      catalog: wrongToolCatalog,
      descriptors: [{ name: "ops_status" }, { name: claimedTool }],
      executableSuiteCases: [privateSuiteCase],
    });
    assert.equal(wrongTool.status, "BLOCKED");
    assert.ok(
      wrongTool.gaps.some(
        (gap) => gap.code === "SUITE_TOOL_NOT_LEASED" && gap.tool === claimedTool,
      ),
    );
    assert.deepEqual(wrongTool.coveredTools, []);
  }

  const wrongAssertionCatalog = minimalCatalog({
    cases: [
      {
        ...minimalCatalog().cases[0],
        assertions: [
          {
            kind: "trace",
            type: "tool_result",
            where: { name: "ops_status", isError: false },
            count: 2,
          },
        ],
      },
    ],
  });
  const wrongAssertion = checkFeatureCoverage({
    catalog: wrongAssertionCatalog,
    descriptors: oneDescriptor,
    executableSuiteCases: [privateSuiteCase],
  });
  assert.equal(wrongAssertion.status, "BLOCKED");
  assert.ok(wrongAssertion.gaps.some((gap) => gap.code === "SUITE_ASSERTIONS_MISMATCH"));
  assert.deepEqual(wrongAssertion.coveredDomains, []);
});

test("mutating catalog case stays blocked without an implemented cleanup binding", () => {
  const catalog = minimalCatalog({
    cases: [
      {
        ...minimalCatalog().cases[0],
        mutation: "isolated",
        fixture: "disposable task",
        cleanup: "cancel the task",
      },
    ],
  });
  const result = checkFeatureCoverage({
    catalog,
    descriptors: oneDescriptor,
    executableSuiteCases: [privateSuiteCase],
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.gaps.some((gap) => gap.code === "MUTATION_EXECUTION_UNSUPPORTED"));
  assert.deepEqual(result.coveredTools, []);
});
