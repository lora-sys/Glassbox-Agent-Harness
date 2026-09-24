import {
  QQ_SOURCE_CLASSES,
  type AuthorizedQqSourceReader,
  type QqSourceCandidate,
  type QqSourceClass,
} from "@glassbox/contracts";
import type { QqCapabilityCategory } from "../channels/onebot/capabilities.js";
import type { CallerContext } from "../identity/scope.js";
import { ChannelArchiveStore } from "./channel-archive.js";
import { groupResourceId } from "./source-resolver.js";
import type { RetrievalStorePort } from "./ports.js";

/**
 * Authorized QQ source reader.
 *
 * P4B owns the QQ Capability Registry and this source interface; P4A consumes candidates
 * as Memory evidence. A source class is readable only when BOTH hold:
 *
 *   Owner enablement   the durable per-group policy enables the class
 *   Principal authority the caller currently holds the protected Action on group:<id>
 *
 * Enablement alone is intent; a grant alone is authority. Neither is sufficient, so a
 * disabled class can never generate candidates and an unauthorized Principal can never
 * read a class the Owner enabled for someone else.
 *
 * Candidate generation never creates a Run, an Agent message or a Memory record.
 */

/**
 * The capability category and protected Action that authorize each source class.
 *
 * The Action is stated explicitly rather than derived, because a category can map to more
 * than one Tool and the source class must bind to exactly one protected Action.
 */
const SOURCE_CLASS_AUTHORITY: Record<
  QqSourceClass,
  { category: QqCapabilityCategory; action: string }
> = {
  history: { category: "group.history", action: "history:read" },
  notice: { category: "group.content", action: "group:content:read" },
  essence: { category: "group.content", action: "group:content:read" },
  album: { category: "group.content", action: "group:content:read" },
  metadata: { category: "group.read", action: "group:read" },
  file: { category: "group.files.read", action: "group:files:read" },
};

export function sourceClassAuthority(sourceClass: QqSourceClass): {
  category: QqCapabilityCategory;
  action: string;
} {
  return SOURCE_CLASS_AUTHORITY[sourceClass];
}

export class AuthorizedQQSourceReader implements AuthorizedQqSourceReader {
  private readonly archive: ChannelArchiveStore;

  constructor(
    private readonly options: {
      store: RetrievalStorePort;
      caller: CallerContext;
      archive?: ChannelArchiveStore;
    },
  ) {
    this.archive = options.archive ?? new ChannelArchiveStore(options.store.db);
  }

  async enabledSourceClasses(
    connectionId: string,
    groupId: string,
  ): Promise<readonly QqSourceClass[]> {
    const stored = await this.options.store.capabilities.read(connectionId, groupId);
    if (!stored) return [];
    const enabled: QqSourceClass[] = [];
    for (const sourceClass of QQ_SOURCE_CLASSES) {
      // The policy projection is owned by Management; Retrieval consumes only this
      // source-class flag and does not depend on Management's policy implementation.
      if (stored.policy.memorySources?.[sourceClass] !== true) continue;
      // Re-authorize now. Policy enablement is never a substitute for the grant, and no
      // earlier decision is reused.
      const decision = await this.options.store.authorization.check({
        caller: this.options.caller,
        resourceId: groupResourceId(groupId),
        action: SOURCE_CLASS_AUTHORITY[sourceClass].action,
      });
      if (decision.decision === "ALLOW") enabled.push(sourceClass);
    }
    return enabled;
  }

  async readCandidates(input: {
    connectionId: string;
    groupId: string;
    sourceClass: QqSourceClass;
    query?: string;
    limit?: number;
    since?: string;
    until?: string;
  }): Promise<readonly QqSourceCandidate[]> {
    const enabled = await this.enabledSourceClasses(input.connectionId, input.groupId);
    if (!enabled.includes(input.sourceClass)) return [];
    const records = await this.archive.searchMessages({
      allowedGroupIds: [input.groupId],
      sourceClasses: [input.sourceClass],
      query: input.query,
      since: input.since,
      until: input.until,
      limit: input.limit,
    });
    return records.map((record) => ({
      id: record.id,
      sourceId: groupResourceId(record.groupId),
      sourceClass: input.sourceClass,
      text: record.normalizedText,
      occurredAt: record.occurredAt,
      externalMessageId: record.externalMessageId,
      senderId: record.senderId,
      returnMode: "raw" as const,
    }));
  }
}
