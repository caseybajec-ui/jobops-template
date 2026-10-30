"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { copyText } from "./useAction";
import {
  TEMPLATES, TEMPLATE_BY_KEY, renderTemplate, firstNameOf, roleFactOf,
  recommendRole, recommendReason, linkedinNote, LINKEDIN_LIMIT,
} from "@/lib/people";

/**
 * Assemble a message from a template, let the owner edit it, hand it to the
 * clipboard, and record that he said he sent it.
 *
 * NO MODEL. Not as a cost saving — as a correctness requirement. A model
 * writing these would produce warmth it has no basis for ("I've been following
 * your work on…") about a person the owner has never read, which is precisely what
 * CLAUDE.md forbids, on the one surface where the reader is a stranger and the
 * cost of being caught inventing a connection is the relationship. A template
 * can only say what its fields hold.
 *
 * THE TOOL NEVER SENDS. It fills a textarea and copies it. "Copy message" logs
 * an outreach_sent because the owner is about to paste it into LinkedIn or an email
 * client himself — the log records HIS action, not the tool's. That is the same
 * human-approval gate outreach.py has, with the approval step being the paste.
 *
 * Which is why the undo exists: the log fires on copy, and copying to re-read
 * something is a thing people do. Ten minutes to take it back, then the honest
 * correction is to log what really happened.
 */
export default function DraftMessage({
  person, roleTitle = null, overrides = {}, suggest = null, roles = [],
}) {
  const router = useRouter();
  const [key, setKey] = useState(
    suggest || (person.messagesSent > 0 ? "follow_up" : "alum_cold"));
  const template = TEMPLATE_BY_KEY[key];

  // WHICH ROLE THIS NOTE IS ABOUT.
  //
  // A cold note that names a specific requisition reads as someone asking
  // about a JOB; one that says "the role" reads as someone asking for one.
  // Both Palantir contacts have no role on file, so before this existed
  // every draft to them rendered the literal words "the role".
  //
  // The picked role also supplies {role_fact} -- location, straight off the
  // posting. Derived, never written: a model asked for something concrete
  // about a stranger's job invents it, which is the one thing forbidden on
  // the surface where a real person reads it.
  // ONE RECOMMENDED ROLE, NOT A DROPDOWN. The cadence allows two messages
  // per person ever, so there is one real slot -- offering twelve options
  // for it is the interface implying a freedom that does not exist. The
  // choice is made from the data and the REASON is shown, so it can be
  // disagreed with; `person.job_key` still wins, because a role the owner tied
  // to this person by hand is a decision and outranks a score.
  const recommended = recommendRole(roles);
  const [jobKey, setJobKey] = useState(
    person.job_key || recommended?.key || null);
  const [override, setOverride] = useState(false);
  const job = roles.find((r) => r.key === jobKey) || null;
  const reason = recommendReason(job, roles);

  const fieldsFor = (forJob) => ({
    first_name: firstNameOf(person.name),
    company: person.display_name || person.company,
    role_title: forJob?.title || roleTitle || person.target_role
      || person.role || "the role",
    role_fact: roleFactOf(forJob),
    shared_hook: person.shared_hook || "",
  });

  // The LinkedIn note goes through linkedinNote, which shortens the TITLE
  // until it fits 300 characters. LinkedIn truncates silently, so a note
  // that is merely rendered and hoped for arrives cut off mid-question.
  const compose = (k, forJob = job) => (
    k === "linkedin_note"
      ? linkedinNote({ ...fieldsFor(forJob),
                       body: overrides[k] ?? undefined }).text
      : renderTemplate(overrides[k] ?? TEMPLATE_BY_KEY[k].body,
                       fieldsFor(forJob)));

  const [text, setText] = useState(() => compose(key));
  const [copied, setCopied] = useState(null);   // the interaction id, for undo
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  function pick(k) {
    setKey(k);
    setText(compose(k));
    setCopied(null);
    setErr(null);
  }

  // Changing the role rewrites the draft, discarding edits -- the same
  // trade picking a template already makes. Silently keeping the old text
  // under a new role name would be the worse of the two, because the note
  // would then name one requisition and describe another.
  function pickRole(k) {
    const next = roles.find((r) => r.key === k) || null;
    setJobKey(k);
    setText(compose(key, next));
    setCopied(null);
    setErr(null);
  }

  async function copyAndLog() {
    setBusy(true);
    setErr(null);
    // The clipboard FIRST. If it fails there is nothing to log — recording a
    // message as sent when it never reached the clipboard would put a real
    // person into the follow-up cadence for something they were never sent.
    if (!(await copyText(text))) {
      setBusy(false);
      setErr("Couldn't reach the clipboard — select the text and copy it by hand.");
      return;
    }
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "log",
          contact_id: person.id,
          type: key === "thank_you" ? "thank_you_sent" : "outreach_sent",
          channel: person.email ? "email" : "linkedin",
          note: `${template.label} — copied from the draft`,
        }),
      });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error || "Couldn't record that");
      setCopied(b.id);
      router.refresh();
    } catch (e) {
      // The text IS on the clipboard at this point. Saying "copied, but not
      // recorded" is the whole truth; saying "couldn't save" would suggest the
      // copy failed too and get the message sent twice.
      setErr(`Copied, but not recorded — ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "undo", id: copied }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Couldn't undo that");
      }
      setCopied(null);
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "template", key, body: text }),
      });
      if (!res.ok) throw new Error("Couldn't save that template");
      setEditing(false);
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="draft">
      <p className="drafthead">
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`act${t.key === key ? " on" : ""}`}
            title={t.when}
            onClick={() => pick(t.key)}
          >
            {t.label}
          </button>
        ))}
      </p>
      <p className="draftwhen">{template.when}</p>

      {/* WHICH ROLE. Only when there are roles to choose between -- a
          one-option select is a control that cannot do anything, and a
          person at a company with no reachable roles should not be offered
          a picker that says so in an empty dropdown. */}
      {job && (
        <p className="draftrole">
          <span className="draftrolename">{job.title}</span>
          {job.url && (
            <>
              {" "}
              <a href={job.url} target="_blank" rel="noreferrer noopener">
                posting
              </a>
            </>
          )}
          {/* THE REASON, ON THE ROW. A recommendation whose basis is
              invisible has to be trusted blindly or re-derived by hand. */}
          {reason && <span className="draftrolewhy">{reason}</span>}
          {roles.length > 1 && !override && (
            <button
              type="button"
              className="act"
              onClick={() => setOverride(true)}
            >
              change
            </button>
          )}
        </p>
      )}

      {/* The override, only once asked for. */}
      {override && roles.length > 1 && (
        <p className="draftrole">
          <label htmlFor="draftrole">Write about</label>{" "}
          <select
            id="draftrole"
            className="draftrolesel"
            value={jobKey || ""}
            onChange={(e) => pickRole(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.title}
                {r.location ? `, ${r.location.split(";")[0].trim()}` : ""}
                {r.score != null ? ` (${r.score})` : ""}
              </option>
            ))}
          </select>
        </p>
      )}

      {/* THE COUNTER, because the limit is invisible in LinkedIn's own box. */}
      {key === "linkedin_note" && (
        <p className="draftrole">
          <span className={text.length > LINKEDIN_LIMIT
            ? "draftoverlimit" : "draftrolewhy"}>
            {text.length} / {LINKEDIN_LIMIT} characters
            {text.length > LINKEDIN_LIMIT
              ? " — LinkedIn will cut this without saying so"
              : ""}
          </span>
        </p>
      )}

      <textarea
        className="drafttext"
        rows={Math.min(20, text.split("\n").length + 2)}
        value={text}
        disabled={busy}
        onChange={(e) => { setText(e.target.value); setEditing(true); }}
      />

      <p className="draftacts">
        <button type="button" onClick={copyAndLog} disabled={busy}>
          Copy message
        </button>
        {editing && (
          <button type="button" className="linkish" onClick={saveTemplate} disabled={busy}
                  title="Keep these words as the template for everyone, not just this person">
            save as the template
          </button>
        )}
        {overrides[key] && (
          <button
            type="button"
            className="linkish"
            disabled={busy}
            title="Go back to the wording this tool shipped with"
            onClick={async () => {
              await fetch("/api/people", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "template", key, body: null }),
              });
              router.refresh();
            }}
          >
            reset to the original
          </button>
        )}
        {copied && (
          <span className="toast" role="status">
            Copied, and logged as sent.{" "}
            <button type="button" className="linkish" onClick={undo} disabled={busy}>
              undo
            </button>
          </span>
        )}
        {err && <span className="acterr">{err}</span>}
      </p>

      <p className="draftnote">
        Nothing is sent from here. Paste it into LinkedIn or your mail client
        yourself — copying it is what records the message as sent.
      </p>
    </div>
  );
}
