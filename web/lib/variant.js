/**
 * Which resume goes to which company. Pure, deterministic, no model.
 *
 * "If code can decide it, code decides it." A company's category is already a
 * field in companies.yaml and already on every job row; choosing a resume from
 * it is a lookup, not a judgement, and handing that lookup to a model would buy
 * nothing but a bill and a chance of being wrong.
 *
 * THE MAP IS THE WHOLE RULE:
 *
 *   defense    -> tech       consulting -> finance
 *   product    -> tech       vc         -> finance
 *
 * WHERE EACH ONE ACTUALLY SHOWS UP. Every fetched role today is defense (89) or
 * product (12), so the tech tag is what appears on Apply buttons. There are ZERO
 * fetched consulting or VC roles and there never will be many — those firms
 * recruit through channels the fetcher cannot see, which is why they live in
 * `deadlines:` instead. So the finance tag's home is the deadline and
 * manual-application rows, not the job list. Both surfaces carry `category`.
 */

/** The two variants, and everything a surface needs to render one. */
export const VARIANTS = {
  tech: {
    key: "tech",
    label: "Tech",
    source: "resume_tech.md",
    pdf: "/resume/resume-tech.pdf",
    filename: "resume-tech.pdf",
    // Said in the owner's terms, because this string is what the profile card
    // shows. The category names are fixed; what they mean to a person is set
    // by which companies.yaml groups they put companies in.
    goesTo: "defense and product & tech",
  },
  finance: {
    key: "finance",
    label: "Finance",
    source: "resume_finance.md",
    pdf: "/resume/resume-finance.pdf",
    filename: "resume-finance.pdf",
    goesTo: "consulting and VC & growth",
  },
};

export const VARIANT_KEYS = ["tech", "finance"];

const BY_CATEGORY = {
  defense: "tech",
  product: "tech",
  consulting: "finance",
  vc: "finance",
};

/** Every category this map knows, so a test can assert none was forgotten. */
export const KNOWN_CATEGORIES = Object.keys(BY_CATEGORY);

/**
 * The variant key for a company category, or NULL when there is no answer.
 *
 * NULL, never a default. 84% of jobs.category is empty in the bulk table —
 * every curated role has one today, but the moment that stops being true a
 * default would put the finance resume in front of a defense recruiter and say
 * nothing about it. Showing no tag is a surface saying "I do not know", which
 * is true; showing the wrong resume is a surface lying quietly.
 */
export function variantForCategory(category) {
  if (typeof category !== "string") return null;
  return BY_CATEGORY[category.trim().toLowerCase()] || null;
}

/** The variant object for a category, or null. Convenience for renderers. */
export function variantFor(category) {
  const key = variantForCategory(category);
  return key ? VARIANTS[key] : null;
}
