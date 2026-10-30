"use client";

import AddPerson from "./AddPerson";
import PersonRow from "./PersonRow";
import { Meter, CategoryLegend } from "./Palette";
import { categoryOfCompany } from "@/lib/palette";
import { OWNER } from "@/lib/constants";
import {
  STATUSES, STATUS_LABEL, STATUS_BLURB, STATUS_ORDER,
  MESSAGES_PER_WEEK, COLD_AFTER_DAYS,
} from "@/lib/people";

/**
 * People — the half of this tool that decides whether it is worth opening in
 * December.
 *
 * The pipeline's own conclusion is that a referral is what routes around a
 * CS-degree screen and a clearance requirement. Everything on Companies and
 * Inbox is intelligence for getting to this page; this is where the work is.
 *
 * GROUPED BY DERIVED STATUS, not by company or by name. The question a person
 * opens this page with is "who is waiting on me", and status answers it
 * directly where an alphabetical list makes you read all of them. Status comes
 * from the latest interaction and is never stored — see derivedStatus().
 *
 * The empty state is the setup action, not a headstone. "Nobody on the list
 * yet" reads as a quiet day and it is not one: it means this feature has never
 * been used, and the fix is a form, right there.
 */
export default function People({
  people = [], companies = [], ready = true, overrides = {},
  filterCompany = null, openAdd = false, pulse = null, openFor = null,
  openMode = "log", suggestTemplate = null,
  // slug -> reachable roles, so each row's draft can name a real
  // requisition instead of the literal words "the role".
  rolesByCompany = {},
}) {
  const shown = filterCompany
    ? people.filter((p) => p.company === filterCompany)
    : people;

  const co = companies.find((c) => c.name === filterCompany) || null;

  const groups = STATUS_ORDER
    .map((k) => [k, shown.filter((p) => p.derived === k)])
    .filter(([, list]) => list.length > 0);

  if (!ready) {
    // A table that is not there and a table with nobody in it look identical on
    // screen unless something says otherwise. That confusion is exactly what
    // made reading contacts.csv on Vercel invisible for weeks: the page said
    // "None owed" and looked like a quiet day.
    return (
      <div className="sheet">
        <p className="page-intro">
          The people tables are not in this database yet. Run{" "}
          <code>cd web &amp;&amp; node lib/applymigration.mjs ../migrations/002_people.sql</code>{" "}
          once and this page works. Nothing else in the app is affected.
        </p>
      </div>
    );
  }

  return (
    <div className="sheet">
      <p className="page-intro">
        Referrals are what get past a CS-degree screen and a clearance
        requirement — that is this tool&apos;s own read of your gap data. This is
        where that happens. Names come from the {OWNER.schoolShort} alumni
        directory and warm intros, entered by hand; nothing here looks anybody
        up, and nothing here sends anything.
      </p>

      {pulse && (
        <section className="pulse">
          <Meter
            done={pulse.sent}
            total={pulse.target}
            id="people-pulse"
            label={
              <>
                <span className="mstrong">
                  {pulse.sent} of {MESSAGES_PER_WEEK} messages sent this week.
                </span>{" "}
                {pulse.replies} {pulse.replies === 1 ? "reply" : "replies"} back
                {" · "}{pulse.calls} {pulse.calls === 1 ? "call" : "calls"} booked.
                Resets Monday.
              </>
            }
          />
        </section>
      )}

      {filterCompany && (
        <p className="sub">
          Showing {co?.display_name || filterCompany} only.{" "}
          <a href="/people">Show everyone</a>.
        </p>
      )}

      <AddPerson
        companies={companies}
        defaultCompany={filterCompany || ""}
        open={openAdd || people.length === 0}
      />

      {shown.length === 0 ? (
        <div className="empty">
          {filterCompany
            ? <>Nobody at {co?.display_name || filterCompany} yet. Two names is the target — the form above is open.</>
            : <>Nobody on the list yet. <a href="/companies">Companies</a> ranks who
               to get to know first; the names come out of the{" "}
               {OWNER.schoolShort} alumni directory by hand.</>}
        </div>
      ) : (
        groups.map(([key, list]) => (
          <section className="section pgroup" key={key}>
            <h2>
              {STATUS_LABEL[key]}{" "}
              <span className="h2note">— {STATUS_BLURB[key]}</span>
              <span className="count"> {list.length}</span>
            </h2>
            {list.map((p) => (
              <PersonRow key={p.id} person={p} overrides={overrides}
                roles={rolesByCompany[p.company] || []}
                         openFor={openFor} openMode={openMode}
                         suggestTemplate={suggestTemplate} />
            ))}
          </section>
        ))
      )}

      {shown.length > 0 && (
        <p className="note">
          Status is worked out from the last thing that happened, so it is never
          out of date and there is nothing to keep up. Nothing either way for{" "}
          {COLD_AFTER_DAYS} days reads as gone cold — that is information, not a
          task.
        </p>
      )}

      <CategoryLegend
        only={new Set(shown.map((p) => categoryOfCompany(p.company)))}
        note="Nothing on this page is ever sent by the tool. You paste and send."
      />
    </div>
  );
}

export { STATUSES };
