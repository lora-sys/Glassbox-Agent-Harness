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
 * Both sides of that comparison read a value through the same rule. A message carrying the
 * query's own text must be a match for it, and it is not one if naming a value and recognizing
 * it disagree about where the value ends or about the width it was typed in.
 *
 * The rule is deliberately narrow. Widening it to any alphanumeric run would turn ordinary
 * searches — `iOS18`, `v2`, a year — into containment searches and answer "not found" for
 * messages that really are about the question. Narrowing it to the one shape that caused the
 * incident would leave the rest of the class in place.
 *
 * Narrow also means a value has to be arbitrary rather than descriptive. `2026-09-18` names a
 * day, and every spelling of that day is the same day, so it is prose; `v1.2.3` names a release
 * and is not. The letter is what separates them, and it is why a digit-only segmented run is
 * left to the ordinary token search.
 */

/** A run of identifier characters. The leading character is never a separator. */
const IDENTIFIER_RUN = /[A-Za-z0-9][A-Za-z0-9._-]*/gu;

/** The full-width forms of the ASCII identifier characters, and the ideographic space. */
const FULL_WIDTH = /[！-～　]/gu;

/** The offset between a full-width ASCII character and the ASCII character it stands for. */
const FULL_WIDTH_OFFSET = 0xfee0;

/**
 * The text with full-width characters folded to their ASCII form.
 *
 * Width is a property of how a value was typed, not of the value. A Chinese input method emits
 * `Ｐ4B-A-１３４９` for the identifier `P4B-A-1349`, and the fold has to happen before the run is
 * read, because a full-width character inside the run ends it there: the query named `4b-a-1349`
 * and the message carrying the identifier was not a match for it. Reading both sides through
 * this one fold means the width a side used cannot decide whether a value was found.
 */
function folded(text: string): string {
  return text.replace(FULL_WIDTH, (character) =>
    character === "　" ? " " : String.fromCharCode(character.charCodeAt(0) - FULL_WIDTH_OFFSET),
  );
}

/** A separator between identifier segments, or a trailing one a sentence added. */
const SEPARATOR = /[._-]/u;

/** The separators a run ends with, which the sentence contributed rather than the value. */
const TRAILING_SEPARATORS = /[._-]+$/u;

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
  // A segmented value is arbitrary only when it carries a letter: `P4B-A-1349`, `v1.2.3`,
  // `order_123`. A digit-only segmented run is a date or a range — `2026-09-18`, `10-20` —
  // which describes a day rather than naming a value, and every spelling of that day is the
  // same day. Requiring one spelling verbatim would answer "not found" for messages that really
  // are about the question, which is what the narrow rule exists to prevent.
  if (SEPARATOR.test(run)) return /[A-Za-z]/u.test(run);
  return /^\d+$/u.test(run) && run.length >= MIN_BARE_DIGIT_RUN;
}

/**
 * The value one identifier run names: lowercased, without the separators the sentence added.
 *
 * Both sides of the search read a run through this one function. Naming a value and recognizing
 * it have to be the same rule, or a message carrying the query's own text is not a match for it:
 * the query side dropped a trailing separator as the sentence's, while the candidate side asked
 * for a non-identifier character after the term, so `见 P4B-A-1349.` named `p4b-a-1349` and a
 * message ending with exactly that text was dropped as a different value. The search then
 * answered "not found" for a message that is really there — the wrong answer the containment
 * rule exists to prevent, arriving from the other direction.
 *
 * A separator ends the value only when nothing but separators follow it: `P4B-A-1349.` is the
 * identifier and a full stop, while `P4B-A-1349.2` is one longer value.
 */
function identifierValue(run: string): string {
  return run.replace(TRAILING_SEPARATORS, "").toLowerCase();
}

/**
 * The arbitrary-value terms a query carries, lowercased and deduplicated in query order.
 *
 * Empty for a prose query, which is the signal that the search needs no containment rule.
 */
export function exactTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of folded(query).matchAll(IDENTIFIER_RUN)) {
    const term = identifierValue(match[0]);
    if (!isIdentifierTerm(term)) continue;
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

/**
 * Whether a candidate's own text carries every identifier the query named.
 *
 * Read with the same boundary rule that named the terms, so a candidate carrying one of them is
 * recognized however the sentence around it is punctuated. A candidate that fails this carries a
 * different value, so dropping it is not truncation and does not make the search partial. `text`
 * is the content the model is shown: an identifier that appears only in a field the answer
 * cannot disclose would leave the model reading a hit that does not contain the thing it was
 * asked about.
 */
export function carriesEveryExactTerm(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const carried = new Set<string>();
  for (const match of folded(text).matchAll(IDENTIFIER_RUN)) carried.add(identifierValue(match[0]));
  return terms.every((term) => carried.has(term));
}
