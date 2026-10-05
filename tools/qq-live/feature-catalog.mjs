import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { HISTORY_SEED_FAMILY_ID } from "./lib/history-seed-workflow.mjs";
import { validateMemoryFamily, validateHistoryFamily } from "./lib/feature-suite.mjs";
import {
  MEMORY_FAMILY_ID,
  MEMORY_REJECT_FAMILY_ID,
  memoryWorkflow,
} from "./lib/memory-workflow.mjs";
import { validateReadFeatureSpecs } from "./lib/feature-specs.mjs";
import { validateFeatureAssertions } from "./lib/feature-observer.mjs";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

const MUTATION_CLASSES = new Set(["none", "reversible", "isolated"]);
const MEMORY_FAMILY_FIXTURE =
  "unique qqtest project; Owner private feedback, promotion and cleanup Runs";
const MEMORY_FAMILY_CLEANUP =
  "expire the exact promoted fixture; retain feedback, candidate, Memory and audit history";
const MEMORY_REJECT_FAMILY_FIXTURE =
  "unique qqtest project; Owner private feedback and rejection Runs for a pending candidate";
const MEMORY_REJECT_FAMILY_CLEANUP =
  "reject the exact pending candidate; verify rejected state and preserve feedback audit history";
const MEMORY_FAMILY_ASSERTIONS = [
  {
    kind: "trace",
    type: "tool_result",
    where: { name: "owner_memory_admin", isError: false },
    count: 1,
  },
];

/**
 * Static Tool inventory plus a bounded set of executable acceptance cases. It is not complete
 * feature or domain coverage. Group assignments and schedules remain unimplemented.
 */
export const FEATURE_CATALOG = Object.freeze({
  schemaVersion: 1,
  coverageNotice:
    "Executable cases are bounded acceptance seeds, not complete descriptor or domain coverage.",
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
      executionStatus: "executable",
      tools: ["qq_group_members"],
      suiteCaseId: "qq-group-member-count-read",
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "qq_group_members", isError: false },
          count: 1,
        },
        { kind: "aggregate_projection", tool: "qq_group_members", count: 1 },
      ],
      coveragePlan:
        "Read only group A's aggregate member count in Owner private chat. Independently verify complete Trace outputHead bytes and digest, and require its exact projection to contain only memberCount.",
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
        "Keep complete scope-isolation, Taste learning and authorization-negative cases planned. The fixed promotion and rejection families do not cover them.",
      mutation: "isolated",
      fixture: "unique project scope and qqtest nonce; Owner private Run",
      cleanup:
        "reject pending candidate or revoke/retire promoted test Memory; retain audit evidence",
    },
    {
      id: MEMORY_FAMILY_ID,
      domain: "memory_taste",
      executionStatus: "executable",
      executionKind: "memory-lifecycle",
      tools: ["owner_memory_admin"],
      suiteCaseId: MEMORY_FAMILY_ID,
      assertions: MEMORY_FAMILY_ASSERTIONS,
      coveragePlan:
        "Run the fixed Owner-private project feedback, promotion and expiration family with an isolated qqtest project and independent cleanup proof.",
      mutation: "isolated",
      fixture: MEMORY_FAMILY_FIXTURE,
      cleanup: MEMORY_FAMILY_CLEANUP,
    },
    {
      id: MEMORY_REJECT_FAMILY_ID,
      domain: "memory_taste",
      executionStatus: "executable",
      executionKind: "memory-lifecycle",
      tools: ["owner_memory_admin"],
      suiteCaseId: MEMORY_REJECT_FAMILY_ID,
      assertions: MEMORY_FAMILY_ASSERTIONS,
      coveragePlan:
        "Run the fixed Owner-private project feedback and candidate rejection family with an isolated qqtest project and independent cleanup proof.",
      mutation: "isolated",
      fixture: MEMORY_REJECT_FAMILY_FIXTURE,
      cleanup: MEMORY_REJECT_FAMILY_CLEANUP,
    },
    {
      id: "history-search-current-group",
      domain: "history_retrieval",
      executionStatus: "executable",
      tools: ["group_history_search"],
      suiteCaseId: "history-current-group-nonce",
      leaseTools: [
        {
          name: "group_history_search",
          operations: [
            {
              action: "history:read",
              resourceId: "group:{{group:A}}",
              inputConstraint: { query: "{{nonce}}", limit: 1 },
            },
          ],
        },
      ],
      assertions: [
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
            groups: ["{{group:A}}"],
            resources: ["group:{{group:A}}"],
            sourceKind: "channel_message",
            retrievalMode: "lexical",
          },
          count: 1,
        },
      ],
      coveragePlan:
        "Scope-limited read-only path check on dedicated group A. This does not prove a positive hit, absence of a match, or complete source synchronization.",
      mutation: "none",
    },
    {
      id: "history-search-owner-scoped-groups",
      domain: "history_retrieval",
      executionStatus: "executable",
      tools: ["owner_history_search"],
      suiteCaseId: "history-owner-group-a-nonce",
      leaseTools: [
        {
          name: "owner_history_search",
          operations: [
            {
              action: "history:search",
              resourceId: "owner-history",
              inputConstraint: { query: "{{nonce}}", groupIds: ["{{group:A}}"], limit: 1 },
            },
          ],
        },
      ],
      assertions: [
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
            query: "{{nonce}}",
            groups: ["{{group:A}}"],
            resources: ["group:{{group:A}}"],
            sourceKind: "channel_message",
            retrievalMode: "lexical",
          },
          count: 1,
        },
      ],
      coveragePlan:
        "Owner-private scope-limited read-only path check on dedicated group A. No group message is seeded by this suite, so a positive match is not proven.",
      mutation: "none",
    },
    {
      id: "history-current-group-complete",
      domain: "history_retrieval",
      executionStatus: "executable",
      tools: ["group_history_search"],
      suiteCaseId: "history-current-group-complete",
      leaseTools: [
        {
          name: "group_history_search",
          operations: [
            {
              action: "history:read",
              resourceId: "group:{{group:A}}",
              inputConstraint: {
                query: "{{nonce}}",
                limit: 1,
              },
            },
          ],
        },
      ],
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: {
            name: "group_history_search",
            isError: false,
          },
          count: 1,
        },
        {
          kind: "trace",
          type: "history_retrieval",
          where: {
            query: "{{nonce}}",
            groups: ["{{group:A}}"],
            resources: ["group:{{group:A}}"],
            sourceKind: "channel_message",
            retrievalMode: "lexical",
          },
          count: 1,
        },
        {
          kind: "history_coverage",
          query: "{{nonce}}",
          groupId: "{{group:A}}",
          count: 1,
        },
      ],
      coveragePlan:
        "Verify the single test group source walk and nonce search window are complete. Positive-result semantics and cross-group negatives remain separate pending acceptance.",
      mutation: "none",
    },
    {
      id: "history-owner-group-a-complete",
      domain: "history_retrieval",
      executionStatus: "executable",
      tools: ["owner_history_search"],
      suiteCaseId: "history-owner-group-a-complete",
      leaseTools: [
        {
          name: "owner_history_search",
          operations: [
            {
              action: "history:search",
              resourceId: "owner-history",
              inputConstraint: {
                query: "{{nonce}}",
                groupIds: ["{{group:A}}"],
                limit: 1,
              },
            },
          ],
        },
      ],
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: {
            name: "owner_history_search",
            isError: false,
          },
          count: 1,
        },
        {
          kind: "trace",
          type: "history_retrieval",
          where: {
            query: "{{nonce}}",
            groups: ["{{group:A}}"],
            resources: ["group:{{group:A}}"],
            sourceKind: "channel_message",
            retrievalMode: "lexical",
          },
          count: 1,
        },
        {
          kind: "history_coverage",
          query: "{{nonce}}",
          groupId: "{{group:A}}",
          count: 1,
        },
      ],
      coveragePlan:
        "Verify the single test group source walk and nonce search window are complete. Positive-result semantics and cross-group negatives remain separate pending acceptance.",
      mutation: "none",
    },
    {
      id: "history-current-group-hit",
      domain: "history_retrieval",
      executionStatus: "executable",
      tools: ["group_history_search"],
      suiteCaseId: "history-current-group-hit",
      leaseTools: [
        {
          name: "group_history_search",
          operations: [
            {
              action: "history:read",
              resourceId: "group:{{group:A}}",
              inputConstraint: {
                query: "{{nonce}}",
                limit: 1,
              },
            },
          ],
        },
      ],
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: {
            name: "group_history_search",
            isError: false,
          },
          count: 1,
        },
        {
          kind: "trace",
          type: "history_retrieval",
          where: {
            query: "{{nonce}}",
            groups: ["{{group:A}}"],
            resources: ["group:{{group:A}}"],
            sourceKind: "channel_message",
            retrievalMode: "lexical",
          },
          count: 1,
        },
        {
          kind: "history_coverage",
          query: "{{nonce}}",
          groupId: "{{group:A}}",
          count: 1,
        },
        {
          kind: "history_result",
          tool: "group_history_search",
          query: "{{nonce}}",
          groupId: "{{group:A}}",
          result: "hit",
          count: 1,
        },
      ],
      coveragePlan:
        "Verify the current group input archive record and actual protected Tool result digest.",
      mutation: "none",
    },
    {
      id: "history-owner-group-a-no-match",
      domain: "history_retrieval",
      executionStatus: "executable",
      tools: ["owner_history_search"],
      suiteCaseId: "history-owner-group-a-no-match",
      leaseTools: [
        {
          name: "owner_history_search",
          operations: [
            {
              action: "history:search",
              resourceId: "owner-history",
              inputConstraint: {
                query: "{{nonce}}",
                groupIds: ["{{group:A}}"],
                limit: 1,
              },
            },
          ],
        },
      ],
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: {
            name: "owner_history_search",
            isError: false,
          },
          count: 1,
        },
        {
          kind: "trace",
          type: "history_retrieval",
          where: {
            query: "{{nonce}}",
            groups: ["{{group:A}}"],
            resources: ["group:{{group:A}}"],
            sourceKind: "channel_message",
            retrievalMode: "lexical",
          },
          count: 1,
        },
        {
          kind: "history_coverage",
          query: "{{nonce}}",
          groupId: "{{group:A}}",
          count: 1,
        },
        {
          kind: "history_result",
          tool: "owner_history_search",
          query: "{{nonce}}",
          groupId: "{{group:A}}",
          result: "no_match",
          count: 1,
        },
      ],
      coveragePlan:
        "Verify the fresh private nonce has no matches in the complete target-group archive window and the actual protected Tool output reports no matches. This is not absence outside that archive window.",
      mutation: "none",
    },
    {
      id: HISTORY_SEED_FAMILY_ID,
      domain: "history_retrieval",
      executionStatus: "executable",
      executionKind: "history-seed",
      suiteCaseId: HISTORY_SEED_FAMILY_ID,
      tools: ["group_history_search", "owner_history_search"],
      assertions: [
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "group_history_search", isError: false },
          count: 1,
        },
        {
          kind: "trace",
          type: "tool_result",
          where: { name: "owner_history_search", isError: false },
          count: 1,
        },
      ],
      coveragePlan:
        "Verify a real group A seed and a strictly later private recall with a fixed until bound, distinct Runs, exact source identity and protected output digest. Cross-group negatives remain separate.",
      mutation: "none",
    },
    {
      id: "history-positive-and-negative-result-proof",
      domain: "history_retrieval",
      executionStatus: "planned",
      tools: ["group_history_search", "owner_history_search"],
      coveragePlan:
        "Current-input positive and fresh private no-match seeds now bind actual output digests and scoped archive evidence. Distinct older seeded messages, cross-group isolation and authorization negatives still need dedicated live scenarios before full retrieval coverage.",
      mutation: "none",
    },
    {
      id: "history-source-sync-completeness",
      domain: "history_retrieval",
      executionStatus: "planned",
      tools: ["group_history_search", "owner_history_search"],
      coveragePlan:
        "Complete-source seeds now verify the fixed single-group window. Provider failures, cursor and page bounds, and actual truncation behavior still need dedicated live scenarios and remain uncovered.",
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

function bindMemoryFamily(testCase, suiteCases, gaps) {
  let workflow;
  try {
    workflow = memoryWorkflow(testCase.suiteCaseId);
  } catch {
    gaps.push({
      code: "SUITE_CASE_NOT_AVAILABLE",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    return false;
  }
  const matches = suiteCases.filter((suiteCase) => suiteCase?.id === workflow.id);
  if (matches.length !== 1 || testCase.suiteCaseId !== workflow.id) {
    gaps.push({
      code: matches.length > 1 ? "SUITE_CASE_AMBIGUOUS" : "SUITE_CASE_NOT_AVAILABLE",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    return false;
  }

  let valid = true;
  try {
    validateMemoryFamily(matches[0]);
  } catch {
    gaps.push({
      code: "SUITE_CASE_INVALID",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    valid = false;
  }

  if (
    testCase.id !== workflow.id ||
    testCase.domain !== "memory_taste" ||
    stableJson(testCase.tools) !== stableJson(["owner_memory_admin"]) ||
    testCase.mutation !== "isolated" ||
    testCase.fixture !==
      (workflow.id === MEMORY_FAMILY_ID ? MEMORY_FAMILY_FIXTURE : MEMORY_REJECT_FAMILY_FIXTURE) ||
    testCase.cleanup !==
      (workflow.id === MEMORY_FAMILY_ID ? MEMORY_FAMILY_CLEANUP : MEMORY_REJECT_FAMILY_CLEANUP) ||
    stableJson(testCase.assertions) !== stableJson(MEMORY_FAMILY_ASSERTIONS) ||
    typeof testCase.coveragePlan !== "string" ||
    !testCase.coveragePlan.trim() ||
    testCase.leaseTools !== undefined
  ) {
    gaps.push({ code: "MEMORY_FAMILY_CATALOG_BINDING_INVALID", caseId: testCase.id });
    valid = false;
  }
  return valid;
}

function bindToSuiteCase(testCase, suiteCases, gaps, suiteConfig) {
  if (testCase.executionKind === "history-seed") {
    const matches = suiteCases.filter((c) => c?.id === HISTORY_SEED_FAMILY_ID);
    const fixed = FEATURE_CATALOG.cases.find((c) => c.id === HISTORY_SEED_FAMILY_ID);
    try {
      if (matches.length !== 1 || stableJson(testCase) !== stableJson(fixed))
        throw new Error("binding");
      validateHistoryFamily(matches[0]);
      if (!suiteConfig?.groups?.some((g) => g.alias === "A" && /^[1-9]\d{0,15}$/.test(g.id)))
        throw new Error("group");
      return true;
    } catch {
      gaps.push({ code: "HISTORY_FAMILY_CATALOG_BINDING_INVALID", caseId: testCase.id });
      return false;
    }
  }
  if (testCase.executionKind === "memory-lifecycle")
    return bindMemoryFamily(testCase, suiteCases, gaps);
  if (testCase.executionKind !== undefined) {
    gaps.push({ code: "UNSUPPORTED_EXECUTION_KIND", caseId: testCase.id });
    return false;
  }
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

  if (
    testCase.leaseTools !== undefined &&
    stableJson(testCase.leaseTools) !== stableJson(suiteCase.leaseTools)
  ) {
    gaps.push({
      code: "SUITE_LEASE_BINDING_MISMATCH",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    valid = false;
  }
  const needsGroupA = (testCase.tools ?? []).some((name) =>
    ["group_history_search", "owner_history_search", "qq_group_members"].includes(name),
  );
  if (needsGroupA && !suiteConfig) {
    gaps.push({
      code: "SUITE_CONFIG_REQUIRED",
      caseId: testCase.id,
      suiteCaseId: testCase.suiteCaseId,
    });
    valid = false;
  }

  try {
    validateReadFeatureSpecs(
      { schemaVersion: 2, cases: [suiteCase] },
      suiteConfig ?? {
        groups: suiteCase.chat === "private" ? [] : [{ alias: suiteCase.chat, id: "10001" }],
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
  suiteConfig,
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
          "executionKind",
          "suiteCaseId",
          "leaseTools",
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
          ? bindToSuiteCase(testCase, executableSuiteCases, gaps, suiteConfig)
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
    if (testCase.mutation !== "none" && testCase.executionKind !== "memory-lifecycle") {
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
