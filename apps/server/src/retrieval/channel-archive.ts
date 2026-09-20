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
        sql: "SELECT id FROM channel_messages WHERE dedup_key = ?",
        args: [dedupKey],
      });

      if (existing.rows[0]) {
        return stringColumn(existing.rows[0], "id");
      }

      const id = randomUUID();
      const ingestedAt = new Date().toISOString();

      await tx.execute({
        sql: `INSERT INTO channel_messages (
                id, channel, connection_id, group_id, external_message_id,
                sender_id, normalized_text, source_class, occurred_at, ingested_at,
                resource_id, dedup_key
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          input.channel,
          input.connectionId,
          input.groupId,
          input.externalMessageId,
          input.senderId,
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
        args: [segmentForFts(input.normalizedText), id, input.groupId],
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
  }): Promise<RetrievalCandidate[]> {
    const records = await this.searchMessages({
      allowedGroupIds: params.allowedSourceIds,
      sourceClasses: params.sourceClasses ?? ["history"],
      query: params.query,
      since: params.since,
      until: params.until,
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
        sourceClass: rec.sourceClass,
        resourceId: rec.resourceId,
      },
    }));
  }
}

const COLUMNS = `m.id, m.channel, m.connection_id, m.group_id, m.external_message_id,
                  m.sender_id, m.normalized_text, m.source_class, m.occurred_at, m.ingested_at,
                  m.resource_id, m.dedup_key`;

function channelMessageRow(row: Row): ChannelMessageRecord {
  return {
    id: stringColumn(row, "id"),
    channel: stringColumn(row, "channel"),
    connectionId: stringColumn(row, "connection_id"),
    groupId: stringColumn(row, "group_id"),
    externalMessageId: stringColumn(row, "external_message_id"),
    senderId: stringColumn(row, "sender_id"),
    normalizedText: stringColumn(row, "normalized_text"),
    sourceClass: stringColumn(row, "source_class"),
    occurredAt: stringColumn(row, "occurred_at"),
    ingestedAt: stringColumn(row, "ingested_at"),
    resourceId: stringColumn(row, "resource_id"),
    dedupKey: stringColumn(row, "dedup_key"),
  };
}
