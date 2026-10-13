import { describe, expect, it } from "vite-plus/test";
import type { ExecutionInput } from "../execution/run-service/types.js";
import { canonicalQqLiveTextSha256 } from "./qq-live-lease.js";
import {
  isBoundQqLiveLearningInput,
  type QqLiveLearningBinding,
} from "./qq-live-learning-binding.js";

function fixture() {
  const scope = {
    connectionId: "fixture",
    botId: "10001",
    chatType: "private" as const,
    chatId: "10002",
    senderId: "10002",
  };
  const text = "GLASSBOX_ACCEPTANCE_V1 1234567890abcdef1234567890abcdef\n请记住我的测试偏好。";
  const input: Pick<ExecutionInput, "caller" | "run" | "text"> = {
    caller: { principalId: "owner", scope },
    text,
    run: {
      id: "run-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      source: "external",
      principalId: "owner",
      executionRef: "pi:fixture",
      status: "running",
      resultText: null,
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
    },
  };
  const binding: QqLiveLearningBinding = {
    leaseId: "lease-1",
    principalId: "owner",
    scope,
    messageId: "external-message-1",
    runMessageId: "message-1",
    runId: "run-1",
    textSha256: canonicalQqLiveTextSha256(text),
  };
  return { input, binding };
}

describe("QQ acceptance implicit learning binding", () => {
  it("recognizes the exact server-bound input without depending on current lease activity", () => {
    const { input, binding } = fixture();
    expect(isBoundQqLiveLearningInput(binding, input)).toBe(true);
  });
  it("does not treat a marker or an ordinary preference as a trusted binding", () => {
    const { input } = fixture();
    expect(isBoundQqLiveLearningInput(undefined, input)).toBe(false);
    expect(isBoundQqLiveLearningInput(undefined, { ...input, text: "我喜欢简短的回答。" })).toBe(
      false,
    );
  });
  it.each(["id", "messageId", "principalId"] as const)("rejects a changed Run %s", (field) => {
    const { input, binding } = fixture();
    expect(
      isBoundQqLiveLearningInput(binding, { ...input, run: { ...input.run, [field]: "other" } }),
    ).toBe(false);
  });
  it("rejects internal Runs, changed caller and changed input text", () => {
    const { input, binding } = fixture();
    expect(
      isBoundQqLiveLearningInput(binding, { ...input, run: { ...input.run, source: "task_step" } }),
    ).toBe(false);
    expect(
      isBoundQqLiveLearningInput(binding, {
        ...input,
        caller: { ...input.caller, principalId: "visitor" },
      }),
    ).toBe(false);
    expect(isBoundQqLiveLearningInput(binding, { ...input, text: input.text + "changed" })).toBe(
      false,
    );
  });
  it.each(["connectionId", "botId", "chatId", "senderId"] as const)(
    "rejects a changed scope %s",
    (field) => {
      const { input, binding } = fixture();
      expect(
        isBoundQqLiveLearningInput(binding, {
          ...input,
          caller: { ...input.caller, scope: { ...input.caller.scope, [field]: "other" } },
        }),
      ).toBe(false);
    },
  );
});
