/**
 * Deployment › Basic
 *
 * Bulk-creates Genesys Cloud objects from an Excel workbook.
 * Each sheet tab maps to a specific function by tab name.
 *
 * Supported tabs:
 *   "DID Pools" — POST /api/v2/telephony/providers/edges/didpools
 *
 * Excel format per tab:
 *   Row 1:  Header row (column names — skipped)
 *   Row 2+: Data rows
 *
 *   DID Pools columns:
 *     A: Number - Start   (E.164, required)
 *     B: Number - End     (E.164, required)
 *     C: Description      (optional)
 *     D: Comment          (optional)
 *     E: Provider         (required: PURE_CLOUD_VOICE | BYOC_CLOUD | BYOC_PREMISES)
 */
import * as gc from "../../services/genesysApi.js";
import { logAction } from "../../services/activityLogService.js";
import { escapeHtml } from "../../utils.js";

// ── Tab handlers ──────────────────────────────────────────────────────────────
// Each handler receives ({ rows, api, orgId, me }) where rows excludes the header.
// Returns { created, failed } counts (updates are made via addResult internally).

const TAB_HANDLERS = {
  "DID Pools":              processDIDPools,
  "Divisions":              processDivisions,
  "Queues":                 processQueues,
  "Schedule Groups":        processScheduleGroups,
  "Schedules":              processSchedules,
  "Site - Number Plans":    processNumberPlans,
  "Site - Outbound Routes": processOutboundRoutes,
  "Sites":                  processSites,
  "Skills":            processSkills,
  "Skills - Language": processLanguages,
  "Users":             processUsers,
  "Wrapup Codes":      processWrapupCodes,
};

// ── Tab: Number Plans ────────────────────────────────────────────────────────
// Columns: A=Site Name (req), B=Plan Name (req), C=Classification (req),
//          D=Match Type (req: numberList|digitLength|intraCountryCode|interCountryCode|regex),
//          E=Priority (req, integer), F=State (req: active|inactive),
//          G=Numbers (one entry per row, for numberList/interCountryCode/intraCountryCode),
//          H=Digit Length (e.g. "4-10" or "7", for digitLength),
//          I=Match Pattern (regex string, for regex),
//          J=Normalized Format (optional)
//
// Rows are grouped by Site Name, then by Plan Name within each site.
// For numberList/interCountryCode/intraCountryCode: multiple rows with the same
// Site+Plan name each contribute one entry to numbers[].
// One PUT per site — replaces ALL number plans on that site.
// Max 200 plans per site (Genesys API limit).
async function processNumberPlans({ rows, api, orgId, me, addResult }) {
  let updated = 0;
  let failed  = 0;

  const MULTI_NUMBER_TYPES = new Set(["numberlist", "intercountrycode", "intracountrycode"]);
  const VALID_TYPES = new Set(["numberlist", "digitlength", "intracountrycode", "intercountrycode", "regex"]);

  // Pre-fetch all sites once
  let sites;
  try {
    sites = await gc.fetchAllSites(api, orgId);
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch sites: ${err.message}`);
    return { created: 0, failed: rows.length };
  }
  const siteMap = Object.fromEntries(sites.map(s => [s.name.toLowerCase(), s]));

  // Group rows by site name (preserving insertion order)
  const siteGroups = new Map();
  for (const row of rows) {
    const siteName = String(row[0] || "").trim();
    if (!siteName) continue;
    if (!siteGroups.has(siteName)) siteGroups.set(siteName, []);
    siteGroups.get(siteName).push(row);
  }

  for (const [siteName, siteRows] of siteGroups) {
    const site = siteMap[siteName.toLowerCase()];
    if (!site) {
      addResult(siteName, false, `Site '${siteName}' not found`);
      failed++;
      continue;
    }

    // Group rows by plan name within this site (preserving order)
    const planGroups = new Map();
    for (const row of siteRows) {
      const planName = String(row[1] || "").trim();
      if (!planName) continue;
      if (!planGroups.has(planName)) planGroups.set(planName, []);
      planGroups.get(planName).push(row);
    }

    if (planGroups.size === 0) {
      addResult(siteName, false, "No valid plan rows — skipped");
      failed++;
      continue;
    }

    const plans = [];
    let rowError = null;

    for (const [planName, planRows] of planGroups) {
      // All rows for this plan should agree on classification/matchType/priority/state/normalizedFormat
      // — use values from the first row.
      const first = planRows[0];
      const classification   = String(first[2] || "").trim();
      const matchTypeRaw     = String(first[3] || "").trim().toLowerCase();
      const priorityRaw      = String(first[4] || "").trim();
      const state            = String(first[5] || "").trim().toLowerCase() || "active";
      const digitLengthRaw   = String(first[7] || "").trim();
      const matchPattern     = String(first[8] || "").trim();
      const normalizedFormat = String(first[9] || "").trim();

      if (!classification) { rowError = `Plan '${planName}': missing classification`; break; }
      if (!VALID_TYPES.has(matchTypeRaw)) {
        rowError = `Plan '${planName}': invalid matchType '${first[3]}' — must be numberList, digitLength, intraCountryCode, interCountryCode, or regex`;
        break;
      }
      const priority = parseInt(priorityRaw, 10);
      if (isNaN(priority)) { rowError = `Plan '${planName}': invalid priority '${priorityRaw}'`; break; }

      // Capitalise matchType to Genesys casing (e.g. "numberlist" → "numberList")
      const matchTypeCased = {
        numberlist:       "numberList",
        digitlength:      "digitLength",
        intracountrycode: "intraCountryCode",
        intercountrycode: "interCountryCode",
        regex:            "regex",
      }[matchTypeRaw];

      const plan = { name: planName, classification, matchType: matchTypeCased, priority, state };

      if (MULTI_NUMBER_TYPES.has(matchTypeRaw)) {
        const nums = planRows
          .map(r => String(r[6] || "").trim())
          .filter(Boolean)
          .map(v => ({ start: v }));
        if (nums.length) plan.numbers = nums;
      }

      if (matchTypeRaw === "digitlength" && digitLengthRaw) {
        const parts = digitLengthRaw.split("-").map(s => parseInt(s.trim(), 10));
        plan.digitLength = parts.length === 2
          ? { start: parts[0], end: parts[1] }
          : { start: parts[0] };
      }

      if (["intracountrycode", "intercountrycode", "regex"].includes(matchTypeRaw) && matchPattern) {
        plan.match = matchPattern;
      }

      if (normalizedFormat) plan.normalizedFormat = normalizedFormat;

      plans.push(plan);
    }

    if (rowError) {
      addResult(siteName, false, rowError);
      failed++;
      continue;
    }

    try {
      // GET existing plans, merge (sheet plans overwrite by name, unknowns are kept)
      let existing = [];
      try { existing = await gc.getSiteNumberPlans(api, orgId, site.id) || []; } catch (_) { /* start fresh if GET fails */ }

      const sheetByName = new Map(plans.map(p => [p.name.toLowerCase(), p]));
      const existingByName = new Map(existing.map(p => [p.name.toLowerCase(), p]));
      const existingNotInSheet = existing.filter(p => !sheetByName.has(p.name.toLowerCase()));
      // Carry over id (and version) from existing plan when names match — required by Genesys PUT
      const resolvedPlans = plans.map(p => {
        const ex = existingByName.get(p.name.toLowerCase());
        if (!ex) return p;
        return { ...p, id: ex.id, ...(ex.version !== undefined ? { version: ex.version } : {}) };
      });
      const merged = [...existingNotInSheet, ...resolvedPlans];

      if (merged.length > 200) {
        addResult(siteName, false, `Merged total of ${merged.length} plans exceeds Genesys limit of 200 — skipped`);
        failed++;
        continue;
      }

      await gc.updateSiteNumberPlans(api, orgId, site.id, merged);
      for (const p of plans) {
        addResult(`${siteName} — ${p.name}`, true);
      }
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Updated ${plans.length} number plan(s) on site '${siteName}' (${merged.length} total)` });
      updated++;
    } catch (err) {
      addResult(siteName, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to update number plans on site '${siteName}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created: updated, failed };
}

// ── Tab: Outbound Routes ─────────────────────────────────────────────────────
// Columns: A=Site Name (req), B=Route Name (req), C=Classification Types (one per row),
//          D=Distribution (req: SEQUENTIAL|RANDOM, from first row of each route group),
//          E=Trunk Names (one per row, resolved to IDs by name),
//          F=State (req: true|false → enabled, from first row)
//
// Rows are grouped by Site Name then by Route Name.
// Multiple rows with the same Site+Route accumulate classification types and trunk names.
// Existing routes on a site not present in the sheet are left untouched.
// Routes matching by name are updated (PUT); new routes are created (POST).
async function processOutboundRoutes({ rows, api, orgId, me, addResult }) {
  let updated = 0;
  let failed  = 0;

  // Pre-fetch all sites
  let sites;
  try {
    sites = await gc.fetchAllSites(api, orgId);
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch sites: ${err.message}`);
    return { created: 0, failed: rows.length };
  }
  const siteMap = Object.fromEntries(sites.map(s => [s.name.toLowerCase(), s]));

  // Pre-fetch all trunk base settings
  let trunks;
  try {
    trunks = await gc.fetchAllTrunkBaseSettings(api, orgId);
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch trunk base settings: ${err.message}`);
    return { created: 0, failed: rows.length };
  }
  const trunkMap = Object.fromEntries(trunks.map(t => [t.name.toLowerCase(), t]));

  // Group rows by site name
  const siteGroups = new Map();
  for (const row of rows) {
    const siteName = String(row[0] || "").trim();
    if (!siteName) continue;
    if (!siteGroups.has(siteName)) siteGroups.set(siteName, []);
    siteGroups.get(siteName).push(row);
  }

  for (const [siteName, siteRows] of siteGroups) {
    const site = siteMap[siteName.toLowerCase()];
    if (!site) {
      addResult(siteName, false, `Site '${siteName}' not found`);
      failed++;
      continue;
    }

    // GET existing outbound routes for merge (update by name if exists)
    let existingRoutes = [];
    try {
      const resp = await gc.getSiteOutboundRoutes(api, orgId, site.id);
      existingRoutes = Array.isArray(resp) ? resp : (resp?.entities ?? []);
    } catch (_) { /* start fresh if GET fails */ }
    const existingByName = new Map(existingRoutes.map(r => [r.name.toLowerCase(), r]));

    // Group rows by route name within this site
    const routeGroups = new Map();
    for (const row of siteRows) {
      const routeName = String(row[1] || "").trim();
      if (!routeName) continue;
      if (!routeGroups.has(routeName)) routeGroups.set(routeName, []);
      routeGroups.get(routeName).push(row);
    }

    if (routeGroups.size === 0) {
      addResult(siteName, false, "No valid route rows — skipped");
      failed++;
      continue;
    }

    for (const [routeName, routeRows] of routeGroups) {
      const first = routeRows[0];
      const distribution = String(first[3] || "").trim().toUpperCase();
      const stateRaw     = String(first[5] || "").trim().toLowerCase();
      const enabled      = stateRaw !== "false";

      if (!distribution) {
        addResult(`${siteName} — ${routeName}`, false, "Missing Distribution");
        failed++;
        continue;
      }

      // Accumulate classification types (col C, one per row, skip blanks)
      const classificationTypes = routeRows
        .map(r => String(r[2] || "").trim())
        .filter(Boolean);

      // Accumulate trunk names (col E, one per row), deduplicate, resolve to objects
      const seenTrunks = new Set();
      const externalTrunkBases = [];
      let trunkError = null;
      for (const row of routeRows) {
        const trunkName = String(row[4] || "").trim();
        if (!trunkName || seenTrunks.has(trunkName.toLowerCase())) continue;
        seenTrunks.add(trunkName.toLowerCase());
        const trunk = trunkMap[trunkName.toLowerCase()];
        if (!trunk) {
          trunkError = `Trunk '${trunkName}' not found`;
          break;
        }
        externalTrunkBases.push({ id: trunk.id, name: trunk.name });
      }

      if (trunkError) {
        addResult(`${siteName} — ${routeName}`, false, trunkError);
        failed++;
        continue;
      }

      const body = { name: routeName, classificationTypes, distribution, enabled, externalTrunkBases };

      try {
        const existing = existingByName.get(routeName.toLowerCase());
        if (existing) {
          await gc.updateSiteOutboundRoute(api, orgId, site.id, existing.id, { ...body, id: existing.id });
        } else {
          await gc.createSiteOutboundRoute(api, orgId, site.id, body);
        }
        addResult(`${siteName} — ${routeName}`, true);
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] ${existing ? "Updated" : "Created"} outbound route '${routeName}' on site '${siteName}'` });
        updated++;
      } catch (err) {
        addResult(`${siteName} — ${routeName}`, false, err.message);
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to ${existingByName.has(routeName.toLowerCase()) ? "update" : "create"} outbound route '${routeName}' on site '${siteName}': ${err.message}`, result: "failure", errorMessage: err.message });
        failed++;
      }
    }
  }

  return { created: updated, failed };
}

// ── Tab: Sites ──────────────────────────────────────────────────────────────
// Columns: A=Name (req), B=Media Model (req: Cloud|Premises), C=Media Regions (Cloud only, comma-sep),
//          D=Location Name (req), E=TURN Relay (opt: Site|Geo, default=Site), F=Caller ID (opt), G=Caller Name (opt), H=Description (opt)
async function processSites({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let failed  = 0;

  // Pre-fetch locations once
  let locations;
  try {
    locations = await gc.fetchAllLocations(api, orgId);
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch locations: ${err.message}`);
    return { created: 0, failed: rows.length };
  }

  const locationMap = Object.fromEntries(
    locations.map(l => [l.name.toLowerCase(), l])
  );

  const turnRelayMap = {
    "site": "AnyMediaRegionForSite",
    "geo":  "GeoLocation",
  };

  for (const row of rows) {
    const name         = String(row[0] || "").trim();
    const mediaModel   = String(row[1] || "").trim();
    const mediaRegions = String(row[2] || "").trim().split(",").map(s => s.trim()).filter(Boolean);
    const locationName = String(row[3] || "").trim();
    const turnRelayRaw = String(row[4] || "").trim().toLowerCase() || "site";
    const callerId     = String(row[5] || "").trim();
    const callerName   = String(row[6] || "").trim();
    const description  = String(row[7] || "").trim();

    const label = name || "(empty)";

    if (!name)         { addResult(label, false, "Missing name — skipped");       failed++; continue; }
    if (!mediaModel)   { addResult(label, false, "Missing media model — skipped"); failed++; continue; }
    if (!locationName) { addResult(label, false, "Missing location — skipped");    failed++; continue; }

    const normalizedModel = mediaModel.charAt(0).toUpperCase() + mediaModel.slice(1).toLowerCase();
    if (!["Cloud", "Premises"].includes(normalizedModel)) {
      addResult(label, false, `Invalid media model '${mediaModel}' — must be Cloud or Premises`);
      failed++;
      continue;
    }

    if (normalizedModel === "Cloud" && !mediaRegions.length) {
      addResult(label, false, "Media regions required for Cloud sites — skipped");
      failed++;
      continue;
    }

    const turnRelay = turnRelayMap[turnRelayRaw];
    if (!turnRelay) {
      addResult(label, false, `Invalid TURN Relay '${row[4]}' — must be Site or Geo`);
      failed++;
      continue;
    }

    const location = locationMap[locationName.toLowerCase()];
    if (!location) {
      addResult(label, false, `Location '${locationName}' not found`);
      failed++;
      continue;
    }

    const body = {
      name,
      mediaModel: normalizedModel,
      location: { id: location.id, name: location.name },
      mediaRegionsUseLatencyBased: turnRelay === "GeoLocation",
      ...(normalizedModel === "Cloud" && { mediaRegions }),
      ...(callerId   && { callerId }),
      ...(callerName && { callerName }),
      ...(description && { description }),
    };

    try {
      const result = await gc.createSite(api, orgId, body);
      addResult(name, true, result?.id ? `id: ${result.id}` : "");
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Created site '${name}' (${normalizedModel})` });
      created++;
    } catch (err) {
      addResult(name, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to create site '${name}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created, failed };
}

// ── Tab: Skills ──────────────────────────────────────────────────────────────
// Columns: A=Name (required)
async function processSkills({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let failed  = 0;

  for (const row of rows) {
    const name = String(row[0] || "").trim();
    if (!name) { addResult("(empty)", false, "Missing name — skipped"); failed++; continue; }

    try {
      await gc.createSkill(api, orgId, { name });
      addResult(name, true);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Created skill '${name}'` });
      created++;
    } catch (err) {
      addResult(name, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to create skill '${name}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created, failed };
}

// ── Tab: Schedules ───────────────────────────────────────────────────────────
// Columns:
//   A=Name (req), B=Division, C=Description,
//   D=Start (req) ISO-8601 without timezone: yyyy-MM-ddTHH:mm:ss.SSS
//   E=End   (req) same format
//   F=RRule  iCal RRULE string e.g. FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR (optional)
//
// Start/End times are interpreted in the org's configured timezone by Genesys.
// Names are matched case-insensitively; existing schedules are PUT (updated),
// new ones are POST (created).
async function processSchedules({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let updated = 0;
  let failed  = 0;

  // Pre-fetch divisions and existing schedules for upsert
  let divMap = {}, scheduleMap = {};
  try {
    const [divs, schedules] = await Promise.all([
      gc.fetchAllDivisions(api, orgId),
      gc.fetchAllSchedules(api, orgId),
    ]);
    divMap      = Object.fromEntries(divs.map(d => [d.name.toLowerCase(), d.id]));
    scheduleMap = Object.fromEntries(schedules.map(s => [s.name.toLowerCase(), { id: s.id, version: s.version }]));
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch lookup data: ${err.message}`);
    return { created: 0, failed: rows.length };
  }

  // Validate ISO-8601 without timezone: yyyy-MM-ddTHH:mm:ss or yyyy-MM-ddTHH:mm:ss.SSS
  function parseDateTime(val) {
    const s = String(val ?? "").trim();
    if (!s) return { value: null, error: null };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s))
      return { value: null, error: `Invalid datetime '${s}' — expected yyyy-MM-ddTHH:mm:ss[.SSS] (no timezone)` };
    return { value: s, error: null };
  }

  for (const row of rows) {
    const name        = String(row[0] ?? "").trim();
    const divisionRaw = String(row[1] ?? "").trim();
    const description = String(row[2] ?? "").trim();
    const startRaw    = row[3];
    const endRaw      = row[4];
    const rrule       = String(row[5] ?? "").trim();

    if (!name) { addResult("(empty)", false, "Missing name — skipped"); failed++; continue; }

    const start = parseDateTime(startRaw);
    if (start.error) { addResult(name, false, `Start: ${start.error}`); failed++; continue; }
    if (!start.value) { addResult(name, false, "Missing Start date/time — required"); failed++; continue; }

    const end = parseDateTime(endRaw);
    if (end.error) { addResult(name, false, `End: ${end.error}`); failed++; continue; }
    if (!end.value) { addResult(name, false, "Missing End date/time — required"); failed++; continue; }

    const body = { name, start: start.value, end: end.value };
    if (description) body.description = description;
    if (rrule)       body.rrule = rrule;
    if (divisionRaw) {
      const divId = divMap[divisionRaw.toLowerCase()];
      if (divId === undefined) { addResult(name, false, `Division '${divisionRaw}' not found`); failed++; continue; }
      body.division = { id: divId };
    }

    const existing = scheduleMap[name.toLowerCase()];
    try {
      if (existing) {
        await gc.putSchedule(api, orgId, existing.id, { ...body, version: existing.version });
        addResult(name, true, "Updated");
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Updated schedule '${name}'` });
        updated++;
      } else {
        await gc.createSchedule(api, orgId, body);
        addResult(name, true, "Created");
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Created schedule '${name}'` });
        created++;
      }
    } catch (err) {
      addResult(name, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to ${existing ? "update" : "create"} schedule '${name}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created: created + updated, failed };
}

// ── Tab: Schedule Groups ─────────────────────────────────────────────────────
// Multi-row per group: rows sharing the same Group Name (col A) are folded into
// one POST/PUT.  Division / Description / Time Zone are read only from the
// FIRST row of each group; subsequent rows need only A + E + F.
//
// Columns:
//   A  Group Name     (req)        — groups rows with the same name
//   B  Division                    — resolved by name; first row only
//   C  Description                 — first row only
//   D  Time Zone                   — IANA id e.g. Europe/Copenhagen; first row only
//   E  Type           (req)        — open | closed | holiday
//   F  Schedule Name  (req)        — resolved to {id} via schedule name lookup
//
async function processScheduleGroups({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let updated = 0;
  let failed  = 0;

  // Pre-fetch lookup data
  let divMap = {}, scheduleMap = {}, groupMap = {};
  try {
    const [divs, schedules, groups] = await Promise.all([
      gc.fetchAllDivisions(api, orgId),
      gc.fetchAllSchedules(api, orgId),
      gc.fetchAllScheduleGroups(api, orgId),
    ]);
    divMap      = Object.fromEntries(divs.map(d => [d.name.toLowerCase(), d.id]));
    scheduleMap = Object.fromEntries(schedules.map(s => [s.name.toLowerCase(), { id: s.id }]));
    groupMap    = Object.fromEntries(groups.map(g => [g.name.toLowerCase(), { id: g.id, version: g.version }]));
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch lookup data: ${err.message}`);
    return { created: 0, failed: rows.length };
  }

  // Fold rows into groups: Map<lowerName, { meta, open[], closed[], holiday[], rowCount }>
  const VALID_TYPES = new Set(["open", "closed", "holiday"]);
  const groups_acc = new Map();

  for (const row of rows) {
    const name = String(row[0] ?? "").trim();
    if (!name) { addResult("(empty)", false, "Missing Group Name — skipped"); failed++; continue; }

    const key = name.toLowerCase();
    if (!groups_acc.has(key)) {
      groups_acc.set(key, {
        name,
        divisionRaw:  String(row[1] ?? "").trim(),
        description:  String(row[2] ?? "").trim(),
        timeZone:     String(row[3] ?? "").trim(),
        open:     [],
        closed:   [],
        holiday:  [],
        rowErrors: [],
      });
    }

    const g       = groups_acc.get(key);
    const typeRaw = String(row[4] ?? "").trim().toLowerCase();
    const schName = String(row[5] ?? "").trim();

    if (!VALID_TYPES.has(typeRaw)) {
      g.rowErrors.push(`Type '${row[4]}' invalid (must be open/closed/holiday)`);
      continue;
    }
    if (!schName) {
      g.rowErrors.push(`Missing Schedule Name for type '${typeRaw}'`);
      continue;
    }
    const sch = scheduleMap[schName.toLowerCase()];
    if (!sch) {
      g.rowErrors.push(`Schedule '${schName}' not found`);
      continue;
    }

    g[typeRaw].push({ id: sch.id });
  }

  // Process each collected group
  for (const [, g] of groups_acc) {
    // Surface row-level errors first
    if (g.rowErrors.length) {
      for (const e of g.rowErrors) addResult(g.name, false, e);
      failed++;
      continue;
    }

    // Build body
    const body = { name: g.name };
    if (g.description) body.description = g.description;
    if (g.timeZone)    body.timeZone    = g.timeZone;
    if (g.open.length)    body.openSchedules    = g.open;
    if (g.closed.length)  body.closedSchedules  = g.closed;
    if (g.holiday.length) body.holidaySchedules = g.holiday;

    if (g.divisionRaw) {
      const divId = divMap[g.divisionRaw.toLowerCase()];
      if (divId === undefined) {
        addResult(g.name, false, `Division '${g.divisionRaw}' not found`);
        failed++;
        continue;
      }
      body.division = { id: divId };
    }

    const existing = groupMap[g.name.toLowerCase()];
    try {
      if (existing) {
        await gc.putScheduleGroup(api, orgId, existing.id, { ...body, version: existing.version });
        addResult(g.name, true, "Updated");
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Updated schedule group '${g.name}'` });
        updated++;
      } else {
        await gc.createScheduleGroup(api, orgId, body);
        addResult(g.name, true, "Created");
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Created schedule group '${g.name}'` });
        created++;
      }
    } catch (err) {
      addResult(g.name, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to ${existing ? "update" : "create"} schedule group '${g.name}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created: created + updated, failed };
}

// ── Tab: Queues ──────────────────────────────────────────────────────────────
// Columns A–AY (51 total, 0-indexed 0–50)
//
// General (cols 0–20):
//   0:A  Queue Name              text    REQUIRED
//   1:B  Division                name→ID REQUIRED
//   2:C  Description             text
//   3:D  Scoring Method          enum    TimestampAndPriority | PriorityOnly
//   4:E  Last Agent Routing      enum    Disabled | QueueMembersOnly | AnyAgent
//   5:F  ACW Prompt              enum    OPTIONAL | MANDATORY | MANDATORY_TIMEOUT | MANDATORY_FORCED_TIMEOUT | AGENT_REQUESTED
//   6:G  Skill Eval Method       enum    NONE | BEST | ALL
//   7:H  Auto Answer Only        bool
//   8:I  Enable Transcription    bool
//   9:J  Enable Manual Assign    bool
//  10:K  Suppress Recording      bool
//  11:L  Calling Party Name      text
//  12:M  Calling Party Number    text
//  13:N  Call In-Queue Flow      name→ID
//  14:O  Email In-Queue Flow     name→ID
//  15:P  Message In-Queue Flow   name→ID
//  16:Q  Call Script             name→ID
//  17:R  Callback Script         name→ID
//  18:S  Chat Script             name→ID
//  19:T  Email Script            name→ID
//  20:U  Message Script          name→ID
//
// Media blocks (6 cols each): call=21, callback=27, chat=33, email=39, message=45
//   +0 Alerting (s)             number
//   +1 Auto Answer              bool
//   +2 Enable Audio Duration    bool
//   +3 Audio Duration (s)       number
//   +4 SL %                     number
//   +5 SL Duration (ms)         number
//
// Blank cell = field omitted (no error). Only required fields are Queue Name and Division.
// Non-blank but invalid value (bad enum / non-boolean / non-number / name not found) = skip row.
async function processQueues({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let updated = 0;
  let failed  = 0;

  const SCORING_METHODS    = new Set(["TimestampAndPriority", "PriorityOnly"]);
  const LAST_AGENT_MODES   = new Set(["Disabled", "QueueMembersOnly", "AnyAgent"]);
  const ACW_PROMPTS        = new Set(["OPTIONAL", "MANDATORY", "MANDATORY_TIMEOUT", "MANDATORY_FORCED_TIMEOUT", "AGENT_REQUESTED"]);
  const SKILL_EVAL_METHODS = new Set(["NONE", "BEST", "ALL"]);

  // Pre-fetch lookup maps once (divisions, flows, scripts, existing queues)
  let divMap = {}, flowMap = {}, scriptMap = {}, queueMap = {};
  try {
    const [divs, flows, scripts, queues] = await Promise.all([
      gc.fetchAllDivisions(api, orgId),
      gc.fetchAllFlows(api, orgId),
      gc.fetchAllScripts(api, orgId),
      gc.fetchAllQueues(api, orgId),
    ]);
    divMap    = Object.fromEntries(divs.map(d => [d.name.toLowerCase(), d.id]));
    flowMap   = Object.fromEntries(flows.map(f => [f.name.toLowerCase(), f.id]));
    scriptMap = Object.fromEntries(scripts.map(s => [s.name.toLowerCase(), s.id]));
    queueMap  = Object.fromEntries(queues.map(q => [q.name.toLowerCase(), { id: q.id, version: q.version }]));
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch lookup data: ${err.message}`);
    return { created: 0, failed: rows.length };
  }

  // blank → null (omit); non-blank invalid → error string
  function parseEnum(val, validSet) {
    const s = String(val ?? "").trim();
    if (!s) return { value: null, error: null };
    if (!validSet.has(s)) return { value: null, error: `Invalid value '${s}' — expected one of: ${[...validSet].join(", ")}` };
    return { value: s, error: null };
  }

  function parseBool(val) {
    const s = String(val ?? "").trim().toLowerCase();
    if (!s) return { value: null, error: null };
    if (s === "true")  return { value: true,  error: null };
    if (s === "false") return { value: false, error: null };
    return { value: null, error: `Invalid boolean '${val}' — must be true or false` };
  }

  function parseNum(val) {
    const s = String(val ?? "").trim();
    if (!s) return { value: null, error: null };
    const n = Number(s);
    if (isNaN(n)) return { value: null, error: `Invalid number '${val}'` };
    return { value: n, error: null };
  }

  function resolveName(val, map, entityType) {
    const s = String(val ?? "").trim();
    if (!s) return { id: null, error: null };
    const id = map[s.toLowerCase()];
    if (id === undefined) return { id: null, error: `${entityType} '${s}' not found` };
    return { id, error: null };
  }

  // Parse a 6-column media block starting at row[offset].
  // Col +0=Alerting(s), +1=AutoAnswer(bool), +2=AutoAnswerAlertTone(s), +3=ManualAnswerAlertTone(s),
  // +4=SL%, +5=SLDurationMs. All 5 media types support all fields.
  // Returns { block, error } — block is null if all 6 cells are blank.
  function parseMediaBlock(row, offset) {
    const vals = [row[offset], row[offset+1], row[offset+2], row[offset+3], row[offset+4], row[offset+5]];
    if (vals.every(v => String(v ?? "").trim() === "")) return { block: null, error: null };

    const alerting          = parseNum(vals[0]);
    const autoAnswer        = parseBool(vals[1]);
    const autoAnswerTone    = parseNum(vals[2]);
    const manualAnswerTone  = parseNum(vals[3]);
    const slPct             = parseNum(vals[4]);
    const slDur             = parseNum(vals[5]);

    for (const r of [alerting, autoAnswer, autoAnswerTone, manualAnswerTone, slPct, slDur]) {
      if (r.error) return { block: null, error: r.error };
    }

    const block = {};
    if (alerting.value         !== null) block.alertingTimeoutSeconds        = alerting.value;
    if (autoAnswer.value       !== null) block.enableAutoAnswer              = autoAnswer.value;
    if (autoAnswerTone.value   !== null) block.autoAnswerAlertToneSeconds    = autoAnswerTone.value;
    if (manualAnswerTone.value !== null) block.manualAnswerAlertToneSeconds  = manualAnswerTone.value;
    if (slPct.value !== null || slDur.value !== null) {
      block.serviceLevel = {};
      if (slPct.value !== null) block.serviceLevel.percentage = slPct.value / 100;
      if (slDur.value !== null) block.serviceLevel.durationMs = slDur.value;
    }
    return { block, error: null };
  }

  for (const row of rows) {
    const name        = String(row[0] ?? "").trim();
    const divisionRaw = String(row[1] ?? "").trim();

    if (!name)        { addResult("(empty)", false, "Missing queue name — skipped");   failed++; continue; }
    if (!divisionRaw) { addResult(name,      false, "Missing division — skipped");      failed++; continue; }

    const div = resolveName(divisionRaw, divMap, "Division");
    if (div.error) { addResult(name, false, div.error); failed++; continue; }

    const description = String(row[2] ?? "").trim();

    const scoringMethod   = parseEnum(row[3], SCORING_METHODS);
    if (scoringMethod.error)   { addResult(name, false, scoringMethod.error);   failed++; continue; }
    const lastAgentMode   = parseEnum(row[4], LAST_AGENT_MODES);
    if (lastAgentMode.error)   { addResult(name, false, lastAgentMode.error);   failed++; continue; }
    const acwPrompt       = parseEnum(row[5], ACW_PROMPTS);
    if (acwPrompt.error)       { addResult(name, false, acwPrompt.error);       failed++; continue; }
    const skillEvalMethod = parseEnum(row[6], SKILL_EVAL_METHODS);
    if (skillEvalMethod.error) { addResult(name, false, skillEvalMethod.error); failed++; continue; }

    const enableTranscription = parseBool(row[7]);
    if (enableTranscription.error) { addResult(name, false, enableTranscription.error); failed++; continue; }
    const enableManualAssign  = parseBool(row[8]);
    if (enableManualAssign.error)  { addResult(name, false, enableManualAssign.error);  failed++; continue; }
    const suppressRecording   = parseBool(row[9]);
    if (suppressRecording.error)   { addResult(name, false, suppressRecording.error);   failed++; continue; }

    const callingPartyName   = String(row[10] ?? "").trim();
    const callingPartyNumber = String(row[11] ?? "").trim();

    const callFlow  = resolveName(row[12], flowMap, "Call in-queue flow");
    if (callFlow.error)  { addResult(name, false, callFlow.error);  failed++; continue; }
    const emailFlow = resolveName(row[13], flowMap, "Email in-queue flow");
    if (emailFlow.error) { addResult(name, false, emailFlow.error); failed++; continue; }
    const msgFlow   = resolveName(row[14], flowMap, "Message in-queue flow");
    if (msgFlow.error)   { addResult(name, false, msgFlow.error);   failed++; continue; }

    const callScript     = resolveName(row[15], scriptMap, "Call script");
    if (callScript.error)     { addResult(name, false, callScript.error);     failed++; continue; }
    const callbackScript  = resolveName(row[16], scriptMap, "Callback script");
    if (callbackScript.error) { addResult(name, false, callbackScript.error); failed++; continue; }
    const chatScript      = resolveName(row[17], scriptMap, "Chat script");
    if (chatScript.error)     { addResult(name, false, chatScript.error);     failed++; continue; }
    const emailScript     = resolveName(row[18], scriptMap, "Email script");
    if (emailScript.error)    { addResult(name, false, emailScript.error);    failed++; continue; }
    const msgScript       = resolveName(row[19], scriptMap, "Message script");
    if (msgScript.error)      { addResult(name, false, msgScript.error);      failed++; continue; }

    const callMedia     = parseMediaBlock(row, 20);
    if (callMedia.error)     { addResult(name, false, `Call media: ${callMedia.error}`);         failed++; continue; }
    const callbackMedia = parseMediaBlock(row, 26);
    if (callbackMedia.error) { addResult(name, false, `Callback media: ${callbackMedia.error}`); failed++; continue; }
    const chatMedia     = parseMediaBlock(row, 32);
    if (chatMedia.error)     { addResult(name, false, `Chat media: ${chatMedia.error}`);         failed++; continue; }
    const emailMedia    = parseMediaBlock(row, 38);
    if (emailMedia.error)    { addResult(name, false, `Email media: ${emailMedia.error}`);       failed++; continue; }
    const msgMedia      = parseMediaBlock(row, 44);
    if (msgMedia.error)      { addResult(name, false, `Message media: ${msgMedia.error}`);       failed++; continue; }

    // Build API body — only include fields that have a value
    const body = {
      name,
      division: { id: div.id },
    };

    if (description)                        body.description                  = description;
    if (scoringMethod.value)                body.scoringMethod                = scoringMethod.value;
    if (lastAgentMode.value)                body.lastAgentRoutingMode         = lastAgentMode.value;
    if (acwPrompt.value)                    body.acwSettings                  = { wrapupPrompt: acwPrompt.value };
    if (skillEvalMethod.value)              body.skillEvaluationMethod        = skillEvalMethod.value;
    if (enableTranscription.value !== null) body.enableTranscription          = enableTranscription.value;
    if (enableManualAssign.value  !== null) body.enableManualAssignment       = enableManualAssign.value;
    if (suppressRecording.value   !== null) body.suppressInQueueCallRecording = suppressRecording.value;
    if (callingPartyName)                   body.callingPartyName             = callingPartyName;
    if (callingPartyNumber)                 body.callingPartyNumber           = callingPartyNumber;
    if (callFlow.id)                        body.queueFlow                    = { id: callFlow.id };
    if (emailFlow.id)                       body.emailInQueueFlow             = { id: emailFlow.id };
    if (msgFlow.id)                         body.messageInQueueFlow           = { id: msgFlow.id };

    const defaultScripts = {};
    if (callScript.id)     defaultScripts.CALL     = { id: callScript.id };
    if (callbackScript.id) defaultScripts.CALLBACK = { id: callbackScript.id };
    if (chatScript.id)     defaultScripts.CHAT     = { id: chatScript.id };
    if (emailScript.id)    defaultScripts.EMAIL    = { id: emailScript.id };
    if (msgScript.id)      defaultScripts.MESSAGE  = { id: msgScript.id };
    if (Object.keys(defaultScripts).length) body.defaultScripts = defaultScripts;

    const mediaSettings = {};
    if (callMedia.block)     mediaSettings.call     = callMedia.block;
    if (callbackMedia.block) mediaSettings.callback = callbackMedia.block;
    if (chatMedia.block)     mediaSettings.chat     = chatMedia.block;
    if (emailMedia.block)    mediaSettings.email    = emailMedia.block;
    if (msgMedia.block)      mediaSettings.message  = msgMedia.block;
    if (Object.keys(mediaSettings).length) body.mediaSettings = mediaSettings;

    const existing = queueMap[name.toLowerCase()];
    try {
      if (existing) {
        await gc.putQueue(api, orgId, existing.id, { ...body, version: existing.version });
        addResult(name, true, "Updated");
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Updated queue '${name}'` });
        updated++;
      } else {
        await gc.createQueue(api, orgId, body);
        addResult(name, true, "Created");
        logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Created queue '${name}'` });
        created++;
      }
    } catch (err) {
      addResult(name, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to ${existing ? "update" : "create"} queue '${name}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created: created + updated, failed };
}

// ── Tab: Skills - Language ────────────────────────────────────────────────────
// Columns: A=Name (required)
async function processLanguages({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let failed  = 0;

  for (const row of rows) {
    const name = String(row[0] || "").trim();
    if (!name) { addResult("(empty)", false, "Missing name — skipped"); failed++; continue; }

    try {
      await gc.createLanguage(api, orgId, { name });
      addResult(name, true);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Created language '${name}'` });
      created++;
    } catch (err) {
      addResult(name, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to create language '${name}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created, failed };
}

// ── Tab: Divisions ───────────────────────────────────────────────────────────
// Columns: A=Name (required), B=Description (optional)
async function processDivisions({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let failed  = 0;

  for (const row of rows) {
    const name        = String(row[0] || "").trim();
    const description = String(row[1] || "").trim();

    if (!name) {
      addResult("(empty)", false, "Missing name — skipped");
      failed++;
      continue;
    }

    const body = {
      name,
      ...(description && { description }),
    };

    try {
      await gc.createDivision(api, orgId, body);
      addResult(name, true);
      logAction({
        me, orgId,
        action: "deployment_basic",
        description: `[Deployment] Created division '${name}'`,
      });
      created++;
    } catch (err) {
      addResult(name, false, err.message);
      logAction({
        me, orgId,
        action: "deployment_basic",
        description: `[Deployment] Failed to create division '${name}': ${err.message}`,
        result: "failure",
        errorMessage: err.message,
      });
      failed++;
    }
  }

  return { created, failed };
}

// ── Tab: Wrapup Codes ────────────────────────────────────────────────────────
// Columns:
//   A=Name (req), B=Division, C=Description, D=Queue Name
//
// Upserts by name (PUT with version if found, POST if new).
// If col D has a queue name, the code is assigned to that queue after upsert.
async function processWrapupCodes({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let updated = 0;
  let failed  = 0;

  // Pre-fetch lookup maps once
  let codeMap = {}, divMap = {}, queueMap = {};
  try {
    const [codes, divs, queues] = await Promise.all([
      gc.fetchAllWrapupCodes(api, orgId),
      gc.fetchAllDivisions(api, orgId),
      gc.fetchAllQueues(api, orgId),
    ]);
    codeMap  = Object.fromEntries(codes.map(c => [c.name.toLowerCase(), { id: c.id, version: c.version }]));
    divMap   = Object.fromEntries(divs.map(d => [d.name.toLowerCase(), d.id]));
    queueMap = Object.fromEntries(queues.map(q => [q.name.toLowerCase(), q.id]));
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch lookup data: ${err.message}`);
    return { created: 0, failed: rows.length };
  }

  for (const row of rows) {
    const name        = String(row[0] || "").trim();
    const divisionRaw = String(row[1] || "").trim();
    const description = String(row[2] || "").trim();
    const queueRaw    = String(row[3] || "").trim();

    if (!name) { addResult("(empty)", false, "Missing name — skipped"); failed++; continue; }

    // Resolve division (optional)
    let divisionId = null;
    if (divisionRaw) {
      divisionId = divMap[divisionRaw.toLowerCase()];
      if (!divisionId) { addResult(name, false, `Division '${divisionRaw}' not found`); failed++; continue; }
    }

    // Resolve queue (optional)
    let queueId = null;
    if (queueRaw) {
      queueId = queueMap[queueRaw.toLowerCase()];
      if (!queueId) { addResult(name, false, `Queue '${queueRaw}' not found`); failed++; continue; }
    }

    const body = {
      name,
      ...(description && { description }),
      ...(divisionId  && { division: { id: divisionId } }),
    };

    try {
      const existing = codeMap[name.toLowerCase()];
      let codeId;
      let action;

      if (existing) {
        const result = await gc.putWrapupCode(api, orgId, existing.id, { ...body, version: existing.version });
        codeId = existing.id;
        action = "Updated";
        updated++;
        codeMap[name.toLowerCase()] = { id: codeId, version: result?.version ?? existing.version };
      } else {
        const result = await gc.createWrapupCode(api, orgId, body);
        codeId = result?.id;
        action = "Created";
        created++;
        if (codeId) codeMap[name.toLowerCase()] = { id: codeId, version: result.version };
      }

      if (queueId && codeId) {
        await gc.addWrapupCodesToQueue(api, orgId, queueId, [{ id: codeId }]);
        action += `, added to '${queueRaw}'`;
      }

      addResult(name, true, action);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] ${action.split(",")[0]} wrapup code '${name}'` });
    } catch (err) {
      addResult(name, false, err.message);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to upsert wrapup code '${name}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
    }
  }

  return { created: created + updated, failed };
}

// ── Tab: Users ───────────────────────────────────────────────────────────────
// Columns:
//   A=User (display name, req), B=E-mail (req), C=Phone Name, D=Phone Site,
//   E=Division, F=Skill, G=Roles, H=Extension, I=DID (Direct Number), J=Phone Type
//
// Multi-row: rows sharing the same e-mail (case-insensitive) are folded into one
// user upsert. First row determines: name, phone name, phone site, division,
// extension, DID, phone type. Every row contributes one Skill (col F) and one
// Role (col G) — blank cells are skipped.
//
// Steps per user (each is independent — a failure logs a warning but does NOT
// abort the remaining steps for that user):
//   1. Upsert user by email   (POST if new, PATCH name if found)
//   2. Assign to division     (moveToDivision)
//   3. Grant roles            (additive — does not remove existing)
//   4. Add routing skills     (proficiency 1.0, additive)
//   5. Phone — find by name; create if missing; assign via owner/webRtcUser
//   6. Set extension          (PATCH user addresses, type WORK2)
//   7. Set DID                (PATCH user addresses, type WORK)
async function processUsers({ rows, api, orgId, me, addResult }) {
  let succeeded = 0;
  let failed    = 0;

  // ── Pre-fetch lookup maps ──────────────────────────────────────────────────
  let userMap = {}, divMap = {}, skillMap = {}, roleMap = {}, siteMap = {},
      phoneBaseMap = {}, phoneMap = {};
  try {
    const [users, divs, skills, roles, sites, phoneBases, phones] = await Promise.all([
      gc.fetchAllUsers(api, orgId, { state: "any" }),
      gc.fetchAllDivisions(api, orgId),
      gc.fetchAllSkills(api, orgId),
      gc.fetchAllAuthorizationRoles(api, orgId),
      gc.fetchAllSites(api, orgId),
      gc.fetchAllPhoneBaseSettings(api, orgId),
      gc.fetchAllPhones(api, orgId),
    ]);
    userMap      = Object.fromEntries(users.map(u => [
      (u.email || u.username || "").toLowerCase(),
      { id: u.id, version: u.version, name: u.name },
    ]));
    divMap       = Object.fromEntries(divs.map(d => [d.name.toLowerCase(), { id: d.id, name: d.name, selfUri: d.selfUri }]));
    skillMap     = Object.fromEntries(skills.map(s => [s.name.toLowerCase(), s.id]));
    roleMap      = Object.fromEntries(roles.map(r => [r.name.toLowerCase(), r.id]));
    siteMap      = Object.fromEntries(sites.map(s => [s.name.toLowerCase(), s.id]));
    phoneBaseMap = Object.fromEntries(phoneBases.map(b => [b.name.toLowerCase(), b.id]));
    phoneMap     = Object.fromEntries(phones.map(p => [p.name.toLowerCase(), { id: p.id, version: p.version }]));
  } catch (err) {
    addResult("(setup)", false, `Failed to fetch lookup data: ${err.message}`);
    return { created: 0, failed: rows.length };
  }

  // ── Fold rows by email ─────────────────────────────────────────────────────
  // Map<lowerEmail, { name, email, phoneName, phoneSite, division, extension, did, phoneType, roles[], skills[] }>
  const userGroups = new Map();
  for (const row of rows) {
    const name      = String(row[0] || "").trim();
    const email     = String(row[1] || "").trim();
    const phoneName = String(row[2] || "").trim();
    const phoneSite = String(row[3] || "").trim();
    const division  = String(row[4] || "").trim();
    const skill     = String(row[5] || "").trim();
    const role      = String(row[6] || "").trim();
    const extension = String(row[7] || "").trim();
    const did       = String(row[8] || "").trim();
    const phoneType = String(row[9] || "").trim();

    if (!email) continue;
    const key = email.toLowerCase();

    if (!userGroups.has(key)) {
      userGroups.set(key, { name, email, phoneName, phoneSite, division, extension, did, phoneType, roles: [], skills: [] });
    }
    const g = userGroups.get(key);
    if (role)  g.roles.push(role);
    if (skill) g.skills.push(skill);
  }

  // ── Process each user ──────────────────────────────────────────────────────
  for (const [, g] of userGroups) {
    const label = g.email;
    const notes = [];   // per-step outcome notes
    let userId  = null;
    let version = null;
    let isNew   = false;

    // Step 1: upsert user
    try {
      const existing = userMap[g.email.toLowerCase()];
      if (existing) {
        userId  = existing.id;
        version = existing.version;
        // PATCH name if provided and different
        if (g.name && g.name !== existing.name) {
          const result = await gc.patchUser(api, orgId, userId, { version, name: g.name });
          version = result?.version ?? version;
          notes.push("Updated");
        } else {
          notes.push("Updated");
        }
      } else {
        if (!g.name) { addResult(label, false, "Missing display name for new user"); failed++; continue; }
        const result = await gc.createUser(api, orgId, { name: g.name, email: g.email });
        userId  = result?.id;
        version = result?.version ?? 1;
        isNew   = true;
        if (userId) userMap[g.email.toLowerCase()] = { id: userId, version, name: g.name };
        notes.push("Created");
      }
    } catch (err) {
      addResult(label, false, `User upsert failed: ${err.message}`);
      logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] Failed to upsert user '${g.email}': ${err.message}`, result: "failure", errorMessage: err.message });
      failed++;
      continue;
    }

    // Step 2: assign division
    if (g.division) {
      const divEntry = divMap[g.division.toLowerCase()];
      if (!divEntry) {
        notes.push(`⚠ Division '${g.division}' not found`);
      } else {
        try {
          await gc.moveToDivision(api, orgId, divEntry.id, "USER", [userId]);
          notes.push(`division '${g.division}'`);
        } catch (err) {
          notes.push(`⚠ Division failed: ${err.message}`);
        }
      }
    }

    // Step 3: grant roles
    if (g.roles.length) {
      const roleGrants = [];
      const divId = g.division ? (divMap[g.division.toLowerCase()]?.id ?? null) : null;
      for (const roleName of g.roles) {
        const roleId = roleMap[roleName.toLowerCase()];
        if (!roleId) { notes.push(`⚠ Role '${roleName}' not found`); continue; }
        roleGrants.push({ roleId, divisionId: divId ?? "00000000-0000-0000-0000-000000000000" });
      }
      if (roleGrants.length) {
        try {
          await gc.grantUserRoles(api, orgId, userId, roleGrants);
          notes.push(`role(s): ${g.roles.filter(r => roleMap[r.toLowerCase()]).join(", ")}`);
        } catch (err) {
          notes.push(`⚠ Role grant failed: ${err.message}`);
        }
      }
    }

    // Step 4: add routing skills
    if (g.skills.length) {
      const skillEntries = [];
      for (const skillName of g.skills) {
        const skillId = skillMap[skillName.toLowerCase()];
        if (!skillId) { notes.push(`⚠ Skill '${skillName}' not found`); continue; }
        skillEntries.push({ id: skillId, proficiency: 1.0 });
      }
      if (skillEntries.length) {
        try {
          await gc.addUserRoutingSkillsBulk(api, orgId, userId, skillEntries);
          notes.push(`skill(s): ${g.skills.filter(s => skillMap[s.toLowerCase()]).join(", ")}`);
        } catch (err) {
          notes.push(`⚠ Skill assignment failed: ${err.message}`);
        }
      }
    }

    // Step 5: phone create/find + assign
    if (g.phoneName) {
      const existingPhone = phoneMap[g.phoneName.toLowerCase()];
      if (existingPhone) {
        notes.push(`phone '${g.phoneName}' found`);
      } else {
        // Need base setting + site
        const baseId  = g.phoneType ? phoneBaseMap[g.phoneType.toLowerCase()] : null;
        const siteId  = g.phoneSite ? siteMap[g.phoneSite.toLowerCase()] : null;

        if (!baseId) {
          notes.push(`⚠ Phone type '${g.phoneType || "(not set)"}' not found — phone skipped`);
        } else if (!siteId) {
          notes.push(`⚠ Phone site '${g.phoneSite || "(not set)"}' not found — phone skipped`);
        } else {
          try {
            // Fetch base detail to get lineBaseSettings id
            const baseDetail = await gc.getPhoneBaseSetting(api, orgId, baseId);
            const lineBaseId = baseDetail?.lines?.[0]?.lineBaseSettings?.id ?? null;
            const isWebRtc   = (g.phoneType || "").toLowerCase().includes("webrtc");

            const phoneBody = {
              name: g.phoneName,
              site: { id: siteId },
              phoneBaseSettings: { id: baseId },
              ...(lineBaseId && { lines: [{ lineBaseSettings: { id: lineBaseId } }] }),
              owner: { id: userId, type: "USER" },
              ...(isWebRtc && { webRtcUser: { id: userId, type: "USER" } }),
            };
            const newPhone = await gc.createPhone(api, orgId, phoneBody);
            if (newPhone?.id) phoneMap[g.phoneName.toLowerCase()] = { id: newPhone.id, version: newPhone.version };
            notes.push(`phone '${g.phoneName}' created`);
          } catch (err) {
            notes.push(`⚠ Phone create failed: ${err.message}`);
          }
        }
      }
    }

    // Step 6: set extension (PATCH user addresses type WORK2)
    if (g.extension) {
      try {
        // GET fresh version first so PATCH doesn't conflict
        const fresh = await gc.patchUser(api, orgId, userId, {
          version,
          addresses: [{ mediaType: "PHONE", type: "WORK2", address: g.extension }],
        });
        version = fresh?.version ?? version;
        notes.push(`ext ${g.extension}`);
      } catch (err) {
        notes.push(`⚠ Extension failed: ${err.message}`);
      }
    }

    // Step 7: set DID (PATCH user addresses type WORK)
    if (g.did) {
      try {
        const fresh = await gc.patchUser(api, orgId, userId, {
          version,
          addresses: [{ mediaType: "PHONE", type: "WORK", address: g.did }],
        });
        version = fresh?.version ?? version;
        notes.push(`DID ${g.did}`);
      } catch (err) {
        notes.push(`⚠ DID failed: ${err.message}`);
      }
    }

    addResult(label, true, notes.join("; "));
    logAction({ me, orgId, action: "deployment_basic", description: `[Deployment] ${isNew ? "Created" : "Updated"} user '${g.email}'` });
    succeeded++;
  }

  return { created: succeeded, failed };
}

// ── Tab: DID Pools ────────────────────────────────────────────────────────────
// Columns: A=Number-Start, B=Number-End, C=Description, D=Comment, E=Provider
async function processDIDPools({ rows, api, orgId, me, addResult }) {
  let created = 0;
  let failed  = 0;

  for (const row of rows) {
    const start       = String(row[0] || "").trim();
    const end         = String(row[1] || "").trim();
    const description = String(row[2] || "").trim();
    const comments    = String(row[3] || "").trim();
    const provider    = String(row[4] || "").trim();

    const label = start || "(empty)";

    if (!start || !end) {
      addResult(label, false, "Missing start or end number — skipped");
      failed++;
      continue;
    }
    if (!provider) {
      addResult(label, false, "Missing provider — skipped");
      failed++;
      continue;
    }

    const body = {
      startPhoneNumber: start,
      endPhoneNumber:   end,
      provider,
      ...(description && { description }),
      ...(comments    && { comments }),
    };

    try {
      await gc.createDIDPool(api, orgId, body);
      addResult(label, true);
      logAction({
        me, orgId,
        action: "deployment_basic",
        description: `[Deployment] Created DID pool ${start}–${end} (${provider})`,
      });
      created++;
    } catch (err) {
      addResult(label, false, err.message);
      logAction({
        me, orgId,
        action: "deployment_basic",
        description: `[Deployment] Failed to create DID pool ${start}: ${err.message}`,
        result: "failure",
        errorMessage: err.message,
      });
      failed++;
    }
  }

  return { created, failed };
}

// ── Page renderer ─────────────────────────────────────────────────────────────

export default function renderDeploymentBasic({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h2>Deployment — Basic</h2>
    <p class="page-desc">
      Select an Excel workbook to bulk-create Genesys Cloud objects.
      Each sheet tab maps to a specific function (e.g. "DID Pools").
      Row 1 is the header row and is skipped.
    </p>

    <div class="dt-actions">
      <button class="btn" id="dbSelectBtn">Select Excel Sheet</button>
      <input type="file" id="dbFileInput" accept=".xlsx,.xls" style="display:none" />
    </div>

    <div class="dt-status" id="dbStatus"></div>

    <ul class="ddt-results" id="dbResults" style="list-style:none;padding:0;margin-top:12px;max-height:480px;overflow-y:auto"></ul>
  `;

  const $selectBtn = el.querySelector("#dbSelectBtn");
  const $fileInput = el.querySelector("#dbFileInput");
  const $status    = el.querySelector("#dbStatus");
  const $results   = el.querySelector("#dbResults");

  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
  }

  function addResult(label, ok, detail) {
    const li = document.createElement("li");
    li.style.cssText = "padding:4px 0;border-bottom:1px solid var(--border,#334)";
    li.innerHTML = ok
      ? `<span style="color:#4ade80">✓</span> <strong>${escapeHtml(label)}</strong>${detail ? ` <span style="color:var(--text-muted,#888);font-size:.85em">${escapeHtml(detail)}</span>` : ""}`
      : `<span style="color:#f87171">✗</span> <strong>${escapeHtml(label)}</strong> — ${escapeHtml(detail)}`;
    $results.appendChild(li);
  }

  function addSectionHeader(tabName) {
    const li = document.createElement("li");
    li.style.cssText = "padding:6px 0 2px;font-weight:600;color:var(--accent,#60a5fa)";
    li.textContent = tabName;
    $results.appendChild(li);
  }

  async function processWorkbook(workbook, selectedTabs = null) {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }

    $results.innerHTML = "";
    $selectBtn.disabled = true;

    const sheets = workbook.SheetNames;
    const supported   = sheets.filter(n => TAB_HANDLERS[n] && (!selectedTabs || selectedTabs.includes(n)));
    const unsupported = sheets.filter(n => !TAB_HANDLERS[n]);

    if (!supported.length) {
      setStatus(
        selectedTabs && selectedTabs.length === 0
          ? "No tabs selected — nothing to deploy."
          : `No supported tabs found. Recognised tab names: ${Object.keys(TAB_HANDLERS).join(", ")}.`,
        "error"
      );
      $selectBtn.disabled = false;
      return;
    }

    if (unsupported.length) {
      unsupported.forEach(n => addResult(n, false, "Tab not recognised — skipped"));
    }

    let totalCreated = 0;
    let totalFailed  = 0;

    setStatus(`Processing ${supported.length} tab(s)…`);

    for (const tabName of supported) {
      const ws   = workbook.Sheets[tabName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

      // Skip header row (row 0)
      const dataRows = rows.slice(1).filter(r => String(r[0] || "").trim() !== "");

      addSectionHeader(tabName);

      if (!dataRows.length) {
        addResult(tabName, false, "No data rows found — skipped");
        totalFailed++;
        continue;
      }

      const handler = TAB_HANDLERS[tabName];
      const { created, failed } = await handler({ rows: dataRows, api, orgId, me, addResult });
      totalCreated += created;
      totalFailed  += failed;
    }

    const summary = `Done — ${totalCreated} created, ${totalFailed} failed.`;
    setStatus(summary, totalFailed === 0 ? "success" : (totalCreated === 0 ? "error" : ""));
    $selectBtn.disabled = false;
  }

  function showConfirmDialog(fileName, workbook, onConfirm) {
    const orgDetails = orgContext.getDetails();
    const orgName    = orgDetails ? orgDetails.name : (orgContext.get() || "Unknown org");

    const sheets    = workbook.SheetNames;
    const supported = sheets.filter(n => TAB_HANDLERS[n]);
    const skipped   = sheets.filter(n => !TAB_HANDLERS[n]);

    // Tabs that upsert (update existing matched by name / merge, rather than always creating new)
    const UPSERT_TABS = new Set(["Schedule Groups", "Schedules", "Site - Number Plans", "Site - Outbound Routes", "Queues", "Users", "Wrapup Codes"]);

    // Build per-tab summary rows (with checkboxes)
    const tabRows = supported.map(tabName => {
      const ws   = workbook.Sheets[tabName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      const dataRows = rows.slice(1).filter(r => String(r[0] || "").trim() !== "");
      const upsertNote = UPSERT_TABS.has(tabName)
        ? ` <span style="color:var(--text-muted,#888);font-size:.82em">(existing will be updated)</span>`
        : "";
      const safeTab = escapeHtml(tabName);
      return `<tr>
        <td style="padding:3px 10px 3px 0">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer">
            <input type="checkbox" data-tab="${safeTab}" checked style="cursor:pointer;width:14px;height:14px;flex-shrink:0">
            ${safeTab}${upsertNote}
          </label>
        </td>
        <td style="padding:3px 0;text-align:right;white-space:nowrap">${dataRows.length} row${dataRows.length !== 1 ? "s" : ""}</td>
      </tr>`;
    }).join("");

    const skippedHtml = skipped.length
      ? `<p style="margin:10px 0 0;color:var(--text-muted,#888);font-size:.875rem">
           Unrecognised tabs (will be skipped): ${skipped.map(s => escapeHtml(s)).join(", ")}
         </p>`
      : "";

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center";

    overlay.innerHTML = `
      <div style="background:var(--bg-card,#1e293b);border:1px solid var(--border,#334);border-radius:8px;padding:24px;min-width:340px;max-width:640px;width:90%">
        <h3 style="margin:0 0 16px;font-size:1.1rem">Confirm Deployment</h3>
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          <tr><td style="padding:3px 10px 3px 0;color:var(--text-muted,#888)">Org</td>
              <td style="padding:3px 0"><strong>${escapeHtml(orgName)}</strong></td></tr>
          <tr><td style="padding:3px 10px 3px 0;color:var(--text-muted,#888)">File</td>
              <td style="padding:3px 0">${escapeHtml(fileName)}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid var(--border,#334);margin:14px 0">
        <table style="width:100%;border-collapse:collapse;font-size:.9rem">
          ${tabRows}
        </table>
        ${skippedHtml}
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
          <button id="dbConfirmCancel" class="btn btn--secondary">Cancel</button>
          <button id="dbConfirmDeploy" class="btn">Deploy</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector("#dbConfirmCancel").addEventListener("click", () => {
      document.body.removeChild(overlay);
    });
    overlay.querySelector("#dbConfirmDeploy").addEventListener("click", () => {
      const checked = [...overlay.querySelectorAll("input[data-tab]")]
        .filter(cb => cb.checked)
        .map(cb => cb.dataset.tab);
      document.body.removeChild(overlay);
      onConfirm(checked);
    });
  }

  $selectBtn.addEventListener("click", () => $fileInput.click());

  $fileInput.addEventListener("change", () => {
    const file = $fileInput.files[0];
    if (!file) return;
    $fileInput.value = "";

    const reader = new FileReader();
    reader.onload = (e) => {
      let workbook;
      try {
        workbook = XLSX.read(e.target.result, { type: "array" });
      } catch (err) {
        setStatus(`Could not read file: ${err.message}`, "error");
        return;
      }
      showConfirmDialog(file.name, workbook, (selectedTabs) => processWorkbook(workbook, selectedTabs));
    };
    reader.readAsArrayBuffer(file);
  });

  return el;
}
