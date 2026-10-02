import { expect, it } from "vite-plus/test";
import { historyLimit, historyTimestamp, historyTimeWindow } from "./history-time.js";

it.each([
  "2026-10-01T00:30:00.123Z",
  "2026-10-01T08:30:00.123+08:00",
  "2026-09-30T17:30:00.123-07:00",
  "2026-10-01T08:30:00.123+0800",
  "2026-10-01 00:30:00.123Z",
])("normalizes supported equivalent timestamps without floating date arithmetic: %s", (value) => {
  expect(historyTimeWindow({ since: value, until: value })).toEqual({
    since: "2026-10-01T00:30:00.123Z",
    until: "2026-10-01T00:30:00.123Z",
    sinceMs: 1790814600123,
    untilMs: 1790814600123,
  });
});

it.each([
  "Thu, 01 Oct 2026 00:30:00 GMT",
  "2026-10-01",
  "1969-12-31T23:59:59.999Z",
  "+010000-01-01T00:00:00.001Z",
])("retains legacy Date.parse acceptance: %s", (value) => {
  expect(historyTimestamp(value)).toBe(Date.parse(value));
});

it.each(["", "bad", null, 123, {}, "999999-01-01"])("rejects invalid timestamps: %j", (value) => {
  expect(() => historyTimestamp(value)).toThrow("invalid_history_timestamp");
});

it("rejects reversed ranges after comparing actual instants", () => {
  expect(() =>
    historyTimeWindow({
      since: "2026-10-01T00:30:00.124Z",
      until: "2026-10-01T08:30:00.123+08:00",
    }),
  ).toThrow("invalid_history_time_range");
});

it.each([0, -1, 1.5, NaN, Infinity, 201, "1"])("rejects invalid limits: %j", (value) => {
  expect(() => historyLimit(value, 50, 200)).toThrow("invalid_history_limit");
});
