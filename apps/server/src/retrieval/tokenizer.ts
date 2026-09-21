/**
 * Ported / adapted from:
 * 1. HKUDS/OpenHarness
 *    Upstream repository: https://github.com/HKUDS/OpenHarness.git
 *    Pinned commit: 9b2efd795c6aa09f88b0c257d269a9e518da6ae7
 *    Original source path: src/openharness/memory/search.py (_tokenize)
 *    License: MIT
 * 2. TokenRhythm/opensquilla
 *    Upstream repository: https://github.com/TokenRhythm/opensquilla.git
 *    Pinned commit: 75a7085960ee57bc7a17acde5ce08071af4e7632
 *    Original source path: src/opensquilla/memory/retrieval.py (_jaccard_similarity)
 *    License: Apache-2.0
 * Ported behavior: Tokenization for mixed ASCII words and Han/CJK ideographs,
 * token-level Jaccard similarity for MMR diversity reranking.
 */

/**
 * Extract search tokens from text, handling ASCII and Han/CJK ideographs.
 * Matches OpenHarness and OpenSquilla token extraction.
 */
export function tokenizeText(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;

  const lower = text.toLowerCase();

  // ASCII words (sequences of letters/digits)
  const asciiMatches = lower.match(/[a-z0-9_]+/gu);
  if (asciiMatches) {
    for (const match of asciiMatches) {
      if (match.length > 0) {
        tokens.add(match);
      }
    }
  }

  // Han / CJK ideographs
  const cjkChars = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff]/gu);
  if (cjkChars) {
    for (let i = 0; i < cjkChars.length; i++) {
      tokens.add(cjkChars[i]!);
      if (i < cjkChars.length - 1) {
        tokens.add(cjkChars[i]! + cjkChars[i + 1]!);
      }
    }
  }

  return tokens;
}

/**
 * Token-level Jaccard similarity for MMR diversity.
 * Ported from OpenSquilla _jaccard_similarity.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenizeText(a);
  const tb = tokenizeText(b);

  if (ta.size === 0 && tb.size === 0) return 1.0;
  if (ta.size === 0 || tb.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = ta.size + tb.size - intersectionSize;
  return unionSize === 0 ? 0.0 : intersectionSize / unionSize;
}
