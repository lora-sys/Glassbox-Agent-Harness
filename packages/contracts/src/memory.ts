/**
 * Canonical durable Memory boundary shared by P4A writers and P4B readers.
 *
 * The shape is derived from the MGP Memory object and evidence contracts. Glassbox adds
 * explicit global or project scope, lifecycle state, retention factors, and source lineage.
 * Retrieval code may consume this contract without importing the P4A store or learning logic.
 */

export const memoryTypes = [
  "preference",
  "semantic_fact",
  "episodic_event",
  "relationship",
] as const;
export type MemoryType = (typeof memoryTypes)[number];

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
