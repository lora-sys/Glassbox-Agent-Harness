import { fail } from "./core.mjs";
import { TASTE_FAMILY_ID } from "./taste-scenario.mjs";

/** Persist an accepted family only after the independent final verifier returns PASS. */
export async function finalizeTasteFamilyAcceptance(report, verify) {
  if (!report || typeof verify !== "function")
    fail("TASTE_FAMILY_INPUT", "固定偏好全族复核缺少报告或验证器。", "INCONCLUSIVE");
  report.status = "INCONCLUSIVE";
  report.productAcceptance = { status: "INCONCLUSIVE", code: "TASTE_FAMILY_PENDING" };
  const candidate = {
    ...report,
    status: "PASS",
    productAcceptance: { status: "PASS", runtime: report.runtime },
  };
  const acceptance = await verify(candidate);
  if (acceptance?.status !== "PASS" || acceptance.familyId !== TASTE_FAMILY_ID)
    fail("TASTE_FAMILY_EVIDENCE", "固定偏好全族复核没有通过。", "INCONCLUSIVE");
  report.tasteFamilyAcceptance = acceptance;
  report.productAcceptance = {
    status: "PASS",
    acceptanceKind: "TASTE_LIFECYCLE",
    runtime: acceptance.runtime,
    familyId: TASTE_FAMILY_ID,
    stageRunIds: acceptance.stageRunIds,
  };
  report.status = "PASS";
  return acceptance;
}

export function tasteFixtureCheckpointRemovable(report) {
  return Boolean(
    report?.status === "PASS" &&
    report?.productAcceptance?.status === "PASS" &&
    report?.tasteLifecycle?.requiresReconciliation === false &&
    report?.tasteLifecycle?.status === "PASS",
  );
}
