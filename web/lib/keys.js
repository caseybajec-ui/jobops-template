/**
 * The keyboard map, and the one rule that makes it safe.
 *
 * Pure, so "does `s` fire while typing in the add-item box" is a test rather
 * than something you find out by losing a sentence.
 *
 * THE RULE: a shortcut NEVER fires while focus is in an input, a textarea, a
 * select or anything contenteditable. Every single-key shortcut in this app is
 * a letter, and the page is full of text boxes — the add-item field, the note
 * field, the profile card, the wrong-cycle reason. Typing "save" in one of them
 * would otherwise hide a role, mark another applied, and open a dialog.
 */

export const SHORTCUTS = [
  ["k", "⌘K / Ctrl-K", "anywhere", "open the command palette"],
  ["j", "j", "any list", "move down"],
  ["k", "k", "any list", "move up"],
  ["x", "x", "On you", "tick the focused task"],
  ["s", "s", "a role row", "save / unsave"],
  ["h", "h", "a role row", "hide"],
  ["a", "a", "a role row", "mark applied"],
  ["Enter", "Enter", "a focused row", "open it"],
  ["?", "?", "anywhere", "this list"],
  ["Escape", "Esc", "anywhere", "close whatever is open"],
];

/**
 * Is this keystroke being typed INTO something?
 *
 * Checked on the event target rather than on document.activeElement: a keydown
 * during a focus change reports the element the key actually went to, and the
 * two disagree exactly when it matters.
 */
export function isTyping(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // A role="textbox" is a text box however it is built.
  if (String(target.getAttribute?.("role") || "") === "textbox") return true;
  return false;
}

/**
 * What a keystroke means, or null.
 *
 * Returns null for anything held with a modifier except the palette itself:
 * ⌘S is save-page and ⌘A is select-all, and stealing either would be a bug
 * people report as "the browser is broken".
 */
export function shortcutFor(e) {
  if (!e) return null;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && String(e.key).toLowerCase() === "k") return "palette";
  if (mod || e.altKey) return null;

  if (isTyping(e.target)) {
    // Escape still works inside a field — it is how you get out of one.
    return e.key === "Escape" ? "escape" : null;
  }

  switch (e.key) {
    case "j": return "down";
    case "k": return "up";
    case "x": return "toggle";
    case "s": return "save";
    case "h": return "hide";
    case "a": return "applied";
    case "Enter": return "open";
    case "?": return "help";
    case "Escape": return "escape";
    default: return null;
  }
}
