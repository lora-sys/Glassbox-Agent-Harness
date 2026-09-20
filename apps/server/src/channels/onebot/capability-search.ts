/**
 * Bounded deterministic matching for the `qq_capability_search` Tool.
 *
 * The matching is the OpenHarness-derived tokenizer the retrieval path already uses, not a
 * second search engine: the query and each entry's searchable text are tokenized the same way
 * (ASCII words plus Han ideographs), and an entry matches when it carries every query token.
 * That keeps a short Tool name and a phrase query both predictable, needs no index, no scoring
 * model and no dependency, and — because the candidate set arrives already authorized — can
 * never widen what the caller may see.
 *
 * Registry metadata is the only source of an entry's text. The description is the registry's
 * own, so the searchable surface and the Tool surface cannot drift apart.
 */

import type { QqCapabilityCategory } from "./capabilities.js";
import { tokenizeText } from "../../retrieval/tokenizer.js";

/**
 * One discoverable capability, already narrowed to what this caller may use.
 *
 * `groupIds` is the authorization result, not a request: it names only the groups where the
 * entry is currently usable, so a result can explain where a capability applies without ever
 * mentioning a group the caller is not assigned to.
 */
export interface CapabilitySearchEntry {
  tool: string;
  description: string;
  category: QqCapabilityCategory;
  readOnly: boolean;
  /** The managed groups where this entry is usable, in the inventory's own order. */
  groupIds: string[];
}

/** The text one entry is matched against. */
function searchableText(entry: CapabilitySearchEntry): string {
  return `${entry.tool} ${entry.category} ${entry.description}`;
}

/**
 * Filters entries by a bounded lexical query, preserving their incoming order.
 *
 * An absent or blank query is not a wildcard failure mode: it returns the whole authorized
 * set, which is what an Owner asking "what can you do here" needs. A query whose tokens no
 * entry carries returns nothing rather than falling back to everything, so a search that
 * matched nothing is reported as nothing.
 */
export function matchCapabilityEntries(
  entries: readonly CapabilitySearchEntry[],
  query: string | undefined,
): CapabilitySearchEntry[] {
  const trimmed = query?.trim() ?? "";
  if (trimmed === "") return [...entries];
  const wanted = tokenizeText(trimmed);
  if (wanted.size === 0) return [...entries];
  return entries.filter((entry) => {
    const tokens = tokenizeText(searchableText(entry));
    for (const token of wanted) if (!tokens.has(token)) return false;
    return true;
  });
}
