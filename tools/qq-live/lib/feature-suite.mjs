import { fail } from "./core.mjs";
import { memoryFixtureStep } from "./memory-scenario.mjs";
import { resolveReadFeatureSpecs } from "./feature-specs.mjs";

export const MEMORY_FAMILY_ID = "memory-project-promote-expire";

const MEMORY_FAMILY = Object.freeze({
  id: MEMORY_FAMILY_ID,
  kind: "memory-lifecycle",
  workflow: "promote-expire",
  chat: "private",
});

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
export function memoryFamilyPlan() {
  const placeholder = "0".repeat(32);
  return {
    schemaVersion: 3,
    scenario: "memory-lifecycle",
    stages: ["feedback", "promote", "expire"].map((stage) => ({
      stage,
      spec: memoryPlanSpec(stage, placeholder),
    })),
    cleanup:
      "expire the exact promoted fixture; retain feedback, candidate, Memory and audit history",
  };
}

export function validateMemoryFamily(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(MEMORY_FAMILY).some(
      (key) => !Object.hasOwn(value, key) || value[key] !== MEMORY_FAMILY[key],
    )
  )
    fail("FEATURE_MEMORY_FAMILY", "Memory family must match the fixed promote-expire definition.");
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

/** Resolve schema 2 reads or schema 3 with exactly one fixed Memory family and optional reads. */
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
  if (families.length !== 1)
    fail("FEATURE_MEMORY_FAMILY", "Schema 3 requires exactly one fixed Memory family.");
  const family = validateMemoryFamily(families[0]);
  const readTemplates = raw.cases.filter((item) => item !== families[0]);
  const readCases = readTemplates.length
    ? resolveReadFeatureSpecs({ schemaVersion: 2, cases: readTemplates }, config)
    : [];
  const resolvedReads = new Map(readCases.map((item) => [item.id, item]));
  return {
    cases: raw.cases.map((item) => (item === families[0] ? family : resolvedReads.get(item.id))),
    readCases,
    memoryFamilies: [family],
  };
}
