import { expect, it } from "vitest";
import { parseLiveConversations, parseLiveRuns, parseLiveTrace } from "./live-contract";

const scope = {
  connectionId: "onebot-main",
  botId: "bot",
  chatType: "private",
  chatId: "owner",
  senderId: "owner",
};

it("accepts the server items/nextCursor envelope and sparse Conversation records", () => {
  expect(
    parseLiveConversations({
      items: [
        {
          id: "conversation-1",
          agentId: "agent",
          principalId: "owner",
          scope,
          createdAt: "2026-09-29T00:00:00Z",
        },
      ],
      nextCursor: null,
    }).items[0],
  ).toMatchObject({ id: "conversation-1", scope: { chatType: "private" } });
  expect(() => parseLiveConversations({ conversations: [] })).toThrow();
});

it("accepts canonical RunStatus values without fabricated tokens or cost", () => {
  for (const status of [
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
    "interrupted",
    "unknown",
  ]) {
    expect(
      parseLiveRuns({
        items: [
          {
            id: "run-1",
            conversationId: "conversation-1",
            principalId: "owner",
            executionRef: "pi",
            status,
            resultText: null,
            createdAt: "2026-09-29T00:00:00Z",
            updatedAt: "2026-09-29T00:00:00Z",
            scope,
          },
        ],
        nextCursor: null,
      }).items[0]?.status,
    ).toBe(status);
  }
  expect(() => parseLiveRuns({ items: [{ status: "completed" }], nextCursor: null })).toThrow();
});

it("reads trace records from the server records envelope", () => {
  expect(
    parseLiveTrace({
      records: [
        {
          seq: 1,
          ts: "2026-09-29T00:00:00Z",
          provenance: "server",
          event: { type: "turn.started" },
        },
      ],
      nextCursor: "cursor-2",
      indexed: null,
    }),
  ).toMatchObject({ items: [{ seq: 1 }], nextCursor: "cursor-2" });
});
