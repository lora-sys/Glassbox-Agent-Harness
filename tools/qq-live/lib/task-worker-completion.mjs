import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fail } from "./core.mjs";
import { runtimeSnapshot } from "./product-evidence.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";

/** Poll only the already verified Task/Attempt/Binding; never dispatch or retry. */
export async function waitForTaskWorkerCompletion(
  { config, taskId, attemptId, bindingId, expectedRuntime, signal },
  {
    readRuntime = () => runtimeSnapshot(config.runtime),
    readState,
    now = Date.now,
    pause = (ms) => delay(ms, undefined, { signal }),
  } = {},
) {
  const invalid = (code) =>
    fail(code, "Worker 的原始绑定尚未确认完成，本轮不会重委派。", "INCONCLUSIVE");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
  if (
    ![taskId, attemptId, bindingId].every((id) => uuid.test(id ?? "")) ||
    !Number.isSafeInteger(config?.taskWorkerFixtures?.timeoutMs) ||
    config.taskWorkerFixtures.timeoutMs < 1000 ||
    config.taskWorkerFixtures.timeoutMs > 900000 ||
    !expectedRuntime
  )
    invalid("TASK_WORKER_COMPLETION_CONFIG");
  if (JSON.stringify(readRuntime()) !== JSON.stringify(expectedRuntime)) invalid("RUNTIME_CHANGED");
  let db;
  try {
    if (!readState) {
      db = openReadOnlyDatabase(join(config.runtime.dataDirectory, "glassbox.db"));
      const query = db.prepare(
        "SELECT t.id AS taskId,t.status AS taskStatus,t.active_attempt_id AS attemptId,a.status AS attemptStatus,b.id AS bindingId,b.last_observed_agent_state AS workerState FROM tasks t JOIN task_attempts a ON a.id=t.active_attempt_id AND a.task_id=t.id JOIN worker_bindings b ON b.task_attempt_id=a.id WHERE t.id=?",
      );
      readState = () => query.all(taskId);
    }
    const deadline = now() + config.taskWorkerFixtures.timeoutMs;
    while (now() < deadline) {
      if (signal?.aborted) invalid("TASK_WORKER_ABORTED");
      const rows = await readState();
      if (!Array.isArray(rows) || rows.length !== 1) invalid("TASK_WORKER_BINDING_CHANGED");
      const row = rows[0];
      if (row.taskId !== taskId || row.attemptId !== attemptId || row.bindingId !== bindingId)
        invalid("TASK_WORKER_BINDING_CHANGED");
      if (
        row.taskStatus === "REVIEW" &&
        row.attemptStatus === "review" &&
        ["idle", "done"].includes(row.workerState)
      ) {
        if (JSON.stringify(readRuntime()) !== JSON.stringify(expectedRuntime))
          invalid("RUNTIME_CHANGED");
        return { taskId, attemptId, bindingId, terminalObserved: true };
      }
      if (
        !["RUNNING", "REVIEW"].includes(row.taskStatus) ||
        !["running", "review"].includes(row.attemptStatus) ||
        !["starting", "working", "idle", "unknown", "done"].includes(row.workerState)
      )
        invalid("TASK_WORKER_TERMINAL_UNCONFIRMED");
      await pause(Math.min(500, Math.max(1, deadline - now())));
    }
    invalid("TASK_WORKER_COMPLETION_TIMEOUT");
  } finally {
    db?.close();
  }
}
