/**
 * The clearance phrasing rule, as code. ONE definition, used everywhere.
 *
 * CLAUDE.md states it as a hard constraint on wording in every resume, cover
 * note, outreach draft, form answer and interview-prep answer the tool ever
 * produces:
 *
 *   MAY say — US citizen, no sponsorship needed; no current or prior clearance;
 *   no known disqualifying factors; willing to undergo the process.
 *
 *   MAY NEVER say — that he is "cleared", holds "an active clearance", is
 *   "clearance-eligible" or "eligible for TS/SCI", or anything else that reads
 *   as an adjudicated result. Eligibility is decided by a government
 *   adjudicator, not by the candidate. Asserting it is a false claim on a
 *   defense application, which is the highest-stakes place in this pipeline to
 *   get wrong.
 *
 * WHY THIS FILE EXISTS RATHER THAN A REGEX IN EACH TEST. It was four regexes in
 * four test files — test_why, test_lifecycle, test_sf86, test_writes — each
 * written separately, each covering slightly different phrasings, and each able
 * to rot on its own. One of them did: its `\b` escapes collapsed into literal
 * 0x08 bytes through a shell heredoc, so it matched nothing and passed whatever
 * the page said, for weeks. Nobody could have noticed by reading the file,
 * because the character is invisible.
 *
 * A rule enforced in four places is a rule with four chances to die quietly.
 * This is the one place. It has its own tests, including a proof that it
 * catches every forbidden phrasing and clears every permitted one — so if it
 * ever goes inert again, that failure is loud and immediate rather than a
 * silent green.
 */

/**
 * Phrasings that assert a determination nobody has made.
 *
 * Written as an array of sources joined at construction, so each line is
 * readable and a new one is a one-line addition rather than an edit to a long
 * literal — the shape that invited the mangling in the first place.
 */
/**
 * Flat assertions. NEVER excusable by a preceding negator.
 *
 * "is cleared" negated is "is not cleared", which does not match this pattern
 * in the first place — so there is no legitimate sentence where one of these
 * appears behind a "no". Keeping them un-negatable means the negation handling
 * below cannot become a hole in the half of the rule that matters most.
 */
const ASSERTION_SOURCES = [
  String.raw`\bis cleared\b`,
  String.raw`\bare cleared\b`,
  String.raw`\byou'?re cleared\b`,
  String.raw`\bclearance[- ]eligible\b`,
  String.raw`\byou are eligible\b`,
  String.raw`\byou'?re eligible\b`,
  String.raw`\beligibility (?:has been |is )?(?:confirmed|established|granted)\b`,
  String.raw`\bwould be granted\b`,
  String.raw`\bcleared to (?:ts\/sci|top secret|secret)\b`,
];

/**
 * Possession and eligibility NOUN PHRASES, which are forbidden as a claim and
 * REQUIRED as a denial.
 *
 * CLAUDE.md permits exactly this: "that he holds no current or prior
 * clearance". So "I have no active clearance" is not merely allowed, it is the
 * sentence the tool is supposed to write — and it was being flagged, because
 * the pattern matched the noun phrase without looking at the word in front of
 * it. See the negation handling in forbiddenClaim.
 */
const POSSESSION_SOURCES = [
  String.raw`\bactive clearance\b`,
  String.raw`\bcurrent clearance\b`,
  String.raw`\bholds? (?:a |an )?(?:active |current )?(?:ts\/sci|top secret|secret) clearance\b`,
  String.raw`\beligible for (?:a |an )?(?:ts\/sci|ts|top secret|secret|security) clearance\b`,
];

export const FORBIDDEN_SOURCES = [...ASSERTION_SOURCES, ...POSSESSION_SOURCES];

export const FORBIDDEN = new RegExp(FORBIDDEN_SOURCES.join("|"), "i");
const POSSESSION = new RegExp(POSSESSION_SOURCES.join("|"), "i");

/**
 * A denial immediately before the phrase.
 *
 * Anchored with `$` and limited to two intervening words, so it reads only the
 * words actually attached to the phrase — "I do not have a current clearance"
 * is negator + "have" + "a". A wider window would excuse "there is no doubt
 * that he holds a secret clearance", which is the bypass this must not become;
 * that sentence is why the assertions above are exempt from negation entirely.
 */
const NEGATOR = /\b(?:no|not|never|without|lacks?|lacking|nor)\b(?:\s+\w+){0,2}\s*$/i;

/**
 * Does this text make a claim nobody is entitled to make?
 *
 * Returns the offending phrase, or null. The PHRASE rather than a boolean,
 * because a test that says "the export claims a clearance" and cannot say where
 * is a test somebody has to re-derive by hand at the worst possible moment.
 */
export function forbiddenClaim(text) {
  const s = String(text || "");
  // Every match, not just the first: a note may deny one clearance phrase and
  // then assert another, and `.match` without /g would stop at the denial and
  // report the sentence clean. Scanning the lot is the only version that
  // cannot be walked past.
  const all = new RegExp(FORBIDDEN.source, "gi");
  for (let m = all.exec(s); m; m = all.exec(s)) {
    // A DENIAL IS NOT A CLAIM. "I have no active clearance" is the sentence
    // CLAUDE.md permits; only possession phrases are negatable, so a stray
    // negator cannot excuse "is cleared".
    if (POSSESSION.test(m[0]) && NEGATOR.test(s.slice(0, m.index))) continue;
    return m[0];
  }
  return null;
}

/**
 * The sentence the tool is allowed to say, verbatim.
 *
 * Exported so a surface that needs to state the position can use this rather
 * than paraphrase it — CLAUDE.md's instruction is "use those, and do not
 * paraphrase them upward", and a paraphrase is exactly how "willing to undergo
 * the process" becomes "eligible".
 */
export const PERMITTED_STATEMENT =
  "US citizen, no current or prior clearance, no known disqualifying factors, "
  + "willing to undergo the process.";
