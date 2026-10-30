/** @type {import('next').NextConfig} */
export default {
  // Server Actions carry the one write path that is not an API route: the note
  // box in an expanded row. It was two until the stage select was replaced by
  // LifecycleControl, which posts to /api/lifecycle like everything else.
  // middleware.js gates them like anything else — an unauthenticated POST carrying a Next-Action header
  // redirects to /login, which is checked explicitly during verification.
  //
  // This comment used to read "local tool only, never expose this publicly:
  // there is no auth by design". That stopped being true when the password gate
  // landed, and a stale security comment is worse than no comment.
  experimental: { serverActions: { bodySizeLimit: "1mb" } },

  // A `next dev` server and a `next build` both write to .next, and running one
  // while the other is up leaves a half-written directory: every route then 500s
  // with "Cannot find module './51.js'", which looks like a code bug and is not.
  // Set NEXT_DIST_DIR to give a verification build its own output directory.
  // Unset — which is how Vercel and `npm run dev` run — it stays .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
