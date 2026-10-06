import { fail } from "./core.mjs";

const TOOL = "owner_memory_admin";
export const TASTE_FAMILY_ID = "taste-project-feedback-lifecycle";
const NONCE = /^[a-f0-9]{32}$/;
const CANDIDATE_ID = /^candidate_[a-f0-9]{32}$/;
const MEMORY_ID = /^memory_[a-f0-9]{32}$/;

export function tasteFixtureProject(nonce) {
  if (!NONCE.test(nonce ?? "")) fail("TASTE_FIXTURE_NONCE", "偏好测试需要唯一的 32 位本轮编号。");
  return `qqtest-${nonce}`;
}

export function tasteFixtureStatement(nonce) {
  tasteFixtureProject(nonce);
  return `qqtest-taste-${nonce}`;
}

/** Fixed Owner-private Taste lifecycle steps. IDs come from the independent readonly observer. */
export function tasteFixtureStep(stage, fixture) {
  const nonce = fixture?.nonce;
  const projectId = tasteFixtureProject(nonce);
  const statement = tasteFixtureStatement(nonce);
  let command;
  let input;
  let action;

  if (stage === "feedback" || stage === "negative-feedback") {
    const signalType = stage === "feedback" ? "explicit_positive" : "explicit_negative";
    command = `/memory feedback project:${projectId} ${signalType} ${statement}`;
    input = {
      action: "feedback",
      scopeType: "project",
      projectId,
      signalType,
      statement,
    };
    action = "memory:write";
  } else if (stage === "promote") {
    if (!CANDIDATE_ID.test(fixture?.candidateId ?? ""))
      fail("TASTE_FIXTURE_ID", "治理步骤需要独立核对的待审偏好候选 ID。");
    command = `/memory promote ${fixture.candidateId}`;
    input = { action: "promote", id: fixture.candidateId };
    action = "memory:govern";
  } else if (stage === "retire") {
    if (!CANDIDATE_ID.test(fixture?.correctionCandidateId ?? ""))
      fail("TASTE_FIXTURE_ID", "退役步骤需要独立核对的修正候选 ID。");
    if (!MEMORY_ID.test(fixture?.memoryId ?? ""))
      fail("TASTE_FIXTURE_ID", "退役步骤需要独立核对的偏好记录 ID。");
    command = `/memory promote ${fixture.correctionCandidateId}`;
    input = { action: "promote", id: fixture.correctionCandidateId };
    action = "memory:govern";
  } else if (stage === "reject-candidate" || stage === "reject-correction") {
    const candidateId =
      stage === "reject-candidate" ? fixture?.candidateId : fixture?.correctionCandidateId;
    if (!CANDIDATE_ID.test(candidateId ?? ""))
      fail("TASTE_FIXTURE_ID", "恢复步骤需要独立核对的待审候选 ID。");
    command = `/memory reject ${candidateId}`;
    input = { action: "reject", id: candidateId };
    action = "memory:govern";
  } else if (stage === "expire-original") {
    if (!MEMORY_ID.test(fixture?.memoryId ?? ""))
      fail("TASTE_FIXTURE_ID", "恢复步骤需要独立核对的偏好记录 ID。");
    command = `/memory expire ${fixture.memoryId}`;
    input = { action: "expire", id: fixture.memoryId };
    action = "memory:govern";
  } else {
    fail("TASTE_FIXTURE_STAGE", "该偏好测试步骤未实现。");
  }

  return {
    id: `taste-${stage}`,
    chat: "private",
    prompt: `${command}\n请在回复中包含本轮测试编号 {{nonce}}。`,
    expectContains: ["{{nonce}}"],
    sideEffect: "acceptance_fixture",
    leaseTools: [
      {
        name: TOOL,
        operations: [{ action, resourceId: "owner-memory", inputConstraint: input }],
      },
    ],
    featureAssertions: [
      { kind: "trace", type: "tool_result", where: { name: TOOL, isError: false }, count: 1 },
    ],
  };
}

export function tasteFamilyPlan() {
  const nonce = "0".repeat(32);
  return {
    familyId: TASTE_FAMILY_ID,
    workflow: "project-positive-feedback-promote-negative-feedback-retire",
    scope: { type: "project", projectId: `qqtest-${nonce}` },
    stages: ["feedback", "promote", "negative-feedback", "retire"].map((stage) => {
      const fixture = {
        nonce,
        candidateId: `candidate_${"1".repeat(32)}`,
        memoryId: `memory_${"2".repeat(32)}`,
        correctionCandidateId: `candidate_${"3".repeat(32)}`,
      };
      const spec = tasteFixtureStep(stage, fixture);
      return {
        id: spec.id,
        prompt: spec.prompt,
        route: "private",
        tool: TOOL,
        action: spec.leaseTools[0].operations[0].action,
        inputConstraint: spec.leaseTools[0].operations[0].inputConstraint,
      };
    }),
    recovery: ["reject-candidate", "reject-correction", "expire-original"],
    cleanup:
      "Only the nonce-scoped pending candidates and preference Memory are eligible for recovery.",
    coverage:
      "This is a fixed fixture lifecycle. It does not establish general Memory or Taste retrieval coverage.",
  };
}
