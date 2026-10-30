/**
 * Where a role actually is, against where the owner wants to be.
 *
 * Pure, derived at read time, and DISPLAY-AND-FILTER ONLY. It must never touch
 * a score, and the reason is a specific role: Palantir's Deployment Strategist
 * is the highest-fit posting in the corpus under every scoring regime the
 * pipeline has run, and one of its locations is Colorado Springs. Weighting
 * location into fit would push the best role on the board down the page to
 * express a preference — and a preference is a thing you decide with, not a
 * thing that decides for you. So: the row SAYS where it is, and a checkbox
 * filters. Nothing is reranked and nothing is hidden by default.
 *
 * WHAT THE STRINGS ACTUALLY LOOK LIKE, measured over the 40+ roles:
 *
 *   Three separators, not one: "; " (Greenhouse multi-city), " | " (Ashby),
 *   and occasionally a bare comma list ("Chicago, New York, San Francisco").
 *   New York appears as "New York, NY", "New York, New York, United States",
 *   "New York, NY (HQ)" and "New York City, NY".
 *   San Francisco appears as "San Francisco", "San Francisco, CA",
 *   "San Francisco, California" and "San Francisco, California, United States".
 *
 * A matcher built on any one of those spellings would silently report the wrong
 * answer for the other three, which is the class of bug this file is most
 * likely to have — so it matches on substrings of a normalised string rather
 * than parsing a structure the boards do not agree on.
 */

/**
 * The metros worth naming, and what counts as each.
 *
 * The Bay Area peninsula is folded into San Francisco deliberately: Palo Alto,
 * Mountain View, San Mateo and Menlo Park are a commute, not a different life,
 * and splitting them would put a Databricks role in "somewhere else" for a
 * preference that is really about the region. The row still shows the real
 * metro name, so nothing is hidden by the folding.
 */
export const METROS = [
  ["nyc", "New York", ["new york", "nyc", "brooklyn", "manhattan", "jersey city", "hoboken"]],
  ["sf", "SF Bay Area", ["san francisco", "palo alto", "mountain view", "san mateo",
                         "menlo park", "sunnyvale", "redwood city", "bay area",
                         "south san francisco", "oakland", "berkeley", "san jose",
                         "santa clara", "cupertino", "foster city", "fremont"]],
  ["la", "Los Angeles", ["los angeles", "el segundo", "santa monica", "culver city",
                         "pasadena", "long beach", "torrance", "hawthorne", "irvine"]],
  // THE OWNER PICKS FROM THESE in config.yaml (preferred_metros, home_metro).
  // The original had three because its owner had three; a template needs
  // the metros a US new grad plausibly names. Add one by adding a row: a
  // code, a label, and the lowercase substrings a board writes for it.
  ["boston", "Boston", ["boston", "cambridge, ma", "cambridge, massachusetts", "somerville"]],
  ["chicago", "Chicago", ["chicago"]],
  ["dc", "Washington DC", ["washington, d", "washington dc", "arlington, va", "arlington, virginia",
                           "mclean", "reston", "tysons", "alexandria, va", "bethesda"]],
  ["seattle", "Seattle", ["seattle", "bellevue", "redmond", "kirkland"]],
  ["austin", "Austin", ["austin"]],
  ["denver", "Denver", ["denver", "boulder"]],
  ["dallas", "Dallas", ["dallas", "fort worth", "plano", "irving, tx", "frisco"]],
  ["atlanta", "Atlanta", ["atlanta"]],
  ["miami", "Miami", ["miami", "fort lauderdale", "boca raton"]],
  ["houston", "Houston", ["houston"]],
  ["philadelphia", "Philadelphia", ["philadelphia"]],
  ["minneapolis", "Minneapolis", ["minneapolis", "st. paul", "saint paul"]],
  ["phoenix", "Phoenix", ["phoenix", "scottsdale", "tempe"]],
  ["san_diego", "San Diego", ["san diego", "la jolla", "carlsbad, ca"]],
  ["portland", "Portland", ["portland, or", "portland, oregon"]],
  ["slc", "Salt Lake City", ["salt lake", "lehi", "provo"]],
  ["raleigh", "Raleigh-Durham", ["raleigh", "durham", "chapel hill", "research triangle"]],
  ["pittsburgh", "Pittsburgh", ["pittsburgh"]],
  ["detroit", "Detroit", ["detroit", "ann arbor"]],
  ["remote", "Remote", ["remote", "anywhere", "distributed"]],
];

export const METRO_LABEL = Object.fromEntries(METROS.map(([k, l]) => [k, l]));

/** Short markers for a row, where the full metro name would not fit. */
export const METRO_TAG = Object.fromEntries(METROS.map(([k, l]) => [k, ({
  nyc: "NY", sf: "SF", la: "LA", dc: "DC", slc: "SLC", remote: "remote",
})[k] || l.split(/[\s-]/)[0]]));

/**
 * Split a location field into places.
 *
 * THREE separators. `splitLocations()` in display.js splits on ";" alone and is
 * correct for what it does — it feeds the visible location column, where the
 * semicolon is the only separator Greenhouse uses. This one also has to survive
 * Ashby's " | " and the occasional bare comma list, because a metro missed here
 * is a role that silently reports the wrong city.
 *
 * A bare comma is NOT a separator on its own: "Costa Mesa, California" is one
 * place. It is only treated as one when no part looks like a state or country
 * qualifier, which is what distinguishes "Chicago, New York, San Francisco"
 * from "Quincy, Massachusetts, United States".
 */
export function splitPlaces(location) {
  const raw = String(location || "").trim();
  if (!raw) return [];
  let parts = raw.split(/\s*[;|]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    const commas = parts[0].split(/\s*,\s*/).filter(Boolean);
    const qualifier = /^(united states|usa|us|remote|[a-z]{2}|[a-z]+ ?[a-z]*)$/i;
    // Every part is a city name in its own right, none is a state or country.
    const allCities = commas.length >= 3
      && commas.every((c) => !/^(united states|usa|u\.s\.?|us)$/i.test(c))
      && commas.every((c) => c.length > 3 && !/^[A-Z]{2}$/.test(c))
      && commas.every((c) => METROS.some(([, , keys]) => keys.some((k) => c.toLowerCase().includes(k))));
    if (allCities) parts = commas;
  }
  return parts;
}

/** Every metro a role touches. A posting can genuinely be in several. */
export function metrosOf(location) {
  const hay = String(location || "").toLowerCase();
  const found = new Set();
  for (const [key, , keys] of METROS) {
    if (keys.some((k) => hay.includes(k))) found.add(key);
  }
  return found;
}

/**
 * The marker for a row, and whether it is somewhere he wants to be.
 *
 * `preferred` is true for New York, the Bay Area, or remote. Los Angeles is
 * NOT preferred and is NOT a miss — it is home, so it is called that. The
 * distinction matters: "LA" reads as a fact, "not preferred" would read as a
 * mark against a role in the city he already lives in.
 *
 * `kind` — "preferred" | "home" | "other" — names which of those three answered.
 * `preferred` alone cannot: home and somewhere-else both report false, and they
 * are not the same claim. A caller that wants to render only the chips carrying
 * an answer has no other way to ask, and inferring it from the label means
 * re-implementing this function at the call site.
 */
export function placeFor(role, prefs) {
  // NO DEFAULT METROS. The original fell back to its owner's two cities; a
  // template that silently preferred New York for everyone would be a quiet
  // lie on every row. config.yaml preferences are required by the build.
  const preferred = new Set(prefs?.preferredMetros || []);
  const remoteOk = prefs?.remoteAcceptable !== false;
  const home = prefs?.homeMetro || null;

  const metros = metrosOf(role?.location);
  const places = splitPlaces(role?.location);

  const hit = [...metros].filter((m) => preferred.has(m));
  if (hit.length) {
    return {
      metros: [...metros],
      tags: hit.map((m) => METRO_TAG[m]),
      preferred: true, kind: "preferred",
      label: hit.map((m) => METRO_TAG[m]).join(" · "),
      title: `In ${hit.map((m) => METRO_LABEL[m]).join(" and ")}, which you want.`,
    };
  }
  if (metros.has("remote") && remoteOk) {
    return {
      metros: [...metros], tags: ["remote"], preferred: true, kind: "preferred",
      label: "remote",
      title: "Remote, which works.",
    };
  }
  if (metros.has(home)) {
    return {
      metros: [...metros], tags: [METRO_TAG[home]], preferred: false, kind: "home",
      label: METRO_TAG[home],
      // Home is a fact, not a mark against the role.
      title: `In ${METRO_LABEL[home]} — home, though not one of your preferred metros.`,
    };
  }

  // Somewhere else. NAME IT rather than saying "elsewhere": the whole point is
  // that he can see where a role is without reading a truncated column, and
  // "not preferred" tells him nothing he can act on.
  const first = places[0] || String(role?.location || "").trim();
  const short = first.split(/\s*,\s*/)[0] || first;
  return {
    metros: [...metros],
    tags: short ? [short] : [],
    preferred: false, kind: "other",
    label: short || null,
    title: places.length > 1
      ? `${places.length} locations, none of them New York or the Bay Area: ${places.join(" · ")}`
      : (short ? `In ${first}, which is neither New York nor the Bay Area.` : null),
  };
}

/**
 * How a whole result set is distributed, for the Inbox footer.
 *
 * Counts ROLES, not postings, and counts a role once per metro it touches — so
 * the numbers can sum to more than the total, and the sentence says so rather
 * than pretending otherwise. A role in both New York and San Francisco is
 * genuinely two answers to "where can I work".
 */
export function whereThese(roles = [], prefs) {
  const counts = new Map();
  let anyPreferred = 0;
  for (const r of roles) {
    const m = metrosOf(r.location);
    // THE SAME PREDICATE THE FILTER USES. This counted only the metro
    // intersection, which excludes remote — so "Preferred locations only"
    // returned 21 rows and the footer beneath them said 17 were in a preferred
    // place. Two numbers on one screen, one filtered set, two definitions of
    // the same word.
    if (placeFor(r, prefs).preferred) anyPreferred += 1;
    if (!m.size) {
      const p = placeFor(r, prefs);
      const k = `other:${p.label || "not stated"}`;
      counts.set(k, (counts.get(k) || 0) + 1);
      continue;
    }
    for (const k of m) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const named = METROS
    .map(([k, label]) => ({ key: k, label, n: counts.get(k) || 0 }))
    .filter((x) => x.n > 0);
  const other = [...counts]
    .filter(([k]) => k.startsWith("other:"))
    .map(([k, n]) => ({ key: k, label: k.slice(6), n }))
    // TOTAL: the label can repeat across nothing here, but ties on n are
    // common, so the label breaks them and the order is stable run to run.
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));

  return {
    total: roles.length,
    preferred: anyPreferred,
    named: named.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    other: other.slice(0, 4),
    otherTotal: other.reduce((s, x) => s + x.n, 0),
  };
}
