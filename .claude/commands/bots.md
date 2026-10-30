Produce the person's Grok Bot team from `setup/BOTS.md`, ready to paste.

1. Read `setup/BOTS.md` and `setup/inputs.yaml`. Ask for the deployed JobOps URL if the person
   has not given it; ask for `email_personal` and `linkedin_url` if `inputs.yaml` lacks them.
2. Fill every `{{PLACEHOLDER}}` in BOTS.md from the table at its top. Never guess a value; ask.
   Never include a password, token or verification code in any block — the sync skill refers to
   the token as a Vault secret by name only.
3. Print, in this order, each as its own fenced block with a one-line instruction above it
   saying where it goes in Grok Bot: (a) the three pre-flight steps (Vault, timezone, Gmail);
   (b) the five standing-instruction blocks, one per bot, in the order Ops Boss, Job Search Ops,
   Job app Bot, Networking Bot, Reply Bot; (c) the shared-files message and the apply-log header;
   (d) the four skills; (e) the routines table with the exact sentence to say to each bot;
   (f) the group-chat message; (g) a reminder to add `JOBOPS_IMPORT_TOKEN` to Vercel and to
   Vault as a secret, generated with `openssl rand -hex 32` (print the command, never a value).
4. End with the short "what only you do" list from BOTS.md. Do not summarize or paraphrase the
   blocks; they are verbatim with placeholders filled.

Arguments: $ARGUMENTS
