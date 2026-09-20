/**
 * Ported / adapted from HKUDS/MGP
 * Upstream repository: https://github.com/HKUDS/MGP.git
 * Pinned commit: 54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10
 * Original source paths:
 *   - schemas/recall-intent.schema.json
 *   - schemas/search-memory.request.schema.json
 *   - schemas/search-memory.response.schema.json
 *   - schemas/search-result-item.schema.json
 *   - schemas/retrieval-mode.schema.json
 *   - schemas/return-mode.schema.json
 *   - schemas/score-kind.schema.json
 *   - schemas/redaction-info.schema.json
 *   - spec/search-results.md
 * License: MIT
 * Ported behavior: Normalized RecallIntent, Search request/response, SearchResultItem,
 * and retrieval metadata (ScoreKind, RetrievalMode, ReturnMode, RedactionInfo).
 * Glassbox-specific changes: Map subjects and scopes onto Glassbox Principal / Scope / Resource
 * identity rather than using MGP policy engine as authority.
 */

export type ScoreKind = "backend_local" | "normalized" | "comparable";

export type RetrievalMode = "lexical" | "semantic" | "hybrid" | "graph" | "direct_lookup";

export type ReturnMode = "raw" | "summary" | "masked" | "metadata_only";

export interface RedactionInfo {
  /** MGP requires the effective access-control view that produced this item. */
  policy_view?: ReturnMode;
  reason_code?: string;
  masked_fields?: readonly string[];
  transformed_fields?: readonly string[];
  summary_generated?: boolean;
  explanation?: string;
}

export type IntentType =
  | "free_text"
  | "fact_lookup"
  | "preference_lookup"
  | "relationship_lookup"
  | "episodic_lookup"
  | "semantic_lookup"
  | "direct_lookup";

export interface TimeScope {
  since?: string;
  until?: string;
  include_expired?: boolean;
}

export interface RecallIntent {
  query_text: string;
  intent_type?: IntentType;
  keywords?: readonly string[];
  target_memory_types?: readonly string[];
  subject?: {
    kind: string;
    id: string;
  };
  scope?: string;
  time_scope?: TimeScope;
  top_k?: number;
  pagination_token?: string;
  timeout_ms?: number;
}

export interface SearchResultItem<T = unknown> {
  memory: T;
  score: number;
  score_kind: ScoreKind;
  backend_origin: string;
  retrieval_mode: RetrievalMode;
  return_mode: ReturnMode;
  redaction_info: RedactionInfo | null;
  consumable_text: string;
  matched_terms?: readonly string[];
  explanation?: string;
}

export interface SearchMemoryRequest {
  request_id: string;
  policy_context?: {
    actor_principal_id?: string;
    scope_key?: string;
    action?: string;
  };
  payload: {
    intent?: RecallIntent;
    query?: string;
    limit?: number;
  };
}

export interface SearchMemoryResponse<T = unknown> {
  request_id: string;
  status: "ok" | "error";
  error?: {
    code: string;
    message: string;
  } | null;
  data?: {
    results: readonly SearchResultItem<T>[];
    pagination_token?: string;
  };
}

/**
 * Authorized QQ source contract shared with P4A.
 *
 * P4B owns the QQ Capability Registry and this authorized source interface. P4A consumes
 * candidates as Memory evidence. Source enablement permits candidate generation only; it
 * never auto-promotes a source item into canonical Memory, and it never widens authority.
 */
export const QQ_SOURCE_CLASSES = [
  "history",
  "notice",
  "essence",
  "metadata",
  "file",
  "album",
] as const;

export type QqSourceClass = (typeof QQ_SOURCE_CLASSES)[number];

export interface QqSourceCandidate {
  id: string;
  /** Protected Resource the candidate was authorized under. */
  sourceId: string;
  sourceClass: QqSourceClass;
  text: string;
  occurredAt: string;
  returnMode: ReturnMode;
}

export interface AuthorizedQqSourceReader {
  /** Source classes the Owner has enabled for this managed group, intersected with
   * the classes the Principal may currently read. */
  enabledSourceClasses(connectionId: string, groupId: string): Promise<readonly QqSourceClass[]>;
  /** Candidates for one enabled class. Unauthorized or disabled classes return none. */
  readCandidates(input: {
    connectionId: string;
    groupId: string;
    sourceClass: QqSourceClass;
    query?: string;
    limit?: number;
    since?: string;
    until?: string;
  }): Promise<readonly QqSourceCandidate[]>;
}
