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

import type { SearchResultItem } from "@glassbox/contracts";

export interface BoundedContextOptions {
  /** Maximum number of items kept after capping. */
  topK?: number;
  /** Maximum items kept per source id. */
  perSourceCap?: number;
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
}

export interface BoundedContext {
  items: BoundedContextItem[];
  /** Total candidates considered before bounding. */
  considered: number;
  /** True when at least one item was dropped by a bound rather than by authorization. */
  truncated: boolean;
}

const DEFAULT_TOP_K = 8;
const DEFAULT_PER_SOURCE_CAP = 3;
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

/**
 * Bounds an already-authorized result set for model-visible Context.
 *
 * Only `consumable_text` is ever read: metadata_only results carry a policy placeholder
 * there, so a bounded Context can never re-expose text that the retriever withheld.
 */
export function selectBoundedContext(
  results: readonly SearchResultItem<unknown>[],
  options: BoundedContextOptions = {},
): BoundedContext {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const perSourceCap = options.perSourceCap ?? DEFAULT_PER_SOURCE_CAP;
  const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const surfaced = new Set(options.alreadySurfaced ?? []);

  const perSourceCounts = new Map<string, number>();
  const items: BoundedContextItem[] = [];
  let truncated = false;

  for (const result of results) {
    const id = itemId(result);
    if (id && surfaced.has(id)) {
      truncated = true;
      continue;
    }

    const sourceId = itemSourceId(result);
    const used = perSourceCounts.get(sourceId) ?? 0;
    if (used >= perSourceCap) {
      truncated = true;
      continue;
    }

    if (items.length >= topK) {
      truncated = true;
      break;
    }

    const text = result.consumable_text;
    const snippet = text.length > snippetChars ? `${text.slice(0, snippetChars)}…` : text;

    items.push({
      id,
      sourceId,
      snippet,
      score: result.score,
      occurredAt: itemTimestamp(result),
    });
    perSourceCounts.set(sourceId, used + 1);
  }

  return { items, considered: results.length, truncated };
}
