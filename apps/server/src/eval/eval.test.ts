import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AccessDeniedError } from "../auth/service.js";
import { TraceCorruptedError } from "../trace/run-store.js";
import { createRunEvaluator, RUN_INTEGRITY_SCORER_VERSION } from "./index.js";
import { evalGroup, evalOwner, openEvalFixture } from "./fixture.js";

const fixtures: Awaited<ReturnType<typeof openEvalFixture>>[] = [];
const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(join(tmpdir(), "glassbox-eval-"));
  directories.push(result);
  return result;
}
async function fixture(options: Parameters<typeof openEvalFixture>[1] = {}) {
  const result = await openEvalFixture(await directory(), options);
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of fixtures.splice(0)) await entry.close();
  for (const entry of directories.splice(0)) {
    const target = resolve(entry);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("glassbox-eval-"))
      throw new Error("Invalid disposable Eval path");
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("Run-linked integrity Eval", () => {
  it("scores actual persisted lifecycle and delivery evidence without executing or sending again", async () => {
    const current = await fixture();
    const runId = await current.run();
    const before = await readFile(current.trace.getTracePath(runId));
    const evaluator = createRunEvaluator(current);
    const result = await evaluator.evaluate(evalOwner, runId);
    expect(result).toMatchObject({
      scorerVersion: RUN_INTEGRITY_SCORER_VERSION,
      passed: true,
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
    });
    expect(result.assessment).toMatchObject({
      verdict: "pass",
      source: "stored-run-evidence",
      acceptance: "not-assessed",
      run: { id: runId, executionRef: "fake-fixture" },
      sample: { id: result.sampleId, input: { runId }, target: "run-integrity-v1" },
    });
    expect(result.assessment?.scores).toHaveLength(5);
    expect(result.assessment?.scores.every((score) => score.value === "pass")).toBe(true);
    expect(result.assessment?.trace).toEqual(
      await current.store.evidence.getTrace(evalOwner, runId),
    );
    expect(
      result.assessment?.scores.find((score) => score.id === "terminal_event")?.traceSequence,
    ).toBeGreaterThan(0);
    expect(result.observed).not.toContain("PRIVATE-PAYLOAD");
    expect(result.observed).not.toContain("PRIVATE-PROMPT");
    expect(await current.store.evidence.getEval(evalOwner, runId, result.id)).toMatchObject({
      observed: result.observed,
      expected: result.expected,
    });
    const repeated = await evaluator.evaluate(evalOwner, runId);
    expect(repeated.sampleId).not.toBe(result.sampleId);
    expect(repeated.id).not.toBe(result.id);
    const first = await evaluator.list(evalOwner, runId, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await evaluator.list(evalOwner, runId, { limit: 1, cursor: first.nextCursor! });
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set([result.id, repeated.id]),
    );
    expect(current.counts()).toEqual({ executions: 1, sends: 1 });
    expect(await readFile(current.trace.getTracePath(runId))).toEqual(before);
  });

  it.each(["unknown", "failed"] as const)(
    "preserves %s delivery observations without retry",
    async (status) => {
      const current = await fixture({ delivery: { status } });
      const runId = await current.run();
      const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
      expect(result.passed).toBe(false);
      expect(result.assessment?.verdict).toBe(status === "failed" ? "fail" : "unknown");
      expect(
        result.assessment?.scores.find((score) => score.id === "result_delivery"),
      ).toMatchObject({ value: status === "failed" ? "fail" : "unknown", observed: status });
      expect(current.counts()).toEqual({ executions: 1, sends: 1 });
    },
  );

  it("distinguishes consistent failed execution evidence from product acceptance", async () => {
    const current = await fixture({ result: { status: "failed" } });
    const runId = await current.run();
    const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
    expect(result.assessment).toMatchObject({
      verdict: "pass",
      acceptance: "not-assessed",
      run: { status: "failed" },
    });
  });

  it("keeps an unknown Run outcome unknown even with a matching terminal event", async () => {
    const current = await fixture({ result: { status: "unknown" } });
    const runId = await current.run();
    const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
    expect(result.assessment?.verdict).toBe("unknown");
    expect(result.assessment?.scores.find((score) => score.id === "run_terminal")?.value).toBe(
      "unknown",
    );
  });

  it("does not trust provider objects that imitate missing server lifecycle evidence", async () => {
    const current = await fixture({ includeEvent: (event) => event.type !== "run_finished" });
    const runId = await current.run();
    const run = await current.store.conversations.getRun(evalOwner, runId);
    await current.store.evidence.advanceTrace(
      evalOwner,
      await current.trace.append(
        runId,
        {
          type: "run_finished",
          runId,
          conversationId: run.conversationId,
          status: "succeeded",
          outputWithheld: false,
          payload: "PRIVATE-TRACE-TEXT",
        },
        "glassbox-model",
      ),
    );
    const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
    expect(result.assessment?.scores.find((score) => score.id === "terminal_event")).toMatchObject({
      value: "unknown",
      reason: "terminal_event_not_observed",
    });
    expect(result.observed).not.toContain("PRIVATE-TRACE-TEXT");
  });

  it("fails contradictory trusted terminal evidence and preserves the source file", async () => {
    const current = await fixture();
    const runId = await current.run();
    const run = await current.store.conversations.getRun(evalOwner, runId);
    await current.store.evidence.advanceTrace(
      evalOwner,
      await current.trace.append(
        runId,
        {
          type: "run_finished",
          runId,
          conversationId: run.conversationId,
          status: "failed",
          outputWithheld: false,
        },
        "glassbox-run",
      ),
    );
    const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
    expect(result.assessment?.scores.find((score) => score.id === "terminal_event")).toMatchObject({
      value: "fail",
      reason: "duplicate_terminal_events",
    });
  });

  it("pins the indexed prefix and ignores a later unindexed partial tail", async () => {
    const current = await fixture();
    const runId = await current.run();
    const indexed = await current.store.evidence.getTrace(evalOwner, runId);
    await appendFile(current.trace.getTracePath(runId), '{"unindexed":');
    const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
    expect(result.assessment?.verdict).toBe("pass");
    expect(result.assessment?.trace).toEqual(indexed);
  });

  it("records damaged indexed Trace as failed without storing filesystem diagnostics", async () => {
    const current = await fixture();
    const runId = await current.run();
    await writeFile(current.trace.getTracePath(runId), "not-json\n");
    const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
    expect(result.assessment?.scores.find((score) => score.id === "trace_index")).toMatchObject({
      value: "fail",
      reason: "indexed_events_missing",
    });
    expect(result.observed).not.toContain(current.trace.dataDirectory);
  });

  it("requires an existing index and keeps a queued observation unknown", async () => {
    const current = await fixture();
    const accepted = await current.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: evalGroup,
      messageId: "queued",
      text: "fixture",
      executionRef: "fake",
    });
    const evaluator = createRunEvaluator(current);
    await expect(evaluator.evaluate(evalOwner, accepted.run.id)).rejects.toMatchObject({
      code: "EVAL_TRACE_NOT_INDEXED",
    });
    expect((await evaluator.list(evalOwner, accepted.run.id)).items).toEqual([]);
    await current.store.evidence.advanceTrace(
      evalOwner,
      await current.trace.append(
        accepted.run.id,
        { type: "run_queued", runId: accepted.run.id, conversationId: accepted.conversation.id },
        "glassbox-run",
      ),
    );
    expect((await evaluator.evaluate(evalOwner, accepted.run.id)).assessment?.verdict).toBe(
      "unknown",
    );
    await expect(
      evaluator.evaluate(evalOwner, accepted.run.id, "invented-suite"),
    ).rejects.toMatchObject({ code: "EVAL_SUITE_NOT_FOUND" });
    expect(current.counts()).toEqual({ executions: 0, sends: 0 });
  });

  it("rejects cross-scope and revoked authority before reading any Trace", async () => {
    const current = await fixture();
    const runId = await current.run();
    const read = vi.spyOn(current.trace, "readPage");
    const evaluator = createRunEvaluator(current);
    const privateCaller = {
      ...evalOwner,
      scope: { ...evalGroup, chatType: "private" as const, chatId: "eval-owner" },
    };
    await expect(evaluator.evaluate(privateCaller, runId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(evaluator.list(privateCaller, runId)).rejects.toBeInstanceOf(AccessDeniedError);
    await current.store.authorization.revoke(current.grants.get("eval:write")!);
    await expect(evaluator.evaluate(evalOwner, runId)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(read).not.toHaveBeenCalled();
    expect((await evaluator.list(evalOwner, runId)).items).toEqual([]);
    await current.store.authorization.revoke(current.grants.get("conversation:read")!);
    await expect(evaluator.list(evalOwner, runId)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("keeps a completion concurrent with the Run snapshot unknown rather than contradictory", async () => {
    const current = await fixture();
    const accepted = await current.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: evalGroup,
      messageId: "concurrent",
      text: "fixture",
      executionRef: "fake",
    });
    const getTrace = current.store.evidence.getTrace.bind(current.store.evidence);
    vi.spyOn(current.store.evidence, "getTrace").mockImplementationOnce(async (caller, runId) => {
      await current.store.lifecycle.transitionRun(caller, runId, "queued", "running");
      await current.store.lifecycle.transitionRun(caller, runId, "running", "succeeded");
      await current.store.evidence.advanceTrace(
        caller,
        await current.trace.append(
          runId,
          {
            type: "run_finished",
            runId,
            conversationId: accepted.conversation.id,
            status: "succeeded",
            outputWithheld: false,
          },
          "glassbox-run",
        ),
      );
      return getTrace(caller, runId);
    });
    const result = await createRunEvaluator(current).evaluate(evalOwner, accepted.run.id);
    expect(result.assessment?.verdict).toBe("unknown");
    expect(result.assessment?.scores.find((score) => score.id === "terminal_event")).toMatchObject({
      value: "unknown",
      reason: "run_snapshot_incomplete",
    });
  });

  it("rechecks revocation after Trace observation and before saving", async () => {
    const current = await fixture();
    const runId = await current.run();
    const readPage = current.trace.readPage.bind(current.trace);
    vi.spyOn(current.trace, "readPage").mockImplementation(async (id, options) => {
      const page = await readPage(id, options);
      await current.store.authorization.revoke(current.grants.get("eval:write")!);
      return page;
    });
    await expect(createRunEvaluator(current).evaluate(evalOwner, runId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect((await current.store.evidence.listEvals(evalOwner, runId)).items).toEqual([]);
  });

  it("bounds large indexed observations and rechecks authority between pages", async () => {
    const current = await fixture();
    const runId = await current.run();
    const indexed = await current.store.evidence.getTrace(evalOwner, runId);
    if (!indexed) throw new Error("Fixture Trace index missing");
    const records = Array.from(
      { length: 10_000 },
      (_, offset) =>
        JSON.stringify({
          seq: indexed.eventCount + offset + 1,
          ts: "2026-01-01T00:00:00.000Z",
          event: { type: "fixture_padding" },
          provenance: "fixture",
        }) + "\n",
    ).join("");
    await appendFile(current.trace.getTracePath(runId), records);
    await current.store.evidence.advanceTrace(evalOwner, {
      ...indexed,
      eventCount: indexed.eventCount + 10_000,
      byteOffset: indexed.byteOffset + Buffer.byteLength(records),
    });
    const readPage = current.trace.readPage.bind(current.trace);
    const read = vi.spyOn(current.trace, "readPage");
    const evaluator = createRunEvaluator(current);
    const result = await evaluator.evaluate(evalOwner, runId);
    expect(result.assessment?.verdict).toBe("unknown");
    expect(result.assessment?.scores.find((score) => score.id === "trace_index")).toMatchObject({
      value: "unknown",
      reason: "trace_scan_limit",
    });
    expect(read).toHaveBeenCalledTimes(100);
    read.mockClear();
    read.mockImplementation(async (id, options) => {
      const page = await readPage(id, options);
      await current.store.authorization.revoke(current.grants.get("eval:write")!);
      return page;
    });
    await expect(evaluator.evaluate(evalOwner, runId)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await evaluator.list(evalOwner, runId)).items).toHaveLength(1);
  });

  it("retains readable old scorer rows without inventing a structured assessment", async () => {
    const current = await fixture();
    const runId = await current.run();
    const index = await current.store.evidence.getTrace(evalOwner, runId);
    await current.store.evidence.recordEval(evalOwner, {
      runId,
      sampleId: "old-sample",
      scorerVersion: "older",
      traceRef: runId,
      traceStart: 0,
      traceEnd: index!.eventCount,
      expected: "old target",
      observed: "plain observation",
      passed: false,
    });
    expect((await createRunEvaluator(current).list(evalOwner, runId)).items[0]).toMatchObject({
      assessment: null,
      observed: "plain observation",
    });
  });

  it("does not turn an unavailable Trace reader into a fabricated pass", async () => {
    const current = await fixture();
    const runId = await current.run();
    vi.spyOn(current.trace, "readPage").mockRejectedValue(new Error("SECRET-HOST-PATH"));
    const result = await createRunEvaluator(current).evaluate(evalOwner, runId);
    expect(result.assessment?.verdict).toBe("unknown");
    expect(result.observed).not.toContain("SECRET-HOST-PATH");
    vi.spyOn(current.trace, "readPage").mockRejectedValue(
      new TraceCorruptedError("SECRET-HOST-PATH"),
    );
    expect((await createRunEvaluator(current).evaluate(evalOwner, runId)).assessment?.verdict).toBe(
      "fail",
    );
  });

  it("reopens persisted samples and rescoring evidence after both child processes exit", async () => {
    const target = await directory();
    const script = fileURLToPath(new URL("./reopen-fixture.ts", import.meta.url));
    const execute = promisify(execFile);
    const created = await execute(process.execPath, ["--import", "tsx", script, "write", target], {
      timeout: 15_000,
    });
    const ids: unknown = JSON.parse(created.stdout);
    if (
      !ids ||
      typeof ids !== "object" ||
      !("runId" in ids) ||
      typeof ids.runId !== "string" ||
      !("evalId" in ids) ||
      typeof ids.evalId !== "string"
    )
      throw new Error("Invalid child fixture output");
    await execute(
      process.execPath,
      ["--import", "tsx", script, "read", target, ids.runId, ids.evalId],
      { timeout: 15_000 },
    );
  });
});
