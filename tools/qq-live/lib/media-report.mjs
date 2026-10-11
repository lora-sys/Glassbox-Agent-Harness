import { isDeepStrictEqual as same } from "node:util";
import { fail } from "./core.mjs";
import { MEDIA_FAMILY_ID, mediaFamilyPlan } from "./media-scenario.mjs";
import { verifyMediaCase } from "./media-product-evidence.mjs";
import { validateMediaWorkflowEvidence } from "./media-workflow.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const bad = () =>
  fail("MEDIA_REPORT_EVIDENCE", "Historical media evidence is inconclusive.", "INCONCLUSIVE");

/** Recheck retained image/video evidence. This never generates, delivers, or rewrites evidence. */
export async function verifyMediaHistoricalReport(
  { report, config, clients, expectedRuntime, approvedSuiteSha256 },
  { verifyCase = verifyMediaCase } = {},
) {
  try {
    if (
      !expectedRuntime ||
      !/^[a-f0-9]{40}$/u.test(expectedRuntime.commit ?? "") ||
      !Number.isSafeInteger(expectedRuntime.pid) ||
      expectedRuntime.pid < 1 ||
      typeof expectedRuntime.checkout !== "string" ||
      !expectedRuntime.checkout ||
      typeof expectedRuntime.dataDirectory !== "string" ||
      !expectedRuntime.dataDirectory ||
      expectedRuntime.dataDirectory !== config?.runtime?.dataDirectory ||
      !SHA.test(approvedSuiteSha256 ?? "") ||
      report?.suiteSha256 !== approvedSuiteSha256 ||
      report.mode !== "run" ||
      report.status !== "PASS" ||
      !same(report.runtime, expectedRuntime) ||
      !same(report.productAcceptance?.runtime, expectedRuntime) ||
      report.productAcceptance?.status !== "PASS" ||
      report.productAcceptance.cleanupVerified !== true ||
      report.plannedCaseCount !== 2 ||
      report.executedCaseCount !== 2 ||
      !Array.isArray(report.cases) ||
      report.cases.length !== 2 ||
      !Array.isArray(report.productAcceptance.cases) ||
      report.productAcceptance.cases.length !== 2 ||
      report.mediaFamilyAcceptance?.familyId !== MEDIA_FAMILY_ID ||
      typeof verifyCase !== "function" ||
      !config?.runtime ||
      !clients?.bot ||
      !clients?.driver
    )
      bad();
    const verified = [];
    const stages = [];
    let previousCreatedAt = -Infinity;
    for (const [index, { stage, spec }] of mediaFamilyPlan().stages.entries()) {
      const c = report.cases[index];
      const recorded = report.productAcceptance.cases[index];
      if (
        c.id !== spec.id ||
        recorded.caseId !== spec.id ||
        c.mediaObservationClosed !== true ||
        c.mediaObservationOverflow === true ||
        !Array.isArray(c.mediaObservations) ||
        c.mediaObservations.length !== 1
      )
        bad();
      const fresh = await verifyCase({
        stage,
        caseRecord: c,
        config,
        clients,
        expectedRuntime,
        mediaObservations: { candidates: c.mediaObservations, overflow: false },
      });
      const createdAt = Date.parse(fresh.runCreatedAt);
      if (
        !Number.isFinite(createdAt) ||
        createdAt <= previousCreatedAt ||
        !fresh.messageBinding?.input ||
        c.runId !== fresh.runId
      )
        bad();
      for (const key of [
        "status",
        "stage",
        "runId",
        "asset",
        "receiverBinding",
        "cleanupVerified",
        "actualQqDeliveryVerified",
      ])
        if (!same(recorded[key], fresh[key])) bad();
      for (const key of ["runCreatedAt", "messageBinding"])
        if (Object.hasOwn(recorded, key) && !same(recorded[key], fresh[key])) bad();
      previousCreatedAt = createdAt;
      verified.push({ transportCase: c, mediaAcceptance: fresh });
      stages.push({
        stage,
        runId: fresh.runId,
        runCreatedAt: fresh.runCreatedAt,
        messageBinding: fresh.messageBinding,
        asset: fresh.asset,
      });
    }
    const family = validateMediaWorkflowEvidence(verified);
    if (!same(family, report.mediaFamilyAcceptance)) bad();
    return {
      ...family,
      runtime: expectedRuntime,
      cleanupVerified: true,
      actualQqDeliveryVerified: true,
      stages,
    };
  } catch {
    bad();
  }
}
