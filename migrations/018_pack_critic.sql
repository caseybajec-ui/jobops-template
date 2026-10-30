-- The second-pass critic's verdict on each apply pack.
--
-- A pack is the only model-generated text in this tool that reaches an
-- EMPLOYER. One invented number is a false statement on an application, and
-- unlike a bad score there is nobody downstream to catch it.
--
-- TWO COLUMNS, AND THE DISTINCTION MATTERS. critic_at records that a verdict
-- was READ; critic_note records what it said. A pack with critic_at set and
-- critic_note NULL passed. A pack with both set was refused, and the note
-- names the claim -- so a refusal can be argued with rather than only obeyed.
ALTER TABLE apply_packs ADD COLUMN IF NOT EXISTS critic_at TEXT;
ALTER TABLE apply_packs ADD COLUMN IF NOT EXISTS critic_note TEXT;
