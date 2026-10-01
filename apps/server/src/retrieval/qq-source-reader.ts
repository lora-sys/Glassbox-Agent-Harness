import { SOURCE_CLASS_AUTHORITY, qqMemorySourceCondition } from "../auth/policy-condition.js";
import {
  AccessDeniedError,
  type AuthorizationDecision,
  type AuthorizationService,
} from "../auth/service.js";
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
      store: RetrievalStorePort & {
        authorization: Pick<AuthorizationService, "check" | "authorizeReadResults">;
      };
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
        policyCondition: qqMemorySourceCondition(
          this.options.caller,
          connectionId,
          groupId,
          sourceClass,
        ),
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
    return (await this.readAuthorizedCandidates(input)).items;
  }

  /** Returns the actual condition-bearing read decision for import evidence. */
  async readAuthorizedCandidates(input: {
    connectionId: string;
    groupId: string;
    sourceClass: QqSourceClass;
    query?: string;
    limit?: number;
    since?: string;
    until?: string;
    conversationId?: string;
    runId?: string;
  }): Promise<{ items: readonly QqSourceCandidate[]; decision?: AuthorizationDecision }> {
    const enabled = await this.enabledSourceClasses(input.connectionId, input.groupId);
    if (!enabled.includes(input.sourceClass)) return { items: [] };
    const request = {
      caller: this.options.caller,
      resourceId: groupResourceId(input.groupId),
      action: SOURCE_CLASS_AUTHORITY[input.sourceClass].action,
      policyCondition: qqMemorySourceCondition(
        this.options.caller,
        input.connectionId,
        input.groupId,
        input.sourceClass,
      ),
      conversationId: input.conversationId,
      runId: input.runId,
    };
    const decision = await this.options.store.authorization.check(request);
    if (decision.decision !== "ALLOW") return { items: [] };
    const records = await this.archive.searchMessages({
      allowedGroupIds: [input.groupId],
      connectionId: input.connectionId,
      sourceClasses: [input.sourceClass],
      query: input.query,
      since: input.since,
      until: input.until,
      limit: input.limit,
    });
    let released: AuthorizationDecision | undefined;
    if (records.length) {
      try {
        [released] = await this.options.store.authorization.authorizeReadResults([
          { request, decisionId: decision.id, source: "content_source" },
        ]);
      } catch (error) {
        if (error instanceof AccessDeniedError) return { items: [] };
        throw error;
      }
    }
    const items = records.map((record) => ({
      id: record.id,
      sourceId: groupResourceId(record.groupId),
      sourceClass: input.sourceClass,
      text: record.normalizedText,
      occurredAt: record.occurredAt,
      externalMessageId: record.externalMessageId,
      senderId: record.senderId,
      returnMode: "raw" as const,
    }));
    return { items, decision: released ?? decision };
  }
}
