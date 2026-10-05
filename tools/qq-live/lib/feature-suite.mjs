import { fail } from "./core.mjs";
import { memoryFixtureStep } from "./memory-scenario.mjs";
import { resolveReadFeatureSpecs } from "./feature-specs.mjs";
import { MEMORY_FAMILY_ID, memoryWorkflow } from "./memory-workflow.mjs";

export { MEMORY_FAMILY_ID, MEMORY_REJECT_FAMILY_ID } from "./memory-workflow.mjs";

function memoryPlanSpec(stage, nonce) {
  const placeholder = "0".repeat(32);
  const spec = memoryFixtureStep(stage, {
    nonce,
    candidateId: `candidate_${nonce}`,
    memoryId: `memory_${nonce}`,
  });
  return JSON.parse(
    JSON.stringify(spec)
      .replaceAll(`candidate_${placeholder}`, "{{candidate_id}}")
      .replaceAll(`memory_${placeholder}`, "{{memory_id}}")
      .replaceAll(`qqtest-${placeholder}`, "qqtest-{{fixture_nonce}}"),
  );
}

/** Return the fixed three-stage plan for display. This does not execute the family. */
export function memoryFamilyPlan(familyId = MEMORY_FAMILY_ID) {
  const contract = memoryWorkflow(familyId);
  const placeholder = "0".repeat(32);
  return {
    schemaVersion: 3,
    scenario: "memory-lifecycle",
    stages: contract.stages.map((stage) => ({
      stage,
      spec: memoryPlanSpec(stage, placeholder),
    })),
    cleanup:
      contract.cleanupStatus === "expired"
        ? "expire the exact promoted fixture; retain feedback, candidate, Memory and audit history"
        : "reject the exact pending candidate; retain feedback, candidate and audit history",
  };
}

export function validateMemoryFamily(value) {
  const contract = memoryWorkflow(value?.id);
  const keys = ["id", "kind", "workflow", "chat"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    keys.some((key) => !Object.hasOwn(value, key) || value[key] !== contract[key])
  )
    fail("FEATURE_MEMORY_FAMILY", "Memory family must match a fixed workflow definition.");
  return value;
}

function uniqueCaseIds(cases) {
  if (!Array.isArray(cases) || cases.length === 0)
    fail("FEATURE_SUITE", "Feature suite needs at least one case.");
  const ids = new Set();
  for (const item of cases) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id)
      fail("FEATURE_CASE", "Feature suite case identity is invalid.");
    if (ids.has(item.id)) fail("FEATURE_CASE", "Feature suite case IDs must be unique.");
    ids.add(item.id);
  }
}

/** Resolve schema 2 reads or schema 3 with one or both fixed Memory families and optional reads. */
export function resolveFeatureSuite(raw, config) {
  if (raw?.schemaVersion === 2) {
    const readCases = resolveReadFeatureSpecs(raw, config);
    return { cases: readCases, readCases, memoryFamilies: [] };
  }
  if (raw?.schemaVersion !== 3)
    fail("FEATURE_SUITE", "Feature suite schemaVersion must be 2 or 3.");
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 2 ||
    !Object.hasOwn(raw, "schemaVersion") ||
    !Object.hasOwn(raw, "cases")
  )
    fail("FEATURE_SUITE", "Schema 3 accepts only schemaVersion and cases.");

  uniqueCaseIds(raw.cases);
  const families = raw.cases.filter((item) => item.kind === "memory-lifecycle");
  if (families.length < 1 || families.length > 2)
    fail("FEATURE_MEMORY_FAMILY", "Schema 3 requires one or both fixed Memory families.");
  families.forEach(validateMemoryFamily);
  const readTemplates = raw.cases.filter((item) => !families.includes(item));
  const readCases = readTemplates.length
    ? resolveReadFeatureSpecs({ schemaVersion: 2, cases: readTemplates }, config)
    : [];
  const resolvedReads = new Map(readCases.map((item) => [item.id, item]));
  return {
    cases: raw.cases.map((item) => (families.includes(item) ? item : resolvedReads.get(item.id))),
    readCases,
    memoryFamilies: families,
  };
}
