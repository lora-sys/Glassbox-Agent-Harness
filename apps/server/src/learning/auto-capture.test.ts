import { describe, expect, it } from "vitest";
import { classifyAutoCapture, type AutoCaptureInput } from "./auto-capture.js";

const privateInput = (
  text: string,
  overrides: Partial<AutoCaptureInput> = {},
): AutoCaptureInput => ({
  text,
  actor: "owner",
  role: "user",
  scope: { type: "private" },
  origin: "current_message",
  ...overrides,
});

describe("conservative automatic learning signal classification", () => {
  it("creates a pending global Taste candidate from an explicit durable preference", () => {
    expect(classifyAutoCapture(privateInput("全局记住，我偏好简洁的中文回复"))).toMatchObject({
      status: "pending",
      type: "preference",
      scope: { type: "global" },
      statement: "简洁的中文回复",
      evidence: { kind: "explicit_preference", source: "current_message" },
    });
  });

  it("creates a pending fact only when the Owner explicitly asks to remember it", () => {
    expect(classifyAutoCapture(privateInput("全局记住，我的时区是 Asia/Shanghai"))).toMatchObject({
      status: "pending",
      type: "semantic_fact",
      scope: { type: "global" },
      statement: "我的时区是 Asia/Shanghai",
      evidence: { kind: "explicit_remember" },
    });
  });

  it("keeps clear Owner-private signals as pending global candidates", () => {
    expect(classifyAutoCapture(privateInput("我偏好简洁的中文回复"))).toMatchObject({
      scope: { type: "global" },
      type: "preference",
      status: "pending",
    });
    expect(classifyAutoCapture(privateInput("记住，我住在上海"))).toMatchObject({
      scope: { type: "global" },
      type: "semantic_fact",
      status: "pending",
    });
  });

  it("keeps group candidates scoped to the named group", () => {
    expect(
      classifyAutoCapture(
        privateInput("在这个群里，请始终用中文简短回复", {
          scope: { type: "group", connectionId: "qq-main", botId: "bot-1", groupId: "group-42" },
        }),
      ),
    ).toMatchObject({
      status: "pending",
      type: "preference",
      scope: { type: "group", connectionId: "qq-main", botId: "bot-1", groupId: "group-42" },
      statement: "用中文简短回复",
      evidence: { kind: "explicit_preference" },
    });
  });

  it("allows explicit group memory requests without widening scope", () => {
    expect(
      classifyAutoCapture(
        privateInput("请记入这个群的记忆，我是本群管理员", {
          scope: { type: "group", connectionId: "qq-main", botId: "bot-1", groupId: "group-42" },
        }),
      ),
    ).toMatchObject({
      type: "semantic_fact",
      scope: { type: "group", connectionId: "qq-main", botId: "bot-1", groupId: "group-42" },
      statement: "我是本群管理员",
    });
  });

  it("captures an explicit group response preference as Taste", () => {
    expect(
      classifyAutoCapture(
        privateInput("请记住：在本群回答时先给结论，再列步骤。", {
          scope: { type: "group", connectionId: "qq-main", botId: "bot-1", groupId: "1126022432" },
        }),
      ),
    ).toMatchObject({
      status: "pending",
      type: "preference",
      scope: { type: "group", connectionId: "qq-main", botId: "bot-1", groupId: "1126022432" },
      statement: "在本群回答时先给结论，再列步骤",
      evidence: { kind: "explicit_preference", source: "current_message" },
    });
  });

  it("does not turn a private request for group memory into global Memory", () => {
    expect(classifyAutoCapture(privateInput("请记住这个群的记忆：周三集会"))).toBeUndefined();
    expect(classifyAutoCapture(privateInput("以后群里请始终用中文回复"))).toBeUndefined();
  });

  it("rejects group chatter that is not explicitly relevant to group learning", () => {
    const scope = {
      type: "group" as const,
      connectionId: "qq-main",
      botId: "bot-1",
      groupId: "group-42",
    };
    expect(classifyAutoCapture(privateInput("我偏好简洁回复", { scope }))).toBeUndefined();
    expect(classifyAutoCapture(privateInput("请记住，我住在上海", { scope }))).toBeUndefined();
  });

  it("keeps group scope distinct across connections, bots, and groups", () => {
    const message = "在这个群里，请始终用中文简短回复";
    const scopes = [
      { type: "group" as const, connectionId: "qq-a", botId: "bot-1", groupId: "group-42" },
      { type: "group" as const, connectionId: "qq-b", botId: "bot-1", groupId: "group-42" },
      { type: "group" as const, connectionId: "qq-a", botId: "bot-2", groupId: "group-42" },
      { type: "group" as const, connectionId: "qq-a", botId: "bot-1", groupId: "group-43" },
    ];
    const candidates = scopes.map((scope) => classifyAutoCapture(privateInput(message, { scope })));
    expect(candidates.every(Boolean)).toBe(true);
    expect(new Set(candidates.map((candidate) => JSON.stringify(candidate?.scope))).size).toBe(
      scopes.length,
    );
  });

  it("rejects missing, malformed, and overlong group scope identifiers", () => {
    const base = {
      type: "group" as const,
      connectionId: "qq-main",
      botId: "bot-1",
      groupId: "group-42",
    };
    expect(
      classifyAutoCapture(
        privateInput("在这个群里，请始终用中文简短回复", { scope: { ...base, botId: "" } }),
      ),
    ).toBeUndefined();
    expect(
      classifyAutoCapture(
        privateInput("在这个群里，请始终用中文简短回复", {
          scope: { ...base, connectionId: "has space" },
        }),
      ),
    ).toBeUndefined();
    expect(
      classifyAutoCapture(
        privateInput("在这个群里，请始终用中文简短回复", {
          scope: { ...base, groupId: "x".repeat(129) },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects visitor, unknown actor, non-user, quoted, and retrieved content", () => {
    expect(
      classifyAutoCapture(privateInput("全局记住，我偏好简洁回复", { actor: "visitor" })),
    ).toBeUndefined();
    expect(
      classifyAutoCapture(privateInput("全局记住，我偏好简洁回复", { actor: "unknown" })),
    ).toBeUndefined();
    expect(
      classifyAutoCapture(privateInput("全局记住，我偏好简洁回复", { role: "assistant" })),
    ).toBeUndefined();
    expect(
      classifyAutoCapture(privateInput("全局记住，我偏好简洁回复", { origin: "quoted" })),
    ).toBeUndefined();
    expect(
      classifyAutoCapture(privateInput("全局记住，我偏好简洁回复", { origin: "retrieved" })),
    ).toBeUndefined();
  });

  it("rejects ordinary chatter, quoted text, credentials, URLs, and overlong input", () => {
    expect(classifyAutoCapture(privateInput("今天天气不错"))).toBeUndefined();
    expect(classifyAutoCapture(privateInput("全局记住，'我偏好简洁回复'"))).toBeUndefined();
    expect(classifyAutoCapture(privateInput("全局记住，我的 API key 是 abc123"))).toBeUndefined();
    expect(
      classifyAutoCapture(privateInput("全局记住，我偏好 https://example.com")),
    ).toBeUndefined();
    expect(
      classifyAutoCapture(privateInput(`全局记住，我偏好${"很".repeat(250)}`)),
    ).toBeUndefined();
  });

  it("keeps output bounded, links evidence, and never marks a candidate active", () => {
    const candidate = classifyAutoCapture(
      privateInput("全局记住，我偏好简洁回复。", { messageRef: "message-1" }),
    );
    expect(candidate).toMatchObject({
      status: "pending",
      statement: "简洁回复",
      evidence: { source: "current_message", messageRef: "message-1" },
    });
    expect(candidate?.statement.length).toBeLessThanOrEqual(240);
    expect(candidate).not.toHaveProperty("lifecycleState", "active");
  });
});
