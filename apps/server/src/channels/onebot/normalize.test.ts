import { describe, expect, it } from "vite-plus/test";
import { parseOneBotConfig } from "./config.ts";
import { normalizeOneBotMessage } from "./normalize.ts";

const config = parseOneBotConfig({
  connectionId: "napcat-test",
  label: "Test QQ",
  endpoint: "ws://127.0.0.1:6700/",
  botId: "10001",
  ownerId: "10002",
  visitorIds: ["10004"],
  groupIds: ["10003"],
  credentialSlot: "qq-token",
  allowRemote: false,
});

function privateMessage(message: unknown, overrides: Record<string, unknown> = {}) {
  return normalizeOneBotMessage(
    {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      self_id: 10001,
      user_id: 10002,
      message_id: 42,
      message,
      ...overrides,
    },
    config,
  );
}

describe("OneBot incoming media normalization", () => {
  it("preserves ordered text and opaque image parts without retaining the URL", () => {
    expect(
      privateMessage([
        { type: "text", data: { text: "请看" } },
        {
          type: "image",
          data: { file: "abc-123.jpg", url: "https://media.example/private.jpg" },
        },
        { type: "text", data: { text: "这张图" } },
      ]),
    ).toMatchObject({
      kind: "message",
      message: {
        text: "请看这张图",
        parts: [
          { type: "text", text: "请看" },
          { type: "image", file: "abc-123.jpg" },
          { type: "text", text: "这张图" },
        ],
      },
    });
  });

  it("accepts a pure image message with empty text", () => {
    expect(privateMessage([{ type: "image", data: { file: "opaque_123" } }])).toMatchObject({
      kind: "message",
      message: { text: "", parts: [{ type: "image", file: "opaque_123" }] },
    });
  });

  it("keeps text, at, reply, and CQ image behavior in the normalized shape", () => {
    expect(
      privateMessage([
        { type: "reply", data: { id: 17 } },
        { type: "text", data: { text: "看" } },
        { type: "at", data: { qq: "10004" } },
        { type: "image", data: { file: "pic.png" } },
      ]),
    ).toMatchObject({
      kind: "message",
      message: {
        text: "看@10004",
        replyTo: "17",
        parts: [
          { type: "text", text: "看" },
          { type: "text", text: "@10004" },
          { type: "image", file: "pic.png" },
        ],
      },
    });
    expect(privateMessage("请看 [CQ:image,file=cq-123.jpg]")).toMatchObject({
      kind: "message",
      message: {
        text: "请看",
        parts: [
          { type: "text", text: "请看 " },
          { type: "image", file: "cq-123.jpg" },
        ],
      },
    });
  });

  it.each([
    "https://media.example/private.jpg",
    "file:///tmp/private.jpg",
    "../private.jpg",
    "C:\\private.jpg",
    "x".repeat(129),
  ])("rejects non-opaque or oversized file identifiers", (file) => {
    expect(privateMessage([{ type: "image", data: { file } }])).toMatchObject({
      kind: "rejected",
      code: "invalid_message",
    });
  });

  it("rejects flash images and messages with more than four images", () => {
    expect(
      privateMessage([{ type: "image", data: { file: "pic.jpg", type: "flash" } }]),
    ).toMatchObject({ kind: "rejected", code: "invalid_message" });
    expect(
      privateMessage(
        Array.from({ length: 5 }, (_, index) => ({
          type: "image",
          data: { file: `pic-${index}.jpg` },
        })),
      ),
    ).toMatchObject({ kind: "rejected", code: "invalid_message" });
  });

  it("rejects group images and unknown segment types", () => {
    expect(
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          self_id: 10001,
          user_id: 10002,
          group_id: 10003,
          message_id: 43,
          message: [
            { type: "at", data: { qq: "10001" } },
            { type: "image", data: { file: "group-image.jpg" } },
          ],
        },
        config,
      ),
    ).toMatchObject({ kind: "rejected", code: "unsupported_message" });
    expect(privateMessage([{ type: "video", data: { file: "opaque" } }])).toMatchObject({
      kind: "rejected",
      code: "unsupported_message",
    });
  });
});
