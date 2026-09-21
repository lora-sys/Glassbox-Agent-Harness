/**
 * Exact-term retrieval discipline.
 *
 * Lexical search treats a query as a bag of tokens, which is right for prose and wrong for
 * an identifier. `P4B-A-1349` tokenizes to `p4b`, `a`, `1349`; a message that mentions only
 * `1349` shares a token with the query, scores above zero, and arrives in the result list
 * looking exactly like the message that really carries the identifier. The model has no way
 * to tell the two apart, and the identifier is already in the Conversation, so the answer it
 * composes reads like a confirmed observation while resting on nothing.
 *
 * An identifier is a term whose value is arbitrary rather than descriptive: you either find
 * that exact string or you did not find it. Partial overlap is not weak evidence of it, it is
 * a different term. So a query that carries one is answered by containment, not by tokens.
 *
 * The rule is deliberately narrow. Widening it to any alphanumeric run would turn ordinary
 * searches — `iOS18`, `v2`, a year — into containment searches and answer "not found" for
 * messages that really are about the question. Narrowing it to the one shape that caused the
 * incident would leave the rest of the class in place.
 */

/** A run of identifier characters. The leading character is never a separator. */
const IDENTIFIER_RUN = /[A-Za-z0-9][A-Za-z0-9._-]*/gu;

/** A separator between identifier segments, or a trailing one a sentence added. */
const SEPARATOR = /[._-]/u;

/** Characters that continue an identifier, so a match inside one is not a match. */
const IDENTIFIER_CHARACTER = /[a-z0-9._-]/u;

/**
 * Below this, a run is a label rather than an identifier: `v2`, `a1`, `第1`.
 *
 * Not a tuned threshold. It is the point below which a run is short enough that a message
 * sharing it is more likely to be about something else than about this exact value.
 */
const MIN_IDENTIFIER_LENGTH = 4;

/**
 * A bare digit run only addresses a record once it is long enough to be one.
 *
 * `1349` is a quantity or a year and belongs to prose; `1234567890` is a QQ number or an
 * order id, and a message that merely contains those digits is not the message it names.
 */
const MIN_BARE_DIGIT_RUN = 6;

function isIdentifierTerm(run: string): boolean {
  if (run.length < MIN_IDENTIFIER_LENGTH) return false;
  if (!/\d/u.test(run)) return false;
  // Segmented values are arbitrary by construction: `P4B-A-1349`, `v1.2.3`, `order_123`.
  if (SEPARATOR.test(run)) return true;
  return /^\d+$/u.test(run) && run.length >= MIN_BARE_DIGIT_RUN;
}

/**
 * The arbitrary-value terms a query carries, lowercased and deduplicated in query order.
 *
 * Empty for a prose query, which is the signal that the search needs no containment rule.
 */
export function exactTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(IDENTIFIER_RUN)) {
    // A sentence's own punctuation is not part of the value it names.
    const run = match[0].replace(/[._-]+$/u, "");
    if (!isIdentifierTerm(run)) continue;
    const term = run.toLowerCase();
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

/** Whether `text` carries one occurrence of `term` that is not part of a longer identifier. */
function carriesTerm(text: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at === -1) return false;
    const before = at === 0 ? undefined : text[at - 1];
    const after = text[at + term.length];
    const bounded = (character: string | undefined) =>
      character === undefined || !IDENTIFIER_CHARACTER.test(character);
    if (bounded(before) && bounded(after)) return true;
    from = at + 1;
  }
}

/**
 * Whether a candidate's own text carries every identifier the query named.
 *
 * A candidate that fails this was never a match, so dropping it is not truncation and does
 * not make the search partial. `text` is the content the model is shown: an identifier that
 * appears only in a field the answer cannot disclose would leave the model reading a hit
 * that does not contain the thing it was asked about.
 */
export function carriesEveryExactTerm(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = text.toLowerCase();
  return terms.every((term) => carriesTerm(haystack, term));
}
