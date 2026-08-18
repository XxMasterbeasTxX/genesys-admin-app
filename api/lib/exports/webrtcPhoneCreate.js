/**
 * Scheduled WebRTC phone creation.
 *
 * Runs the job Phones › WebRTC › Create does interactively, unattended, and
 * emails the same Excel log as its result. Registered as an export type so it
 * rides the existing schedule store, runner and email path — "export" is a
 * misnomer here, but the contract (execute → {success, filename, base64,
 * summary}) fits a job that produces a log.
 *
 * ── Why this one is written defensively ──
 *
 * The interactive page's safety is a person reading a review before anything is
 * written. Unattended, that person is gone, so the checks they would have read
 * become preconditions the run enforces on itself:
 *
 *   1. The creator is re-checked every run, and the job is refused if they have
 *      lost the permission or left (see creatorAuth).
 *   2. The holder match is verified before writing. If the org plainly has
 *      WebRTC phones but none could be matched to a user, the run aborts. That
 *      is the exact failure that once offered a duplicate phone to every user
 *      in an org; interactively it is a line in the Findings panel that a human
 *      notices, and here it has to stop the run instead.
 *   3. A ceiling on how many phones one run may create. A schedule that
 *      suddenly wants hundreds is far more likely to be a broken lookup than a
 *      real intake, so it stops and reports rather than writing.
 *
 * An aborted run returns success:false with the reason; the runner records that
 * against the schedule rather than emailing a misleading log.
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const XLSX = require("xlsx-js-style");
const rules = require("../webrtcPhoneRules");
const { verifyCreator, INTERNAL_OWNER } = require("../creatorAuth");

/** Refuse to create more than this in one unattended run unless overridden. */
const DEFAULT_MAX_CREATES = 100;

/** The permission the interactive page requires (featurePermissionMap). */
const REQUIRED_PERMISSIONS = ["telephony:plugin:all"];

// ── Genesys REST (server-side, client credentials) ──────

function credentialsFor(orgId) {
  const customer = customers.find((c) => c.id === orgId);
  if (!customer) throw new Error("Unknown customer org: " + orgId);
  const envKey = "GENESYS_" + orgId.replace(/-/g, "_").toUpperCase();
  const clientId = process.env[envKey + "_CLIENT_ID"];
  const clientSecret = process.env[envKey + "_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("Credentials not configured for " + orgId);
  return { region: customer.region, clientId, clientSecret };
}

function makeClient(orgId) {
  const { region, clientId, clientSecret } = credentialsFor(orgId);

  async function request(method, path, body) {
    const token = await getGenesysToken(orgId, region, clientId, clientSecret);
    const resp = await fetch("https://api." + region + path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (resp.status === 204) return null;
    const text = await resp.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!resp.ok) {
      const err = new Error(parsed.message || ("Genesys " + method + " " + path + " -> " + resp.status));
      err.status = resp.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  async function getAll(path, pageSize) {
    const size = pageSize || 100;
    let page = 1;
    let all = [];
    for (;;) {
      const sep = path.indexOf("?") === -1 ? "?" : "&";
      const resp = await request("GET", path + sep + "pageSize=" + size + "&pageNumber=" + page);
      const items = (resp && resp.entities) || [];
      all = all.concat(items);
      const pageCount = resp && resp.pageCount != null ? resp.pageCount : page;
      if (items.length < size || page >= pageCount) break;
      page++;
    }
    return all;
  }

  return { request, getAll };
}

/** Retry only on 429 — a 4xx does not become correct by being repeated. */
async function withRateLimitRetry(fn, attempts) {
  const max = attempts || 4;
  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!err || err.status !== 429 || attempt >= max) throw err;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

// ── Excel log ───────────────────────────────────────────

const COLUMNS = [
  ["Division", 22], ["Name", 28], ["Email", 32], ["User ID", 38],
  ["Licences", 30], ["Phone Name", 32], ["Site", 22], ["Status", 34], ["Detail", 40],
];

function buildWorkbook(rows) {
  const header = COLUMNS.map((c) => c[0]);
  const ws = XLSX.utils.aoa_to_sheet([header].concat(rows));
  ws["!cols"] = COLUMNS.map((c) => ({ wch: c[1] }));

  const headerStyle = {
    font: { bold: true, color: { rgb: "FFFFFF" } },
    fill: { fgColor: { rgb: "3B82F6" } },
    alignment: { horizontal: "center" },
  };
  for (let c = 0; c < header.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = headerStyle;
  }

  const statusCol = header.indexOf("Status");
  for (let r = 1; r <= rows.length; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: statusCol });
    if (!ws[addr]) continue;
    const v = String(ws[addr].v || "");
    if (/^created/i.test(v)) ws[addr].s = { font: { color: { rgb: "16A34A" }, bold: true } };
    else if (/^failed/i.test(v)) ws[addr].s = { font: { color: { rgb: "DC2626" }, bold: true } };
    else if (/^skipped|^not run/i.test(v)) ws[addr].s = { font: { color: { rgb: "D97706" } } };
  }

  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }),
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "WebRTC Phones");
  return wb;
}

function timestampedFilename(prefix) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return prefix + "_" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
    + "_" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + ".xlsx";
}

// ── The job ─────────────────────────────────────────────

async function execute(context, schedule) {
  const cfg = schedule.exportConfig || {};
  const orgId = cfg.orgId;
  const siteId = cfg.siteId;
  const maxCreates = Number(cfg.maxCreates) > 0 ? Number(cfg.maxCreates) : DEFAULT_MAX_CREATES;

  if (!orgId) return { success: false, error: "No org configured on this schedule" };
  if (!siteId) return { success: false, error: "No destination site configured on this schedule" };

  // 1. The creator must still be allowed to do this.
  const creator = await verifyCreator(schedule.ownerOrgId || INTERNAL_OWNER, {
    userId: schedule.createdById,
    requiredPermissions: REQUIRED_PERMISSIONS,
  });
  if (creator.verified && !creator.ok) {
    return { success: false, error: "Refused: " + creator.reason };
  }
  const creatorNote = creator.verified
    ? "Creator re-checked and still authorised."
    : "Creator NOT verified — " + creator.reason + ".";
  if (!creator.verified && context && context.log && context.log.warn) {
    context.log.warn("[webrtcPhoneCreate] " + creatorNote);
  }

  const api = makeClient(orgId);

  // 2. Discover the WebRTC bases.
  const bases = await api.getAll("/api/v2/telephony/providers/edges/phonebasesettings");
  const webRtcBases = bases.filter(rules.isWebRtcBase);
  if (!webRtcBases.length) return { success: false, error: "No WebRTC phone base settings in this org" };
  const base = webRtcBases[0];
  const webRtcBaseIds = new Set(webRtcBases.map((b) => b.id));

  const fullBase = await api.request("GET",
    "/api/v2/telephony/providers/edges/phonebasesettings/" + base.id);
  const lineBaseSettingsId = fullBase && fullBase.lines && fullBase.lines[0] && fullBase.lines[0].id;
  if (!lineBaseSettingsId) {
    return { success: false, error: "Phone base '" + base.name + "' has no line base settings" };
  }

  // 3. Read the org.
  const reads = await Promise.all([
    api.getAll("/api/v2/users?expand=division&state=active"),
    api.getAll("/api/v2/license/users"),
    api.getAll("/api/v2/telephony/providers/edges/phones"),
    api.getAll("/api/v2/telephony/providers/edges/sites"),
  ]);
  const users = reads[0], licenseUsers = reads[1], phones = reads[2], sites = reads[3];
  const siteMatch = sites.find((s) => s.id === siteId);
  if (!siteMatch) {
    return { success: false, error: "The configured destination site no longer exists in this org" };
  }
  const siteName = siteMatch.name || siteId;

  // 4. Match existing phones to their holders.
  const holders = await rules.resolvePhoneHolders(
    phones, webRtcBaseIds,
    (id) => api.request("GET", "/api/v2/telephony/providers/edges/phones/" + id)
  );
  const phoneByUser = holders.byUser;

  // GUARD: the failure that must never run unattended. If the org has phones on
  // a WebRTC base but not one could be matched to a user, the holder lookup is
  // broken and every user looks like they need a phone.
  const webRtcPhoneCount = phones.filter(
    (p) => !(p.phoneBaseSettings && p.phoneBaseSettings.id) || webRtcBaseIds.has(p.phoneBaseSettings.id)
  ).length;
  if (webRtcPhoneCount > 0 && phoneByUser.size === 0) {
    return {
      success: false,
      error: "Aborted before writing: the org has " + webRtcPhoneCount + " WebRTC phone(s) but none "
        + "could be matched to a user. Creating now would duplicate phones for users who already have one.",
    };
  }

  // 5. Apply the schedule's filters.
  const groupIds = new Set(cfg.groupIds || []);
  const divisionIds = new Set(cfg.divisionIds || []);
  let groupMemberIds = null;
  if (groupIds.size) {
    const lists = await Promise.all(Array.from(groupIds).map((id) =>
      api.getAll("/api/v2/groups/" + id + "/members").catch(() => [])));
    groupMemberIds = new Set([].concat.apply([], lists).map((m) => m.id));
  }
  const scoped = rules.applyUserFilters(users, groupMemberIds, divisionIds);

  // 6. Decide.
  const analysis = rules.analyseUsers(scoped, licenseUsers, phones, phoneByUser);
  const eligible = analysis.eligible;
  const skipped = analysis.skipped;
  const toCreate = eligible.filter((r) => !r.nameConflict);

  // GUARD: an unexpectedly large run is more likely a broken lookup than a real
  // intake, so it reports instead of writing.
  if (toCreate.length > maxCreates) {
    return {
      success: false,
      error: "Aborted before writing: " + toCreate.length + " phones would be created, over the limit of "
        + maxCreates + " for an unattended run. Run the page manually to review them.",
    };
  }

  // 7. Create.
  let created = 0, existed = 0, failed = 0;
  const results = new Map();

  for (let i = 0; i < toCreate.length; i++) {
    const row = toCreate[i];
    try {
      await withRateLimitRetry(() => api.request("POST", "/api/v2/telephony/providers/edges/phones", {
        name: row.phoneName,
        site: { id: siteId },
        phoneBaseSettings: { id: base.id },
        lines: [{ lineBaseSettings: { id: lineBaseSettingsId } }],
        webRtcUser: { id: row.userId, type: "USER" },
        owner: { id: row.userId, type: "USER" },
      }));
      created++;
      results.set(row.userId, ["Created", row.phoneName]);
    } catch (err) {
      const code = String((err && err.body && err.body.code) || "");
      if ((err && err.status === 409) || code.indexOf("duplicate") === 0) {
        existed++;
        results.set(row.userId, ["Skipped (already exists)", (err && err.message) || ""]);
      } else {
        failed++;
        const status = err && err.status ? err.status + " — " : "";
        results.set(row.userId, [("Failed: " + status + ((err && err.message) || "")).slice(0, 200), ""]);
      }
    }
    if (i < toCreate.length - 1) await new Promise((r) => setTimeout(r, 50));
  }

  // 8. Log every user considered, as the interactive page does.
  const rows = eligible.map((r) => {
    const res = results.get(r.userId);
    const status = res ? res[0] : (r.nameConflict ? "Skipped (no free phone name)" : "Not run");
    return [r.division, r.name, r.email || "—", r.userId, r.licences || "—",
      r.phoneName, siteName, status, res ? res[1] : ""];
  }).concat(skipped.map((r) => [
    r.division, r.name, r.email || "—", r.userId, r.licences || "—",
    "—", siteName, "Skipped (" + r.reason.toLowerCase() + ")", r.detail || "",
  ]));

  const orgName = (customers.find((c) => c.id === orgId) || {}).name || orgId;
  const parts = ["Created: " + created];
  if (existed) parts.push("Already existed: " + existed);
  if (failed) parts.push("Failed: " + failed);
  parts.push("Skipped: " + skipped.length);

  return {
    success: true,
    filename: timestampedFilename("WebRTC_Phones_" + String(orgName).replace(/\s+/g, "_")),
    base64: XLSX.write(buildWorkbook(rows), { bookType: "xlsx", type: "base64" }),
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    summary: orgName + " — site '" + siteName + "' — " + parts.join(", ") + ". "
      + phoneByUser.size + " existing WebRTC phones matched"
      + (holders.detailFetches ? " (" + holders.detailFetches + " read individually)" : "")
      + (holders.unreadable.length ? ", " + holders.unreadable.length + " unreadable" : "")
      + ". " + creatorNote,
  };
}

module.exports = { execute, DEFAULT_MAX_CREATES, REQUIRED_PERMISSIONS };
