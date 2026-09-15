import { describe, expect, it } from "vite-plus/test";
import { RUN_INTEGRITY_SUITE } from "@glassbox/contracts";
import { decodeEvalPage, decodeEvalResult, decodeEvaluation } from "./eval-schema";

const evaluation = {
  id: "eval-1",
  runId: "run-1",
  sampleId: "sample-1",
  scorerVersion: "run-integrity-v1.0",
  traceRef: "run-1",
  traceStart: 0,
  traceEnd: 2,
  expected: "Expected evidence",
  observed: "Observed evidence",
  passed: false,
  inputTokens: null,
  outputTokens: null,
  durationMs: null,
  createdAt: "2026-09-12T01:02:03.000Z",
  assessment: {
    suiteId: RUN_INTEGRITY_SUITE,
    source: "stored-run-evidence",
    acceptance: "not-assessed",
    verdict: "unknown",
    sample: {
      id: "sample-1",
      input: { runId: "run-1", messageId: "message-1" },
      target: RUN_INTEGRITY_SUITE,
    },
    run: {
      id: "run-1",
      conversationId: "conversation-1",
      executionRef: "claude-code",
      status: "unknown",
    },
    trace: { runId: "run-1", traceRef: "run-1", byteOffset: 200, eventCount: 2 },
    scores: [
      "run_terminal",
      "trace_index",
      "terminal_event",
      "ack_delivery",
      "result_delivery",
      "result_delivery_event",
    ].map((id) => ({
      id,
      value: "unknown",
      expected: "evidence",
      observed: "unknown",
      reason: "No complete evidence",
      traceSequence: 2,
    })),
  },
};
describe("bounded stored-evidence evaluations", () => {
  it("preserves unknown judgments and missing measurements without treating them as zero", () => {
    const parsed = decodeEvalResult({ evaluation }, "run-1");
    expect(parsed.inputTokens).toBeNull();
    expect(parsed.durationMs).toBeNull();
    expect(parsed.assessment?.verdict).toBe("unknown");
    expect(parsed.assessment?.acceptance).toBe("not-assessed");
    expect(decodeEvalPage({ items: [evaluation], nextCursor: null }, "run-1").items).toEqual([
      parsed,
    ]);
  });
  it("supports old stored records without pretending to reconstruct a new assessment", () => {
    const parsed = decodeEvaluation(
      { ...evaluation, assessment: null, inputTokens: 0, outputTokens: 21, durationMs: 500 },
      "run-1",
    );
    expect(parsed.assessment).toBeNull();
    expect(parsed.inputTokens).toBe(0);
  });
  it("rejects cross-run evidence, unsupported real-acceptance claims and inconsistent pass results", () => {
    expect(() => decodeEvaluation(evaluation, "other-run")).toThrow();
    expect(() =>
      decodeEvaluation(
        {
          ...evaluation,
          assessment: {
            ...evaluation.assessment,
            trace: { ...evaluation.assessment.trace, runId: "other-run" },
          },
        },
        "run-1",
      ),
    ).toThrow();
    expect(() =>
      decodeEvaluation(
        { ...evaluation, assessment: { ...evaluation.assessment, acceptance: "passed" } },
        "run-1",
      ),
    ).toThrow();
    expect(() => decodeEvaluation({ ...evaluation, passed: true }, "run-1")).toThrow();
    expect(() =>
      decodeEvaluation(
        { ...evaluation, assessment: { ...evaluation.assessment, suiteId: "live-qq" } },
        "run-1",
      ),
    ).toThrow();
  });
  it.each([
    { inputTokens: -1 },
    { outputTokens: 0.5 },
    { durationMs: undefined },
    { traceStart: 3 },
    { passed: "yes" },
  ])("rejects invalid measurements and bounds %j", (change) => {
    expect(() => decodeEvaluation({ ...evaluation, ...change }, "run-1")).toThrow();
  });
  it("rejects duplicate or invalid per-check judgments", () => {
    const score = evaluation.assessment.scores[0]!;
    for (const scores of [
      [score, score],
      [{ ...score, value: "success" }],
      [{ ...score, id: "made-up" }],
      [{ ...score, traceSequence: 0 }],
    ])
      expect(() =>
        decodeEvaluation(
          { ...evaluation, assessment: { ...evaluation.assessment, scores } },
          "run-1",
        ),
      ).toThrow();
  });
});
