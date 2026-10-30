"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SOURCES, WARMTH, nameFromLinkedIn, looksLikeLinkedIn } from "@/lib/people";
import { OWNER } from "@/lib/constants";

/**
 * Add a person, in as few keystrokes as it is possible to need.
 *
 * NAME AND COMPANY ARE THE ONLY REQUIRED FIELDS. Every extra required field is
 * a reason to close the form and do it later, and later is how the contacts
 * table stayed empty for a month while three features that read it rendered
 * empty states that looked like quiet days.
 *
 * PASTING A LINKEDIN URL INTO THE NAME BOX IS ENOUGH. The slug is turned into a
 * name and the link is kept — deterministically, by string manipulation, with
 * no network call. Nothing in this repository fetches a LinkedIn page and
 * nothing ever will: CLAUDE.md rule 2, and their terms.
 *
 * The derived name lands in an EDITABLE field and is never treated as a fact.
 * "jane-doe-8a41b2" becoming "Jane Doe" is a starting point; the box is right
 * there if LinkedIn's slug spelled it differently.
 */
export default function AddPerson({ companies = [], defaultCompany = "", open = false }) {
  const router = useRouter();
  const [show, setShow] = useState(open);
  const [name, setName] = useState("");
  const [company, setCompany] = useState(defaultCompany);
  const [role, setRole] = useState("");
  const [link, setLink] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("alumni_directory");
  const [warmth, setWarmth] = useState("cold");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  /**
   * Turn a LinkedIn URL sitting in the name box into a name.
   *
   * Fired on PASTE and on BLUR, and deliberately not on every keystroke. The
   * first version ran on change, which meant that typing a URL character by
   * character rewrote the field the moment "linkedin.com/in/z" became matchable
   * — so the next keystroke landed after a derived "Z" and the box filled with
   * garbage. Pasting is the common case and typing is a real one, and neither
   * should be able to corrupt the field it is trying to help with.
   *
   * A name is only overwritten when one could actually be read out. A profile
   * URL with no usable slug leaves the box holding the URL, which is visibly
   * wrong and therefore gets fixed, rather than silently blank.
   */
  function absorbLink(v) {
    if (!looksLikeLinkedIn(v)) return false;
    const derived = nameFromLinkedIn(v);
    setLink(v.trim());
    setSource("linkedin");
    if (derived) { setName(derived); return true; }
    return false;
  }

  async function submit() {
    if (!name.trim() || !company.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "add",
          name: name.trim(),
          company: company.trim(),
          role: role.trim() || null,
          linkedin_url: link.trim() || null,
          email: email.trim() || null,
          source,
          warmth,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Couldn't save — try again");
      }
      setName(""); setRole(""); setLink(""); setEmail("");
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!show) {
    return (
      <p className="addopen">
        <button type="button" onClick={() => setShow(true)}>Add someone</button>
        <span className="dim">
          {" "}Names come from the {OWNER.schoolShort} alumni directory and warm intros, by hand.
          The tool never looks anyone up.
        </span>
      </p>
    );
  }

  return (
    <div className="addperson">
      <div className="addrow">
        <label>
          <span className="dim">Name — or paste their LinkedIn link</span>
          <input
            value={name}
            disabled={busy}
            placeholder="Jane Doe"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onPaste={(e) => {
              const t = e.clipboardData?.getData("text") || "";
              // preventDefault only when a name was actually read out of it,
              // or a URL that cannot be parsed would be swallowed entirely.
              if (looksLikeLinkedIn(t) && absorbLink(t)) e.preventDefault();
            }}
            onBlur={(e) => absorbLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Enter on a pasted-and-typed URL should convert it first, then
              // submit — not submit a person literally named after a URL.
              if (absorbLink(name)) return;
              submit();
            }}
          />
        </label>
        <label>
          <span className="dim">Company</span>
          <input
            value={company}
            disabled={busy}
            list="jobops-companies"
            placeholder="palantir"
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <datalist id="jobops-companies">
          {companies.map((c) => (
            <option key={c.name} value={c.name}>{c.display_name}</option>
          ))}
        </datalist>
      </div>

      <div className="addrow">
        <label>
          <span className="dim">Their title (optional)</span>
          <input
            value={role}
            disabled={busy}
            placeholder="Deployment Strategist"
            onChange={(e) => setRole(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <label>
          <span className="dim">How you found them</span>
          <select value={source} disabled={busy} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>
          <span className="dim">Do you know them?</span>
          <select value={warmth} disabled={busy} onChange={(e) => setWarmth(e.target.value)}>
            {WARMTH.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>

      <div className="addrow">
        <label>
          <span className="dim">LinkedIn link (optional)</span>
          <input
            value={link}
            disabled={busy}
            placeholder="https://www.linkedin.com/in/…"
            onChange={(e) => setLink(e.target.value)}
          />
        </label>
        <label>
          <span className="dim">Email (optional)</span>
          <input
            value={email}
            disabled={busy}
            placeholder="jane@example.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
      </div>

      <p className="addacts">
        <button type="button" onClick={submit} disabled={busy || !name.trim() || !company.trim()}>
          Add this person
        </button>
        <button type="button" className="linkish" onClick={() => setShow(false)}>
          close
        </button>
        {err && <span className="acterr">{err}</span>}
      </p>
    </div>
  );
}
