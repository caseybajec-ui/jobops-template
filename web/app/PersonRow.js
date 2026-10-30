"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CategoryDot } from "./Palette";
import DraftMessage from "./DraftMessage";
import { categoryOfCompany } from "@/lib/palette";
import {
  INTERACTION_TYPES, INTERACTION_LABEL, CHANNELS, STATUS_LABEL,
  PREP_BANKS, PREP_BY_KEY, ASK_LADDER, roleFamilyOf, MAX_MESSAGES,
} from "@/lib/people";

/** "Messaged 6 days ago" — what happened, and how long it has been sitting. */
function lastLine(p) {
  if (!p.latest) return "Nothing logged yet";
  const d = p.daysSinceActivity;
  const when = d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  return `${INTERACTION_LABEL[p.latest.type] || p.latest.type} ${when}`;
}

/**
 * Log what happened. One tap opens it, one tap closes it.
 *
 * The date defaults to today and is editable, because the thing being recorded
 * happened when it happened and not when the owner got round to typing it — and
 * every cadence rule measures from occurred_at. Logging Friday's call on Sunday
 * with Sunday's date would push the thank-you two days late.
 */
function LogSheet({ person, onDone }) {
  const router = useRouter();
  const [type, setType] = useState("outreach_sent");
  const [channel, setChannel] = useState("linkedin");
  const [when, setWhen] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "log",
          contact_id: person.id,
          type,
          channel,
          occurred_at: when,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Couldn't record that");
      }
      onDone();
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="logsheet">
      <label>
        <span className="dim">What happened</span>
        <select value={type} disabled={busy} onChange={(e) => setType(e.target.value)}>
          {INTERACTION_TYPES.map(([k, verb]) => <option key={k} value={k}>{verb}</option>)}
        </select>
      </label>
      <label>
        <span className="dim">How</span>
        <select value={channel} disabled={busy} onChange={(e) => setChannel(e.target.value)}>
          {CHANNELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label>
        <span className="dim">When</span>
        <input type="date" value={when} disabled={busy}
               onChange={(e) => setWhen(e.target.value)} />
      </label>
      <label className="lognote">
        <span className="dim">Anything worth remembering (optional)</span>
        <input value={note} disabled={busy} placeholder="what they said, what you promised"
               onChange={(e) => setNote(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && save()} />
      </label>
      <span className="logacts">
        <button type="button" onClick={save} disabled={busy}>Save it</button>
        <button type="button" className="linkish" onClick={onDone}>cancel</button>
        {err && <span className="acterr">{err}</span>}
      </span>
    </div>
  );
}

/**
 * The questions to ask, by role family.
 *
 * Static, written by hand, and it stays that way. The questions worth asking a
 * deployment strategist are the same every time; a generated set drifts toward
 * "what does a typical day look like", which is the question that gets a
 * brochure answer back.
 *
 * When the title does not match a family, all four banks are offered rather
 * than one being guessed. A wrong bank is worse than no bank — it would put
 * "how does clearance sponsorship work here" in front of a VC analyst.
 */
function Prep({ person }) {
  const guessed = roleFamilyOf(person.role || person.target_role || "");
  const [key, setKey] = useState(guessed);
  const bank = key ? PREP_BY_KEY[key] : null;

  return (
    <div className="prep">
      {!guessed && (
        <p className="dim">
          Their title doesn&apos;t say which of these it is, so pick one — the
          wrong bank is worse than none.
        </p>
      )}
      <p className="prepfam">
        {PREP_BANKS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`act${b.key === key ? " on" : ""}`}
            onClick={() => setKey(b.key)}
          >
            {b.label}
          </button>
        ))}
      </p>
      {bank && (
        <>
          <ol className="prepq">
            {bank.questions.map((q, i) => <li key={i}>{q}</li>)}
          </ol>
          <ul className="ladder">
            {ASK_LADDER.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

export default function PersonRow({
  person, overrides = {}, openFor = null, openMode = "log", suggestTemplate = null,
  // Reachable roles at THIS person's company, for the draft's role picker.
  // Empty is a real state and renders no picker.
  roles = [],
}) {
  // Daily links straight here with the composer already showing and the
  // template already chosen. "One tap" has to mean one tap; landing on the
  // page and then hunting for the person is three.
  const [open, setOpen] = useState(openFor === person.id ? openMode : null);
  const toggle = (k) => setOpen(open === k ? null : k);

  const done = person.messagesSent >= MAX_MESSAGES;

  return (
    <div className="person">
      <div className="phead">
        <span className="pname">
          <CategoryDot category={categoryOfCompany(person.company)} />
          {person.name}
          {person.linkedin_url && (
            <a className="plink" href={person.linkedin_url} target="_blank" rel="noreferrer"
               title="their LinkedIn profile">↗</a>
          )}
        </span>
        <span className="pmeta">
          {person.display_name || person.company}
          {person.role ? <><span className="sep"> · </span>{person.role}</> : null}
        </span>
        <span className="pwhen">{lastLine(person)}</span>
        <span className="pacts">
          <button type="button" className={`act${open === "log" ? " on" : ""}`}
                  onClick={() => toggle("log")}>
            Log interaction
          </button>
          <button type="button" className={`act${open === "draft" ? " on" : ""}`}
                  onClick={() => toggle("draft")}>
            Draft message
          </button>
          <button type="button" className={`act${open === "prep" ? " on" : ""}`}
                  onClick={() => toggle("prep")}>
            Before the call
          </button>
        </span>
      </div>

      {/* The cadence, stated on the row rather than only enforced silently. A
          rule you can see is one you can trust; a list that simply stops
          mentioning somebody looks like a bug. */}
      {done && (
        <p className="pcadence">
          {MAX_MESSAGES} messages sent and no reply. That is an answer — the tool
          will not suggest another. Leave the door open for a warm intro later.
        </p>
      )}

      {open === "log" && <LogSheet person={person} onDone={() => setOpen(null)} />}
      {open === "draft" && (
        <DraftMessage
          person={person}
          overrides={overrides}
          roles={roles}
          suggest={suggestTemplate
            || (person.messagesSent > 0 ? "follow_up" : null)}
        />
      )}
      {open === "prep" && <Prep person={person} />}

      {open === "log" && person.interactions.length > 0 && (
        <ol className="phistory">
          {person.interactions.map((i) => (
            <li key={i.id}>
              <span className="mono">{String(i.occurred_at).slice(0, 10)}</span>{" "}
              {INTERACTION_LABEL[i.type] || i.type}
              {i.note ? <span className="dim"> — {i.note}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export { STATUS_LABEL };
