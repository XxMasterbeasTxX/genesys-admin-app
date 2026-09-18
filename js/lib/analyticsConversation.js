/**
 * Reading a conversation in the *analytics* shape — participants with
 * sessions and segments — into the columns the Search pages show.
 *
 * Shared by Interactions › Search and Interactions › Search Recent, which used
 * to carry identical copies of the first two helpers. The two new ones landed
 * here rather than as a third and fourth copy: a copy per page is how the
 * same-participant bug in `filterByPD` came to exist in one place and not the
 * other, and the fix for that was `participantData.js`.
 *
 * Nothing here touches the DOM or the API.
 */

/** First non-empty value of a session field across all participants. */
export function extractSessionField(participants, field) {
  if (!participants) return "";
  for (const p of participants) {
    for (const s of p.sessions || []) {
      if (s[field]) return s[field];
    }
  }
  return "";
}

/** First disconnect type found on any segment. */
export function extractDisconnect(participants) {
  if (!participants) return "";
  for (const p of participants) {
    for (const s of p.sessions || []) {
      for (const seg of s.segments || []) {
        if (seg.disconnectType) return seg.disconnectType;
      }
    }
  }
  return "";
}

/**
 * The people who took part: every participant that carries a `userId`, by
 * name, deduplicated, in the order they appear.
 *
 * Defined by `userId` rather than by `purpose`. Agents arrive as `agent`, a
 * person called directly rather than through a queue as `user`, and the
 * enum has nineteen values; "has a Genesys user behind it" is the honest
 * reading of "Users" and does not depend on guessing which purposes count.
 *
 * Deduplicated because transfers and consults produce several legs, and the
 * same agent can hold more than one. Falls back to the id so a participant
 * without a name is still counted rather than silently dropped — measured
 * 2026-09-18, every `userId` participant carried a `participantName`, so the
 * fallback is defence rather than expectation.
 */
export function extractUsers(participants) {
  const seen = new Set();
  const names = [];
  for (const p of participants || []) {
    if (!p.userId) continue;
    const name = p.participantName || p.userId;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(", ");
}

/**
 * The remote party — the customer's name, number or address — read from any
 * leg other than the customer's own.
 *
 * `remote` is "the remote party" from that session's point of view, so it is
 * not the same field on every leg. Measured 2026-09-18 on five conversations:
 * it is `null` on the customer's own sessions and carries the customer's
 * identity — "Salesforce External Routing", "Guest" — on every workflow, acd
 * and agent leg, all agreeing. The customer leg is skipped explicitly rather
 * than relied on to be empty: on a voice call it may well carry the *dialled*
 * side instead, which would put DNIS in the Remote column.
 *
 * `remoteNameDisplayable` was `null` throughout and is not read.
 */
export function extractRemote(participants) {
  for (const p of participants || []) {
    if (p.purpose === "customer" || p.purpose === "external") continue;
    for (const s of p.sessions || []) {
      if (s.remote) return s.remote;
    }
  }
  return "";
}
