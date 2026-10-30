/* Signed session cookie. No dependencies, no session store.
 *
 * There is exactly one user, so there is nothing to look up: the cookie IS the
 * session. It holds an expiry and an HMAC over that expiry, keyed by
 * JOBOPS_PASSWORD. Valid signature plus unexpired timestamp means signed in.
 *
 * WebCrypto rather than node:crypto because middleware runs on the Edge runtime,
 * where node:crypto is not available. Both the middleware and the login route
 * import this file, so they cannot drift apart on the format.
 *
 * Changing JOBOPS_PASSWORD invalidates every existing cookie, since the password
 * is the signing key. That is the desired behaviour and worth knowing: rotating
 * the password signs the owner out everywhere rather than leaving old sessions live.
 */

export const COOKIE = "jobops_session";
export const MAX_AGE_DAYS = 30;

const enc = new TextEncoder();

async function key(secret) {
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"],
  );
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A cookie value proving the holder knew the password, valid for MAX_AGE_DAYS. */
export async function sign(secret, now = Date.now()) {
  const exp = String(now + MAX_AGE_DAYS * 86400_000);
  const mac = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(exp));
  return `${exp}.${b64url(mac)}`;
}

/** True only for an untampered, unexpired cookie. */
export async function verify(secret, value, now = Date.now()) {
  if (!secret || !value) return false;
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const exp = value.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
  // Re-sign and compare rather than decoding: crypto.subtle.verify wants raw
  // bytes back, and comparing the encoded strings avoids a base64url decoder
  // whose edge cases would be one more thing to get wrong.
  const expected = await sign(secret, Number(exp) - MAX_AGE_DAYS * 86400_000);
  return timingSafeEqual(expected, value);
}

/** Constant-time string compare, so a wrong cookie leaks nothing by timing. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
