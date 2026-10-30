"use client";

import { useEffect, useState } from "react";

/**
 * Jump to a section of Daily, from the rail.
 *
 * Daily is two screens tall on a laptop and "Worth a look" is below the fold on
 * every one of them, while the rail under the cost block was empty. The page
 * already had the space for a table of contents and was not using it.
 *
 * IT READS THE PAGE, NOT A LIST. Half of Daily's sections are conditional —
 * Saved appears only when something is saved, People becomes Follow-ups owed
 * once anyone is on the list, In flight renders two different ways — so a
 * hand-kept array here would link to a section that is not on the page the
 * first time one of those conditions changed, and nothing would say so. It
 * queries `[data-section]` after mount instead, which cannot drift because the
 * sections themselves are what answer.
 *
 * Rendering nothing on the server is deliberate and costs nothing: this is a
 * navigation aid for a page that is already fully readable by scrolling.
 *
 * It carried folded/unfolded markers while sections could collapse. Those went
 * with the collapse.
 */
export default function SectionNav() {
  const [sections, setSections] = useState([]);

  useEffect(() => {
    setSections([...document.querySelectorAll("[data-section]")]
      .map((el) => ({ id: el.id, title: el.dataset.section }))
      .filter((s) => s.id));
  }, []);

  if (!sections.length) return null;

  return (
    <section className="railblock railnav">
      <h2 className="railhead">On this page</h2>
      <ul className="railnavlist">
        {sections.map((s) => (
          <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>
        ))}
      </ul>
    </section>
  );
}
