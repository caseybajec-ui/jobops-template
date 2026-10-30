/**
 * Who to reach out to next, and why. Pure — no database, no network, no `node:`.
 *
 * THE QUESTION IT ANSWERS. A company has a role the owner would actually take and
 * they know nobody there. That gap is the highest-leverage thing in this whole
 * tool — the roles on these boards get filled through people, and the owner
 * graduates with the baked class, so relationships built now are the point and applications are
 * downstream of them. Until this page existed the gap was computable and never
 * computed: Companies could show "Find 2 names" but nothing ranked the
 * companies where finding them mattered most.
 *
 * IT RANKS COMPANIES, NOT PEOPLE, AND IT NAMES NOBODY. There are no real names
 * in here and there is no lookup that could produce one. CLAUDE.md rule 2:
 * nothing in this repository scrapes LinkedIn or any directory. Every row hands
 * the owner a SEARCH URL to open themselves, signed in as themselves, and they
 * type in what they find. That is the same gate FindNames has, on a surface that ranks.
 *
 * IT DRAFTS NOTHING BY MODEL. The message comes from DraftMessage, which fills
 * a template from fields that exist. A model writing these would produce warmth
 * it has no basis for about a stranger, which CLAUDE.md forbids outright, and
 * would do it on the one surface where being caught inventing a connection
 * costs the relationship.
 *
 * NOTHING HERE SENDS. There is no send path on this page, no address field, and
 * no code that could reach one — same as everywhere else in this tool. Copying
 * a message logs that THE OWNER copied it; the paste is the approval.
 */

/**
 * The fit floor for the queue.
 *
 * "Good" rather than "Excellent", and the reason is the population rather than
 * taste: Excellent is a narrow band and the queue exists to be worked through
 * five names a week. A floor that yields two companies is a page he opens once.
 *
 * Read as a BAND, never as a raw score. Scores here are ordinal — run-to-run
 * variance is about ±10 points — so comparing against a number would encode a
 * precision the scorer does not have. bandOf() already collapses that.
 */
export const QUEUE_BANDS = new Set(["Excellent", "Strong", "Good"]);

/**
 * Companies worth a name, best first.
 *
 * @param companies  rows from listCompanies(): { name, display_name, contacts,
 *                   best, bestTitle, bestKey, reachable40, n2027 }
 * @param bandOf     the band function, injected so this module stays pure and
 *                   has no import of its own to keep in step
 * @param namesPerCompany  the target from lib/people.js (2). A company already
 *                   at the target is done and drops out — which is what makes
 *                   this queue FINITE. A queue that refills itself occupies
 *                   whatever slot it holds forever.
 */
export function outreachQueue(companies = [], bandOf, {
  namesPerCompany = 2,
  limit = 25,
  pins = {},
  searchAs = {},
} = {}) {
  const rows = [];
  for (const c of companies || []) {
    const have = c.contacts || 0;
    // DONE, NOT PENDING — and this applies to a PINNED company too. A pin says
    // which companies get into the queue, never that one stays there forever.
    // "A queue that refills itself will occupy whatever slot it holds": the
    // finiteness rule outranks the pin, so a pinned company drops out at the
    // name target exactly like every other row.
    if (have >= namesPerCompany) continue;

    const pinReason = pins?.[c.name] || null;

    // A company with no REACHABLE role is not an outreach target. `best` is
    // already best-reachable in listCompanies — the raw MAX(score) next to it
    // is `bestAny`, and using that would queue companies whose only strong role
    // is one the owner cannot take.
    //
    // A PIN OVERRIDES BOTH TESTS, because it is answering a different question.
    // The band test asks "did the scorer like a role here"; a pin asks "did a
    // human decide this company is worth a relationship". Mistral has neither a
    // reachable role nor a qualifying band and is the reason the field exists.
    const band = c.best ? bandOf(c.best) : null;
    const qualifies = Boolean(c.best) && QUEUE_BANDS.has(band);
    if (!qualifies && !pinReason) continue;

    rows.push({
      name: c.name,
      display_name: c.display_name || c.name,
      // WHAT TO SEARCH LINKEDIN FOR, which is not always what to print. The
      // link is a KEYWORD match, so every token in the name is a term the
      // profile has to contain. Falls back to the display name, which is
      // correct for nearly every company.
      searchAs: searchAs?.[c.name] || c.display_name || c.name,
      // A pinned company that does not qualify has NO BAND, and the row must
      // not invent one. Rendering "Good" next to a company whose best role
      // scores 28 would be the two-numbers-one-population failure: the label
      // would be read as a verdict the scorer never gave.
      band: qualifies ? band : null,
      score: qualifies ? c.best : null,
      roleTitle: qualifies ? (c.bestTitle || null) : null,
      roleKey: qualifies ? (c.bestKey || null) : null,
      // The screen-out tags for that same role, so the queue says what would
      // stop him BEFORE he opens a search and spends an evening on names.
      // Carried raw and rendered by lib/blockers.js; nothing is classified here.
      blockers: qualifies ? (c.blockers ?? null) : null,
      blockers_full_text: qualifies ? (c.blockers_full_text ?? null) : null,
      pinned: Boolean(pinReason),
      pinReason,
      contacts: have,
      needed: namesPerCompany - have,
      n2027: c.n2027 || 0,
      reachable40: c.reachable40 || 0,
    });
  }

  // PINNED FIRST, because a human decision outranks a model score. Below that:
  // class-year-dated roles — the ones the owner can actually start — then depth of reachable
  // roles, then fit, then the slug as a UNIQUE tie-break. Every sort in this
  // project ends in something unique; three separate reshuffling bugs came from
  // comparators that could return 0, and a pinned row scoring null would tie
  // with every other pinned row without it.
  rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned))
    || (b.n2027 - a.n2027)
    || (b.reachable40 - a.reachable40)
    || ((b.score || 0) - (a.score || 0))
    || String(a.name).localeCompare(String(b.name)));

  return rows.slice(0, limit);
}

/**
 * The top few, as digest lines.
 *
 * THREE, because the Monday email is a prompt and not the page. The whole queue
 * lives at /outreach; an email listing twenty companies is one that gets
 * skimmed and archived.
 */
export function queueLines(queue = [], baseUrl = "", limit = 3) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  return queue.slice(0, limit).map(
    // A pinned row says PINNED where a scored row says its band. It must never
    // borrow a band it does not have — in an email, out of context, "Good" is
    // read as the scorer's verdict.
    (q) => `**${q.display_name}** — ${q.pinned ? "pinned" : q.band}`
      + (q.roleTitle ? `: ${q.roleTitle}` : "")
      + `. ${q.contacts}/${q.contacts + q.needed} names. ${base}/outreach`);
}
