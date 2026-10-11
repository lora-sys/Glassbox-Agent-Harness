import assert from "node:assert/strict";
import test from "node:test";
import { readMediaTrace } from "../lib/media-product-evidence.mjs";

const runId = "12345678-1234-4234-8234-123456789abc";

function traceRows() {
  return [
    {
      seq: 1,
      ts: "2026-10-08T00:00:00.000Z",
      provenance: "pi",
      event: { type: "session_start", runId, sessionId: "session-1" },
    },
    {
      seq: 2,
      ts: "2026-10-08T00:00:00.001Z",
      provenance: "glassbox-media",
      event: {
        type: "media_generation_completed",
        provider: "agnes",
        mediaType: "image",
        assetIds: ["fedcba98-7654-4321-8765-abcdefabcdef"],
      },
    },
  ];
}

function read(rows = traceRows()) {
  const output = JSON.stringify({
    runId,
    summary: { events: rows.length },
    integrity: { malformed: 0, seqGaps: [] },
    events: rows,
  });
  return readMediaTrace("/fixture/checkout", "/fixture/data", runId, () => output);
}

test("maps actual Trace envelope sequence and provenance without inventing completion fields", () => {
  const rows = traceRows();
  const trace = read(rows);

  assert.equal(trace.rows[1].event.runId, undefined);
  assert.deepEqual(
    trace.events.map(({ runId: mappedRunId, seq, provenance }) => ({
      runId: mappedRunId,
      seq,
      provenance,
    })),
    [
      { runId, seq: 1, provenance: "pi" },
      { runId, seq: 2, provenance: "glassbox-media" },
    ],
  );
  assert.equal(trace.events[1].type, "media_generation_completed");
});

test("rejects event fields that conflict with their selected Trace envelope", () => {
  const mutations = [
    (rows) => {
      rows[0].event.runId = "other-run";
    },
    (rows) => {
      rows[0].event.seq = 99;
    },
    (rows) => {
      rows[1].event.provenance = "untrusted-source";
    },
    (rows) => {
      rows[1].provenance = "";
    },
    (rows) => {
      rows[1].seq = "2";
    },
  ];

  for (const mutate of mutations) {
    const rows = traceRows();
    mutate(rows);
    assert.throws(() => read(rows), { code: "MEDIA_TRACE_EVIDENCE" });
  }
});
