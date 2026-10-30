import { listCompanies, actionState, actionDates } from "@/lib/db";
import { referralTally } from "@/lib/lifecycle";
import { listActiveApplications } from "@/lib/applications";
import { companyNotes } from "@/lib/companyNotes";
import Companies from "../Companies";
import { resolved } from "@/lib/assert";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }) {
  const sp = await searchParams;
  const sort = sp.sort || "best";
  // The UNION, so the tally counts the consulting applications too — they are
  // the ones with the nearest deadline and they were invisible to it.
  const [state, applied, allApplications] = await Promise.all([
    actionState(), actionDates("applied"), listActiveApplications(),
  ]);
  resolved(state, "actionState");
  resolved(applied, "actionDates");

  // A role-level "applied" is company-level news here: the group key starts
  // with the company slug.
  const appliedByCompany = new Map();
  for (const [key, at] of applied) {
    const co = String(key).split("|")[0];
    if (!appliedByCompany.has(co) || at > appliedByCompany.get(co)) {
      appliedByCompany.set(co, at);
    }
  }

  const notes = companyNotes();
  const companies = resolved(await listCompanies({ sort }), "listCompanies").map((c) => ({
    ...c,
    appliedAt: appliedByCompany.get(c.name) || null,
    why: notes.get(c.name) || null,
  }));

  return (
    <Companies
      companies={companies}
      sort={sort}
      targets={[...state.targets]}
      tally={referralTally(allApplications)}
    />
  );
}
