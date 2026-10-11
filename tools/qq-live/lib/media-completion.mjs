import { join } from "node:path";
import { createHash } from "node:crypto";
import { readTraceEvents } from "./product-evidence.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { fail } from "./core.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";

/** Wait for persisted terminal delivery state. This is not an acceptance receipt. */
export async function waitForMediaCompletion({ config, caseRecord, signal }, overrides = {}) {
  const io = { openReadOnlyDatabase, readTraceEvents, now: Date.now, delay, ...overrides };
  const timeout = config.mediaFixtures?.timeoutMs;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > 900000 ||
    !caseRecord?.inputBinding?.botMessageId
  )
    fail("MEDIA_COMPLETION_INPUT", "媒体完成状态缺少固定输入。", "INCONCLUSIVE");
  const scope = JSON.stringify([
    config.runtime.connectionId,
    String(config.bot.qq),
    "private",
    String(config.driver.qq),
    String(config.driver.qq),
    config.runtime.threadId ?? null,
  ]);
  const deadline = io.now() + timeout;
  let inspectedRunId;
  while (true) {
    if (signal?.aborted) fail("CANCELLED", "媒体测试已停止。", "INCONCLUSIVE");
    const db = io.openReadOnlyDatabase(join(config.runtime.dataDirectory, "glassbox.db"));
    try {
      const runs = db
        .prepare(
          "SELECT r.id,r.status FROM runs r JOIN messages m ON m.id=r.message_id WHERE m.external_id=? AND m.scope_key=?",
        )
        .all(caseRecord.inputBinding.botMessageId, scope);
      if (runs.length > 1) fail("MEDIA_RUN_AMBIGUOUS", "媒体输入对应多个 Run。", "INCONCLUSIVE");
      if (runs.length === 1) {
        const run = runs[0];
        if (["failed", "cancelled"].includes(run.status))
          fail("MEDIA_RUN_TERMINAL_FAILURE", "媒体 Run 未成功完成。", "INCONCLUSIVE");
        const deliveries = db
          .prepare("SELECT status,payload_kind FROM deliveries WHERE run_id=?")
          .all(run.id);
        if (
          deliveries.length > 2 ||
          deliveries.some((d) => ["unknown", "failed"].includes(d.status))
        )
          fail("MEDIA_DELIVERY_UNCONFIRMED", "媒体发送状态无法确认。", "INCONCLUSIVE");
        if (run.status === "succeeded" && inspectedRunId !== run.id) {
          const trace = io.readTraceEvents(
            config.runtime.checkout,
            config.runtime.dataDirectory,
            run.id,
          );
          inspectedRunId = run.id;
          if (failedGeneration(trace, run.id))
            fail(
              "MEDIA_GENERATION_FAILED",
              "媒体工具已记录生成失败，不再等待媒体到达。",
              "INCONCLUSIVE",
            );
        }
        if (
          run.status === "succeeded" &&
          deliveries.length === 2 &&
          deliveries.every((d) => d.status === "sent") &&
          deliveries.filter((d) => d.payload_kind === "result").length === 1 &&
          deliveries.filter((d) => d.payload_kind === "media_artifact").length === 1
        )
          return { runId: run.id, terminalDeliveryObserved: true };
      }
    } finally {
      db.close();
    }
    if (io.now() >= deadline)
      fail("MEDIA_COMPLETION_TIMEOUT", "媒体发送未在等待窗口内完成。", "INCONCLUSIVE");
    await io.delay(Math.min(250, deadline - io.now()), undefined, { signal });
  }
}

function failedGeneration(trace, runId) {
  if (trace?.runId !== runId || !Array.isArray(trace.events)) return false;
  const calls = new Set(
    trace.events
      .filter(
        (row) =>
          row.event?.type === "tool_call" &&
          row.event.runId === runId &&
          row.event.data?.name === "media_generate" &&
          typeof row.event.data.toolCallId === "string",
      )
      .map((row) => row.event.data.toolCallId),
  );
  return trace.events.some(({ event }) => {
    if (
      event?.type !== "tool_result" ||
      event.runId !== runId ||
      event.data?.name !== "media_generate" ||
      !calls.has(event.data.toolCallId)
    )
      return false;
    if (event.data.isError === true) return true;
    // Older runtimes returned a failure envelope as a non-error Tool result. It can stop the
    // wait, but cannot prove cleanup or authorize another generation.
    const data = event.data;
    if (
      data.outputTruncated !== false ||
      typeof data.outputHead !== "string" ||
      Buffer.byteLength(data.outputHead) !== data.outputBytes ||
      createHash("sha256").update(data.outputHead).digest("hex") !== data.outputSha256
    )
      return false;
    try {
      const result = JSON.parse(data.outputHead);
      return [
        "media_auth_missing",
        "media_quota_exhausted",
        "media_rate_limited",
        "media_capability_unavailable",
        "media_timeout",
        "media_failed",
        "media_output_too_large",
      ].includes(result?.details?.status);
    } catch {
      return false;
    }
  });
}
