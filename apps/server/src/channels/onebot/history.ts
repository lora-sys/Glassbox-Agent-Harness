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
 * The opaque cursor and timestamp used to page backwards through `get_group_msg_history`.
 *
 * NapCat names the input `message_seq`, but its action resolves that value through the
 * short `message_id` map before asking QQ for the next page. The response's `message_seq`
 * is also that short id, while `real_seq` is the QQ sequence. Neither id is chronologically
 * ordered. Glassbox therefore selects the oldest record by `time` and passes its short id
 * back with `reverse_order=true`.
 */
export function historyCursor(record: unknown): { id: string; occurredAt: string } | undefined {
  const input = object(record);
  if (!input) return undefined;
  const providerSequence = messageId(input.message_seq);
  if (!providerSequence || providerSequence === "0") return undefined;
  const id = messageId(input.message_id) ?? providerSequence;
  const occurredAt = secondsToIso(input.time);
  return id && id !== "0" && occurredAt ? { id, occurredAt } : undefined;
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
