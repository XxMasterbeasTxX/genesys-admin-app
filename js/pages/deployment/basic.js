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
  "Site - Number Plans":    processNumberPlans,
  "Site - Outbound Routes": processOutboundRoutes,
  "Sites":                  processSites,
  "Skills":            processSkills,
  "Skills - Language": processLanguages,
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
      const existingNotInSheet = existing.filter(p => !sheetByName.has(p.name.toLowerCase()));
      const merged = [...existingNotInSheet, ...plans];

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

    <ul class="ddt-results" id="dbResults" style="list-style:none;padding:0;margin-top:12px"></ul>
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
      ? `<span style="color:#4ade80">✓</span> <strong>${escapeHtml(label)}</strong>`
      : `<span style="color:#f87171">✗</span> <strong>${escapeHtml(label)}</strong> — ${escapeHtml(detail)}`;
    $results.appendChild(li);
  }

  function addSectionHeader(tabName) {
    const li = document.createElement("li");
    li.style.cssText = "padding:6px 0 2px;font-weight:600;color:var(--accent,#60a5fa)";
    li.textContent = tabName;
    $results.appendChild(li);
  }

  async function processWorkbook(workbook) {
    const orgId = orgContext.get();
    if (!orgId) { setStatus("Please select a customer org first.", "error"); return; }

    $results.innerHTML = "";
    $selectBtn.disabled = true;

    const sheets = workbook.SheetNames;
    const supported   = sheets.filter(n => TAB_HANDLERS[n]);
    const unsupported = sheets.filter(n => !TAB_HANDLERS[n]);

    if (!supported.length) {
      setStatus(
        `No supported tabs found. Recognised tab names: ${Object.keys(TAB_HANDLERS).join(", ")}.`,
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
      processWorkbook(workbook);
    };
    reader.readAsArrayBuffer(file);
  });

  return el;
}
