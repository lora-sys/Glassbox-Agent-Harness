export const memoryTypes = [
  "preference",
  "semantic_fact",
  "episodic_event",
  "relationship",
] as const;
export type MemoryType = (typeof memoryTypes)[number];

export const candidateKinds = ["assertion", "confirmation", "correction", "derived"] as const;
export type MemoryCandidateKind = (typeof candidateKinds)[number];

export const mergeStrategies = [
  "create",
  "dedupe",
  "upsert",
  "replace",
  "merge",
  "reinforce",
  "manual_review_required",
] as const;
export type MemoryMergeStrategy = (typeof mergeStrategies)[number];

export const lifecycleStates = ["active", "expired", "revoked", "retired"] as const;
export type MemoryLifecycleState = (typeof lifecycleStates)[number];

export type GlassboxMemoryScope = { type: "global" } | { type: "project"; projectId: string };

export interface MemorySubject {
  kind: "user" | "agent" | "org" | "task" | "session" | "custom";
  id: string;
}

export interface MemorySource {
  kind: "chat" | "tool" | "document" | "human" | "system" | "external";
  ref: string;
}

export interface MemoryEvidence {
  evidenceId: string;
  kind:
    | "chat_message"
    | "tool_result"
    | "document_excerpt"
    | "external_record"
    | "user_confirmation"
    | "system_inference"
    | "human_annotation";
  ref: string;
  excerpt?: string;
  capturedAt: string;
  trustLevel?: "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
}

export interface MemoryMergeHint {
  strategy: MemoryMergeStrategy;
  dedupeKey?: string;
  conflictKey?: string;
  idempotencyKey?: string;
  ifMatchMemoryId?: string;
  ifMatchUpdatedAt?: string;
  sourcePriority?: number;
  reinforcementWeight?: number;
  coalesceWindowSeconds?: number;
}

export interface MemoryCandidate {
  candidateId: string;
  candidateKind: MemoryCandidateKind;
  subject: MemorySubject;
  scope: GlassboxMemoryScope;
  proposedType: MemoryType;
  statement: string;
  content: Record<string, unknown>;
  source: MemorySource;
  sourceEvidence: MemoryEvidence[];
  confidence?: number;
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
  retentionPolicy?: string;
  ttlSeconds?: number;
  mergeHint: MemoryMergeHint;
  extensions: Record<string, unknown>;
  status: "pending" | "promoted" | "rejected";
  createdAt: string;
  reviewedAt?: string;
  promotedMemoryId?: string;
}

export interface RetentionFactors {
  emotion: number;
  goalRelevance: number;
  valueAlignment: number;
  selfRelevance: number;
  taskUtility: number;
  reliability: number;
  usage: number;
}

export interface CanonicalMemory {
  memoryId: string;
  subject: MemorySubject;
  scope: GlassboxMemoryScope;
  type: MemoryType;
  content: Record<string, unknown>;
  source: MemorySource;
  confidence?: number;
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
  retentionPolicy?: string;
  ttlSeconds?: number;
  createdAt: string;
  updatedAt: string;
  assertionMode: "asserted" | "confirmed" | "inferred" | "derived" | "imported" | "observed";
  assertedBy: MemorySubject;
  confirmedByUser: boolean;
  evidenceRefs: string[];
  evidence: MemoryEvidence[];
  derivedFrom: string[];
  extensions: Record<string, unknown>;
  signature: string;
  lifecycleState: MemoryLifecycleState;
  freshness: "fresh" | "stale" | "expired";
  expiresAt?: string;
  disabledAt?: string;
  supersedes: string[];
  useCount: number;
  lastUsedAt?: string;
  retentionFactors: RetentionFactors;
  retentionValue: number;
}

export const feedbackSignals = [
  "accept",
  "reject",
  "edit",
  "revert",
  "explicit_positive",
  "explicit_negative",
] as const;
export type FeedbackSignal = (typeof feedbackSignals)[number];

export interface FeedbackEvent {
  id: string;
  principalId: string;
  scope: GlassboxMemoryScope;
  signalType: FeedbackSignal;
  statement: string;
  category?: string;
  conversationId?: string;
  runId?: string;
  taskId?: string;
  artifactRef?: string;
  evidence: MemoryEvidence;
  createdAt: string;
  candidateId: string;
}

export interface LearningOperationContext {
  caller: import("../identity/scope.js").CallerContext;
  conversationId?: string;
  runId?: string;
}

export interface ExtractedMemoryDecision {
  action: "create" | "update" | "retire";
  type: "semantic_fact" | "episodic_event";
  statement: string;
  content?: Record<string, unknown>;
  confidence?: number;
  existingMemoryId?: string;
}

export interface MemoryExtractor {
  extract(input: {
    messages: readonly { role: string; text: string; ref: string }[];
    existing: readonly CanonicalMemory[];
  }): Promise<readonly ExtractedMemoryDecision[]>;
}
