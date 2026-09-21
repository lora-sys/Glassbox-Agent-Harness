import type {
  CanonicalMemory,
  GlassboxMemoryScope,
  MemoryEvidence,
  MemorySource,
  MemorySubject,
  MemoryType,
} from "@glassbox/contracts";

export { lifecycleStates, memoryTypes } from "@glassbox/contracts";
export type {
  CanonicalMemory,
  GlassboxMemoryScope,
  MemoryEvidence,
  MemoryLifecycleState,
  MemorySource,
  MemorySubject,
  MemoryType,
  RetentionFactors,
} from "@glassbox/contracts";

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
