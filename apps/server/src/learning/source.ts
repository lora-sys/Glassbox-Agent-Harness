import { randomUUID } from "node:crypto";
import type {
  GlassboxMemoryScope,
  MemoryCandidate,
  MemoryEvidence,
  MemorySubject,
  MemoryType,
} from "./contracts.js";
import { createLearningId } from "./ids.js";

export interface AuthorizedMemorySourceItem {
  channel: "qq";
  groupResourceId: string;
  groupId: string;
  category: "history" | "notice" | "essence" | "group_info" | "member" | "file" | "album";
  sourceReadRunId: string;
  authorizationDecisionId: string;
  externalMessageId?: string;
  senderId?: string;
  occurredAt: string;
  stableRef: string;
  snippet?: string;
  digest?: string;
}

export interface AuthorizedMemorySource {
  read(): Promise<readonly AuthorizedMemorySourceItem[]>;
}

export function evidenceFromAuthorizedSource(item: AuthorizedMemorySourceItem): MemoryEvidence {
  return {
    evidenceId: randomUUID(),
    kind: "external_record",
    ref: item.stableRef,
    ...(item.snippet ? { excerpt: item.snippet.slice(0, 500) } : {}),
    capturedAt: new Date().toISOString(),
    trustLevel: "low",
    metadata: {
      channel: item.channel,
      groupResourceId: item.groupResourceId,
      groupId: item.groupId,
      category: item.category,
      sourceReadRunId: item.sourceReadRunId,
      authorizationDecisionId: item.authorizationDecisionId,
      occurredAt: item.occurredAt,
      ...(item.externalMessageId ? { externalMessageId: item.externalMessageId } : {}),
      ...(item.senderId ? { senderId: item.senderId } : {}),
      ...(item.digest ? { digest: item.digest } : {}),
      untrustedInput: true,
    },
  };
}

/** Source text is evidence only. It can never request promotion or another side effect. */
export function candidateFromAuthorizedSource(input: {
  item: AuthorizedMemorySourceItem;
  subject: MemorySubject;
  scope: GlassboxMemoryScope;
  type: MemoryType;
  statement: string;
}): Omit<MemoryCandidate, "createdAt" | "status"> {
  return {
    candidateId: createLearningId("candidate"),
    candidateKind: "derived",
    subject: input.subject,
    scope: input.scope,
    proposedType: input.type,
    statement: input.statement,
    content: { statement: input.statement },
    source: { kind: "external", ref: input.item.stableRef },
    sourceEvidence: [evidenceFromAuthorizedSource(input.item)],
    confidence: 0.5,
    sensitivity: "confidential",
    mergeHint: { strategy: "manual_review_required" },
    extensions: { "glassbox:source": "authorized-qq", "glassbox:untrusted": true },
  };
}
