/**
 * Typed normalization for NapCat `get_group_msg_history` results.
 *
 * NapCat is consumed as an external QQ / OneBot runtime through the existing authenticated
 * connection. No NapCat source is vendored. See upstream/napcat/SOURCES.md.
 *
 * Glassbox reads only the fields it archives: message id, sender, group, plain text and
 * timestamp. Provider payload shape never becomes Glassbox authority, and a record that
 * does not belong to the requested group is dropped rather than trusted.
 */

import { messageId, object, qqId } from "./config.ts";

export interface OneBotHistoryMessage {
  messageId: string;
  groupId: string;
  senderId: string;
  senderName?: string;
  mentionTargetIds: string[];
  text: string;
  occurredAt: string;
}

interface HistoryContent {
  text: string;
  mentionTargetIds: string[];
}

/** Extract readable text and preserve structured mention targets for retrieval filters. */
function historyContent(segments: unknown): HistoryContent | undefined {
  if (typeof segments === "string") {
    const text = segments.trim();
    return text ? { text, mentionTargetIds: [] } : undefined;
  }
  if (!Array.isArray(segments) || segments.length > 256) return undefined;
  const texts: string[] = [];
  const mentionTargetIds = new Set<string>();
  for (const segment of segments) {
    const part = object(segment);
    const data = object(part?.data);
    if (!part || !data) return undefined;
    if (part.type === "text") {
      if (typeof data.text !== "string") return undefined;
      texts.push(data.text);
    } else if (part.type === "at") {
      const target = qqId(data.qq);
      if (target) {
        mentionTargetIds.add(target);
        texts.push(`@${target}`);
      } else if (data.qq === "all") texts.push("@all");
    }
  }
  const text = texts.join("").trim();
  return text ? { text, mentionTargetIds: [...mentionTargetIds] } : undefined;
}

function senderName(record: Record<string, unknown>): string | undefined {
  const sender = object(record.sender);
  const value = sender?.card || sender?.nickname;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

/**
 * The provider's own ordering key for paging backwards through `get_group_msg_history`.
 *
 * NapCat accepts it back as `message_seq`, so a caller walks older pages by passing the
 * smallest sequence it has already seen. A record without one cannot advance a cursor,
 * which is what stops a sync from re-reading the same page forever.
 */
export function historySequence(record: unknown): number | undefined {
  const input = object(record);
  if (!input) return undefined;
  const value = input.message_seq ?? input.real_seq;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function secondsToIso(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Normalizes one history record. Returns undefined when the record is not a plain,
 * text-bearing message in the requested group.
 */
export function normalizeOneBotHistoryRecord(
  record: unknown,
  groupId: string,
  _botId: string,
): OneBotHistoryMessage | undefined {
  const input = object(record);
  if (!input) return undefined;
  // Reject a record that names a different group, or that is not a group message at all.
  const recordGroup = qqId(input.group_id);
  if (recordGroup !== undefined && recordGroup !== groupId) return undefined;
  if (input.message_type !== undefined && input.message_type !== "group") return undefined;
  const id = messageId(input.message_id ?? input.real_id);
  const senderId = qqId(input.user_id ?? object(input.sender)?.user_id);
  const occurredAt = secondsToIso(input.time);
  if (id === undefined || !senderId || !occurredAt) return undefined;
  const content = historyContent(input.message ?? input.raw_message);
  if (!content || content.text.length > 16_000) return undefined;
  const name = senderName(input);
  return {
    messageId: id,
    groupId,
    senderId,
    ...(name === undefined ? {} : { senderName: name }),
    mentionTargetIds: content.mentionTargetIds,
    text: content.text,
    occurredAt,
  };
}
