import { describe, expect, it } from "vitest";
import { isWatchSnapshotReady, parseTraceSnapshot } from "../../../scripts/inspect-trace-lines.mts";

describe("parseTraceSnapshot", () => {
  it("retries a half-written final line without losing complete entries", () => {
    const first = '{"seq":1}\n{"seq":2';
    expect(parseTraceSnapshot<{ seq: number }>(first)).toEqual({
      events: [{ seq: 1 }],
      hasIncompleteTail: true,
    });
    expect(parseTraceSnapshot<{ seq: number }>(first + "}\n")).toEqual({
      events: [{ seq: 1 }, { seq: 2 }],
      hasIncompleteTail: false,
    });
  });

  it("rejects a malformed completed line", () => {
    expect(() => parseTraceSnapshot("{bad}\n")).toThrow("Invalid trace JSONL line 1");
  });

  it("waits for the first complete event before marking a run as seen", () => {
    expect(isWatchSnapshotReady(parseTraceSnapshot(""))).toBe(false);
    expect(isWatchSnapshotReady(parseTraceSnapshot('{"seq":1'))).toBe(false);
    expect(isWatchSnapshotReady(parseTraceSnapshot('{"seq":1}\n'))).toBe(true);
  });
});
