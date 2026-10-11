import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { waitForMediaCompletion } from "../lib/media-completion.mjs";

function fixture(states) {
  let clock = 0,
    index = 0,
    closed = 0;
  const config = {
    runtime: { connectionId: "fixture", dataDirectory: "/unused", threadId: null },
    bot: { qq: "10001" },
    driver: { qq: "10002" },
    mediaFixtures: { timeoutMs: 1000 },
  };
  const calls = [];
  return {
    input: { config, caseRecord: { inputBinding: { botMessageId: "123" } } },
    io: {
      readTraceEvents: () => ({ runId: "run-fixture", events: [] }),
      now: () => clock,
      delay: async (ms) => {
        clock += ms;
        index++;
      },
      openReadOnlyDatabase: () => {
        const state = states[Math.min(index, states.length - 1)];
        return {
          prepare: (sql) => ({
            all: (...args) => {
              calls.push({ sql, args });
              return sql.includes("JOIN messages") ? state.runs : state.deliveries;
            },
          }),
          close: () => {
            closed++;
          },
        };
      },
    },
    calls,
    closed: () => closed,
  };
}
const ready = {
  runs: [{ id: "run-fixture", status: "succeeded" }],
  deliveries: [
    { payload_kind: "result", status: "sent" },
    { payload_kind: "media_artifact", status: "sent" },
  ],
};
test("media wait observes persisted completion instead of treating a text reply as delivery", async () => {
  const f = fixture([
    { runs: [], deliveries: [] },
    { ...ready, deliveries: ready.deliveries.map((d) => ({ ...d, status: "sending" })) },
    ready,
  ]);
  assert.deepEqual(await waitForMediaCompletion(f.input, f.io), {
    runId: "run-fixture",
    terminalDeliveryObserved: true,
  });
  assert.equal(f.closed(), 3);
  assert.deepEqual(f.calls[0].args, ["123", '["fixture","10001","private","10002","10002",null]']);
});
test("media wait refuses ambiguous, failed, unknown, or extra deliveries", async () => {
  for (const state of [
    { ...ready, runs: [...ready.runs, ...ready.runs] },
    { ...ready, runs: [{ id: "run-fixture", status: "failed" }] },
    { ...ready, deliveries: ready.deliveries.map((d) => ({ ...d, status: "unknown" })) },
    { ...ready, deliveries: [...ready.deliveries, ready.deliveries[0]] },
  ]) {
    const f = fixture([state]);
    await assert.rejects(waitForMediaCompletion(f.input, f.io), (e) => e.status === "INCONCLUSIVE");
    assert.equal(f.closed(), 1);
  }
});
test("media wait times out on incomplete state and respects cancellation", async () => {
  const f = fixture([{ runs: [], deliveries: [] }]);
  await assert.rejects(waitForMediaCompletion(f.input, f.io), { code: "MEDIA_COMPLETION_TIMEOUT" });
  const signal = AbortSignal.abort();
  await assert.rejects(waitForMediaCompletion({ ...f.input, signal }, f.io), { code: "CANCELLED" });
});

test("terminal failed media evidence ends the wait before the media timeout", async () => {
  const outputHead = JSON.stringify({ details: { status: "media_rate_limited" } });
  for (const data of [
    { isError: true },
    {
      isError: false,
      outputHead,
      outputTruncated: false,
      outputBytes: Buffer.byteLength(outputHead),
      outputSha256: createHash("sha256").update(outputHead).digest("hex"),
    },
  ]) {
    const f = fixture([{ ...ready, deliveries: [ready.deliveries[0]] }]);
    f.io.readTraceEvents = () => ({
      runId: "run-fixture",
      events: [
        {
          event: {
            type: "tool_call",
            runId: "run-fixture",
            data: { name: "media_generate", toolCallId: "media-1" },
          },
        },
        {
          event: {
            type: "tool_result",
            runId: "run-fixture",
            data: { name: "media_generate", toolCallId: "media-1", ...data },
          },
        },
      ],
    });
    await assert.rejects(waitForMediaCompletion(f.input, f.io), {
      code: "MEDIA_GENERATION_FAILED",
    });
    assert.equal(f.closed(), 1);
    assert.equal(f.io.now(), 0);
  }
});

test("an unrelated Tool failure does not classify the current media generation", async () => {
  const f = fixture([{ ...ready, deliveries: [ready.deliveries[0]] }]);
  f.io.readTraceEvents = () => ({
    runId: "run-fixture",
    events: [
      {
        event: {
          type: "tool_call",
          runId: "other-run",
          data: { name: "media_generate", toolCallId: "media-1" },
        },
      },
      {
        event: {
          type: "tool_result",
          runId: "other-run",
          data: { name: "media_generate", toolCallId: "media-1", isError: true },
        },
      },
    ],
  });
  await assert.rejects(waitForMediaCompletion(f.input, f.io), { code: "MEDIA_COMPLETION_TIMEOUT" });
});
