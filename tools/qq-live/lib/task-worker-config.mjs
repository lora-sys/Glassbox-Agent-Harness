import { isAbsolute, resolve } from "node:path";
import { fail } from "./core.mjs";

/** The target is supplied only by protected local configuration. */
export function taskWorkerFixtureConfig(config) {
  const value = config?.taskWorkerFixtures;
  if (!value || value.enabled !== true || value.retainAuditConfirmed !== true)
    fail("TASK_WORKER_FIXTURE_DISABLED", "请明确启用专用 Worker 测试并确认保留审计。");
  if (
    Object.keys(value).sort().join(",") !==
      "agentKind,canonicalRoot,enabled,herdrSession,markerSha256,productWorkspaceId,retainAuditConfirmed,timeoutMs,workspaceId" ||
    typeof value.canonicalRoot !== "string" ||
    !isAbsolute(value.canonicalRoot) ||
    resolve(value.canonicalRoot) !== value.canonicalRoot ||
    !/^[a-f0-9]{64}$/u.test(value.markerSha256 ?? "") ||
    [value.workspaceId, value.productWorkspaceId, value.herdrSession].some(
      (id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id),
    ) ||
    value.agentKind !== "pi" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1000 ||
    value.timeoutMs > 900000
  )
    fail("TASK_WORKER_FIXTURE_CONFIG", "专用 Worker 测试配置不完整或无效。");
  return structuredClone(value);
}
