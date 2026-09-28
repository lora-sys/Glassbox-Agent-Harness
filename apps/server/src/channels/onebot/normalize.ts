import type { TrustedChannelScope } from "../../identity/scope.js";
import { messageId, object, qqId, type OneBotConnectionConfig } from "./config.ts";
import { normalizeQqNativeGroupRole } from "./group-role.js";

/** Adapted from OpenHarness bus events and gateway routing. See SOURCES.md. */
export interface OneBotIncomingMessage {
  channel: "qq-onebot";
  scope: TrustedChannelScope;
  messageId: string;
  text: string;
  parts: OneBotMessagePart[];
  receivedAt: string;
  replyTo?: string;
}

export type OneBotMessagePart = { type: "text"; text: string } | { type: "image"; file: string };

export type NormalizeResult =
  | { kind: "message"; message: OneBotIncomingMessage }
  | { kind: "ignored"; diagnostic?: { groupId: string; reason: "not_addressed" | "empty_message" } }
  | {
      kind: "rejected";
      code: "invalid_message" | "unsupported_message";
      messageId?: string;
      groupId?: string;
    };

function unescapeCq(value: string): string {
  return value
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&#44;", ",")
    .replaceAll("&amp;", "&");
}

function isOpaqueImageFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/]/u.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(value)
  );
}

/** Parse protocol CQ encoding before decoding text, so escaped CQ text cannot become an @. */
function cqSegments(value: string): unknown[] {
  const segments: unknown[] = [];
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/gu;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    if (index > offset)
      segments.push({ type: "text", data: { text: unescapeCq(value.slice(offset, index)) } });
    const data: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const pair of match[2].split(",").slice(1)) {
      const separator = pair.indexOf("=");
      if (separator > 0) data[pair.slice(0, separator)] = unescapeCq(pair.slice(separator + 1));
    }
    segments.push({ type: match[1], data });
    offset = index + match[0].length;
  }
  if (offset < value.length)
    segments.push({ type: "text", data: { text: unescapeCq(value.slice(offset)) } });
  return segments;
}

export function normalizeOneBotMessage(
  event: unknown,
  config: OneBotConnectionConfig,
  now = new Date(),
): NormalizeResult {
  const input = object(event);
  if (!input || input.post_type !== "message") return { kind: "ignored" };
  const senderId = qqId(input.user_id);
  const type = input.message_type;
  if (type !== "private" && type !== "group") return { kind: "ignored" };
  const groupId = type === "group" ? qqId(input.group_id) : undefined;
  // Private chat stays allowlisted. A configured group accepts any real member only after the
  // explicit @ check below; the application then provisions authority for that exact group.
  const isOwner =
    senderId === config.ownerId ||
    (config.coOwnerId !== undefined && senderId === config.coOwnerId);
  if (
    qqId(input.self_id) !== config.botId ||
    !senderId ||
    (type === "private" && !isOwner && !config.visitorIds.includes(senderId)) ||
    senderId === config.botId
  )
    return { kind: "ignored" };
  if (type === "private" && input.sub_type !== "friend") return { kind: "ignored" };
  if (type === "group" && (input.sub_type !== "normal" || input.anonymous != null))
    return { kind: "ignored" };
  const chatId = type === "private" ? senderId : qqId(input.group_id);
  if (!chatId || (type === "group" && !config.groupIds.includes(chatId)))
    return { kind: "ignored" };
  const id = messageId(input.message_id);
  if (id === undefined)
    return { kind: "rejected", code: "invalid_message", ...(groupId ? { groupId } : {}) };
  if (typeof input.message === "string" && input.message.length > 16_000)
    return {
      kind: "rejected",
      code: "invalid_message",
      messageId: id,
      ...(groupId ? { groupId } : {}),
    };
  const segments = typeof input.message === "string" ? cqSegments(input.message) : input.message;
  if (!Array.isArray(segments) || segments.length > 256)
    return {
      kind: "rejected",
      code: "invalid_message",
      messageId: id,
      ...(groupId ? { groupId } : {}),
    };
  const texts: string[] = [];
  let addressed = false;
  let replyTo: string | undefined;
  let unsupported = false;
  let invalidImage = false;
  let imageCount = 0;
  const parts: OneBotMessagePart[] = [];
  for (const segment of segments) {
    const part = object(segment);
    const data = object(part?.data);
    if (!part || !data)
      return {
        kind: "rejected",
        code: "invalid_message",
        messageId: id,
        ...(groupId ? { groupId } : {}),
      };
    if (part.type === "text") {
      if (typeof data.text !== "string")
        return {
          kind: "rejected",
          code: "invalid_message",
          messageId: id,
          ...(groupId ? { groupId } : {}),
        };
      texts.push(data.text);
      parts.push({ type: "text", text: data.text });
    } else if (part.type === "at") {
      const target = qqId(data.qq);
      if (target === config.botId) addressed = true;
      else if (target || data.qq === "all") {
        const text = `@${target ?? "all"}`;
        texts.push(text);
        parts.push({ type: "text", text });
      } else
        return {
          kind: "rejected",
          code: "invalid_message",
          messageId: id,
          ...(groupId ? { groupId } : {}),
        };
    } else if (part.type === "reply") {
      const replyId = messageId(data.id);
      if (replyId === undefined || replyTo !== undefined)
        return {
          kind: "rejected",
          code: "invalid_message",
          messageId: id,
          ...(groupId ? { groupId } : {}),
        };
      replyTo = replyId;
    } else if (part.type === "image") {
      imageCount += 1;
      const file = data.file;
      if (
        type !== "private" ||
        imageCount > 4 ||
        !isOpaqueImageFile(file) ||
        data.type === "flash" ||
        data.sub_type === "flash"
      ) {
        invalidImage = true;
      } else parts.push({ type: "image", file });
    } else unsupported = true;
  }
  if (unsupported)
    return {
      kind: "rejected",
      code: "unsupported_message",
      messageId: id,
      ...(groupId ? { groupId } : {}),
    };
  if (invalidImage)
    return {
      kind: "rejected",
      code: type === "group" ? "unsupported_message" : "invalid_message",
      messageId: id,
      ...(groupId ? { groupId } : {}),
    };
  if (type === "group" && !addressed)
    return {
      kind: "ignored",
      ...(groupId ? { diagnostic: { groupId, reason: "not_addressed" as const } } : {}),
    };
  const text = texts.join("").trim();
  if (!text && parts.every((part) => part.type !== "image"))
    return {
      kind: "ignored",
      ...(groupId ? { diagnostic: { groupId, reason: "empty_message" as const } } : {}),
    };
  if (text.length > 16_000)
    return {
      kind: "rejected",
      code: "invalid_message",
      messageId: id,
      ...(groupId ? { groupId } : {}),
    };
  const sender = object(input.sender);
  return {
    kind: "message",
    message: {
      channel: "qq-onebot",
      scope: {
        connectionId: config.connectionId,
        botId: config.botId,
        chatType: type,
        chatId,
        senderId,
        ...(type === "group"
          ? {
              nativeGroupRole: {
                role: normalizeQqNativeGroupRole(sender?.role),
                source: "onebot_message_sender" as const,
                observedAt: now.toISOString(),
              },
            }
          : {}),
      },
      messageId: id,
      text,
      parts,
      receivedAt: now.toISOString(),
      ...(replyTo !== undefined && { replyTo }),
    },
  };
}
