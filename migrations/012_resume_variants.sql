-- JobOps 012 — a second set of profile bullets, one per resume variant.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/012_resume_variants.sql
--
-- WHY. There are two resumes now: resume_tech.md (defense, product & tech) and
-- resume_finance.md (consulting, VC & growth). The profile card's three bullets
-- are the owner's own pitch lines, and a pitch framed for Anduril is not the pitch
-- for Bain. One set of three cannot serve both without being vague enough to
-- serve neither.
--
-- THE EXISTING COLUMNS ARE THE TECH SET AND ARE NOT TOUCHED. bullet_1..3 keep
-- whatever is in them today; only the finance half is new. A migration that
-- renamed or moved the current bullets would risk the one thing here that
-- cannot be regenerated — text the owner typed himself. Rule 4 cuts both ways: the
-- tool may not invent resume content, and it may not quietly discard it either.
--
-- NULL is the correct starting value. An empty finance bullet is an honest
-- blank that the card renders as blank and completeness() already ignores
-- (it excludes every bullet_ prefix from the required set). Seeding these from
-- the tech bullets was offered and declined: three bullets that CLAIM to be
-- finance-framed while actually being the tech ones is exactly the kind of
-- quiet wrongness this repo keeps paying for.

ALTER TABLE profile ADD COLUMN IF NOT EXISTS bullet_1_finance TEXT;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS bullet_2_finance TEXT;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS bullet_3_finance TEXT;
