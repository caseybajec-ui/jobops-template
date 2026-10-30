/**
 * Contact sourcing: ranking, the connections export, and the paste parser.
 * Run: node test_sourcing.mjs
 *
 * WHY THE SOURCES CHANGED. Scraping company team pages gave 64 candidates
 * across 13 companies and exactly ONE person doing a job the owner applies
 * for. The people who reply are alumni of the owner's school, and they are on
 * LinkedIn, which this tool never automates. So: the owner's own connections
 * export, and text they paste from a search they ran themselves.
 *
 * THE SCHOOL IS THE BAKED ONE. The ranking's two alumni ranks are built from
 * profile.json owner.school_search_terms (first term = rank 1, the rest =
 * rank 2), so every fixture below is assembled from those terms rather than
 * typed -- a literal school here would pass against one owner's build and
 * fail against the next.
 */
import {
  rankContact, RANKS, RANK_LABEL, SURFACE_MAX, SMALL_COMPANY_ROLES, normName, normCompany,
  companyMatches, parseConnections, splitCsvLine, parsePastedPeople, dedupe,
} from "./lib/sourcing.js";
import { OWNER } from "./lib/config.generated.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? (pass++, 0) : fails.push(w));

const [PRIMARY, ...OTHERS] = OWNER.schoolSearchTerms;
// A second term is what makes rank 2 reachable at all; the shipped example
// profile has one, and a profile without one simply never produces rank 2.
const WIDER = OTHERS[0] || PRIMARY;

/* ---- the ranking, in the owner's order -------------------------------- */

ok(rankContact({ school: `${PRIMARY} School of Business` }).rank === 1,
   "an alum of the primary school term is rank 1");
ok(rankContact({ headline: `Analyst | ${PRIMARY}` }).rank === 1,
   "and the signal is found anywhere in the block, not just a school field");
ok(rankContact({ raw: WIDER }).rank === (OTHERS.length ? 2 : 1),
   "an alum of the wider institution is rank 2");
ok(rankContact({ raw: WIDER.toUpperCase() }).rank === (OTHERS.length ? 2 : 1),
   "case does not matter");
ok(rankContact({ raw: WIDER.replace(/\s+/g, "\n") }).rank === (OTHERS.length ? 2 : 1),
   "and a line break inside the school name still matches -- a paste wraps");
ok(rankContact({ raw: `${PRIMARY}ville` }).rank === 7,
   "but the term must match as a whole word: a longer word containing it is not a match");
ok(RANK_LABEL[1] === `${PRIMARY} alum`, `rank 1 is labelled "${PRIMARY} alum"`);
ok(RANK_LABEL[2] === `${WIDER} alum`, `rank 2 is labelled "${WIDER} alum"`);
ok(rankContact({ source: "linkedin_export" }).rank === 3,
   "an existing connection is rank 3");
ok(rankContact({ title: "Deployment Strategist" }).rank === 4,
   "someone doing the job is rank 4");
ok(rankContact({ title: "University Recruiter" }).rank === 5,
   "someone who hires for it is rank 5");
ok(rankContact({ title: "Co-Founder", companyRoles: 20 }).rank === 6,
   "a founder at a small company is rank 6");
ok(rankContact({ title: "Chief Marketing Officer" }).rank === 7,
   "a C-suite title with no school link is rank 7");

/* THE SCHOOL BEATS EVERYTHING, including a better title. This is the whole
 * point of the reorder: an alum in any role replies, a Chief Revenue Officer
 * does not. */
ok(rankContact({ school: PRIMARY, title: "Chief Revenue Officer" }).rank === 1,
   "the school outranks a C-suite title");
ok(rankContact({ school: PRIMARY, title: "Deployment Strategist" }).rank === 1,
   "and outranks the exact role the owner wants");

/* A FOUNDER AT A LARGE COMPANY IS RANK 7 AND IS NOT SURFACED. Vanta's CEO,
 * ClickHouse's three co-founders and Brex's co-CEO all came out of the
 * team-page run; none of them answers a cold note from a junior. */
const bigFounder = rankContact({ title: "Co-Founder & CEO", companyRoles: 180 });
ok(bigFounder.rank === 7, "a founder at a 180-role company is rank 7");
ok(bigFounder.rank > SURFACE_MAX, "and is therefore never surfaced by default");
ok(rankContact({ title: "Co-Founder & CEO", companyRoles: 40 }).rank <= SURFACE_MAX,
   "while a founder at a 40-role company IS surfaced");
ok(SMALL_COMPANY_ROLES === 50, "the small-company line is 50 open roles");
ok(RANKS.length === 7 && SURFACE_MAX === 6,
   "seven ranks, six of them surfaced");

/* THE REASON TRAVELS WITH THE RANK. A ranking that cannot be explained has to
 * be trusted blindly or re-derived by hand. */
for (const p of [{ school: PRIMARY }, { title: "Deployment Strategist" },
                 { title: "Founder", companyRoles: 10 }]) {
  ok((rankContact(p).why || "").length > 4, "every rank carries a reason");
}

/* ---- company matching ------------------------------------------------- */

ok(companyMatches("Scale AI", "Scale AI, Inc."), "suffixes are ignored");
ok(companyMatches("Scale AI", "Scale"), "and a shorter form still matches");
ok(companyMatches("ClickHouse", "ClickHouse Inc"), "and Inc");

/* THE ONE THAT MATTERS: a bare substring test would file a Metabase engineer
 * under Meta, and a Rampart employee under Ramp. */
ok(!companyMatches("Meta", "Metabase"), "Meta does not match Metabase");
ok(!companyMatches("Ramp", "Rampart Security"), "Ramp does not match Rampart");
ok(!companyMatches("Exa", "Exabeam"), "Exa does not match Exabeam");
ok(companyMatches("Meta", "Meta Platforms"), "but Meta does match Meta Platforms");

/* ---- the connections export ------------------------------------------- */

const CSV = [
  "Notes:",
  '"When exporting your connection data, you may notice..."',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Jane,Doe,https://x,,Vanta,Product Manager,01 Mar 2026",
  'John,Smith,https://y,,"Scale AI, Inc.","Head of Ops, Public Sector",02 Apr 2026',
  ",,,,,,",
].join("\n");

const { rows, error } = parseConnections(CSV);
ok(error === null, `the export parses: ${error}`);
ok(rows.length === 2, `two real rows, skipping the preamble (${rows.length})`);
ok(rows[0].name === "Jane Doe", "first and last names are joined");
ok(rows[0].company === "Vanta", "the company is read");
ok(rows[1].title === "Head of Ops, Public Sector",
   `a quoted position with a comma survives: ${rows[1].title}`);
ok(rows.every((r) => r.source === "linkedin_export" && r.connected),
   "every row is marked as an existing connection");

/* THE PREAMBLE IS THE POINT. A parser that trusts line one reads "Notes:" as
 * a header and produces one contact called Notes. */
ok(!rows.some((r) => /notes/i.test(r.name)), "the preamble is not read as data");
ok(parseConnections("no header here").error !== null,
   "a file with no header says so rather than returning nothing quietly");

ok(splitCsvLine('a,"b,c",d').length === 3, "quoted commas do not split");

/* ---- the paste parser -------------------------------------------------- */

const PASTE = `
Jane Doe
2nd
Deployment Strategist at Palantir
Washington, DC
View Jane's profile
Connect

Mark Ruiz
3rd
Associate Product Manager at Vanta · ${PRIMARY} School of Business
San Francisco Bay Area
Message

Priya Nair
Software Engineer at Exa
New York, NY
`;

const parsed = parsePastedPeople(PASTE);
ok(parsed.length === 3, `three people parsed (${parsed.length})`);
ok(parsed[0].name === "Jane Doe", "names come through");
ok(/Deployment Strategist/.test(parsed[0].title),
   `titles come through: ${parsed[0].title}`);
ok(/Palantir/i.test(parsed[0].company), `companies come through: ${parsed[0].company}`);

/* THE ALUMNI FLAG IS THE WHOLE VALUE OF THIS SOURCE. */
ok(parsed[1].alumni === true, "the school line sets the alumni flag");
ok(parsed[1].school === PRIMARY, "and records which term matched");
ok(parsed[0].alumni === false, "someone with no school mention is not flagged");
ok(rankContact(parsed[1]).rank === 1, "and the alum row ranks 1");

/* A LOCATION IS NOT A PERSON, and this is not hypothetical: the first live
 * paste against the deployed app staged "San Francisco" as a rank-7 contact.
 * LinkedIn puts the location directly under the headline, so it is the line
 * most likely to be mistaken for the next name. */
const WITH_PLACES = [
  "Jane Doe", "Deployment Strategist at Vanta", "San Francisco",
  "Mark Ruiz", "Product Manager at Exa", "New York, NY",
  "Priya Nair", "Engineer at Ramp", "Greater Boston Area",
  "Sam Okoro", "Bizops at Glean", "Austin, Texas",
  "Lee Park", "Analyst at Brex", "United States",
].join("\n");
const noPlaces = parsePastedPeople(WITH_PLACES);
ok(noPlaces.length === 5,
   `five people, no locations (${noPlaces.length}): `
   + noPlaces.map((p) => p.name).join(", "));
for (const bad of ["San Francisco", "New York", "Greater Boston Area",
                   "Austin", "United States"]) {
  ok(!noPlaces.some((p) => p.name.startsWith(bad.split(" ")[0])
                        && p.name.includes(bad.split(" ").pop())),
     `${bad} is not staged as a person`);
}
ok(noPlaces.every((p) => p.title), "and every one of the five kept its title");

/* BROWSER NOISE IS DROPPED, not turned into people. */
ok(!parsed.some((p) => /view|connect|message|2nd|3rd/i.test(p.name)),
   "degrees, View and Connect never become a person");
ok(parsed.every((p) => p.source === "manual_paste"), "the source is recorded");

/* ---- dedupe keeps the BEST row ---------------------------------------- */

const merged = dedupe([
  { name: "Mark Ruiz", company: "Vanta", rank: 3, source: "linkedin_export" },
  { name: "mark  ruiz", company: "Vanta Inc.", rank: 1, source: "manual_paste" },
  { name: "Jane Doe", company: "Palantir", rank: 4 },
]);
ok(merged.length === 2, `duplicates collapse (${merged.length})`);
const mark = merged.find((r) => normName(r.name) === "markruiz");
ok(mark.rank === 1,
   "and the BEST-ranked row wins -- the paste carries the alumni flag that "
   + "makes them rank 1, so first-wins would throw it away");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
