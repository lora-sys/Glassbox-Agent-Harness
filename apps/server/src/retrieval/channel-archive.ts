/**
 * Durable Channel history archive and lexical retrieval source.
 *
 * The store shape follows the OpenSquilla memory store / retriever split:
 *   TokenRhythm/opensquilla (Apache-2.0, pinned commit 75a7085960ee57bc7a17acde5ce08071af4e7632)
 *     - src/opensquilla/memory/store.py  (FTS5 index, bm25 rank, relaxed keyword fallback)
 *     - src/opensquilla/memory/types.py  (search options / result shape)
 *   HKUDS/OpenHarness (MIT, pinned commit 9b2efd795c6aa09f88b0c257d269a9e518da6ae7)
 *     - src/openharness/memory/search.py (metadata-weighted lexical scoring, duplicate suppression)
 *
 * Glassbox-specific changes:
 *  - The archived source is a ChannelMessage, not canonical Memory. It keeps provenance
 *    (channel / connection / group / external message id / sender) alongside the
 *    MGP-compatible retrieval metadata.
 *  - Every read is restricted to a pre-authorized group set. The allowed set is applied
 *    inside SQL before any protected text is loaded into a candidate pool.
 *  - Archiving never creates a Run or an Agent message.
 */

import { randomUUID } from "node:crypto";
import type { InValue, Row } from "@libsql/client";
import type { DomainDatabase } from "../persistence/database.js";
import { stringColumn } from "../persistence/database.js";
import { buildFtsQuery, bm25ToScore, segmentForFts } from "./fts.js";
import { groupResourceId } from "./source-resolver.js";
import type { RetrievalCandidate, RetrievalCandidateStore } from "./retriever.js";

export interface IngestChannelMessageInput {
  channel: string;
  connectionId: string;
  groupId: string;
  externalMessageId: string;
  senderId: string;
  senderName?: string;
  mentionTargetIds?: readonly string[];
  normalizedText: string;
  occurredAt: string;
  resourceId?: string;
  /** Authorized QQ source class. Defaults to `history`. */
  sourceClass?: string;
}

export interface ChannelMessageRecord {
  id: string;
  channel: string;
  connectionId: string;
  groupId: string;
  externalMessageId: string;
  senderId: string;
  senderName: string | null;
  mentionTargetIds: string[];
  normalizedText: string;
  sourceClass: string;
  occurredAt: string;
  ingestedAt: string;
  resourceId: string;
  dedupKey: string;
}

export interface ChannelMessageSearchParams {
  allowedGroupIds: readonly string[];
  /** Restricts the candidate pool to these source classes before anything is loaded. */
  sourceClasses?: readonly string[];
  query?: string;
  senderQuery?: string;
  mentionedUserId?: string;
  since?: string;
  until?: string;
  limit?: number;
  minScore?: number;
}

export function channelMessageDedupKey(
  channel: string,
  connectionId: string,
  groupId: string,
  externalMessageId: string,
): string {
  return `${channel}:${connectionId}:${groupId}:${externalMessageId}`;
}

export class ChannelArchiveStore implements RetrievalCandidateStore {
  constructor(private readonly db: DomainDatabase) {}

  /**
   * Ingests a channel message into durable history.
   * Dedupes by (channel, connectionId, groupId, externalMessageId).
   * Does NOT create runs or agent messages.
   *
   * The `resource_id` foreign key enforces the archive invariant: only a group that
   * Glassbox has registered as a configured Resource can be archived. Bot membership
   * alone never registers a Resource.
   */
  async ingest(input: IngestChannelMessageInput): Promise<string> {
    const dedupKey = channelMessageDedupKey(
      input.channel,
      input.connectionId,
      input.groupId,
      input.externalMessageId,
    );
    const resourceId = input.resourceId ?? groupResourceId(input.groupId);

    return this.db.transaction(async (tx) => {
      const existing = await tx.execute({
        sql: `SELECT id, sender_name, mention_target_ids_json
              FROM channel_messages WHERE dedup_key = ?`,
        args: [dedupKey],
      });

      if (existing.rows[0]) {
        const row = existing.rows[0];
        const id = stringColumn(row, "id");
        const existingName = typeof row.sender_name === "string" ? row.sender_name : undefined;
        const senderName = input.senderName ?? existingName;
        const mentionTargetIds =
          input.mentionTargetIds === undefined
            ? parsedMentionTargets(row)
            : normalizedMentionTargets(input.mentionTargetIds);
        const enriched = { ...input, senderName, mentionTargetIds };
        await tx.execute({
          sql: `UPDATE channel_messages
                SET sender_id = ?, sender_name = ?, mention_target_ids_json = ?,
                    normalized_text = ?, occurred_at = ?
                WHERE id = ?`,
          args: [
            input.senderId,
            senderName ?? null,
            JSON.stringify(mentionTargetIds),
            input.normalizedText,
            input.occurredAt,
            id,
          ],
        });
        await tx.execute({ sql: "DELETE FROM channel_messages_fts WHERE id = ?", args: [id] });
        await tx.execute({
          sql: "INSERT INTO channel_messages_fts (segment, id, group_id) VALUES (?, ?, ?)",
          args: [searchableSegment(enriched), id, input.groupId],
        });
        return id;
      }

      const id = randomUUID();
      const ingestedAt = new Date().toISOString();

      await tx.execute({
        sql: `INSERT INTO channel_messages (
                id, channel, connection_id, group_id, external_message_id,
                sender_id, sender_name, mention_target_ids_json, normalized_text,
                source_class, occurred_at, ingested_at, resource_id, dedup_key
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          input.channel,
          input.connectionId,
          input.groupId,
          input.externalMessageId,
          input.senderId,
          input.senderName ?? null,
          JSON.stringify(normalizedMentionTargets(input.mentionTargetIds)),
          input.normalizedText,
          input.sourceClass ?? "history",
          input.occurredAt,
          ingestedAt,
          resourceId,
          dedupKey,
        ],
      });

      await tx.execute({
        sql: "INSERT INTO channel_messages_fts (segment, id, group_id) VALUES (?, ?, ?)",
        args: [searchableSegment(input), id, input.groupId],
      });

      return id;
    });
  }

  /**
   * Searches channel messages strictly within the allowed group IDs.
   *
   * Security invariant: the allowed group set is bound into the SQL predicate. No
   * unauthorized row is ever loaded into memory, so a later filter cannot be the
   * only thing standing between protected text and the retriever.
   */
  async searchMessages(params: ChannelMessageSearchParams): Promise<ChannelMessageRecord[]> {
    if (!params.allowedGroupIds || params.allowedGroupIds.length === 0) return [];
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const placeholders = params.allowedGroupIds.map(() => "?").join(", ");
    const baseArgs: InValue[] = [...params.allowedGroupIds];

    const conditions = [`m.group_id IN (${placeholders})`];
    if (params.sourceClasses && params.sourceClasses.length > 0) {
      conditions.push(`m.source_class IN (${params.sourceClasses.map(() => "?").join(", ")})`);
      baseArgs.push(...params.sourceClasses);
    }
    if (params.since) {
      conditions.push("m.occurred_at >= ?");
      baseArgs.push(params.since);
    }
    if (params.until) {
      conditions.push("m.occurred_at <= ?");
      baseArgs.push(params.until);
    }
    if (params.senderQuery?.trim()) {
      conditions.push("(m.sender_id = ? OR lower(m.sender_name) = lower(?))");
      baseArgs.push(params.senderQuery.trim(), params.senderQuery.trim());
    }
    if (params.mentionedUserId?.trim()) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(m.mention_target_ids_json) WHERE json_each.value = ?)",
      );
      baseArgs.push(params.mentionedUserId.trim());
    }
    const where = conditions.join(" AND ");

    return this.db.transaction(async (tx) => {
      const ftsQuery = params.query?.trim() ? buildFtsQuery(params.query) : null;

      if (ftsQuery === null) {
        // No usable lexical tokens: bounded time-ordered listing inside the authorized set.
        const sql = `SELECT ${COLUMNS} FROM channel_messages m
                     WHERE ${where}
                     ORDER BY m.occurred_at DESC
                     LIMIT ?`;
        const result = await tx.execute({ sql, args: [...baseArgs, limit] });
        return result.rows.map(channelMessageRow);
      }

      const sql = `SELECT ${COLUMNS}, bm25(channel_messages_fts) AS rank
                   FROM channel_messages_fts
                   JOIN channel_messages m ON m.id = channel_messages_fts.id
                   WHERE channel_messages_fts MATCH ?
                     AND ${where}
                   ORDER BY rank
                   LIMIT ?`;
      const result = await tx.execute({
        sql,
        args: [ftsQuery, ...baseArgs, limit],
      });

      const minScore = params.minScore ?? 0;
      const scored = result.rows.map((row) => ({
        record: channelMessageRow(row),
        score: bm25ToScore(Number(row.rank ?? 0)),
      }));
      // Relaxed keyword fallback: a store-level lexical hit survives a min_score cut,
      // mirroring OpenSquilla's relaxed_keyword_match behavior.
      const kept = scored.filter((entry) => entry.score >= minScore);
      return (kept.length > 0 ? kept : scored).slice(0, limit).map((entry) => entry.record);
    });
  }

  /**
   * Implements RetrievalCandidateStore for MemoryRetriever.
   *
   * Defaults to `history`: the group-history Tools retrieve conversation history, not
   * notices or file metadata. Another authorized source class opts in explicitly.
   */
  async searchCandidates(params: {
    query: string;
    allowedSourceIds: readonly string[];
    sourceClasses?: readonly string[];
    limit?: number;
    since?: string;
    until?: string;
    metadataFilters?: Readonly<Record<string, string>>;
  }): Promise<RetrievalCandidate[]> {
    const records = await this.searchMessages({
      allowedGroupIds: params.allowedSourceIds,
      sourceClasses: params.sourceClasses ?? ["history"],
      query: params.query,
      since: params.since,
      until: params.until,
      senderQuery: params.metadataFilters?.sender,
      mentionedUserId: params.metadataFilters?.mentionedUserId,
      limit: params.limit,
    });

    return records.map((rec) => ({
      id: rec.id,
      sourceId: rec.groupId,
      sourceKind: "channel_message",
      text: rec.normalizedText,
      timestamp: rec.occurredAt,
      isEvergreen: false,
      returnMode: "raw",
      metadata: {
        channel: rec.channel,
        connectionId: rec.connectionId,
        externalMessageId: rec.externalMessageId,
        senderId: rec.senderId,
        ...(rec.senderName === null ? {} : { senderName: rec.senderName }),
        mentionTargetIds: rec.mentionTargetIds,
        sourceClass: rec.sourceClass,
        resourceId: rec.resourceId,
      },
    }));
  }
}

const COLUMNS = `m.id, m.channel, m.connection_id, m.group_id, m.external_message_id,
                  m.sender_id, m.sender_name, m.mention_target_ids_json, m.normalized_text,
                  m.source_class, m.occurred_at, m.ingested_at,
                  m.resource_id, m.dedup_key`;

function normalizedMentionTargets(value: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (value ?? [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item !== "" && item.length <= 128),
    ),
  ];
}

function searchableSegment(input: IngestChannelMessageInput): string {
  return segmentForFts(
    [
      input.normalizedText,
      input.senderId,
      input.senderName,
      ...normalizedMentionTargets(input.mentionTargetIds),
    ]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .join(" "),
  );
}

function parsedMentionTargets(row: Row): string[] {
  const raw = stringColumn(row, "mention_target_ids_json");
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? normalizedMentionTargets(
          parsed.filter((value): value is string => typeof value === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

function channelMessageRow(row: Row): ChannelMessageRecord {
  return {
    id: stringColumn(row, "id"),
    channel: stringColumn(row, "channel"),
    connectionId: stringColumn(row, "connection_id"),
    groupId: stringColumn(row, "group_id"),
    externalMessageId: stringColumn(row, "external_message_id"),
    senderId: stringColumn(row, "sender_id"),
    senderName: typeof row.sender_name === "string" ? row.sender_name : null,
    mentionTargetIds: parsedMentionTargets(row),
    normalizedText: stringColumn(row, "normalized_text"),
    sourceClass: stringColumn(row, "source_class"),
    occurredAt: stringColumn(row, "occurred_at"),
    ingestedAt: stringColumn(row, "ingested_at"),
    resourceId: stringColumn(row, "resource_id"),
    dedupKey: stringColumn(row, "dedup_key"),
  };
}
