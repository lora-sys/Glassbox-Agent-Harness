import { describe, expect, it } from "vite-plus/test";
import { CHANNEL_SAFE_ERRORS } from "@glassbox/contracts";
import {
  buildChannelSave,
  channelDraftFor,
  decodeChannel,
  decodeChannelList,
  decodeChannelResult,
  emptyChannelDraft,
} from "./channel-schema";

const channel = {
  id: "qq-personal",
  label: "我的 QQ 助理",
  kind: "qq-onebot" as const,
  endpoint: "ws://127.0.0.1:6700/",
  botId: "12345",
  ownerId: "54321",
  groupIds: ["77777"],
  executionRef: "claude-code",
  tokenConfigured: true,
  autoConnect: false,
  connectionState: "disconnected" as const,
};

describe("public channel schemas", () => {
  it("decodes a public profile and exact list/result envelopes", () => {
    expect(decodeChannelResult({ channel })).toEqual(channel);
    expect(decodeChannelList({ channels: [channel] })).toEqual([channel]);
    expect(decodeChannel({ ...channel, lastError: CHANNEL_SAFE_ERRORS.auth })).toHaveProperty(
      "lastError",
      CHANNEL_SAFE_ERRORS.auth,
    );
    expect(() => decodeChannelResult({ channel, token: "private" })).toThrow();
    expect(() => decodeChannelList({ channels: [channel, channel] })).toThrow();
    expect(() => decodeChannelList({ channels: Array(101).fill(channel) })).toThrow();
  });

  it.each([
    { token: "private" },
    { credentialSlot: "private" },
    { credentials: {} },
    { lastError: "private upstream response" },
    { endpoint: "ws://127.0.0.1/?token=private" },
    { endpoint: "wss://remote.test/" },
    { endpoint: "ws://127.0.0.1/event" },
    { botId: 12345 },
    { ownerId: "12345" },
    { groupIds: ["77777", "77777"] },
    { groupIds: ["9007199254740992"] },
    { connectionState: "ready" },
    { autoConnect: 1 },
    { tokenConfigured: "yes" },
    { id: "../private" },
    { executionRef: "model:../../private" },
  ])("rejects unsafe or invalid public channel data %j", (override) => {
    expect(() => decodeChannel({ ...channel, ...override })).toThrow();
  });

  it("keeps runtime metadata and credentials out of editable drafts", () => {
    expect(emptyChannelDraft()).toMatchObject({
      executionRef: "claude-code",
      endpoint: "ws://127.0.0.1:6700/",
      token: "",
    });
    const draft = channelDraftFor({ ...channel, connectionState: "connected", autoConnect: true });
    expect(draft).not.toHaveProperty("autoConnect");
    expect(draft).not.toHaveProperty("connectionState");
    expect(draft.token).toBe("");
    const saved = buildChannelSave(draft);
    expect(saved).not.toHaveProperty("token");
    expect(saved).not.toHaveProperty("tokenConfigured");
  });

  it("normalizes Chinese separators and loopback URLs with explicit execution refs", () => {
    const draft = {
      ...channelDraftFor(channel),
      groupIds: "77777， 88888 77777",
      endpoint: "ws://localhost:6700",
      executionRef: "model:daily",
    };
    expect(buildChannelSave(draft, channel)).toMatchObject({
      groupIds: ["77777", "88888"],
      endpoint: channel.endpoint,
      executionRef: "model:daily",
    });
    expect(buildChannelSave({ ...draft, groupIds: "" }).groupIds).toEqual([]);
    expect(buildChannelSave({ ...draft, executionRef: "codex" }).executionRef).toBe("codex");
  });

  it("preserves, replaces or explicitly clears the masked token", () => {
    const draft = channelDraftFor(channel);
    expect(buildChannelSave(draft, channel)).not.toHaveProperty("token");
    expect(buildChannelSave({ ...draft, token: "replacement-token" }, channel).token).toBe(
      "replacement-token",
    );
    expect(buildChannelSave({ ...draft, clearToken: true }, channel).token).toBeNull();
    expect(() =>
      buildChannelSave({ ...draft, clearToken: true, token: "replacement" }, channel),
    ).toThrow();
    expect(() => buildChannelSave({ ...draft, token: "bad token" }, channel)).toThrow();
  });

  it("blocks credential origin changes and active edits before posting", () => {
    const draft = { ...channelDraftFor(channel), endpoint: "ws://127.0.0.1:6701/" };
    expect(() => buildChannelSave(draft, channel)).toThrow(
      expect.objectContaining({ code: "CHANNEL_ORIGIN" }),
    );
    expect(buildChannelSave({ ...draft, clearToken: true }, channel).token).toBeNull();
    expect(() =>
      buildChannelSave(channelDraftFor(channel), { ...channel, connectionState: "connected" }),
    ).toThrow(expect.objectContaining({ code: "CHANNEL_ACTIVE" }));
    expect(() =>
      buildChannelSave(channelDraftFor(channel), { ...channel, connectionState: "connecting" }),
    ).toThrow(expect.objectContaining({ code: "CHANNEL_ACTIVE" }));
    expect(() =>
      buildChannelSave({ ...channelDraftFor(channel), id: "renamed" }, channel),
    ).toThrow();
  });
});
