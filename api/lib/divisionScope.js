/**
 * Division scope — internal users see and touch only their own divisions,
 * in the internal org (docs/division-scope-design.md).
 *
 * A Genesys grant is a role IN A DIVISION. The app's internal calls run on
 * the org's OAuth client, so Genesys applies the client's grants, not the
 * person's; the permission check (proxyPermissions.js) restored "what may
 * this person do", and this restores "where". Customer sessions never
 * needed either: their calls carry their own token.
 *
 * Grants come from GET /authorization/subjects/me on the user's own token:
 * each grant's role policies flatten to permission strings, filed under the
 * grant's division — or under "everywhere" for the "*" division. A
 * permission then counts for an object only if held in the object's
 * division.
 *
 *   filterResponse   after a read: drop entities outside the user's divisions
 *   checkWrite       before a write: refuse if the object's division is outside
 *
 * Objects without a division field are not divisioned in Genesys and pass.
 * An object created without a division lands in Home, and is checked as
 * such.
 */
const crypto = require("crypto");
const { permGrants } = require("./userPermissions");

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const homeCache = new Map();          // region|token-hash → home division id (the org's, not the user's)

const ALL = "*";
const OBJECT_PATH = /^\/api\/v2\/authorization\/divisions\/([^/]+)\/objects\/([^/]+)\/?$/i;

// Where an object type of the bulk division move is read from. Genesys's
// enum, plus the older spellings the permission table used.
const MOVE_COLLECTIONS = {
  USER: "/api/v2/users", QUEUE: "/api/v2/routing/queues", CALLROUTE: "/api/v2/architect/ivrs",
  CAMPAIGN: "/api/v2/outbound/campaigns", CONTACTLIST: "/api/v2/outbound/contactlists", DNCLIST: "/api/v2/outbound/dnclists",
  EMAILCAMPAIGN: "/api/v2/outbound/emailcampaigns", MESSAGINGCAMPAIGN: "/api/v2/outbound/messagingcampaigns",
  DATATABLES: "/api/v2/flows/datatables", DATATABLE: "/api/v2/flows/datatables",
  FLOW: "/api/v2/flows", FLOWMILESTONE: "/api/v2/flows/milestones", FLOWOUTCOME: "/api/v2/flows/outcomes",
  EMERGENCYGROUPS: "/api/v2/architect/emergencygroups", EMERGENCYGROUP: "/api/v2/architect/emergencygroups",
  EXTENSIONPOOL: "/api/v2/telephony/providers/edges/extensionpools",
  MANAGEMENTUNIT: "/api/v2/workforcemanagement/managementunits", BUSINESSUNIT: "/api/v2/workforcemanagement/businessunits",
  ROUTINGSCHEDULES: "/api/v2/architect/schedules", SCHEDULE: "/api/v2/architect/schedules",
  ROUTINGSCHEDULEGROUPS: "/api/v2/architect/schedulegroups", SCHEDULEGROUP: "/api/v2/architect/schedulegroups",
  SCRIPT: "/api/v2/scripts", SKILLGROUP: "/api/v2/routing/skillgroups", TEAM: "/api/v2/teams",
  WORKBIN: "/api/v2/taskmanagement/workbins", WORKTYPE: "/api/v2/taskmanagement/worktypes",
  LIBRARY: "/api/v2/responsemanagement/libraries",
};

// Collections whose objects carry no division: a write there needs no read.
const NOT_DIVISIONED = [
  "/api/v2/authorization/roles", "/api/v2/authorization/permissions", "/api/v2/authorization/subjects",
  "/api/v2/oauth", "/api/v2/integrations", "/api/v2/architect/prompts", "/api/v2/routing/languages",
  "/api/v2/gdpr", "/api/v2/license", "/api/v2/orgauthorization", "/api/v2/billing", "/api/v2/organizations",
  "/api/v2/outbound/wrapupcodemappings", "/api/v2/outbound/settings", "/api/v2/audits", "/api/v2/analytics",
  "/api/v2/journey", "/api/v2/quality", "/api/v2/speechandtextanalytics", "/api/v2/recording",
  "/api/v2/webdeployments", "/api/v2/processautomation", "/api/v2/assistants", "/api/v2/groups",
  "/api/v2/routing/email", "/api/v2/routing/message", "/api/v2/stations", "/api/v2/telephony", "/api/v2/externalcontacts",
];

function tokenKey(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * The user's grants, by division.
 * @returns {Promise<{ everywhere: string[], byDivision: Map<string, string[]>, divisionNames: Map<string,string> } | null>}
 *   null when unreadable — the caller fails closed.
 */
async function fetchGrants(token, region) {
  let resp, json;
  try {
    resp = await fetch(`https://api.${region}/api/v2/authorization/subjects/me`, { headers: { Authorization: `Bearer ${token}` } });
    json = await resp.json().catch(() => ({}));
  } catch { return null; }
  if (!resp.ok || !json || !Array.isArray(json.grants)) return null;
  return grantsFrom(json.grants);
}

/** Pure: the shape above from a grants array (tests call this directly). */
function grantsFrom(grants) {
  const everywhere = new Set();
  const byDivision = new Map();
  const divisionNames = new Map();
  for (const g of grants || []) {
    const divId = g && g.division && g.division.id;
    if (!divId) continue;
    if (g.division.name) divisionNames.set(divId, g.division.name);
    const perms = [];
    for (const pol of (g.role && g.role.policies) || []) {
      if (!pol || !pol.domain) continue;
      const entity = pol.entityName || "*";
      const actions = Array.isArray(pol.actions) && pol.actions.length ? pol.actions : ["*"];
      for (const a of actions) perms.push(`${pol.domain}:${entity}:${a}`);
    }
    if (divId === ALL) perms.forEach((p) => everywhere.add(p));
    else {
      if (!byDivision.has(divId)) byDivision.set(divId, new Set());
      perms.forEach((p) => byDivision.get(divId).add(p));
    }
  }
  return {
    everywhere: [...everywhere],
    byDivision: new Map([...byDivision].map(([k, v]) => [k, [...v]])),
    divisionNames,
  };
}

async function grantsFor(token, region) {
  const key = tokenKey(token);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  if (hit) cache.delete(key);
  const value = await fetchGrants(token, region);
  if (value) cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

const holds = (list, required) => required.some((req) => list.some((g) => permGrants(g, req)));

/** Where the user holds any of the required permissions: ALL, or a Set of division ids. */
function divisionsFor(grants, required) {
  if (holds(grants.everywhere, required)) return ALL;
  const out = new Set();
  for (const [div, perms] of grants.byDivision) if (holds(perms, required)) out.add(div);
  return out;
}

/** Every division the user holds any grant in — for the divisions list. */
function anyDivisions(grants) {
  if (grants.everywhere.length) return ALL;
  return new Set(grants.byDivision.keys());
}

const allowedIn = (divs, id) => divs === ALL || divs.has(id);

/** The division id(s) an object sits in, or null if it carries none. */
function objectDivisions(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.division && obj.division.id) return [String(obj.division.id)];
  if (Array.isArray(obj.divisions) && obj.divisions.length) {
    const ids = obj.divisions.map((d) => d && d.division && d.division.id).filter(Boolean).map(String);
    return ids.length ? ids : null;
  }
  return null;
}

const objectAllowed = (divs, obj) => {
  const ids = objectDivisions(obj);
  return !ids || ids.some((id) => allowedIn(divs, id));
};

/**
 * Filter a read's response body to the user's divisions.
 * @returns {{ body: any, removed: number, refused: boolean }}
 */
function filterResponse({ path, body, grants, required }) {
  if (!body || typeof body !== "object") return { body, removed: 0, refused: false };
  const p = String(path || "").split("?")[0].replace(/\/+$/, "");

  // The divisions list itself: only divisions the user has any grant in.
  if (/^\/api\/v2\/authorization\/divisions$/i.test(p) && Array.isArray(body.entities)) {
    const divs = anyDivisions(grants);
    const kept = body.entities.filter((d) => d && allowedIn(divs, String(d.id)));
    return { body: { ...body, entities: kept }, removed: body.entities.length - kept.length, refused: false };
  }
  if (!required || !required.length) return { body, removed: 0, refused: false };
  const divs = divisionsFor(grants, required);
  if (divs === ALL) return { body, removed: 0, refused: false };

  for (const key of ["entities", "results"]) {
    if (Array.isArray(body[key])) {
      const kept = body[key].filter((e) => objectAllowed(divs, e));
      return { body: { ...body, [key]: kept }, removed: body[key].length - kept.length, refused: false };
    }
  }
  // A single object.
  if (!objectAllowed(divs, body)) return { body, removed: 0, refused: true, divisionId: objectDivisions(body)[0] };
  return { body, removed: 0, refused: false };
}

/**
 * Refuse a write whose object's division is outside the user's grant.
 * @param {Function} read  (path) → Promise<{status, body}> with the org's credentials
 * @returns {Promise<{ ok: true } | { ok: false, divisionId?: string, detail: string }>}
 */
async function checkWrite({ method, path, body, grants, required, read, homeDivisionId }) {
  if (!required || !required.length) return { ok: true };
  const divs = divisionsFor(grants, required);
  if (divs === ALL) return { ok: true };
  const p = String(path || "").split("?")[0].replace(/\/+$/, "");
  const verb = String(method || "").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(verb)) return { ok: true };
  const refuse = (divisionId) => ({ ok: false, divisionId: divisionId || "", detail: "Your role does not cover this division." });

  // The bulk move: the target division, and every object's current one.
  const move = OBJECT_PATH.exec(p);
  if (move) {
    const target = move[1];
    if (!allowedIn(divs, target)) return refuse(target);
    const collection = MOVE_COLLECTIONS[String(move[2]).toUpperCase()];
    const ids = Array.isArray(body) ? body : [];
    if (!collection) return { ok: true };
    for (const id of ids) {
      const r = await read(`${collection}/${encodeURIComponent(String(id))}`);
      if (r.status !== 200) continue;                     // Genesys will answer for a missing object
      if (!objectAllowed(divs, r.body)) return refuse((objectDivisions(r.body) || [""])[0]);
    }
    return { ok: true };
  }

  if (NOT_DIVISIONED.some((prefix) => p === prefix || p.startsWith(prefix + "/"))) return { ok: true };

  // Publishing a script names the script in the body, not the path.
  if (/^\/api\/v2\/scripts\/published$/i.test(p) && body && body.scriptId) {
    const r = await read(`/api/v2/scripts/${encodeURIComponent(String(body.scriptId))}`);
    if (r.status === 200 && !objectAllowed(divs, r.body)) return refuse((objectDivisions(r.body) || [""])[0]);
    return { ok: true };
  }

  // A create: the body's division, else Home.
  const segs = p.split("/").filter(Boolean);       // ["api","v2","routing","queues",…]
  const idIndex = segs.findIndex((s, i) => i >= 3 && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s));
  if (idIndex < 0) {
    if (verb !== "POST") return { ok: true };
    if (/\/(search|query)$/i.test(p)) return { ok: true };       // a search is a read
    const divisionId = (body && body.division && body.division.id) || homeDivisionId || "";
    if (!divisionId) return { ok: true };
    return allowedIn(divs, divisionId) ? { ok: true } : refuse(divisionId);
  }

  // A write on an existing object: read it, up to its id.
  const objectPath = "/" + segs.slice(0, idIndex + 1).join("/");
  const r = await read(objectPath);
  if (r.status !== 200 || !r.body || typeof r.body !== "object") return { ok: true };   // Genesys answers for a missing object
  if (!objectAllowed(divs, r.body)) return refuse((objectDivisions(r.body) || [""])[0]);
  return { ok: true };
}

/** The org's Home division id, read once per credential. */
async function homeDivisionFor(read, cacheKeyStr) {
  if (homeCache.has(cacheKeyStr)) return homeCache.get(cacheKeyStr);
  let id = "";
  try {
    const r = await read("/api/v2/authorization/divisions/home");
    if (r.status === 200 && r.body && r.body.id) id = String(r.body.id);
  } catch { /* unknown home: a create without a division is then not checked */ }
  homeCache.set(cacheKeyStr, id);
  return id;
}

function clearDivisionCache() { cache.clear(); homeCache.clear(); }

module.exports = {
  grantsFor, grantsFrom, divisionsFor, anyDivisions, objectDivisions, filterResponse, checkWrite,
  homeDivisionFor, clearDivisionCache, ALL, MOVE_COLLECTIONS,
};
