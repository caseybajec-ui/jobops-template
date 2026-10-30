"use client";

import { useRouter } from "next/navigation";
import { schoolPeopleSearchUrl } from "@/lib/constants";
import { SEARCH_AS } from "@/lib/config.generated";

/**
 * "Go and find a name at this company" — the whole gesture, in one place.
 *
 * It does two things at once, which is the point: the alumni search opens in a
 * NEW tab, and the add-person form opens HERE. Before, the link went to the
 * form and the search was something you went and did separately, so the actual
 * sequence was open the form, realise you have no name, go to LinkedIn, search,
 * come back, and find the form had been navigated away from. Six steps for a
 * ten-minute task, and it is the ten-minute task the whole networking half of
 * this tool depends on the owner doing.
 *
 * Used by the verb on a role row AND by "Find 2 names" on Companies, because
 * two implementations of one gesture is how the two surfaces end up opening
 * different searches — and the search is built in exactly one place,
 * lib/constants.js, from the school terms in profile.json. It is the people
 * search, not a school /people/ page with a query string: those ignore
 * ?keywords= (see the note in lib/constants.js).
 *
 * NOTHING HERE FETCHES LINKEDIN. It builds a URL and opens a tab. What happens
 * next is a person reading a page in their own browser, signed in as
 * themselves — CLAUDE.md rule 2, and the reason contacts are typed by hand.
 */
export function useFindNames() {
  const router = useRouter();
  return function open(company, e) {
    if (e) e.stopPropagation();
    router.push(`/people?co=${encodeURIComponent(company)}&add=1`);
  };
}

/**
 * The search URL for a company, so the anchor is a real link and not an onClick.
 *
 * TAKES THE SLUG AS WELL AS THE LABEL, because what to SEARCH for is not always
 * what to PRINT. These are keyword searches: every token in the name is a term
 * the profile has to contain, so "Mistral AI" makes LinkedIn require the
 * literal "AI" alongside when people simply write "Mistral". The override is
 * `search_as:` in companies.yaml, baked at build time — no company is named in
 * any component. Omit the slug and the label is used, which is right for
 * nearly every company.
 */
export function searchHref(companyLabel, slug = null) {
  return schoolPeopleSearchUrl((slug && SEARCH_AS[slug]) || companyLabel);
}
