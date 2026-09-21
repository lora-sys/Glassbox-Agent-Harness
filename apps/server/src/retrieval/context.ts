/**
 * Bounded Context selection for retrieval results.
 *
 * P4B is not the P5 Context Budget Governor. This module implements only the mature
 * retrieval controls named by the active plan: Top K, per-source cap, snippet, time
 * range, and already-surfaced suppression. It never decides authorization: it operates
 * on results that a caller has already produced from an authorized source set.
 *
 * Snippet / per-source cap / already-surfaced suppression follow the OpenHarness
 * memory search presentation shape:
 *   HKUDS/OpenHarness (MIT, pinned commit 9b2efd795c6aa09f88b0c257d269a9e518da6ae7)
 *     - src/openharness/memory/search.py (per-source truncation, surfaced-set filtering)
 *   HKUDS/MGP (MIT, pinned commit 54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10)
 *     - spec/search-results.md (consumable_text is the only model-visible field)
 */

import type { ReturnMode, SearchResultItem } from "@glassbox/contracts";

export interface BoundedContextOptions {
  /** Maximum number of items kept after capping. */
  topK?: number;
  /**
   * Maximum items kept per source id, or `null` to disable the cap.
   *
   * The cap exists to keep one busy source from filling a cross-source answer. A search that
   * already targets a single source has nothing to diversify against, so capping it only
   * starves the requested limit: a single-group `limit: 8` search returned 3 items and
   * reported a bare `truncated: true`. Such a caller passes `null`.
   */
  perSourceCap?: number | null;
  /** Maximum characters of each item's consumable_text. */
  snippetChars?: number;
  /** Ids already shown to the model; suppressed from the selected Context. */
  alreadySurfaced?: readonly string[];
}

export interface BoundedContextItem {
  id: string;
  sourceId: string;
  snippet: string;
  score: number;
  occurredAt?: string;
  /** 1-based position in the bounded result. Evidence of rank, never authority. */
  rank: number;
  /**
   * The lexical terms that matched, as the retriever reported them. Empty for a
   * metadata-only result, so a bounded Context can never re-expose withheld content.
   */
  matchedTerms: string[];
  /** The MGP return mode the retriever applied to this item. */
  returnMode: ReturnMode;
}

/**
 * Why a candidate was dropped rather than selected.
 *
 * `truncated: true` alone cannot distinguish "the answer is short because the bound is
 * tight" from "the answer is short because there was nothing else". Both readings used to
 * produce the same evidence, and a model reading the bare flag can only guess.
 */
export type TruncationReason =
  | "top_k_reached"
  | "per_source_cap_reached"
  | "already_surfaced_suppressed"
  /**
   * The candidate store returned exactly the ceiling it was asked for, so more candidates may
   * exist unread. Raised by the retriever rather than by this module: the bound is on how much
   * was fetched, not on how much was kept.
   */
  | "candidate_ceiling_reached";

/** Per-source coverage of one bounded selection. */
export interface BoundedSourceCoverage {
  sourceId: string;
  /** Items from this source that survived every bound. */
  returned: number;
  /** Candidates from this source that reached the bound. */
  considered: number;
  /** True when this source lost at least one item to the per-source cap. */
  capped: boolean;
}

export interface BoundedContext {
  items: BoundedContextItem[];
  /** Total candidates considered before bounding. */
  considered: number;
  /** True when at least one item was dropped by a bound rather than by authorization. */
  truncated: boolean;
  /** Why items were dropped, deduplicated. Empty when nothing was dropped. */
  truncationReasons: TruncationReason[];
  /** How many candidates a bound dropped. */
  dropped: number;
  /** The bounds this selection actually applied, so a partial answer stays explainable. */
  bounds: {
    requestedLimit: number;
    /** `null` means the per-source cap was disabled for this selection. */
    perSourceCap: number | null;
    snippetChars: number;
  };
  /** Per-source coverage, ordered by first appearance in the candidate list. */
  sources: BoundedSourceCoverage[];
}

const DEFAULT_TOP_K = 8;
export const DEFAULT_PER_SOURCE_CAP = 3;
const DEFAULT_SNIPPET_CHARS = 240;

function itemId(item: SearchResultItem<unknown>): string {
  const memory = item.memory as { id?: unknown } | null | undefined;
  return typeof memory?.id === "string" ? memory.id : "";
}

function itemSourceId(item: SearchResultItem<unknown>): string {
  const memory = item.memory as { sourceId?: unknown } | null | undefined;
  return typeof memory?.sourceId === "string" ? memory.sourceId : "";
}

function itemTimestamp(item: SearchResultItem<unknown>): string | undefined {
  const memory = item.memory as { timestamp?: unknown } | null | undefined;
  return typeof memory?.timestamp === "string" ? memory.timestamp : undefined;
}

function itemMatchedTerms(item: SearchResultItem<unknown>): string[] {
  return Array.isArray(item.matched_terms) ? [...item.matched_terms] : [];
}

/**
 * Bounds an already-authorized result set for model-visible Context.
 *
 * Only `consumable_text` is ever read: metadata_only results carry a policy placeholder
 * there, so a bounded Context can never re-expose text that the retriever withheld.
 *
 * Every bound that drops a candidate is reported by name. A caller that needs the whole
 * requested limit from one source passes `perSourceCap: null`; the cap is a diversity
 * control, not a safety control, so disabling it never widens authority — it only stops
 * the bound from silently answering a smaller question than the one that was asked.
 */
export function selectBoundedContext(
  results: readonly SearchResultItem<unknown>[],
  options: BoundedContextOptions = {},
): BoundedContext {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const perSourceCap =
    options.perSourceCap === undefined ? DEFAULT_PER_SOURCE_CAP : options.perSourceCap;
  const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const surfaced = new Set(options.alreadySurfaced ?? []);

  const perSourceCounts = new Map<string, number>();
  const coverage = new Map<string, BoundedSourceCoverage>();
  const reasons = new Set<TruncationReason>();
  const items: BoundedContextItem[] = [];
  let dropped = 0;

  const coverageFor = (sourceId: string): BoundedSourceCoverage => {
    const existing = coverage.get(sourceId);
    if (existing) return existing;
    const created: BoundedSourceCoverage = { sourceId, returned: 0, considered: 0, capped: false };
    coverage.set(sourceId, created);
    return created;
  };

  for (const result of results) {
    const id = itemId(result);
    const sourceId = itemSourceId(result);
    const source = coverageFor(sourceId);
    source.considered++;

    if (id && surfaced.has(id)) {
      reasons.add("already_surfaced_suppressed");
      dropped++;
      continue;
    }

    const used = perSourceCounts.get(sourceId) ?? 0;
    if (perSourceCap !== null && used >= perSourceCap) {
      reasons.add("per_source_cap_reached");
      source.capped = true;
      dropped++;
      continue;
    }

    if (items.length >= topK) {
      reasons.add("top_k_reached");
      dropped++;
      continue;
    }

    const text = result.consumable_text;
    const snippet = text.length > snippetChars ? `${text.slice(0, snippetChars)}…` : text;

    items.push({
      id,
      sourceId,
      snippet,
      score: result.score,
      occurredAt: itemTimestamp(result),
      rank: items.length + 1,
      matchedTerms: itemMatchedTerms(result),
      returnMode: result.return_mode,
    });
    perSourceCounts.set(sourceId, used + 1);
    source.returned++;
  }

  return {
    items,
    considered: results.length,
    truncated: dropped > 0,
    truncationReasons: [...reasons],
    dropped,
    bounds: { requestedLimit: topK, perSourceCap, snippetChars },
    sources: [...coverage.values()],
  };
}
