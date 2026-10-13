import { LiveError } from "./core.mjs";
import { runtimeSnapshot } from "./product-evidence.mjs";
import { verifyPreRunCleanupEvidence } from "./pre-run-cleanup-evidence.mjs";

/** Cleanup evidence never establishes feature success; the fixed sent-no-ingress case can separately prove QQ delivery. */
export async function verifyPreRunCleanupReport(
  report,
  config,
  {
    readRuntime = () => runtimeSnapshot(config.runtime),
    verifyCleanup = verifyPreRunCleanupEvidence,
    clients,
  } = {},
) {
  const rejectRuntime = () => {
    const error = new LiveError(
      "RUNTIME_CHANGED",
      "清理核验期间服务进程或代码版本发生变化。",
      "INCONCLUSIVE",
    );
    error.cleanupVerified = false;
    throw error;
  };
  const before = readRuntime();
  if (!report?.runtime || JSON.stringify(report.runtime) !== JSON.stringify(before))
    rejectRuntime();
  if (report.cases?.length !== 1) {
    const error = new LiveError(
      "PRE_RUN_CLEANUP_EVIDENCE",
      "必须核验唯一的原始失败用例。",
      "INCONCLUSIVE",
    );
    error.cleanupVerified = false;
    throw error;
  }
  const receipt = await verifyCleanup({
    dataDirectory: before.dataDirectory,
    caseRecord: report.cases[0],
    config,
    clients,
  });
  if (JSON.stringify(before) !== JSON.stringify(readRuntime())) rejectRuntime();
  return {
    status: receipt.status === "CLEANUP_RECONCILED" ? "CLEANUP_RECONCILED" : "CLEANUP_VERIFIED",
    runtime: before,
    cases: [receipt],
  };
}
