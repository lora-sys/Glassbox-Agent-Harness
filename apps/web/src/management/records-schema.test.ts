import { describe, expect, it } from "vite-plus/test";
import {
  decodeConversations,
  decodeDeliveries,
  decodeManagedRun,
  decodeManagedScope,
  decodeRunResult,
  decodeRuns,
  decodeTrace,
  RUN_STATUSES,
} from "./records-schema";

const time = "2026-09-12T01:02:03.000Z";
const scope = {
  connectionId: "qq-main",
  botId: "12345",
  chatType: "group" as const,
  chatId: "77777",
  senderId: "54321",
};
const run = {
  id: "run-1",
  conversationId: "conversation-1",
  messageId: "incoming-1",
  executionRef: "model:local",
  status: "running",
  resultText: null,
  createdAt: time,
  updatedAt: time,
};
const conversation = {
  id: "conversation-1",
  agentId: "personal",
  principalId: "owner",
  scope,
  createdAt: time,
};
const delivery = {
  id: "delivery-1",
  runId: "run-1",
  dedupKey: "result",
  destinationScopeKey: JSON.stringify(["qq-main", "12345", "group", "77777", "54321", null]),
  payloadText: "你好 <script>data</script>",
  payloadKind: "result",
  status: "unknown",
  externalId: null,
};
const indexed = { runId: "run-1", traceRef: "run-1", byteOffset: 230, eventCount: 2 };
const entry = {
  seq: 1,
  ts: time,
  provenance: "glassbox-run",
  event: { type: "run-started", runId: "run-1" },
};

describe("authorized management record schemas", () => {
  it("decodes namespaced conversation metadata without accepting chat payloads", () => {
    expect(decodeConversations({ items: [conversation], nextCursor: "opaque_cursor-1" })).toEqual({
      items: [conversation],
      nextCursor: "opaque_cursor-1",
    });
    expect(() =>
      decodeConversations({
        items: [{ ...conversation, messages: [{ text: "private" }] }],
        nextCursor: null,
      }),
    ).toThrow();
    expect(
      decodeManagedScope({
        ...scope,
        chatType: "private",
        chatId: "54321",
        threadId: "thread-local",
      }),
    ).toHaveProperty("threadId", "thread-local");
  });

  it.each(RUN_STATUSES)("preserves the real run status %s", (status) => {
    expect(decodeManagedRun({ ...run, status }).status).toBe(status);
  });

  it("decodes list scope separately from single-run results and preserves empty versus missing output", () => {
    expect(decodeRuns({ items: [{ ...run, scope }], nextCursor: null }).items[0]?.scope).toEqual(
      scope,
    );
    expect(decodeRunResult({ run: { ...run, resultText: "" } }, "run-1").resultText).toBe("");
    expect(decodeRunResult({ run }, "run-1").resultText).toBeNull();
    expect(() => decodeRunResult({ run }, "other-run")).toThrow();
    expect(() => decodeRuns({ items: [run], nextCursor: null })).toThrow();
  });

  it.each([
    { status: "finished" },
    { resultText: undefined },
    { createdAt: "not-a-date" },
    { updatedAt: "2026-99-99T00:00:00Z" },
    { apiKey: "private" },
    { id: "" },
    { resultText: "x".repeat(64001) },
  ])("rejects malformed or credential-bearing run data %j", (change) => {
    expect(() => decodeManagedRun({ ...run, ...change })).toThrow();
  });

  it("rejects invalid scope and pagination without silently inventing an empty list", () => {
    expect(() => decodeManagedScope({ ...scope, chatType: "unknown" })).toThrow();
    expect(() => decodeManagedScope({ ...scope, connectionId: "bad\nconnection" })).toThrow();
    expect(() => decodeConversations({ error: { code: "DENIED" } })).toThrow();
    expect(() =>
      decodeConversations({ items: [conversation, conversation], nextCursor: null }),
    ).toThrow();
    expect(() =>
      decodeConversations({ items: Array(101).fill(conversation), nextCursor: null }),
    ).toThrow();
    expect(() => decodeConversations({ items: [], nextCursor: "https://other.test" })).toThrow();
    expect(() => decodeConversations({ items: [], nextCursor: undefined })).toThrow();
  });

  it.each(["pending", "sending", "sent", "failed", "unknown"])(
    "keeps delivery state %s separate from run state",
    (status) => {
      const page = decodeDeliveries(
        {
          items: [{ ...delivery, status, externalId: status === "sent" ? "42" : null }],
          nextCursor: null,
        },
        "run-1",
      );
      expect(page.items[0]?.status).toBe(status);
      expect(page.items[0]?.payloadText).toBe(delivery.payloadText);
    },
  );

  it("rejects deliveries from another run or an invalid status", () => {
    expect(() => decodeDeliveries({ items: [delivery], nextCursor: null }, "other-run")).toThrow();
    expect(() =>
      decodeDeliveries(
        { items: [{ ...delivery, status: "confirmed" }], nextCursor: null },
        "run-1",
      ),
    ).toThrow();
    expect(() =>
      decodeDeliveries({ items: [{ ...delivery, token: "private" }], nextCursor: null }, "run-1"),
    ).toThrow();
  });

  it("retains sequence and index evidence while avoiding duplicate legacy items", () => {
    const value = {
      records: [entry, { ...entry, seq: 2 }],
      items: [entry],
      nextCursor: "gbxtrc_next",
      indexed,
    };
    expect(decodeTrace(value, "run-1")).toEqual({
      records: value.records,
      nextCursor: "gbxtrc_next",
      indexed,
    });
    expect(
      decodeTrace({ records: [], nextCursor: null, indexed: null }, "run-1").indexed,
    ).toBeNull();
  });

  it.each([
    { records: [entry, { ...entry, seq: 3 }] },
    { records: [{ ...entry, seq: 0 }] },
    { records: [entry], indexed: null },
    { indexed: { ...indexed, runId: "other-run" } },
    { indexed: { ...indexed, eventCount: -1 } },
    { indexed: { ...indexed, byteOffset: 0.5 } },
    { records: [{ seq: 1, ts: time, provenance: "source" }] },
    { records: [{ ...entry, ts: "bad" }] },
  ])("rejects invalid or cross-run trace evidence %j", (change) => {
    expect(() =>
      decodeTrace({ records: [entry], nextCursor: null, indexed, ...change }, "run-1"),
    ).toThrow();
  });
});
