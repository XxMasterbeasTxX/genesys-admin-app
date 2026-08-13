/**
 * Which user holds a phone. Pure logic plus one injected fetch.
 *
 * Extracted from Phones › WebRTC › Create because Change Site needs the same
 * answer, and because getting it wrong is quiet rather than loud. The phones
 * LIST endpoint does not reliably return `webRtcUser` — the omission changeSite
 * works around by re-fetching each phone before moving it, and the reason
 * `getPhone` is documented as the "full object".
 *
 * Reading the holder off the list alone therefore yields an empty map in orgs
 * where the field is absent, and an empty map does not look like a failure: it
 * looks like an org where nobody has a phone yet. Create shipped that bug and
 * offered to build a duplicate phone for every user in the org.
 *
 * So: trust the list where it answers, and read individually only the phones it
 * does not — restricted to phones on a WebRTC base, a few at a time.
 */

/**
 * The user a phone belongs to, or null.
 *
 * A WebRTC phone carries the user twice — as `webRtcUser` and as `owner` — and
 * either identifies the holder. Only ever apply this to phones on a WebRTC
 * base: an ordinary desk phone also has an `owner`, and reading that as a
 * WebRTC assignment would skip a user who genuinely needs one.
 */
export function phoneHolder(phone) {
  return phone?.webRtcUser?.id || phone?.owner?.id || null;
}

/**
 * Map phones to the users holding them.
 *
 * @param {Object[]} phones  Phones from the list endpoint.
 * @param {Set<string>|null} webRtcBaseIds  Every WebRTC base in the org, not
 *   just the one new phones are created on — a phone on a second WebRTC base
 *   is still that user's phone. Pass `null` for no restriction, which is what
 *   Change Site wants: there the question is whose phone this is, and a desk
 *   phone belongs to its owner just as much as a softphone does.
 * @param {Function} getFullPhone  `(phoneId) => Promise<phone>`
 * @param {Object}   [opts]
 * @param {Function} [opts.onProgress]  `(done, total)` during the detail reads.
 * @param {Function} [opts.shouldStop]  Polled between reads so a long resolve
 *   can be cancelled.
 * @returns {Promise<{ byUser: Map<string, Object>, byPhone: Map<string, string>,
 *   detailFetches: number, unresolved: number }>}
 *   `byUser` is user id → phone, `byPhone` is phone id → user id.
 */
export async function resolvePhoneHolders(phones, webRtcBaseIds, getFullPhone, { onProgress, shouldStop } = {}) {
  const byUser = new Map();
  const byPhone = new Map();
  const needDetail = [];

  const record = (phone, holder) => {
    byPhone.set(phone.id, holder);
    if (!byUser.has(holder)) byUser.set(holder, phone);
  };

  const restrictToBases = webRtcBaseIds instanceof Set;

  for (const p of phones) {
    // A phone with no phoneBaseSettings in the list response cannot be ruled
    // out, so it is checked rather than assumed to be a desk phone.
    const baseId = p.phoneBaseSettings?.id;
    if (restrictToBases && baseId && !webRtcBaseIds.has(baseId)) continue;

    const holder = phoneHolder(p);
    if (holder) record(p, holder);
    else needDetail.push(p);
  }

  const CONCURRENCY = 6;
  const queue = [...needDetail];
  let done = 0;

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      if (shouldStop?.()) return;
      const p = queue.shift();
      try {
        const full = await getFullPhone(p.id);
        const holder = phoneHolder(full);
        if (holder) record(full, holder);
      } catch {
        // A phone we cannot read is left unresolved. For Create that can only
        // cause a create Genesys then rejects — recorded as a failure, not a
        // silent duplicate. For Change Site it drops out of a filtered view,
        // which the caller reports as a count.
      }
      onProgress?.(++done, needDetail.length);
    }
  }));

  return {
    byUser,
    byPhone,
    detailFetches: needDetail.length,
    // Candidate phones still without a holder: never had one, or the read failed.
    unresolved: needDetail.filter((p) => !byPhone.has(p.id)).length,
  };
}
