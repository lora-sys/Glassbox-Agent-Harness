/**
 * Ported / adapted from:
 * 1. TokenRhythm/opensquilla
 *    Upstream repository: https://github.com/TokenRhythm/opensquilla.git
 *    Pinned commit: 75a7085960ee57bc7a17acde5ce08071af4e7632
 *    Original source paths:
 *      - src/opensquilla/memory/retrieval.py (MemoryRetriever, _temporal_decay, _mmr_rerank, _rank_score)
 *      - src/opensquilla/memory/types.py (MemorySearchOpts, MemorySearchResult)
 *    License: Apache-2.0
 * 2. HKUDS/OpenHarness
 *    Upstream repository: https://github.com/HKUDS/OpenHarness.git
 *    Pinned commit: 9b2efd795c6aa09f88b0c257d269a9e518da6ae7
 *    Original source paths:
 *      - src/openharness/memory/search.py (find_relevant_memories, _recency_boost)
 *      - src/openharness/memory/relevance.py
 *    License: MIT
 * 3. HKUDS/MGP
 *    Upstream repository: https://github.com/HKUDS/MGP.git
 *    Pinned commit: 54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10
 *    Original source paths:
 *      - spec/search-results.md (SearchResultItem shape, metadata_only safe text, return modes)
 *      - schemas/search-result-item.schema.json
 *    License: MIT
 *
 * Glassbox-specific changes:
 * - Default configuration: vector_weight = 0, text_weight = 1 (pure lexical with hybrid-ready interface)
 * - Strict source filtering before candidate loading: store is only queried with pre-authorized source IDs
 * - Output items map directly into MGP-compatible SearchResultItem
 */

import type {
  SearchResultItem,
  ScoreKind,
  RetrievalMode,
  ReturnMode,
  RedactionInfo,
} from "@glassbox/contracts";
import { jaccardSimilarity, tokenizeText } from "./tokenizer.js";

export interface RetrievalCandidate {
  id: string;
  sourceId: string;
  sourceKind: string;
  text: string;
  timestamp: string;
  isEvergreen?: boolean;
  sensitivity?: "public" | "internal" | "restricted";
  returnMode?: ReturnMode;
  metadata?: Record<string, unknown>;
}

export interface RetrievalCandidateStore {
  searchCandidates(params: {
    query: string;
    allowedSourceIds: readonly string[];
    limit?: number;
    since?: string;
    until?: string;
    metadataFilters?: Readonly<Record<string, string>>;
  }): Promise<RetrievalCandidate[]>;
}

export interface MemorySearchOpts {
  allowedSourceIds: readonly string[];
  limit?: number;
  since?: string;
  until?: string;
  minScore?: number;
  metadataFilters?: Readonly<Record<string, string>>;
}

export interface MemoryRetrieverOptions {
  store: RetrievalCandidateStore;
  backendOrigin?: string;
  temporalDecayEnabled?: boolean;
  halfLifeDays?: number;
  mmrEnabled?: boolean;
  mmrLambda?: number;
  vectorWeight?: number;
  textWeight?: number;
  sourceWeights?: Record<string, number>;
  dedupeDuplicates?: boolean;
}

export class MemoryRetriever {
  readonly vectorWeight: number;
  readonly textWeight: number;
  readonly backendOrigin: string;

  private readonly store: RetrievalCandidateStore;
  private readonly temporalDecayEnabled: boolean;
  private readonly halfLifeDays: number;
  private readonly mmrEnabled: boolean;
  private readonly mmrLambda: number;
  private readonly sourceWeights: Record<string, number>;
  private readonly dedupeDuplicates: boolean;

  constructor(options: MemoryRetrieverOptions) {
    this.store = options.store;
    this.backendOrigin = options.backendOrigin ?? "glassbox-retrieval";
    // Defaults: vector_weight = 0, text_weight = 1 (pure lexical initial implementation)
    this.vectorWeight = options.vectorWeight ?? 0;
    this.textWeight = options.textWeight ?? 1;
    this.temporalDecayEnabled = options.temporalDecayEnabled ?? false;
    this.halfLifeDays = options.halfLifeDays ?? 30;
    this.mmrEnabled = options.mmrEnabled ?? false;
    this.mmrLambda = options.mmrLambda ?? 0.7;
    this.sourceWeights = options.sourceWeights ?? {};
    this.dedupeDuplicates = options.dedupeDuplicates ?? true;
  }

  async search(
    query: string,
    opts: MemorySearchOpts,
  ): Promise<SearchResultItem<RetrievalCandidate>[]> {
    // Security invariant: source filtering before candidate loading.
    // If no sources are authorized, return empty immediately without querying store.
    if (!opts.allowedSourceIds || opts.allowedSourceIds.length === 0) {
      return [];
    }

    const limit = opts.limit ?? 10;
    const overFetchLimit = Math.min(200, limit * 10);

    // Over-fetch candidates inside authorized source set only
    const candidates = await this.store.searchCandidates({
      query,
      allowedSourceIds: opts.allowedSourceIds,
      limit: overFetchLimit,
      since: opts.since,
      until: opts.until,
      metadataFilters: opts.metadataFilters,
    });

    if (candidates.length === 0) {
      return [];
    }

    const queryTokens = tokenizeText(query);
    const now = Date.now();
    const seenTexts = new Set<string>();

    interface ScoredCandidate {
      candidate: RetrievalCandidate;
      score: number;
      matchedTerms: string[];
    }

    const scored: ScoredCandidate[] = [];

    for (const candidate of candidates) {
      // Duplicate suppression
      if (this.dedupeDuplicates) {
        const normalized = candidate.text.trim().toLowerCase();
        if (seenTexts.has(normalized)) {
          continue;
        }
        seenTexts.add(normalized);
      }

      // Time bounds check
      if (opts.since && candidate.timestamp < opts.since) continue;
      if (opts.until && candidate.timestamp > opts.until) continue;

      // Lexical scoring (metadata 2x, body 1x)
      const bodyTokens = tokenizeText(candidate.text);
      const matchedTerms: string[] = [];

      let metaHits = 0;
      if (candidate.metadata) {
        const metaStr = Object.values(candidate.metadata)
          .filter((v): v is string => typeof v === "string")
          .join(" ");
        const metaTokens = tokenizeText(metaStr);
        for (const token of queryTokens) {
          if (metaTokens.has(token)) {
            metaHits++;
            if (!matchedTerms.includes(token)) matchedTerms.push(token);
          }
        }
      }

      let bodyHits = 0;
      for (const token of queryTokens) {
        if (bodyTokens.has(token)) {
          bodyHits++;
          if (!matchedTerms.includes(token)) matchedTerms.push(token);
        }
      }

      // Base lexical score
      let score = metaHits * 2.0 + bodyHits;
      if (score === 0 && queryTokens.size > 0) {
        // Fallback: minimal non-zero if candidate was returned by store
        score = 0.1;
      }

      // Temporal decay (OpenSquilla exponential decay)
      if (this.temporalDecayEnabled && !candidate.isEvergreen) {
        const parsedTime = Date.parse(candidate.timestamp);
        if (!Number.isNaN(parsedTime)) {
          const ageDays = (now - parsedTime) / (1000 * 60 * 60 * 24);
          if (ageDays > 0) {
            const lam = Math.LN2 / this.halfLifeDays;
            score *= Math.exp(-lam * ageDays);
          }
        }
      }

      // Source weighting (OpenSquilla source weights)
      const weight = this.sourceWeights[candidate.sourceId] ?? 1.0;
      score *= weight;

      if (opts.minScore !== undefined && score < opts.minScore) {
        continue;
      }

      scored.push({ candidate, score, matchedTerms });
    }

    if (scored.length === 0) {
      return [];
    }

    // MMR diversity reranking or score sorting
    let selected: ScoredCandidate[] = [];

    if (this.mmrEnabled && scored.length > 1) {
      selected = this.mmrRerank(scored, this.mmrLambda, limit);
    } else {
      scored.sort((a, b) => b.score - a.score);
      selected = scored.slice(0, limit);
    }

    // Normalize max score if positive
    const maxScore = Math.max(...selected.map((s) => s.score), 1.0);

    // Format into MGP-compatible SearchResultItem
    return selected.map((s) => {
      const returnMode: ReturnMode = s.candidate.returnMode ?? "raw";
      const isMetadataOnly = returnMode === "metadata_only";

      // The placeholder names no identifier: `consumable_text` is model-visible, and a
      // withheld item's internal record id is exactly the kind of implementation identifier
      // a Delivery Gate refuses when a model copies it into an answer.
      const consumableText = isMetadataOnly
        ? "[Result metadata only due to policy]"
        : s.candidate.text;

      const matchedTerms = isMetadataOnly ? [] : s.matchedTerms;

      const explanation = isMetadataOnly
        ? "Result metadata only due to policy."
        : "Matched lexical terms against source content.";

      const redactionInfo: RedactionInfo | null = isMetadataOnly
        ? {
            policy_view: returnMode,
            reason_code: "policy_metadata_only",
            summary_generated: false,
          }
        : null;

      const normalizedScore = maxScore > 0 ? Number((s.score / maxScore).toFixed(4)) : s.score;

      return {
        memory: s.candidate,
        score: normalizedScore,
        score_kind: "normalized" as ScoreKind,
        backend_origin: this.backendOrigin,
        retrieval_mode: "lexical" as RetrievalMode,
        return_mode: returnMode,
        redaction_info: redactionInfo,
        consumable_text: consumableText,
        matched_terms: matchedTerms,
        explanation,
      };
    });
  }

  /**
   * Maximal Marginal Relevance re-ranking.
   * Ported from OpenSquilla _mmr_rerank.
   */
  private mmrRerank(
    candidates: { candidate: RetrievalCandidate; score: number; matchedTerms: string[] }[],
    lambda: number,
    k: number,
  ): { candidate: RetrievalCandidate; score: number; matchedTerms: string[] }[] {
    if (candidates.length <= 1) {
      return candidates.slice(0, k);
    }

    const maxScore = Math.max(...candidates.map((c) => c.score), 0.0001);
    const remaining = [...candidates];
    const selected: { candidate: RetrievalCandidate; score: number; matchedTerms: string[] }[] = [];

    while (remaining.length > 0 && selected.length < k) {
      if (selected.length === 0) {
        // Pick best score first
        let bestIdx = 0;
        for (let i = 1; i < remaining.length; i++) {
          if (remaining[i]!.score > remaining[bestIdx]!.score) {
            bestIdx = i;
          }
        }
        selected.push(remaining.splice(bestIdx, 1)[0]!);
      } else {
        let bestScore = -Infinity;
        let bestIdx = 0;

        for (let i = 0; i < remaining.length; i++) {
          const cand = remaining[i]!;
          const normScore = cand.score / maxScore;

          let maxSim = 0;
          for (const sel of selected) {
            const sim = jaccardSimilarity(cand.candidate.text, sel.candidate.text);
            if (sim > maxSim) maxSim = sim;
          }

          const mmr = lambda * normScore - (1 - lambda) * maxSim;
          if (mmr > bestScore) {
            bestScore = mmr;
            bestIdx = i;
          }
        }

        selected.push(remaining.splice(bestIdx, 1)[0]!);
      }
    }

    return selected;
  }
}
