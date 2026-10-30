"use client";

import { useState } from "react";
import {
  schoolPeopleSearchUrl, SCHOOL_SEARCH_PREFIX, SCHOOL_LINKEDIN_ALUMNI, OWNER,
} from "@/lib/constants";
import DraftMessage from "./DraftMessage";
import ConsultingBanner from "./ConsultingBanner";
import PasteBox from "./PasteBox";
import { chipsOf, verdictOf } from "@/lib/blockers";

/**
 * The outreach queue.
 *
 * THREE THINGS PER ROW and nothing else: who to search for, a draft to send
 * them, and how many names are still wanted. Everything that would make this a
 * dashboard has been left on Companies.
 *
 * NOBODY IS NAMED HERE. Every row hands over a SEARCH URL that the owner
 * opens themselves. Nothing in this file, or anything it calls, fetches
 * LinkedIn — the link is a string, and what happens after the click is a
 * person reading a page in their own browser signed in as themselves.
 * CLAUDE.md rule 2.
 *
 * NOTHING IS SENT. DraftMessage fills a textarea and copies it; the copy logs
 * that THE OWNER copied it, because the paste into their own mail client is
 * the approval. There is no send button on this page and no code path that
 * could add one — the sender in lib/notify.mjs takes no recipient and runs
 * only from Actions.
 *
 * THE LINK IS A KEYWORD SEARCH AND THE LABEL SAYS SO. LinkedIn school /people/
 * pages silently ignore ?keywords= — three of them were clicked on 2026-09-03
 * and every one landed on the same unfiltered 51,107-alumni page with an empty
 * search box, no 404, so nothing that checked a status code could have caught
 * it. schoolPeopleSearchUrl is the workaround that actually filters, and it
 * is a keyword match rather than an alumni filter: some results will not be
 * alumni, or not at that company. Never relabel it as a filter.
 */
export default function Outreach({
  queue = [], people = [], overrides = {}, consulting = null, namesPerCompany = 2,
}) {
  const [open, setOpen] = useState(null);
  const [paste, setPaste] = useState(null);

  return (
    <>
      <h1>Outreach</h1>

      {consulting && <ConsultingBanner consulting={consulting} />}

      <p className="sub">
        Companies with a role worth taking where you know nobody yet, best first.
        Open the search, find a name, add them on People, then draft. Five a week
        is the cadence.
      </p>

      {!queue.length ? (
        // AN EMPTY QUEUE IS A REAL STATE AND IT IS THE GOOD ONE, so it says
        // which — "nothing to do" and "this feature has never worked" read
        // identically otherwise, and that confusion has bitten this project on
        // three separate surfaces.
        <p className="nothing">
          Nothing queued: every company with a Good-or-better reachable role
          already has {namesPerCompany} names. That is the queue being finished,
          not empty. New roles refill it as they are scored.
        </p>
      ) : (
        <div className="section">
          <h2>
            {queue.length} {queue.length === 1 ? "company" : "companies"}
            <span className="h2note"> · no contact yet</span>
          </h2>

          {queue.map((q) => {
            const isOpen = open === q.name;
            const pasteOpen = paste === q.name;
            // Anyone already known at this company, so the draft has a person
            // to be about. Usually empty — that is the point of the queue.
            const known = people.filter((p) => p.company === q.name);
            return (
              // .person / .phead, the same four-column row People uses. Reused
              // rather than given its own classes: a second grid for the same
              // shape is a second thing to keep aligned, and test_classes.mjs
              // caught the first attempt inventing .btn and .krow-wrap, neither
              // of which had a rule — the page would have rendered unstyled
              // with nothing erroring.
              <div key={q.name} className="person">
                <div className="phead">
                  <span className="pname">{q.display_name}</span>
                  <span className="pmeta">
                    {/* A PINNED ROW SAYS SO AND SHOWS NO BAND. Its best role
                        scores below the queue floor — that is why it needed a
                        pin — so printing a band here would show a verdict the
                        scorer never gave, beside a company it actively skipped. */}
                    {q.pinned ? "Pinned by you" : q.band}
                    {q.roleTitle ? ` · ${q.roleTitle}` : ""}
                  </span>
                  <span className="pwhen">
                    {q.contacts}/{q.contacts + q.needed} names
                  </span>
                  <span className="pacts">
                    <a
                      className="act"
                      href={schoolPeopleSearchUrl(q.searchAs || q.display_name)}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={
                        "Opens a LinkedIn people search for the words "
                        + `“${SCHOOL_SEARCH_PREFIX} ${q.searchAs || q.display_name}”. A keyword `
                        + "match, not an alumni filter — some results will "
                        + "not be alumni, or not at this company."
                      }
                    >
                      Search {OWNER.schoolShort} alumni
                    </a>
                    <button
                      type="button"
                      className="act"
                      onClick={() => setOpen(isOpen ? null : q.name)}
                    >
                      {isOpen ? "Hide draft" : "Draft"}
                    </button>
                    <button
                      type="button"
                      className="act"
                      onClick={() => setPaste(pasteOpen ? null : q.name)}
                    >
                      {pasteOpen ? "Hide paste" : "Paste results"}
                    </button>
                  </span>
                </div>

                {/* WHAT WOULD SCREEN HIM OUT, on the row, before he spends an
                    evening finding names. Green for the two that are not
                    blockers for him at all. An `unknown` row says so rather
                    than staying silent: its posting was cut at 2,000
                    characters before the requirements section. */}
                {q.roleTitle && (() => {
                  const chips = chipsOf(q);
                  const v = verdictOf(q);
                  if (!chips.length && v !== "unknown") return null;
                  return (
                    <p className="chips">
                      {chips.map((c) => (
                        <span key={c.tag}
                              className={c.hard ? "chip chip-hard" : "chip chip-ok"}
                              title={c.explain}>
                          {c.label}
                        </span>
                      ))}
                      {v === "unknown" && (
                        <span className="chip chip-unknown"
                              title="This posting was truncated at 2,000 characters before its requirements section, so no blocker was read. That is not the same as there being none.">
                          Blockers not read
                        </span>
                      )}
                    </p>
                  );
                })()}

                {q.pinReason && (
                  <p className="note pinwhy">
                    <strong>Pinned by decision, not by score.</strong>{" "}
                    {q.pinReason}
                  </p>
                )}

                {pasteOpen && (
                  <PasteBox company={q.display_name} slug={q.name} />
                )}

                {isOpen && (
                  <div className="sub">
                    {known.length ? (
                      known.map((p) => (
                        <DraftMessage
                          key={p.id}
                          person={p}
                          roleTitle={q.roleTitle}
                          overrides={overrides}
                        />
                      ))
                    ) : (
                      <p className="nothing">
                        No one added at {q.display_name} yet, so there is nobody
                        to draft to. Open the search above, then add the name on{" "}
                        <a href={`/people?co=${encodeURIComponent(q.name)}&add=1`}>
                          People
                        </a>
                        . The draft appears here once a person exists — a message
                        with no recipient is not a draft.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="note">
        The search is a LinkedIn <strong>keyword match</strong> on
        {" “"}{SCHOOL_SEARCH_PREFIX} &lt;company&gt;{"”"}, not an alumni filter:
        expect some results who are neither.
        {SCHOOL_LINKEDIN_ALUMNI && (
          <>
            {" "}The school{"’"}s own{" "}
            <a href={SCHOOL_LINKEDIN_ALUMNI} target="_blank" rel="noreferrer noopener">
              unfiltered {OWNER.schoolShort} alumni list
            </a>{" "}
            is the alternative, and it is exactly that — every alumnus, filtered
            by hand once open.
          </>
        )}
      </p>
    </>
  );
}
