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

/**
 * Whether an authorized source message carries enough substance to be worth an Owner's review.
 *
 * The source action imports QQ messages verbatim, and a chat log is mostly messages that assert
 * nothing: greetings, bare acknowledgements, a repeated laugh, a question. Each one becomes a
 * pending candidate the Owner has to read and reject, and the queue fills with noise until the
 * real ones are buried in it.
 *
 * The bar is deliberately about substance rather than length alone, so a long "哈哈哈哈" is still
 * refused. It is a filter, not a classifier: a short message that does state a fact is kept, and a
 * chatty one that happens to be long enough is still imported for the Owner to judge.
 */
export function sourceStatementIsSubstantive(text: string): boolean {
  const trimmed = text.trim();
  // A question asserts nothing, so it can never be a statement of fact.
  if (/[?？]\s*$/u.test(trimmed)) return false;
  if (trimmed.length < 8) return false;
  // Punctuation, symbols and emoji do not carry the statement; what is left has to be varied
  // enough to be words rather than one character repeated.
  const meaningful = trimmed.replace(/[\p{P}\p{S}\p{Zs}\p{Cc}]+/gu, "");
  return new Set(meaningful).size >= 4;
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
