import { fail } from "./core.mjs";

export const MEMORY_FAMILY_ID = "memory-project-promote-expire";
export const MEMORY_REJECT_FAMILY_ID = "memory-project-feedback-reject";

const CONTRACTS = Object.freeze({
  [MEMORY_FAMILY_ID]: Object.freeze({
    id: MEMORY_FAMILY_ID,
    kind: "memory-lifecycle",
    workflow: "promote-expire",
    chat: "private",
    stages: Object.freeze(["feedback", "promote", "expire"]),
    cleanupStatus: "expired",
    checkpointVersion: 2,
  }),
  [MEMORY_REJECT_FAMILY_ID]: Object.freeze({
    id: MEMORY_REJECT_FAMILY_ID,
    kind: "memory-lifecycle",
    workflow: "feedback-reject",
    chat: "private",
    stages: Object.freeze(["feedback", "reject"]),
    cleanupStatus: "rejected",
    checkpointVersion: 3,
  }),
});

export function memoryWorkflow(familyId = MEMORY_FAMILY_ID) {
  if (!Object.hasOwn(CONTRACTS, familyId))
    fail("FEATURE_MEMORY_FAMILY", "Memory family is not a supported fixed workflow.");
  return CONTRACTS[familyId];
}
