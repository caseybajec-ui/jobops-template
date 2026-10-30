import { listCompanies, rolesForOutreach } from "@/lib/db";
import { getPeople, getSetting } from "@/lib/contacts";
import { weeklyPulse, TEMPLATE_KEYS } from "@/lib/people";
import People from "../People";
import { resolved } from "@/lib/assert";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }) {
  const sp = await searchParams;

  // Independent reads go together. Against Neon each await is a network round
  // trip, and this page would otherwise make one for every template.
  const [{ people, ready }, companies, ...templates] = await Promise.all([
    getPeople(),
    listCompanies({}),
    ...TEMPLATE_KEYS.map((k) => getSetting(`template:${k}`)),
  ]);
  resolved(companies, "listCompanies");

  // Only the templates the owner has actually edited. An absent key means "use the
  // shipped wording", which is a different thing from an empty override and is
  // why the reset path stores null rather than "".
  const overrides = {};
  TEMPLATE_KEYS.forEach((k, i) => { if (templates[i]) overrides[k] = templates[i]; });

  // Companies for the autocomplete: display name and slug, in the order the
  // Companies page ranks them, so the ones worth knowing are at the top of the
  // list rather than alphabetically buried.
  const options = companies.map((c) => ({
    name: c.name,
    display_name: c.display_name,
  }));

  // The company's display name has to travel with each person, or every row on
  // this page reads "hadrian-automation" instead of "Hadrian".
  const label = new Map(companies.map((c) => [c.name, c.display_name]));
  const shaped = people.map((p) => ({
    ...p,
    display_name: label.get(p.company) || p.company,
  }));

  // The roles each person's draft can be about. One query per company that
  // actually has somebody in it — not one per person, which would repeat the
  // work for every contact at Palantir — and all of them in parallel, because
  // against Neon each await is a round trip.
  const slugs = [...new Set(shaped.map((p) => p.company).filter(Boolean))];
  const roleLists = await Promise.all(slugs.map((c) => rolesForOutreach(c)));
  const rolesByCompany = Object.fromEntries(
    slugs.map((c, i) => [c, roleLists[i]]));

  return (
    <People
      people={shaped}
      rolesByCompany={rolesByCompany}
      companies={options}
      ready={ready}
      overrides={overrides}
      pulse={weeklyPulse(shaped)}
      filterCompany={sp.co || null}
      openAdd={sp.add === "1"}
      openFor={sp.open || null}
      openMode={sp.do === "draft" ? "draft" : "log"}
      suggestTemplate={sp.t || null}
    />
  );
}
