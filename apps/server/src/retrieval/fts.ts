/**
 * Ported / adapted from TokenRhythm/opensquilla
 * Upstream repository: https://github.com/TokenRhythm/opensquilla.git
 * Pinned commit: 75a7085960ee57bc7a17acde5ce08071af4e7632
 * Original source paths:
 *   - src/opensquilla/memory/store.py (_segment_for_fts, _fallback_segment_for_fts,
 *     _JIEBA_SEGMENT_RANGES, _needs_jieba_segmentation, _build_fts_query, _bm25_to_score)
 * License: Apache-2.0
 *
 * Ported behavior: FTS5 lexical search helpers for a unicode61 index.
 *  - CJK / kana runs are segmented before indexing and before querying so the two
 *    sides stay symmetric. Upstream prefers jieba when importable; Glassbox ports
 *    the documented no-jieba fallback (single-character segmentation of CJK runs)
 *    because jieba is a Python-only dependency.
 *  - Query building prefers multi-character tokens, falls back to single characters,
 *    quotes every token, and joins with OR. Quoting keeps the FTS5 MATCH expression
 *    injection-safe because a double quote can never appear inside a token.
 *  - BM25 rank (negative is better) is converted to a [0,1] score.
 *
 * Glassbox-specific changes: none to the algorithm. The store that uses these helpers
 * is a Glassbox channel archive rather than an OpenSquilla memory store.
 */

const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/gu;

/** Han + Japanese kana ranges written without word spaces. Excludes Hangul. */
const SEGMENT_RANGES: readonly (readonly [number, number])[] = [
  [0x4e00, 0x9fff],
  [0x3040, 0x309f],
  [0x30a0, 0x30ff],
  [0x3400, 0x4dbf],
  [0xf900, 0xfaff],
];

export function needsSegmentation(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return SEGMENT_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

function segmentRun(run: string): string {
  return Array.from(run).join(" ");
}

/** Segment ideographic / kana runs so unicode61 FTS5 tokenizes them. */
export function segmentForFts(text: string): string {
  if (!Array.from(text).some(needsSegmentation)) return text;
  return text
    .replace(CJK_RUN, (run) => ` ${segmentRun(run)} `)
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Convert a user query into an FTS5 OR query. Returns null when the query holds
 * no usable token, which the caller treats as "no lexical match".
 */
export function buildFtsQuery(query: string): string | null {
  const segmented = segmentForFts(query);
  // Python's `\w` under re.UNICODE is Unicode letters + digits (+ underscore). JavaScript's
  // `\w` is ASCII-only, so the port uses property escapes to keep CJK tokens matchable.
  let tokens = segmented.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (tokens.length === 0) tokens = segmented.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  const phrases = segmented.match(/[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+/gu) ?? [];
  const quoted = [
    ...phrases.map((phrase) => `"${phrase}"`),
    ...tokens.map((token) => `"${token}"`),
  ];
  return quoted.join(" OR ");
}

/** Convert BM25 rank (negative = better) to a [0,1] score. */
export function bm25ToScore(rank: number): number {
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1.0 + relevance);
  }
  return 1.0 / (1.0 + rank);
}
