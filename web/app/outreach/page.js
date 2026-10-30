import { listCompanies, bandOf } from "@/lib/db";
import { getPeople, getSetting } from "@/lib/contacts";
import { TEMPLATE_KEYS, NAMES_PER_COMPANY } from "@/lib/people";
import { outreachQueue } from "@/lib/outreachQueue";
import { OUTREACH_PINS, SEARCH_AS } from "@/lib/config.generated";
import { getDeadlines, applyChecks } from "@/lib/deadlines";
import { windowChecks } from "@/lib/db";
import { windowsApplied } from "@/lib/applications";
import { consultingBanner } from "@/lib/consulting";
import Outreach from "../Outreach";
import { resolved } from "@/lib/assert";

export const dynamic = "force-dynamic";

/**
 * The outreach queue: companies with a role worth taking and nobody known there.
 *
 * WHY IT IS ITS OWN PAGE. Companies could already say "Find 2 names", but it
 * says that beside every company, in the order companies happen to rank, so the
 * one where a name matters most looks exactly like the one where it does not.
 * This page is only the gap, ordered by how much closing it is worth.
 *
 * force-dynamic because every number here — contacts, scores, what has been
 * submitted — changes underneath a build.
 */
export default async function Page() {
  const [companies, { people }, checks, applied, ...templates] = await Promise.all([
    listCompanies({}),
    getPeople().catch(() => ({ people: [] })),
    windowChecks().catch(() => []),
    windowsApplied().catch(() => new Set()),
    ...TEMPLATE_KEYS.map((k) => getSetting(`template:${k}`).catch(() => null)),
  ]);
  resolved(companies, "listCompanies");

  const overrides = {};
  TEMPLATE_KEYS.forEach((k, i) => { if (templates[i]) overrides[k] = templates[i]; });

  // OUTREACH_PINS is baked from companies.yaml at BUILD time, not read from
  // disk here. config.yaml read at request time is what made the deployed cost
  // meter say $29.88 / $5.00 OVER CAP while the same code said $3.17 locally.
  const queue = outreachQueue(companies, bandOf, {
    namesPerCompany: NAMES_PER_COMPANY,
    pins: OUTREACH_PINS,
    searchAs: SEARCH_AS,
  });

  // The same banner the digest sends, from the same function, so the page and
  // the email cannot disagree about whether a firm is outstanding.
  const consulting = consultingBanner(applyChecks(getDeadlines(), checks), applied);

  return (
    <Outreach
      queue={queue}
      people={people}
      overrides={overrides}
      consulting={consulting}
      namesPerCompany={NAMES_PER_COMPANY}
    />
  );
}
