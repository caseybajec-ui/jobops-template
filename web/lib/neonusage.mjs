/**
 * Read Neon's own data-transfer figure for the current billing period.
 *
 * ONE ENDPOINT, ONE KEY, AND IT NEVER GUESSES. If the key is absent, or the API
 * refuses, or the response does not carry the field, this returns an error
 * object saying which — it does not fall back to an estimate. transfer_budget.py
 * prices the row payload this repo sends and is explicitly not what Neon bills;
 * substituting one for the other would put the authority of a measurement on a
 * number nobody measured.
 *
 * WHY `consumption_history/account` AND NOT THE PROJECT ENDPOINT. The allowance
 * is an ACCOUNT-level quota — every project on the plan shares the 5 GB — so a
 * per-project figure would be a fraction of the number that actually matters and
 * would read as headroom that is not there.
 *
 * SCOPE, IF IT REFUSES. This endpoint needs a key that can read billing for the
 * account:
 *   - a PERSONAL API key (console.neon.tech -> Account settings -> API keys)
 *     carries the owner's full access and works;
 *   - an ORGANIZATION API key works only if the key's role is `admin`, because
 *     consumption is billing data and `member` cannot read it;
 *   - a PROJECT-scoped key cannot read it at all, whatever its role, since the
 *     figure is not per-project.
 * A 401 means the key is wrong or revoked; a 403 means the key is valid and its
 * role is too low, which on this endpoint means it is a member or project key.
 * The real response body is passed through rather than summarised, because the
 * reason lives in it.
 */
const API = "https://console.neon.tech/api/v2";

/** ISO date for the first of the current UTC month. Neon bills on UTC. */
function periodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString();
}

export async function neonTransfer({ now = new Date(), fetchImpl = fetch } = {}) {
  const key = process.env.NEON_API_KEY;
  // NULL, not an error: nobody asked. lib/transfer.js renders the three states
  // — unset, failed, read — differently on purpose.
  if (!key) return null;

  const from = periodStart(now);
  const to = new Date(now).toISOString();
  const url = `${API}/consumption_history/account`
    + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    + `&granularity=monthly`;

  let r;
  try {
    r = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
  } catch (e) {
    return { error: `the request failed (${e.message})`,
             hint: "Network or DNS, not the key." };
  }

  const body = await r.text();
  if (!r.ok) {
    // THE BODY IS WHERE THE REASON IS, so it is carried, trimmed only for
    // length. Resend answering 403 for an unverified sender was reported as
    // green once in this project because the body was thrown away.
    const detail = body.slice(0, 240).replace(/\s+/g, " ").trim();
    const hint = r.status === 403
      ? "403 means the key is valid but its role cannot read billing. This "
        + "endpoint needs a PERSONAL API key, or an ORGANIZATION key with the "
        + "`admin` role — a `member` key or a project-scoped key cannot read "
        + "account consumption."
      : r.status === 401
        ? "401 means the key is wrong, revoked, or not sent. Check the "
          + "NEON_API_KEY repo secret."
        : "";
    return { error: `Neon returned ${r.status} ${r.statusText}: ${detail}`, hint };
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: "Neon returned a body that is not JSON",
             hint: `First 120 chars: ${body.slice(0, 120)}` };
  }

  // The account shape nests periods under `periods[].consumption[]`. Sum every
  // bucket in the window rather than taking the last: a monthly granularity
  // request can still come back split, and reading only one would UNDERSTATE
  // the figure — the one direction this number must never be wrong in.
  let bytes = 0;
  let seen = 0;
  for (const p of data?.periods || []) {
    for (const c of p?.consumption || []) {
      if (typeof c?.data_transfer_bytes === "number") {
        bytes += c.data_transfer_bytes;
        seen += 1;
      }
    }
  }
  if (!seen) {
    // A 200 CARRYING NOTHING IS NOT ZERO TRANSFER. It means the shape changed
    // or the window was empty, and reporting 0 would be the most reassuring
    // possible way to be wrong.
    return {
      error: "Neon answered 200 but no data_transfer_bytes was present",
      hint: "The response shape may have changed; check "
        + "console.neon.tech/api/v2/consumption_history/account by hand.",
    };
  }
  return { bytes, periodStart: from, buckets: seen };
}
