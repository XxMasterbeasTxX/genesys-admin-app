/**
 * WebRTC phone rules — the decisions Phones › WebRTC › Create makes.
 *
 * Pure logic: no HTTP, no DOM. Deliberately a CommonJS TWIN of the browser
 * implementation, not an import of it. `api_location: "api"` means the
 * Functions host only ever receives the api/ folder, so js/ is not on disk at
 * run time and cannot be required or imported from here.
 *
 * The twin is kept honest by test, not by hope: scratchpad parity checks run
 * these functions and their browser counterparts over the same fixtures and
 * assert identical output. That matters more here than in the other server
 * mirrors, because the bug this feature is most likely to reintroduce — the
 * licence list being id STRINGS rather than objects — is silent, and a
 * scheduled run has no reviewer to notice that every user suddenly looks
 * unlicensed.
 *
 * Browser originals:
 *   js/pages/phones/webrtc/createWebRtc.js  (analyseUsers, applyUserFilters,
 *                                            uniquePhoneName, licence + base rules)
 *   js/lib/phoneHolders.js                  (phoneHolder, resolvePhoneHolders)
 */

// ── Licences ────────────────────────────────────────────
//
// `/api/v2/license/users` returns { id, licenses: ["genesysCloudCX2", …] } —
// plain id strings. A collaborate holder cannot take a WebRTC phone, and the
// test is a substring match rather than a fixed enum because the id set
// differs between orgs.

const COLLABORATE_HINT = /collaborate/i;

function isCollaborateLicence(id) {
  return COLLABORATE_HINT.test(String(id));
}

// ── Phone bases ─────────────────────────────────────────

/**
 * Does this phone base describe a WebRTC softphone?
 *
 * `phoneMetaBase.id` is the platform's own model identifier and survives
 * renaming; the name is only a fallback for bases that predate it.
 */
function isWebRtcBase(base) {
  const meta = String(base?.phoneMetaBase?.id || "").toLowerCase();
  if (meta) return meta.includes("webrtc");
  return String(base?.name || "").toLowerCase().includes("webrtc");
}

// ── Holders ─────────────────────────────────────────────

/** The user a phone belongs to, or null. Only meaningful on a WebRTC base. */
function phoneHolder(phone) {
  return phone?.webRtcUser?.id || phone?.owner?.id || null;
}

/**
 * Map phones to the users holding them.
 *
 * The phones LIST endpoint does not reliably return `webRtcUser`, so phones it
 * does not answer for are read individually. `noHolder` and `unreadable` are
 * kept apart for the same reason as in the browser: "read it, nobody there"
 * and "could not read it" are different facts.
 */
async function resolvePhoneHolders(phones, webRtcBaseIds, getFullPhone, opts = {}) {
  const { onProgress, shouldStop } = opts;
  const byUser = new Map();
  const byPhone = new Map();
  const needDetail = [];

  const record = (phone, holder) => {
    byPhone.set(phone.id, holder);
    if (!byUser.has(holder)) byUser.set(holder, phone);
  };

  const restrictToBases = webRtcBaseIds instanceof Set;

  for (const p of phones) {
    const baseId = p.phoneBaseSettings?.id;
    if (restrictToBases && baseId && !webRtcBaseIds.has(baseId)) continue;

    const holder = phoneHolder(p);
    if (holder) record(p, holder);
    else needDetail.push(p);
  }

  const CONCURRENCY = 6;
  const queue = [...needDetail];
  const noHolder = [];
  const unreadable = [];
  let done = 0;

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      if (shouldStop && shouldStop()) return;
      const p = queue.shift();
      try {
        const full = await getFullPhone(p.id);
        const holder = phoneHolder(full);
        if (holder) record(full, holder);
        else noHolder.push(full);
      } catch {
        unreadable.push(p);
      }
      done++;
      if (onProgress) onProgress(done, needDetail.length);
    }
  }));

  if (queue.length) unreadable.push(...queue);

  return { byUser, byPhone, detailFetches: needDetail.length, noHolder, unreadable };
}

// ── Phone naming ────────────────────────────────────────

/** Pick a phone name that is not already taken. Names are unique per org. */
function uniquePhoneName(user, taken) {
  const preferred = `${user.name} - WebRTC`;
  const local = String(user.email || "").split("@")[0];

  const candidates = [preferred];
  if (local) candidates.push(`${user.name} (${local}) - WebRTC`);
  candidates.push(`${user.name} - WebRTC (${String(user.userId).slice(0, 8)})`);
  for (let n = 2; n <= 50; n++) candidates.push(`${preferred} ${n}`);

  for (const candidate of candidates) {
    if (!taken.has(candidate.toLowerCase())) {
      return { phoneName: candidate, renamedFrom: candidate === preferred ? null : preferred };
    }
  }
  return { phoneName: preferred, renamedFrom: null, nameConflict: true };
}

// ── Filters ─────────────────────────────────────────────

/**
 * Narrow users to those the schedule asked for. Every filter that IS set must
 * be satisfied; an empty one means "any".
 */
function applyUserFilters(users, groupMemberIds, divisionIds) {
  return users.filter((u) => {
    if (groupMemberIds && !groupMemberIds.has(u.id)) return false;
    if (divisionIds.size && !divisionIds.has(u.division?.id)) return false;
    return true;
  });
}

// ── Analysis ────────────────────────────────────────────

/** Classify every user into eligible / skipped. */
function analyseUsers(users, licenseUsers, phones, phoneByUser = new Map()) {
  const licencesByUser = new Map(
    licenseUsers.map((l) => [l.id, (l.licenses || []).filter(Boolean)])
  );

  const taken = new Set();
  for (const p of phones) {
    if (p.name) taken.add(String(p.name).toLowerCase());
  }

  const eligible = [];
  const skipped = [];
  const licenceKinds = new Map();

  for (const u of users) {
    const licences = licencesByUser.get(u.id) || [];
    for (const id of licences) {
      const seen = licenceKinds.get(id) || { count: 0, collaborate: isCollaborateLicence(id) };
      seen.count++;
      licenceKinds.set(id, seen);
    }

    const row = {
      userId: u.id,
      name: u.name || u.username || u.id,
      email: u.email || "",
      division: u.division?.name || "—",
      licences: licences.join(", "),
    };

    const existing = phoneByUser.get(u.id);
    if (existing) {
      skipped.push({ ...row, reason: "Already has a WebRTC phone", detail: existing.name || existing.id });
      continue;
    }
    if (!licences.length) {
      skipped.push({ ...row, reason: "No licence", detail: "no licence assigned" });
      continue;
    }
    if (licences.every(isCollaborateLicence)) {
      skipped.push({ ...row, reason: "Collaborate only", detail: row.licences });
      continue;
    }

    const named = uniquePhoneName(row, taken);
    taken.add(named.phoneName.toLowerCase());
    eligible.push({ ...row, ...named });
  }

  return { eligible, skipped, licenceKinds };
}

module.exports = {
  isCollaborateLicence,
  isWebRtcBase,
  phoneHolder,
  resolvePhoneHolders,
  uniquePhoneName,
  applyUserFilters,
  analyseUsers,
};
