/**
 * Which KIND of interview a role leads to. Pure, deterministic, no model.
 *
 * A Palantir Deployment Strategist interview and a Deloitte case interview
 * share nothing — not the format, not the preparation, not the week before. The
 * tool knows the title and the company category and has never once said which
 * of those two a role is going to be.
 *
 * DETERMINISTIC ON PURPOSE. This is the "if code can decide it, code decides
 * it" rule: title keywords and a company category are structured data already
 * in the row, so asking a model to classify them would cost money to be wrong
 * some fraction of the time.
 *
 * UNKNOWN IS AN ANSWER. A role that matches nothing gets no note rather than
 * the closest guess. A prep checklist for the wrong interview format is worse
 * than none — it is confident, specific and misleading, on the morning of.
 */

/**
 * Ordered. The FIRST match wins, so the list runs from most specific to least.
 *
 * Order matters more than it looks: "Forward Deployed Software Engineer" is a
 * deployment_strategist role and also contains "engineer", and "Product
 * Operations Manager" at a defense company is defense_ops rather than
 * apm_product. Reordering this list changes answers.
 */
export const FAMILY_RULES = [
  {
    key: "deployment_strategist_fdse",
    // The words these roles actually use, verbatim from the corpus.
    title: [/deployment strategist/i, /forward deployed/i, /\bfdse\b/i,
            /field engineer/i, /solutions architect/i, /implementation engineer/i],
  },
  {
    key: "consulting",
    // Category first: an "Associate" at Deloitte is consulting, and the title
    // alone would never say so.
    category: ["consulting"],
    title: [/\bconsultant\b/i, /strategy & (?:consulting|operations)/i, /\bcase team\b/i],
  },
  {
    key: "vc_analyst",
    category: ["vc"],
    title: [/investment analyst/i, /\bventure\b/i, /growth equity/i,
            /full[- ]time analyst/i, /investor\b/i],
  },
  {
    key: "defense_ops",
    // A defense company plus an operations-shaped title. NOT every defense role
    // — a defense software engineer preps like a software engineer.
    category: ["defense"],
    title: [/mission operations?/i, /mission success/i, /operations engineer/i,
            /\bops\b/i, /operations (?:associate|specialist|manager|analyst)/i,
            /deployment/i, /technical program/i],
  },
  {
    key: "apm_product",
    title: [/associate product manager/i, /\bapm\b/i, /product manager/i,
            /product operations/i, /rotational product/i, /product analyst/i],
  },
];

export const FAMILY_KEYS = FAMILY_RULES.map((r) => r.key);

/**
 * The family for a role, or null.
 *
 * `category` is the company category the palette already computes — defense,
 * product, consulting, vc — so nothing new is inferred about the company here.
 */
export function familyOf(role = {}, category = null) {
  const title = String(role.title || "");
  const cat = category || role.category || null;

  for (const rule of FAMILY_RULES) {
    const titleHit = (rule.title || []).some((re) => re.test(title));
    if (!rule.category) {
      if (titleHit) return rule.key;
      continue;
    }
    // A category rule needs BOTH: the category places the role in a world, and
    // the title says which job inside it. Category alone would make every
    // Palantir posting a deployment strategist.
    if (rule.category.includes(cat) && titleHit) return rule.key;
  }
  return null;
}
