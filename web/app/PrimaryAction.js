"use client";

import { useState } from "react";
import { primaryActionFor } from "@/lib/actions";
import { useFindNames, searchHref } from "./FindNames";
import ResumeTag from "./ResumeTag";

/**
 * The one verb, on the right of every role row.
 *
 * Every row on every page looked identical and asked for the same thing — Save.
 * The right move is not the same on every row and the difference is expensive:
 * Palantir's Deployment Strategist is open NOW, so it will be filled long before
 * the owner graduates and applying is close to pointless, while Databricks' APM
 * (dated for the class) is the actual application and it closes. Both rendered
 * as a title, a location and a Save button.
 *
 *   Apply         opens the posting, and marks it saved on the way out, because
 *                 an application he started is a thing he needs to see again.
 *   Find a person opens the alumni search for that company in a new tab AND the
 *                 add-person form, pre-filled. Two clicks became one, and the
 *                 form is open when he comes back with a name.
 *   Watch         renders as words, not a button. There is nothing to do, and a
 *                 button that does nothing is worse than a sentence saying so.
 */
export default function PrimaryAction({ role, contactCounts = {}, onSave = null }) {
  const findNames = useFindNames();
  const [went, setWent] = useState(false);
  const { action, label, why, contacts, note } = primaryActionFor(role, contactCounts);

  if (action === "watch") {
    return (
      <>
        <span className="pact watch" title={note || why}>
          Watch
        </span>
        {/* WHY it is Watch, when the reason is one the owner stated rather than one
            the ladder derived. A demoted verb with no explanation reads as the
            tool having lost track of a role that was an application yesterday. */}
        {note && <span className="pactnote">{note}</span>}
      </>
    );
  }

  if (action === "apply") {
    // WHICH RESUME, on the button that opens the form. Deciding it at the
    // moment of applying is the only moment it matters; a rule that lives only
    // on the profile card is one he has to remember to go and read.
    //
    // Absent when the company has no category — no tag rather than a guess,
    // because attaching the wrong resume is worse than attaching none. The
    // category goes in raw and ResumeTag decides: passing variantFor()'s return
    // value looked equivalent and was not — it hands back the variant OBJECT
    // while the component wants the KEY, so VARIANTS[{…}] was undefined and
    // every tag silently rendered nothing. Nothing threw; the page just had no
    // tags on it, which is indistinguishable from a company with no category.
    return (
      <>
        <a
          className="pact apply"
          href={role.url || "#"}
          target="_blank"
          rel="noreferrer"
          title={why}
          onClick={(e) => {
            e.stopPropagation();
            // Saving is a side effect of leaving, not a second button. If the
            // save fails the tab still opens — the posting is the point, and a
            // failed shortlist write must never eat the click.
            if (onSave) { try { onSave(); } catch { /* the posting still opens */ } }
          }}
        >
          Apply →
        </a>
        <ResumeTag category={role.category} />
      </>
    );
  }

  // find_person
  return (
    <a
      className="pact find"
      href={searchHref(role.display_name || role.company, role.company)}
      target="_blank"
      rel="noreferrer"
      title={contacts === 0
        ? `${why} You know nobody there yet.`
        : `${why} You know 1 person there; one is a single point of failure.`}
      onClick={(e) => {
        setWent(true);
        // The add form opens HERE while the search opens in the new tab, so the
        // name he finds has somewhere to go the moment he switches back.
        findNames(role.company, e);
      }}
    >
      {went ? "Searching…" : "Find a person"}
    </a>
  );
}
