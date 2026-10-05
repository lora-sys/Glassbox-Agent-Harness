import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { validateReadFeatureSpecs } from "./lib/feature-specs.mjs";
import { validateFeatureAssertions } from "./lib/feature-observer.mjs";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

const MUTATION_CLASSES = new Set(["none", "reversible", "isolated"]);

/**
 * Static Tool inventory plus a small executable read-only seed. This seed is not complete
 * feature or domain coverage. Group assignments and schedules remain unimplemented.
 */
export const FEATURE_CATALOG = Object.freeze({
  schemaVersion: 1,
  coverageNotice:
    "Executable cases are a limited read-only seed, not complete descriptor or domain coverage.",
  descriptorBaseline: [
    "qq_capability_search",
    "qq_groups",
    "qq_group_members",
    "qq_group_history",
    "qq_group_content",
    "qq_group_files",
    "qq_group_file_ops",
    "qq_group_moderation",
    "qq_group_local_settings",
    "qq_group_settings",
    "qq_account_status",
    "media_generate",
    "browser",
    "web_search",
    "web_fetch",
    "group_history_search",
    "owner_history_search",
    "owner_group_admin",
    "owner_model_admin",
    "owner_memory_admin",
    "skill_read",
    "ops_status",
    "task_list",
    "task_get",
    "task_create",
    "worker_status",
    "task_delegate",
    "worker_read",
    "task_worker_result",
    "worker_prompt",
    "task_accept",
    "task_rework",
    "task_step_accept",
    "task_step_rework",
    "task_signal",
    "task_approve",
    "task_cancel",
    "task_steps",
    "task_events",
    "task_plan",
    "task_link_child",
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "powershell",
  ],
  requiredDomains: [
    "qq_read",
    "qq_group_policy",
    "memory_taste",
    "history_retrieval",
    "media",
    "agent_operations",
    "authorization_delivery",
  ],
  cases: [
    {
      id: "qq-account-status-read",
      domain: "qq_read",
      executionStatus: "executable",
      tools: ["qq_account_status"],
      suiteCaseId: "qq-account-status-read",
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "qq_account_status", isError: false },
          count: 1,
        },
      ],
      coveragePlan: "Read only the bot's own online status. No group or message data is requested.",
      mutation: "none",
    },
    {
      id: "qq-managed-groups-inventory-read",
      domain: "qq_read",
      executionStatus: "executable",
      tools: ["qq_groups"],
      suiteCaseId: "qq-managed-groups-inventory-read",
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "qq_groups", isError: false },
          count: 1,
        },
      ],
      coveragePlan:
        "Read the Owner's managed-group inventory through qq_groups listing. No group history or member details are requested.",
      mutation: "none",
    },
    {
      id: "qq-capability-registry-read",
      domain: "qq_read",
      executionStatus: "executable",
      tools: ["qq_capability_search"],
      suiteCaseId: "qq-capability-registry-read",
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "qq_capability_search", isError: false },
          count: 1,
        },
      ],
      coveragePlan:
        "Search only the authorized QQ group.read capability registry. Do not enumerate group IDs or member data.",
      mutation: "none",
    },
    {
      id: "qq-group-member-directory-read",
      domain: "qq_read",
      executionStatus: "planned",
      tools: ["qq_group_members"],
      coveragePlan:
        "Requires a dedicated authorized test group and a no-member-identifiers evidence contract before reading member data.",
      mutation: "none",
    },
    {
      id: "qq-group-policy-isolation",
      domain: "qq_group_policy",
      executionStatus: "planned",
      tools: ["owner_group_admin"],
      coveragePlan:
        "Capture policy, change one setting, prove only the selected group changed, then restore it.",
      mutation: "reversible",
      fixture: "dedicated test group; capture policy before mutation",
      cleanup: "restore every changed group policy field to its captured value",
    },
    {
      id: "memory-and-taste-lifecycle",
      domain: "memory_taste",
      executionStatus: "planned",
      tools: ["owner_memory_admin"],
      coveragePlan:
        "Use a unique project-scoped candidate and prove pending, review, persisted state, and scope isolation.",
      mutation: "isolated",
      fixture: "unique project scope and qqtest nonce; Owner private Run",
      cleanup:
        "reject pending candidate or revoke/retire promoted test Memory; retain audit evidence",
    },
    {
      id: "history-search-current-group",
      domain: "history_retrieval",
      executionStatus: "planned",
      tools: ["group_history_search"],
      coveragePlan:
        "Search only a unique message posted to the dedicated test group; assert its retrieval event and coverage.",
      mutation: "none",
    },
    {
      id: "history-search-owner-scoped-groups",
      domain: "history_retrieval",
      executionStatus: "planned",
      tools: ["owner_history_search"],
      coveragePlan:
        "Search only selected authorized test groups and prove an unauthorized group is absent.",
      mutation: "none",
    },
    {
      id: "media-private-delivery",
      domain: "media",
      executionStatus: "planned",
      tools: ["media_generate"],
      coveragePlan:
        "Generate only after budget approval; bind Asset creation and successful delivery to the same private Run.",
      mutation: "isolated",
      fixture:
        "designated shared QQ acceptance identity and stable GLASSBOX_DATA_DIR; confirm external media budget",
      cleanup:
        "retain the Asset ID and delivery evidence; require an approved Asset deletion path or report BLOCKED because delivery cannot be recalled",
    },
    {
      id: "agent-operations-read-and-lifecycle",
      domain: "agent_operations",
      executionStatus: "planned",
      tools: [
        "ops_status",
        "task_list",
        "task_get",
        "task_create",
        "worker_status",
        "task_delegate",
        "worker_read",
        "task_worker_result",
        "worker_prompt",
        "task_accept",
        "task_rework",
        "task_step_accept",
        "task_step_rework",
        "task_signal",
        "task_approve",
        "task_cancel",
        "task_steps",
        "task_events",
        "task_plan",
        "task_link_child",
      ],
      coveragePlan:
        "Create an isolated Task; verify lifecycle and Attempt evidence. Delegate only to an approved workspace and never infer acceptance from Worker done.",
      mutation: "isolated",
      fixture:
        "dedicated disposable Task and registered Worker workspace; verify configured path before delegation",
      cleanup:
        "cancel unfinished Task and close/reconcile Worker pane; accepted Tasks and historical Attempts remain durable",
    },
    {
      id: "agent-operations-status-read",
      domain: "agent_operations",
      executionStatus: "executable",
      tools: ["ops_status"],
      suiteCaseId: "ops-status-read",
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "ops_status", isError: false },
          count: 1,
        },
      ],
      coveragePlan:
        "Read only the aggregate Agent Operations snapshot. Task lifecycle and Worker actions remain uncovered.",
      mutation: "none",
    },
    {
      id: "authorization-and-delivery-boundary",
      domain: "authorization_delivery",
      executionStatus: "planned",
      tools: [
        "group_history_search",
        "owner_history_search",
        "owner_memory_admin",
        "media_generate",
      ],
      coveragePlan:
        "Test allowed and denied principals, context exclusion, delivery audience, and current-grant revocation.",
      mutation: "none",
    },
    {
      id: "non-mutating-domain-descriptor-probe",
      domain: "qq_read",
      executionStatus: "planned",
      tools: [
        "qq_group_history",
        "qq_group_content",
        "qq_group_files",
        "qq_group_settings",
        "qq_group_moderation",
        "qq_group_local_settings",
        "qq_group_file_ops",
      ],
      coveragePlan:
        "For descriptor changes, add operation-specific real state assertions; a provider capability probe alone is not feature acceptance.",
      mutation: "none",
    },
  ],
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function parseSource(path) {
  const source = await readFile(path, "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function variable(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  return undefined;
}

function arrayElements(declaration, sourceFile, name) {
  let initializer = declaration?.initializer;
  while (
    initializer &&
    (ts.isAsExpression(initializer) ||
      ts.isTypeAssertionExpression(initializer) ||
      ts.isSatisfiesExpression(initializer))
  )
    initializer = initializer.expression;
  if (initializer && ts.isCallExpression(initializer) && initializer.arguments.length === 1) {
    const callee = initializer.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "freeze")
      initializer = initializer.arguments[0];
  }
  while (
    initializer &&
    (ts.isAsExpression(initializer) ||
      ts.isTypeAssertionExpression(initializer) ||
      ts.isSatisfiesExpression(initializer))
  )
    initializer = initializer.expression;
  if (!initializer || !ts.isArrayLiteralExpression(initializer))
    fail(
      "DESCRIPTOR_SOURCE_UNSUPPORTED",
      `${name} is not a static array in ${sourceFile.fileName}`,
    );
  return initializer.elements;
}

function stringProperty(node, propertyName) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (key === propertyName && ts.isStringLiteral(property.initializer))
      return property.initializer.text;
  }
  return undefined;
}

function stringLiteral(node) {
  return ts.isStringLiteral(node) ? node.text : undefined;
}

function hasSpreadIdentifier(nodes, name) {
  return nodes.some(
    (node) =>
      ts.isSpreadElement(node) && ts.isIdentifier(node.expression) && node.expression.text === name,
  );
}

function hasMappedSpread(nodes, name) {
  return nodes.some((node) => {
    if (!ts.isSpreadElement(node) || !ts.isCallExpression(node.expression)) return false;
    const callee = node.expression.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "map" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === name
    );
  });
}

async function importBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const modulePath = resolve(
      dirname(sourceFile.fileName),
      `${statement.moduleSpecifier.text.replace(/\.js$/u, ".ts")}`,
    );
    for (const element of statement.importClause.namedBindings.elements) {
      bindings.set(element.name.text, {
        importedName: (element.propertyName ?? element.name).text,
        modulePath,
      });
    }
  }
  return bindings;
}

async function exportedStringConstant(modulePath, name) {
  const file = await parseSource(modulePath);
  const declaration = variable(file, name);
  const value = declaration?.initializer && stringLiteral(declaration.initializer);
  if (value === undefined)
    fail("DESCRIPTOR_SOURCE_UNSUPPORTED", `Cannot resolve static string export ${name}`);
  return value;
}

/** Read the concrete static TOOL_DESCRIPTORS composition without importing runtime code. */
export async function readImplementedToolDescriptors(repoRoot = REPO_ROOT) {
  const toolPlanePath = resolve(repoRoot, "apps/server/src/runtime/pi/tool-plane.ts");
  const toolPlane = await parseSource(toolPlanePath);
  const imports = await importBindings(toolPlane);
  const descriptorsDecl = variable(toolPlane, "TOOL_DESCRIPTORS");
  const descriptorNodes = arrayElements(descriptorsDecl, toolPlane, "TOOL_DESCRIPTORS");
  if (
    !hasMappedSpread(descriptorNodes, "QQ_CAPABILITIES") ||
    !hasSpreadIdentifier(descriptorNodes, "DOMAIN_TOOL_DESCRIPTORS") ||
    !hasSpreadIdentifier(descriptorNodes, "PI_BUILTIN_DESCRIPTORS")
  )
    fail(
      "DESCRIPTOR_SOURCE_UNSUPPORTED",
      "TOOL_DESCRIPTORS composition changed from its known static sources",
    );

  const names = [];
  const add = (name) => {
    if (!name || names.includes(name))
      fail(
        "DESCRIPTOR_SOURCE_UNSUPPORTED",
        `Invalid or duplicate static Tool descriptor: ${name ?? "<unknown>"}`,
      );
    names.push(name);
  };
  const importedConstant = async (identifier) => {
    const binding = imports.get(identifier);
    if (!binding)
      fail("DESCRIPTOR_SOURCE_UNSUPPORTED", `Unresolved descriptor constant ${identifier}`);
    return exportedStringConstant(binding.modulePath, binding.importedName);
  };

  const qqPath = resolve(repoRoot, "apps/server/src/channels/onebot/capabilities.ts");
  const qqSource = await parseSource(qqPath);
  for (const node of arrayElements(
    variable(qqSource, "QQ_CAPABILITIES"),
    qqSource,
    "QQ_CAPABILITIES",
  )) {
    const name = stringProperty(node, "tool");
    if (!name) fail("DESCRIPTOR_SOURCE_UNSUPPORTED", "QQ capability is missing a static tool name");
    add(name);
  }

  const domainNodes = arrayElements(
    variable(toolPlane, "DOMAIN_TOOL_DESCRIPTORS"),
    toolPlane,
    "DOMAIN_TOOL_DESCRIPTORS",
  );
  if (!hasSpreadIdentifier(domainNodes, "OPS_TOOL_DESCRIPTORS"))
    fail(
      "DESCRIPTOR_SOURCE_UNSUPPORTED",
      "DOMAIN_TOOL_DESCRIPTORS no longer includes the static Ops descriptor list",
    );
  for (const node of domainNodes) {
    if (ts.isSpreadElement(node)) {
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "OPS_TOOL_DESCRIPTORS")
        fail("DESCRIPTOR_SOURCE_UNSUPPORTED", "Unknown spread in DOMAIN_TOOL_DESCRIPTORS");
      const opsFile = await parseSource(
        resolve(repoRoot, "apps/server/src/runtime/pi/ops-tools.ts"),
      );
      for (const op of arrayElements(
        variable(opsFile, "OPS_TOOL_NAMES"),
        opsFile,
        "OPS_TOOL_NAMES",
      )) {
        const name = stringLiteral(op);
        if (!name)
          fail("DESCRIPTOR_SOURCE_UNSUPPORTED", "OPS_TOOL_NAMES contains a non-literal entry");
        add(name);
      }
      continue;
    }
    if (!ts.isObjectLiteralExpression(node))
      fail(
        "DESCRIPTOR_SOURCE_UNSUPPORTED",
        "DOMAIN_TOOL_DESCRIPTORS contains a non-static descriptor",
      );
    let name;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : "";
      if (key !== "name") continue;
      name =
        stringLiteral(property.initializer) ??
        (ts.isIdentifier(property.initializer)
          ? await importedConstant(property.initializer.text)
          : undefined);
    }
    add(name);
  }

  const builtins = arrayElements(
    variable(toolPlane, "GLASSBOX_HOST_EXCLUDED_PI_TOOLS"),
    toolPlane,
    "GLASSBOX_HOST_EXCLUDED_PI_TOOLS",
  );
  for (const builtin of builtins) {
    const name = stringLiteral(builtin);
    if (!name)
      fail("DESCRIPTOR_SOURCE_UNSUPPORTED", "Host-excluded Pi Tool is not a string literal");
    add(name);
  }
  return names.map((name) => ({ name }));
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertAssertions(testCase, gaps) {
  if (!nonEmptyArray(testCase.assertions)) {
    gaps.push({ code: "MISSING_EXPECTED_ASSERTION", caseId: testCase.id });
    return;
  }
  try {
    validateFeatureAssertions(testCase.assertions);
  } catch {
    gaps.push({ code: "INVALID_EXECUTION_ASSERTIONS", caseId: testCase.id });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function bindToSuiteCase(testCase, suiteCases, gaps) {
  const matches = suiteCases.filter((suiteCase) => suiteCase?.id === testCase.suiteCaseId);
  if (matches.length !== 1) {
    gaps.push({
      code: matches.length ? "SUITE_CASE_AMBIGUOUS" : "SUITE_CASE_NOT_AVAILABLE",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    return false;
  }

  const suiteCase = matches[0];
  let valid = true;
  const leasedTools = Array.isArray(suiteCase.leaseTools)
    ? suiteCase.leaseTools.map((tool) => tool?.name).filter((name) => typeof name === "string")
    : [];
  if (!leasedTools.length || leasedTools.length !== suiteCase.leaseTools.length) {
    gaps.push({
      code: "SUITE_CASE_TOOLS_REQUIRED",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    valid = false;
  }
  for (const tool of testCase.tools ?? []) {
    if (!leasedTools.includes(tool)) {
      gaps.push({
        code: "SUITE_TOOL_NOT_LEASED",
        caseId: testCase.id,
        suiteCaseId: testCase.suiteCaseId,
        tool,
      });
      valid = false;
    }
  }

  try {
    validateReadFeatureSpecs(
      { schemaVersion: 2, cases: [suiteCase] },
      {
        groups: suiteCase.chat === "private" ? [] : [{ alias: suiteCase.chat }],
      },
    );
  } catch {
    gaps.push({
      code: "SUITE_CASE_INVALID",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    valid = false;
  }
  if (
    !Array.isArray(testCase.assertions) ||
    stableJson(testCase.assertions) !== stableJson(suiteCase.featureAssertions)
  ) {
    gaps.push({
      code: "SUITE_ASSERTIONS_MISMATCH",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    valid = false;
  }
  if (testCase.mutation !== "none") {
    gaps.push({
      code: "MUTATION_EXECUTION_UNSUPPORTED",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    valid = false;
  }
  return valid;
}

/**
 * Fail-closed static coverage check. `changedTools` is supplied by the caller's diff analysis;
 * newly introduced descriptors are detected by the actual source inventory automatically.
 */
export function checkFeatureCoverage({
  catalog = FEATURE_CATALOG,
  descriptors,
  changedTools = [],
  prerequisites = [],
  executableSuiteCases = [],
} = {}) {
  const gaps = [];
  if (!Array.isArray(descriptors))
    return {
      status: "BLOCKED",
      gaps: [{ code: "DESCRIPTORS_REQUIRED" }],
      blockers: [],
    };
  if (
    !catalog ||
    catalog.schemaVersion !== 1 ||
    !Array.isArray(catalog.requiredDomains) ||
    catalog.requiredDomains.length === 0 ||
    !Array.isArray(catalog.descriptorBaseline) ||
    !Array.isArray(catalog.cases)
  ) {
    return {
      status: "BLOCKED",
      gaps: [{ code: "INVALID_CATALOG" }],
      blockers: [],
    };
  }
  if (
    catalog.requiredDomains.some((name) => typeof name !== "string" || !name.trim()) ||
    catalog.descriptorBaseline.some((name) => typeof name !== "string" || !name.trim()) ||
    new Set(catalog.descriptorBaseline).size !== catalog.descriptorBaseline.length
  ) {
    return {
      status: "BLOCKED",
      gaps: [{ code: "INVALID_CATALOG_INVENTORY" }],
      blockers: [],
    };
  }
  if (
    !Array.isArray(changedTools) ||
    !Array.isArray(prerequisites) ||
    !Array.isArray(executableSuiteCases)
  ) {
    return {
      status: "BLOCKED",
      gaps: [{ code: "INVALID_CHECK_INPUT" }],
      blockers: [],
    };
  }

  const descriptorNames = descriptors
    .map((entry) => entry?.name)
    .filter((name) => typeof name === "string");
  if (descriptorNames.length !== descriptors.length) gaps.push({ code: "INVALID_DESCRIPTOR" });
  if (new Set(descriptorNames).size !== descriptorNames.length)
    gaps.push({ code: "DUPLICATE_DESCRIPTOR" });
  const toolSet = new Set(descriptorNames);
  const cases = Array.isArray(catalog?.cases) ? catalog.cases : [];
  const seenCaseIds = new Set();
  const coveredTools = new Set();
  const fullyCoveredCases = new Set();

  for (const testCase of cases) {
    if (!testCase || typeof testCase !== "object") {
      gaps.push({ code: "INVALID_CASE" });
      continue;
    }
    if (
      !onlyKeys(
        testCase,
        new Set([
          "id",
          "domain",
          "tools",
          "executionStatus",
          "suiteCaseId",
          "assertions",
          "coveragePlan",
          "mutation",
          "fixture",
          "cleanup",
        ]),
      )
    )
      gaps.push({ code: "UNSUPPORTED_CASE_FIELD", caseId: testCase.id });
    if (typeof testCase.id !== "string" || !testCase.id.trim())
      gaps.push({ code: "CASE_ID_REQUIRED" });
    else if (seenCaseIds.has(testCase.id))
      gaps.push({ code: "DUPLICATE_CASE_ID", caseId: testCase.id });
    else seenCaseIds.add(testCase.id);
    if (!catalog.requiredDomains?.includes(testCase.domain))
      gaps.push({
        code: "UNKNOWN_DOMAIN",
        caseId: testCase.id,
        domain: testCase.domain,
      });
    if (testCase.executionStatus === "planned") {
      gaps.push({ code: "CASE_NOT_EXECUTABLE", caseId: testCase.id });
      if (typeof testCase.coveragePlan !== "string" || !testCase.coveragePlan.trim())
        gaps.push({
          code: "PLANNED_CASE_DESCRIPTION_REQUIRED",
          caseId: testCase.id,
        });
    } else if (testCase.executionStatus === "executable") {
      const suiteBound =
        typeof testCase.suiteCaseId === "string" && testCase.suiteCaseId.trim()
          ? bindToSuiteCase(testCase, executableSuiteCases, gaps)
          : false;
      if (!suiteBound && (typeof testCase.suiteCaseId !== "string" || !testCase.suiteCaseId.trim()))
        gaps.push({
          code: "SUITE_CASE_REFERENCE_REQUIRED",
          caseId: testCase.id,
        });
      const beforeAssertionGaps = gaps.length;
      assertAssertions(testCase, gaps);
      const knownCaseTools =
        Array.isArray(testCase.tools) &&
        testCase.tools.length > 0 &&
        testCase.tools.every((name) => toolSet.has(name));
      if (suiteBound && gaps.length === beforeAssertionGaps && knownCaseTools) {
        fullyCoveredCases.add(testCase);
        for (const name of testCase.tools) coveredTools.add(name);
      }
    } else {
      gaps.push({ code: "INVALID_EXECUTION_STATUS", caseId: testCase.id });
    }
    if (!MUTATION_CLASSES.has(testCase.mutation))
      gaps.push({ code: "UNKNOWN_MUTATION_CLASS", caseId: testCase.id });
    if (testCase.mutation !== "none") {
      if (typeof testCase.fixture !== "string" || !testCase.fixture.trim())
        gaps.push({ code: "MUTATION_FIXTURE_REQUIRED", caseId: testCase.id });
      if (typeof testCase.cleanup !== "string" || !testCase.cleanup.trim())
        gaps.push({ code: "MUTATION_CLEANUP_REQUIRED", caseId: testCase.id });
    }
    if (!Array.isArray(testCase.tools) || testCase.tools.length === 0)
      gaps.push({ code: "CASE_TOOLS_REQUIRED", caseId: testCase.id });
    for (const name of testCase.tools ?? []) {
      if (!toolSet.has(name)) gaps.push({ code: "UNKNOWN_TOOL", caseId: testCase.id, tool: name });
    }
  }

  const coveredDomains = [];
  for (const domain of catalog.requiredDomains ?? []) {
    const domainCases = cases.filter((testCase) => testCase?.domain === domain);
    if (domainCases.length && domainCases.every((testCase) => fullyCoveredCases.has(testCase))) {
      coveredDomains.push(domain);
    } else {
      gaps.push({ code: "MISSING_DOMAIN_COVERAGE", domain });
    }
  }
  for (const name of toolSet) {
    if (!catalog.descriptorBaseline?.includes(name) && !coveredTools.has(name))
      gaps.push({ code: "NEW_TOOL_UNCOVERED", tool: name });
  }
  for (const name of catalog.descriptorBaseline ?? []) {
    if (!toolSet.has(name)) gaps.push({ code: "BASELINE_TOOL_MISSING", tool: name });
  }
  for (const name of changedTools) {
    if (!toolSet.has(name)) gaps.push({ code: "CHANGED_TOOL_UNKNOWN", tool: name });
    else if (!coveredTools.has(name)) gaps.push({ code: "CHANGED_TOOL_UNCOVERED", tool: name });
  }

  const blockers = prerequisites
    .filter((item) => !item || item.status !== "PASS")
    .map((item) => ({
      code: "PREREQUISITE_BLOCKED",
      id: item?.id ?? null,
      status: item?.status ?? "UNKNOWN",
    }));
  return {
    status: gaps.length || blockers.length ? "BLOCKED" : "PASS",
    gaps,
    blockers,
    coveredDomains: coveredDomains.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    coveredTools: [...coveredTools].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

export async function checkRepositoryFeatureCoverage(options = {}) {
  const descriptors = await readImplementedToolDescriptors(options.repoRoot ?? REPO_ROOT);
  return checkFeatureCoverage({ ...options, descriptors });
}
