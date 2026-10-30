/**
 * Where contacts come from, and which ones are worth surfacing. Pure.
 *
 * WHY THIS REPLACED TEAM-PAGE SCRAPING. Sourcing names from company sites
 * yielded 64 candidates across 13 companies and exactly ONE person doing a job
 * the owner is applying for. The rest were founders of large companies and
 * C-suite nobody answers. The people who actually reply are alumni of the
 * owner's school, and they are on LinkedIn -- which this tool never automates.
 *
 * So the sources are the owner's own data: their connections export, and text
 * they paste from a search they ran themselves in their own browser. Team
 * pages are the last resort, and their rank 5 and 7 rows are not staged at all.
 *
 * NOTHING HERE TOUCHES LINKEDIN. The export is a file the owner downloads; the
 * paste is text they copy. No fetch, no login, no driving. CLAUDE.md rule 2 is
 * about the terms of service and an account ban, not a preference.
 */

// The school, as the words a LinkedIn profile would carry, from profile.json
// owner.school_search_terms. The FIRST term is the closest affiliation (the
// business school, say) and ranks 1; every other term is the wider institution
// and ranks 2. The original hardcoded one school's two names here, which is the
// exact kind of literal that survives a copy and ranks the wrong alumni first.
import { OWNER } from "./config.generated.js";

const SCHOOL_TERMS = (OWNER.schoolSearchTerms || []).filter(Boolean);
const PRIMARY_TERM = SCHOOL_TERMS[0];
const OTHER_TERMS = SCHOOL_TERMS.slice(1);

/**
 * The ranking, in the owner's words, lowest first.
 *
 * NOT SENIORITY, and not "closeness". It is ordered by who actually replies:
 * an alum three years out answers a cold note from a student at their old
 * school, and a CEO does not.
 */
export const RANKS = [
  [1, "school_primary", `${PRIMARY_TERM} alum`],
  // When the profile lists only one term, rank 2 can never match; the label
  // falls back to the primary so the legend never reads "undefined alum".
  [2, "school_other", `${OTHER_TERMS[0] || PRIMARY_TERM} alum`],
  [3, "connected", "already a LinkedIn connection"],
  [4, "role", "does the job you are applying for"],
  [5, "hires", "hires for it"],
  [6, "founder_small", "founder at a small company"],
  [7, "other", "everything else"],
];

export const RANK_LABEL = Object.fromEntries(RANKS.map(([n, , l]) => [n, l]));

/**
 * Rank 7 is never surfaced by default.
 *
 * It is not deleted -- a name that turns out to matter can be promoted by
 * hand -- but a queue that shows everything is a queue nobody reads, and the
 * team-page run produced 47 rank-5-and-7 rows against 3 useful ones.
 */
export const SURFACE_MAX = 6;

/** Founders stop being reachable somewhere around here. Open roles as proxy. */
export const SMALL_COMPANY_ROLES = 50;

const RE_ROLE = /(deployment|forward[- ]deployed|chief of staff|bizops|business operations|product manager|operations associate|program manager|gtm|go[- ]to[- ]market|founder'?s office|first business hire)/i;
const RE_HIRES = /(recruit|talent|people ops|university relations|campus)/i;
const RE_FOUNDER = /(founder|co[- ]?founder|\bceo\b|chief executive)/i;

/**
 * Anything that says this person went to the owner's school, anywhere in
 * their block.
 *
 * WHOLE WORDS, FLEXIBLE SPACE. Each term becomes \bWord\s+Word\b, case-
 * insensitive, so "Westlake University" matches across a line break in a
 * paste and "Westlakeside" does not match at all. Missing a real alum costs
 * the single most valuable contact type this tool has; a false positive costs
 * one glance -- so the match is per term, anywhere in the block.
 */
const esc = (t) => String(t).trim().split(/\s+/).map(
  (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
const termRe = (t) => new RegExp(`\\b${esc(t)}\\b`, "i");
const RE_PRIMARY = PRIMARY_TERM ? termRe(PRIMARY_TERM) : /$^/;
const RE_OTHERS = OTHER_TERMS.map((t) => [t, termRe(t)]);

/** The first school term the text mentions, primary first, or null. */
function schoolTerm(blob) {
  if (RE_PRIMARY.test(blob)) return PRIMARY_TERM;
  for (const [t, re] of RE_OTHERS) if (re.test(blob)) return t;
  return null;
}

/**
 * What rank this person gets, and why.
 *
 * @param p { title, school, source, connected, companyRoles }
 * @returns { rank, why }
 *
 * THE REASON TRAVELS WITH THE RANK. A ranked list whose ordering cannot be
 * explained is one the owner has to either trust blindly or re-derive by hand --
 * the same rule the outreach role picker already follows.
 */
export function rankContact(p = {}) {
  const blob = [p.title, p.school, p.headline, p.notes, p.raw]
    .filter(Boolean).join(" ");
  const term = schoolTerm(blob);
  if (term === PRIMARY_TERM) return { rank: 1, why: `${term} alum` };
  if (term) return { rank: 2, why: `${term} alum` };
  if (p.connected || p.source === "linkedin_export") {
    return { rank: 3, why: "already a LinkedIn connection" };
  }
  const t = p.title || "";
  if (RE_ROLE.test(t)) return { rank: 4, why: "does the job you are applying for" };
  if (RE_HIRES.test(t)) return { rank: 5, why: "hires for it" };
  if (RE_FOUNDER.test(t)) {
    const n = p.companyRoles;
    if (n != null && n <= SMALL_COMPANY_ROLES) {
      return { rank: 6, why: `founder at a small company (${n} open roles)` };
    }
    // A founder at a large company is rank 7 and will not be surfaced. That is
    // deliberate: Vanta's CEO and ClickHouse's three co-founders came out of
    // the team-page run and none of them answers a cold note from a junior.
    return { rank: 7, why: `founder, but the company is large (${n ?? "?"} roles)` };
  }
  return { rank: 7, why: "everything else" };
}

/** Names match when the letters match. Case, punctuation and spacing vary. */
export function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Company names match loosely, because an export writes them however the
 * person typed them: "Scale AI", "Scale", "Scale AI, Inc.".
 *
 * DELIBERATELY NOT A SUBSTRING TEST IN BOTH DIRECTIONS. "Meta" is inside
 * "Metabase" and "Ramp" is inside "Rampart"; a bare `includes` would file a
 * Metabase engineer under Meta. The short side must match a whole token.
 */
const STOP = /\b(inc|llc|ltd|corp|corporation|company|co|technologies|technology|labs|the)\b/g;

export function normCompany(s) {
  return String(s || "").toLowerCase()
    .replace(/[.,&]/g, " ").replace(STOP, " ")
    .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export function companyMatches(a, b) {
  const x = normCompany(a);
  const y = normCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // Whole-token containment only.
  return long.split(" ").includes(short)
    || long.startsWith(short + " ") || long.endsWith(" " + short);
}

/**
 * One row of a LinkedIn connections export.
 *
 * The file has a three-line preamble ("Notes:", a blank, a sentence) before
 * the header on most exports and not on others, so the header is FOUND rather
 * than assumed to be line one -- a parser that trusts line one silently reads
 * the preamble as data and produces one contact called "Notes:".
 */
export function parseConnections(csv) {
  const lines = String(csv || "").split(/\r?\n/);
  const head = lines.findIndex((l) => /first ?name/i.test(l) && /company/i.test(l));
  if (head < 0) return { rows: [], error: "no header row with First Name and Company" };

  const cols = splitCsvLine(lines[head]).map((c) => c.trim().toLowerCase());
  const idx = (want) => cols.findIndex((c) => c.replace(/\s+/g, "") === want);
  const iFirst = idx("firstname");
  const iLast = idx("lastname");
  const iCo = idx("company");
  const iPos = idx("position");
  const iOn = idx("connectedon");
  if (iFirst < 0 || iCo < 0) {
    return { rows: [], error: "header found but First Name or Company is missing" };
  }

  const rows = [];
  for (const line of lines.slice(head + 1)) {
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    const name = [f[iFirst], iLast >= 0 ? f[iLast] : ""]
      .filter(Boolean).join(" ").trim();
    const company = (iCo >= 0 ? f[iCo] : "").trim();
    if (!name || !company) continue;
    rows.push({
      name,
      company,
      title: (iPos >= 0 ? f[iPos] : "").trim(),
      connected_on: (iOn >= 0 ? f[iOn] : "").trim(),
      source: "linkedin_export",
      connected: true,
    });
  }
  return { rows, error: null };
}

/** A CSV line, respecting quotes. Positions carry commas constantly. */
export function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * A pasted LinkedIn people-search result page, as blocks.
 *
 * NO MODEL WHERE THE SHAPE IS REGULAR. A search result is a name line, then a
 * headline, then a location, repeated -- and the school appears in whichever
 * of them the person put it in. This splits on the repeated shape and reads
 * the whole block for the alumni signal.
 *
 * IT IS DELIBERATELY FORGIVING. The owner is pasting from a browser, so the text
 * arrives with connection degrees, "View X's profile", mutual-connection
 * lines and blank runs. Dropping a real person because of a stray line costs
 * the best contact type this tool has; keeping a junk row costs one glance.
 */
/**
 * Lines that are a place, not a person.
 *
 * Two signals, because either alone misses: a known place word, or the
 * "City, Region" comma shape that a person's name never has.
 */
const PLACE = new RegExp(
  "(^|, )(united states|remote|greater |metropolitan|area$|"
  + "san |los |new york|palo alto|menlo|mountain view|washington|"
  + "bay area|london|paris|berlin|toronto|sydney|singapore|"
  + "austin|boston|chicago|seattle|denver|atlanta|miami|dallas|"
  + "california|texas|virginia|colorado|florida|massachusetts)|"
  + "^[A-Z][a-z]+(?: [A-Z][a-z]+)*, [A-Z]{2}$|"
  + "^[A-Z][a-z]+(?: [A-Z][a-z]+)*, [A-Z][a-z]+$", "i");


const NOISE = /^(view\s|.*'s profile$|connect$|message$|follow$|\d+(st|nd|rd|th)\b|·|see more|mutual connection|show all)/i;

export function parsePastedPeople(text, company = null) {
  const raw = String(text || "").split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !NOISE.test(l));

  const people = [];
  let cur = null;
  for (const line of raw) {
    // A NAME LINE: two or three capitalised words, no sentence punctuation.
    // Names carry the degree suffix on LinkedIn ("Jane Doe 2nd"), stripped
    // above, so this sees the bare name.
    // A LOCATION IS NOT A PERSON. "San Francisco", "New York, NY" and
    // "Greater Boston Area" all match the shape of a name -- capitalised
    // words, no stop words -- and the first live paste duly staged San
    // Francisco as a rank-7 contact. LinkedIn puts the location directly
    // under the headline, so it is the line most likely to be mistaken.
    const isName = !PLACE.test(line)
      && /^[A-Z][\w'’-]+(?: [A-Z][\w'’.-]+){1,2}$/.test(line)
      && !/\b(at|the|and|of|for)\b/i.test(line);
    if (isName) {
      if (cur) people.push(cur);
      cur = { name: line, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) people.push(cur);

  return people.map((p) => {
    const blob = p.lines.join(" | ");
    // "Title at Company" is the usual headline shape.
    const m = blob.match(/^(.*?)\s+(?:at|@)\s+([^|]+)/i);
    const title = (m ? m[1] : p.lines[0] || "").trim();
    const co = (m ? m[2] : company || "").trim();
    // The school is recorded as the TERM that matched, so the row says which
    // affiliation it found rather than a name this file would have to know.
    const term = schoolTerm(blob);
    return {
      name: p.name,
      title,
      company: co,
      raw: blob,
      school: term || "",
      source: "manual_paste",
      alumni: !!term,
    };
  }).filter((p) => p.name);
}

/**
 * Dedupe by name + company, keeping the BEST-RANKED row.
 *
 * The same person appears in the export and in a paste, and the paste is the
 * one carrying the school -- so "first wins" would throw away the alumni
 * flag that makes them rank 1.
 */
export function dedupe(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = `${normName(r.name)}|${normCompany(r.company)}`;
    const prev = best.get(k);
    if (!prev || (r.rank ?? 9) < (prev.rank ?? 9)) best.set(k, r);
  }
  return [...best.values()];
}
