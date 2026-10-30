import { VARIANTS, variantFor } from "@/lib/variant";

/**
 * "tech resume" / "finance resume", beside the thing you are about to apply with.
 *
 * ONE COMPONENT so the job list and the deadline rows cannot disagree. Two
 * copies of a rule is two chances for one to drift, and this one has a wrong
 * answer that costs an application.
 *
 * IT RENDERS NOTHING when the category is unknown. A tag is a recommendation,
 * and there is no honest recommendation without a category — 84% of the bulk
 * jobs table has none. Silence is the correct output; a default would put the
 * finance resume in front of a defense prime and look just as confident.
 *
 * The label is the file you will attach, not a code word: the download in the
 * profile card's Resumes section has the same name on it.
 */
export default function ResumeTag({ variant = null, category = null }) {
  const v = variant ? VARIANTS[variant] : variantFor(category);
  if (!v) return null;
  return (
    <span className="restag" title={`Attach ${v.filename} — ${v.goesTo}`}>
      {v.label.toLowerCase()} resume
    </span>
  );
}
