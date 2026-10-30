"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  TOURS, TOUR_KEY, nextIndex, progress, resumeIndex,
} from "@/lib/tour";

/**
 * The tour renderer. Steps live in lib/tour.js as data; this only draws them.
 *
 * THE SCRIM IS FOUR RECTANGLES, NOT ONE WITH A HOLE.
 *
 * The obvious build is a full-screen overlay with the target lifted above it by
 * z-index. It does not survive this app: the targets sit inside CSS grids, a
 * sticky rail, and a position:relative row that each open their own stacking
 * context, so "above the overlay" is not a thing a child of them can be without
 * rewriting their positioning. Four rects around the target's bounding box —
 * top, bottom, left, right — dim everything else and leave the target
 * PHYSICALLY UNTOUCHED at full brightness. No z-index surgery, no changes to
 * any page's CSS, and the page still scrolls.
 *
 * A MISSING TARGET SKIPS, AND NEVER BLOCKS. If a selector matches nothing the
 * step is added to `skipped` and the engine moves on in the direction it was
 * already going. That is right for a live reader and wrong forever, so
 * test_tour_targets.mjs loads every page and fails if a selector matches
 * nothing — skip live, fail in the test.
 *
 * IT NEVER TOUCHES DATA. No writes, no actions on your behalf; a step's optional
 * `cta` is an ordinary link. Walking the tour twice leaves the database exactly
 * as it was.
 */

/** How long to wait for a target after a route change, and how often to look. */
const FIND_TIMEOUT_MS = 2500;
const FIND_POLL_MS = 60;
const RING_PAD = 6;
/** Room the card needs. Used to decide above/below and to clamp into view. */
const CARD_ROOM = 230;

function read() {
  try {
    return JSON.parse(window.localStorage.getItem(TOUR_KEY) || "{}");
  } catch {
    return {};
  }
}
function write(v) {
  try {
    window.localStorage.setItem(TOUR_KEY, JSON.stringify(v));
  } catch { /* private window: the tour simply will not resume */ }
}

export default function Tour() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const name = params.get("tour");
  const steps = TOURS[name] || null;

  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);       // the target's rect, or null
  const [skipped, setSkipped] = useState(() => new Set());
  const started = useRef(false);

  const step = steps ? steps[i] : null;

  /* Resume where it stopped. Keyed by step id — see lib/tour.js. */
  useEffect(() => {
    if (!steps || started.current) return;
    started.current = true;
    setI(resumeIndex(steps, read()[name]));
  }, [steps, name]);

  const stop = useCallback(() => {
    const p = read();
    delete p[name];
    write(p);
    const q = new URLSearchParams(Array.from(params.entries()));
    q.delete("tour");
    router.replace(pathname + (q.toString() ? `?${q}` : ""));
  }, [name, params, pathname, router]);

  const go = useCallback((dir) => {
    if (!steps) return;
    const n = nextIndex(steps, i, dir, skipped);
    if (n === null) { stop(); return; }
    setI(n);
    setBox(null);
  }, [steps, i, skipped, stop]);

  /* Remember where we are, so closing and reopening resumes here. */
  useEffect(() => {
    if (!steps || !step) return;
    write({ ...read(), [name]: step.id });
  }, [steps, step, name]);

  /* Navigate if the step lives on another page. */
  useEffect(() => {
    if (!step) return;
    if (step.page === pathname) return;
    const q = new URLSearchParams();
    q.set("tour", name);
    router.push(`${step.page}?${q}`);
  }, [step, pathname, name, router]);

  /**
   * Find the target, with a DEADLINE. After a route change the element arrives
   * whenever the page renders, so this polls — but a wait loop with only a
   * success condition spins forever when the thing never appears, which is the
   * bug this project already spent four hours on. Success, or timeout and skip.
   */
  useEffect(() => {
    if (!step || step.page !== pathname) return undefined;
    let alive = true;
    const deadline = Date.now() + FIND_TIMEOUT_MS;

    const look = () => {
      if (!alive) return;
      const el = document.querySelector(step.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          // INSTANT, NOT SMOOTH. With behavior:"smooth" the scroll has not
          // happened yet when the next line measures, so the ring was drawn at
          // the element's OLD position — off the target by however far the page
          // was about to move. Measured: the ring failed to line up on the very
          // first step. A smooth scroll under a dimming scrim is not worth a
          // wrong first frame.
          el.scrollIntoView({ block: "center", behavior: "auto" });
          setBox(el.getBoundingClientRect());
          return;
        }
      }
      if (Date.now() > deadline) {
        // Not on this page. Mark it and carry on in the same direction.
        setSkipped((s) => new Set(s).add(step.id));
        const n = nextIndex(steps, i, 1, new Set([...skipped, step.id]));
        if (n === null) stop(); else setI(n);
        return;
      }
      setTimeout(look, FIND_POLL_MS);
    };
    look();
    return () => { alive = false; };
  }, [step, pathname, steps, i, skipped, stop]);

  /* Follow the target while the page moves under it. */
  useEffect(() => {
    if (!step || !box) return undefined;
    const track = () => {
      const el = document.querySelector(step.selector);
      if (el) setBox(el.getBoundingClientRect());
    };
    window.addEventListener("scroll", track, true);
    window.addEventListener("resize", track);
    return () => {
      window.removeEventListener("scroll", track, true);
      window.removeEventListener("resize", track);
    };
  }, [step, box]);

  /* Escape exits, arrows walk. */
  useEffect(() => {
    if (!steps) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); stop(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps, go, stop]);

  if (!steps || !step || !box) return null;

  const p = progress(steps, i, skipped);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ring = {
    top: box.top - RING_PAD, left: box.left - RING_PAD,
    width: box.width + RING_PAD * 2, height: box.height + RING_PAD * 2,
  };

  // Below the target if there is room, otherwise above it.
  //
  // PINNED TO THE BOTTOM ON A PHONE — and also when the target is TALLER THAN
  // MOST OF THE SCREEN. The rail is 300x1035; anchoring a card under a ring that
  // tall put it a thousand pixels below the fold, where the Next button was not
  // merely awkward but unclickable. Found by walking the tour, not by reading
  // it. A tail across half a screen points at nothing either way, so it is
  // dropped in both cases.
  const tall = ring.height > vh * 0.6;
  const narrow = vw <= 640 || tall;
  // Where the ring sits relative to the card, for the written connector above.
  // The card is pinned near the bottom when `narrow`, so compare against that.
  const pointsUp = ring.top + ring.height / 2 < vh - CARD_ROOM;
  const below = ring.top + ring.height + CARD_ROOM < vh;
  const rawTop = below ? ring.top + ring.height + 12 : ring.top - CARD_ROOM - 12;
  const cardStyle = narrow
    ? undefined
    : {
        // Clamped into the viewport regardless of where the target is: a card
        // you cannot reach is the same as no card.
        top: Math.max(12, Math.min(rawTop, vh - CARD_ROOM - 12)),
        left: Math.max(12, Math.min(ring.left, vw - 372)),
      };

  return (
    <div className="tour" role="dialog" aria-label={`Tour: ${step.title}`}>
      {/* Four rects, not one with a hole. The target is never covered. */}
      <div className="tourdim" style={{ top: 0, left: 0, width: "100%", height: Math.max(0, ring.top) }} />
      <div className="tourdim" style={{ top: ring.top + ring.height, left: 0, width: "100%", height: Math.max(0, vh - ring.top - ring.height) }} />
      <div className="tourdim" style={{ top: ring.top, left: 0, width: Math.max(0, ring.left), height: ring.height }} />
      <div className="tourdim" style={{ top: ring.top, left: ring.left + ring.width, width: Math.max(0, vw - ring.left - ring.width), height: ring.height }} />

      <div className="tourring" style={ring} aria-hidden="true" />

      {/* PERSISTENT, IN THE HEADER, for the whole tour. The card carries one
          too, but the card moves with the target and can end up pinned to the
          bottom of a phone — a way out should not be somewhere you have to look
          for it. Rendered here rather than inside the topbar so layout.js does
          not need to know a tour exists. */}
      <button type="button" className="tourexit" onClick={stop}>
        Close tour
      </button>

      <div className={`tourcard${narrow ? " bottom" : ""}`} style={cardStyle}>
        {!narrow && (
          <span className={`tourtail${below ? "" : " up"}`}
                style={{ left: Math.max(14, Math.min(ring.left + ring.width / 2 - Math.max(12, Math.min(ring.left, vw - 372)), 330)) }}
                aria-hidden="true" />
        )}
        {/* WHEN THERE IS NO TAIL, SAY IT IN WORDS.
            The tail's whole job is to state which thing the card is about. It is
            dropped for a target taller than the screen and on a phone, where it
            would stretch across half the viewport and point at nothing — and
            with it gone the link between card and ring is left unstated. One
            grey line restores it.
            The DIRECTION is computed, never written down: the card is pinned to
            the bottom, so the ring is almost always above it, but "almost" is
            not a thing to hardcode into a sentence that would then be wrong. */}
        {narrow && (
          <p className="tourlink">
            {pointsUp ? "↑" : "↓"} the outlined section {pointsUp ? "above" : "below"}
          </p>
        )}
        <p className="tourstep">{p.at} of {p.total}</p>
        <h2 className="tourtitle">{step.title}</h2>
        <p className="tourbody">{step.body}</p>
        <div className="touracts">
          <button type="button" className="railbtn" onClick={() => go(1)}>
            {nextIndex(steps, i, 1, skipped) === null ? "Done" : "Next"}
          </button>
          <button type="button" className="linkish" onClick={() => go(-1)}
                  disabled={nextIndex(steps, i, -1, skipped) === null}>
            Back
          </button>
          {step.cta && (
            <a className="linkish" href={step.cta.href}>{step.cta.label}</a>
          )}
          <span className="spacer" />
          <button type="button" className="linkish" onClick={stop}>Close tour</button>
        </div>
      </div>
    </div>
  );
}
