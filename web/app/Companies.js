"use client";

import CompanyTarget, { nextStep } from "./CompanyTarget";
import Band from "./Band";
import { CategoryDot, CategoryLegend } from "./Palette";
import { bandOf } from "@/lib/display";
import { bandClass, categoryOfCompany } from "@/lib/palette";
import { NAMES_PER_COMPANY } from "@/lib/people";
import { useFindNames, searchHref } from "./FindNames";
import CompanyCycle from "./CompanyCycle";
import QuickAdd from "./QuickAdd";
import {
  schoolPeopleSearchUrl, SCHOOL_SEARCH_PREFIX, SCHOOL_LINKEDIN_ALUMNI, OWNER,
  USER_CLASS_YEAR,
} from "@/lib/constants";
import { SEARCH_AS } from "@/lib/config.generated";

/* THE TWO ALUMNI LINKS, on every company row, labelled for what each one is.
 *
 * The first is a LinkedIn people search for the words "<school> <company>",
 * the school being the first of profile.json owner.school_search_terms. A
 * KEYWORD MATCH, not an alumni filter, and the label says so: some results
 * will not be alumni, or not at that company. Verified by the original owner
 * clicking on 2026-09-03 — 6 of 7 first-page results for Anduril were genuine
 * alumni currently there, two of them already in the contacts. It exists
 * because the true filter does not: LinkedIn's school /people/ pages ignore
 * ?keywords= (three of them, clicked the same day, all landed on the same
 * 51,107-alumni page). The second link is that page, labelled unfiltered, and
 * it is offered only when profile.json names one. See lib/constants.js and
 * CLAUDE.md.
 *
 * Links, not fetches. What happens after the click is a person reading a
 * page in their own browser, signed in as themselves. */
function AlumniLinks({ company, label }) {
  // WHAT TO SEARCH FOR, WHICH IS NOT ALWAYS WHAT TO PRINT. This is a KEYWORD
  // search, so every token in the name is a term the profile has to contain:
  // "Mistral AI" makes LinkedIn require the literal "AI" alongside, and people
  // write "Mistral". The override lives in companies.yaml as `search_as:` and
  // is baked at build time; no company is named in this file. Falls back to the
  // display name, which is right for nearly all of them.
  const term = SEARCH_AS[company] || label;
  return (
    <span className="alumnilinks">
      <a href={schoolPeopleSearchUrl(term)} target="_blank" rel="noreferrer"
         title={`A LinkedIn people search for the words "${SCHOOL_SEARCH_PREFIX} ${term}". A keyword match, not an alumni filter: some results will not be alumni, or not at ${label}. Opens in a new tab.`}>
        Search &ldquo;{SCHOOL_SEARCH_PREFIX} {term}&rdquo; on LinkedIn
      </a>
      <span className="dim"> (keyword match)</span>
      {SCHOOL_LINKEDIN_ALUMNI && (
        <>
          <span className="sep"> · </span>
          <a href={SCHOOL_LINKEDIN_ALUMNI} target="_blank" rel="noreferrer"
             title={`${OWNER.schoolShort}'s alumni page on LinkedIn. Unfiltered — every alumnus; use its own filter box once it opens. Not scoped to this company.`}>
            {OWNER.schoolShort} alumni page (unfiltered, filter by hand)
          </a>
        </>
      )}
    </span>
  );
}

/* Companies — who hires this profile, in two bands.
 *
 * One flat table treated a company with 56 reachable roles at 40+ the same as one
 * with none, which is the opposite of useful when the point is relationship
 * building. So: companies that actually hire this profile get full rows, and the
 * rest become a compact list you can still scan.
 */


function payBand(lo, hi) {
  if (!lo) return null;
  return `$${Math.round(lo / 1000)}–${Math.round(hi / 1000)}K`;
}

export default function Companies({
  companies, sort, targets = [],
  tally = { enough: false, withRef: 0, without: 0, unknown: 0, total: 0,
            progressedWith: 0, progressedWithout: 0 },
}) {
  // The same gesture the verb on a role row runs, from the one implementation.
  const findNames = useFindNames();

  const push = (s) => {
    const p = new URLSearchParams(window.location.search);
    p.set("sort", s);
    window.location.search = p.toString();
  };

  // "Hires your profile" = at least one REACHABLE role scoring 40+. The old
  // table used `at40`, which counted experienced roles too, under a header
  // reading "new-grad 40+".
  const isTarget = (c) => targets.includes(c.name);
  const targeted = companies.filter(isTarget);
  const hires = companies.filter((c) => !isTarget(c) && c.reachable40 > 0);
  const watching = companies.filter((c) => !isTarget(c) && c.reachable40 === 0);
  const anyContacts = companies.some((c) => c.contacts > 0);

  /**
   * Who to get to know first, and one verb per row.
   *
   * This replaces networking_targets.md — 509 lines the owner never opened. The
   * ranking is reachable roles times class-year depth, restricted to companies
   * where they know nobody, because that is the whole point: a referral routes
   * around the two biggest blockers in the gap data, and it cannot route around
   * anything at a company they already have a contact at.
   *
   * WHAT IS DELIBERATELY ABSENT: the "why I'm reaching out" sentence. The
   * generator produced it per CATEGORY, so Palantir, Saronic and Anduril all got
   * the same words. Three identical sentences are a template presenting itself
   * as three insights — the same failure as manufactured warmth, and worse on a
   * page than in a file because a page looks authoritative. What is left is
   * per-company or it is not shown: the company's own note, the titles it
   * actually hires into, and an ask that names its own best role.
   */
  // UNDER the target, not at zero. A company where one name is known still has
  // work left: one contact is a single point of failure, and this used to
  // declare a company finished after a single row.
  const queue = companies
    .filter((c) => c.reachable40 > 0 && (c.contacts || 0) < NAMES_PER_COMPANY)
    .sort((a, b) => (b.reachable40 * (1 + (b.n2027 || 0))) - (a.reachable40 * (1 + (a.n2027 || 0)))
                 || String(a.name).localeCompare(String(b.name)))
    .slice(0, 6);

  // Companies that have hit the target. They leave the queue, and they say so
  // here rather than silently vanishing — a list that shortens with no
  // explanation reads as something having gone wrong.
  const covered = companies.filter(
    (c) => c.reachable40 > 0 && (c.contacts || 0) >= NAMES_PER_COMPANY);

  const StartHere = ({ c }) => (
    <details className="queue">
      <summary>
        <span className="qco">
          <CategoryDot category={categoryOfCompany(c.name)} />
          {c.display_name}
        </span>
        {/* "Find 2 names" was a label with nowhere to go. It is a link into the
            People form with this company already filled in, and it counts:
            0/2, 1/2, done. A progress marker is the difference between a
            standing instruction and a task that can be finished. */}
        {/* Opens the alumni search in a new tab AND the add form here, the
            same gesture the verb on a role row runs. It used to open only the
            form, which is the half of the task he was not stuck on. */}
        <a className="qwhat"
           href={searchHref(c.display_name || c.name, c.name)}
           target="_blank"
           rel="noreferrer"
           onClick={(e) => findNames(c.name, e)}>
          Find {NAMES_PER_COMPANY - (c.contacts || 0)} name
          {NAMES_PER_COMPANY - (c.contacts || 0) === 1 ? "" : "s"}
          <span className="qprog"> {c.contacts || 0}/{NAMES_PER_COMPANY}</span>
        </a>
        <span className="qwhy">
          {c.reachable40} role{c.reachable40 === 1 ? "" : "s"} here fit you
          {c.n2027 ? ` · ${c.n2027} dated ${USER_CLASS_YEAR}` : ""}
        </span>
      </summary>
      <div className="qbody">
        {c.why && <p className="qnote">{c.why}</p>}
        {c.titles?.length > 0 && (
          <p className="qtitles">
            <span className="dim">Titles they hire into, from their own board: </span>
            {c.titles.join(" · ")}
          </p>
        )}
        {c.bestTitle && (
          <p className="qask">
            <span className="dim">An ask worth sending: </span>
            &ldquo;What does {c.bestTitle} actually look like day to day, and what
            separates the people who do it well?&rdquo;
          </p>
        )}
        <p className="qhow">
          Names come from the {OWNER.schoolShort} alumni directory, by hand — the
          tool never looks anyone up.{" "}
          <a href={`/people?co=${encodeURIComponent(c.name)}&add=1`}>
            Add one on the People page
          </a>
          , or right here: a name and a link is enough to start the record.
        </p>
        {/* The one-action form, on the row that told the owner to go and find names.
            The People page is a tab away; a tab away is where the name got
            lost between finding it and typing it. */}
        <p className="qhow">
          <AlumniLinks company={c.name} label={c.display_name || c.name} />
        </p>
        <p className="qhow">
          <QuickAdd company={c.name} label={c.display_name || c.name} />
        </p>
      </div>
    </details>
  );

  const Sort = ({ k, label }) => (
    <button className={`sortbtn${sort === k ? " on" : ""}`} onClick={() => push(k)}>
      {label}
    </button>
  );

  const Row = ({ c, withNext = false }) => {
    const ns = withNext ? nextStep(c) : null;
    // The band colour goes on BOTH rows of a two-row company, so the rule down
    // the left edge reads as one block rather than as a row and an orphan.
    const band = bandClass(c.best);
    return (
      <>
        <div className={`crow ${band}`} key={c.name}>
          <span className="co">
            <CompanyTarget company={c.name} on={isTarget(c)} />{" "}
            <CategoryDot category={categoryOfCompany(c.name)} />
            {c.display_name}
          </span>
          <Band score={c.best} />
          {/* The count sat hard against the band word, so "Excellent 54" read at
              a glance as a score of 54. Lighter, monospaced, and behind a
              hairline: a count is metadata, the band is the judgement. */}
          <span className="num count40">{c.reachable40}</span>
          <span className="title">
            {/* Nullable: a company whose best reachable role has been flagged
                as the wrong cycle has no best role to name, and an anchor with
                no text is an invisible click target rather than an empty one. */}
            {c.bestTitle ? (
              <a href={`/inbox?co=${encodeURIComponent(c.name)}&min=0&cap=0`}>
                {c.bestTitle}
              </a>
            ) : (
              <span className="lvl">nothing reachable right now</span>
            )}
          </span>
          <span
            className={`num${c.n2027 ? "" : " zero"}`}
            title={[
              `${c.n2027} of ${c.n2027All} ${USER_CLASS_YEAR}-dated roles here are ones you could take`,
              c.n2027All > c.n2027
                ? "the rest are another class year, out of band, or need a clearance"
                : null,
              c.first2027
                ? `${USER_CLASS_YEAR}-dated roles seen from ${String(c.first2027).slice(0, 10)} — expect the next batch around then`
                : null,
            ].filter(Boolean).join(". ")}
          >
            {c.n2027 || "—"}
          </span>
          <span className="num">
            {payBand(c.comp_lo, c.comp_hi) || <span className="lvl">not published</span>}
          </span>
          <CompanyCycle company={c.name} label={c.display_name} />
        </div>
        {/* Always rendered now: every company row carries the one-action add,
            so the second line exists whether or not there is a note, a next
            step or a count to put on it. */}
        <div className={`crow nextrow ${band}`}>
            <span />
            <span style={{ gridColumn: "2 / -1" }}>
              {c.why && <span className="whyhere">{c.why}</span>}
              {/* The contact count, on the primary surface rather than behind a
                  tab. Networking state belongs next to the company it is about;
                  a separate page for it is a page that does not get opened. */}
              {c.contacts > 0 && (
                <span className="whoknown">
                  {c.why && <span className="sep"> · </span>}
                  <a href={`/people?co=${encodeURIComponent(c.name)}`}>
                    {c.contacts} {c.contacts === 1 ? "person" : "people"} known
                  </a>
                  {c.referred > 0 && <span className="tick"> ✓ referred</span>}
                </span>
              )}
              {ns && (
                <span className={`nextstep${ns.due ? " due" : ""}`}>
                  {(c.why || c.contacts > 0) && <span className="sep"> · </span>}
                  Next step — {ns.text}
                </span>
              )}
              {(c.why || c.contacts > 0 || ns) && <span className="sep"> · </span>}
              <AlumniLinks company={c.name} label={c.display_name || c.name} />
              <span className="sep"> · </span>
              <QuickAdd company={c.name} label={c.display_name || c.name} />
            </span>
          </div>
      </>
    );
  };

  return (
    <div className="sheet">
      <div className="controls">
        <span>
          You start {OWNER.graduation}, so today&apos;s postings are intelligence
          about who hires this profile — not an application queue.
        </span>
        <span className="spacer" />
        <span className="count">
          {hires.length} hire your profile · {watching.length} watching
        </span>
      </div>

      {queue.length > 0 && (
        <section className="section">
          <h2>
            Start here{" "}
            <span className="h2note">
              — the companies that hire your profile where you know nobody
            </span>
          </h2>
          <p className="sub">
            Ranked by how many roles fit you, weighted by how many are dated{" "}
            {USER_CLASS_YEAR}. Open one for what to search and what to ask.
          </p>
          {queue.map((c) => <StartHere key={c.name} c={c} />)}
          {covered.length > 0 && (
            <p className="qdone">
              <span className="tick">✓</span> {NAMES_PER_COMPANY} or more at{" "}
              {covered.map((c, i) => (
                <span key={c.name}>
                  {i > 0 && <span className="sep"> · </span>}
                  <a href={`/people?co=${encodeURIComponent(c.name)}`}>{c.display_name}</a>
                </span>
              ))}
              . They leave this queue rather than quietly disappearing from it.
            </p>
          )}
        </section>
      )}

      {targeted.length > 0 && (
        <section className="section">
          <h2>
            Targets <span className="h2note">— companies you are actually going after</span>
          </h2>
          <div className="crow head">
            <span>company</span>
            <span>best fit</span>
            <span>roles</span>
            <span>best role you could get</span>
            <span>{USER_CLASS_YEAR} for you</span>
            <span className="num">its pay</span>
            <span />
          </div>
          {targeted.map((c) => <Row key={c.name} c={c} withNext />)}
        </section>
      )}

      <section className="section">
        <h2>
          Hires your profile{" "}
          <span className="h2note">— at least one new-grad role scoring 40+</span>
        </h2>

        <div className="crow head">
          <span>company</span>
          <Sort k="best" label="best fit" />
          <Sort k="reachable40" label="40+" />
          <span>best role you could get</span>
          <Sort k="n2027" label={`${USER_CLASS_YEAR} for you`} />
          <span className="num">its pay</span>
          {/* The menu column. Headed with nothing: a heading over a glyph is a
              heading over a verb nobody has chosen yet. */}
          <span />
        </div>

        {hires.map((c) => <Row key={c.name} c={c} />)}
      </section>

      <section className="section">
        <h2>
          Watching{" "}
          <span className="h2note">
            — on the board, nothing reachable scoring 40+ yet
          </span>
        </h2>
        <p className="nothing">
          {watching.map((c, i) => (
            <span key={c.name}>
              {i > 0 && <span className="sep"> · </span>}
              <CategoryDot category={categoryOfCompany(c.name)} />
              <a href={`/inbox?co=${encodeURIComponent(c.name)}&min=0&cap=0`}>
                {c.display_name}
              </a>
              <span className="faint" title={c.bestAny > (c.best || 0)
                ? `best role you could take: ${bandOf(c.best).toLowerCase()}; their best overall is ${bandOf(c.bestAny).toLowerCase()}, at a level or class year that is not yours`
                : undefined}>
                {" "}{bandOf(c.best).toLowerCase()}
              </span>
            </span>
          ))}
        </p>
      </section>

      {/* THE THESIS, TESTED AGAINST THE OWNER'S OWN RESULTS.
       *
       * Shown only once there are three applications, and that threshold is the
       * honest part. One with a referral and one without is not evidence of
       * anything, and rendering "100% vs 0%" off a sample of two is the same
       * failure as the posting forecast built on two days of history: a
       * confident answer the data cannot support.
       *
       * A TALLY, never a rate, even at three. And `unknown` is counted out loud
       * rather than folded into "without", because "they skipped the question"
       * and "they applied cold" are different facts and only one of them is
       * evidence. */}
      {tally.enough && (
        <p className="note">
          <strong>Your own results so far:</strong> {tally.withRef} application
          {tally.withRef === 1 ? "" : "s"} with a referral, {tally.without} cold
          {tally.unknown > 0 && `, ${tally.unknown} you didn't say`}.
          {" "}
          {tally.progressedWith + tally.progressedWithout > 0
            ? `${tally.progressedWith} of the referred ones got past the application, and ${tally.progressedWithout} of the cold ones did.`
            : "Nothing has moved past the application stage yet either way."}
          {" "}
          <span className="dim">
            {tally.total} applications is far too few to conclude anything. It is
            here so that by the time there are thirty, the number exists.
          </span>
        </p>
      )}

      <p className="note">
        Pay shown is the band on that specific role, base only.
        {!anyContacts && " Contacts appear here once you add people on the People page."}
      </p>

      <CategoryLegend
        only={new Set(companies.map((c) => categoryOfCompany(c.name)))}
        note="The rule down the left edge is best fit: green excellent, blue strong, gold good."
      />
    </div>
  );
}
