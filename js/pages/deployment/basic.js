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
  "DID Pools":         processDIDPools,
  "Divisions":         processDivisions,
  "Sites":             processSites,
  "Skills":            processSkills,
  "Skills - Language": processLanguages,
};

// ── Tab: Sites ──────────────────────────────────────────────────────────────
// Columns: A=Name (req), B=Media Model (req: Cloud|Premises), C=Media Regions (Cloud only, comma-sep),
//          D=Location Name (req), E=TURN Relay (opt: Site|Geo, default=Site), F=Description (opt)
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
    const description  = String(row[5] || "").trim();

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
      ...(description && { description }),
    };

    try {
      const result = await gc.createSite(api, orgId, body);
      // mediaRegionsUseLatencyBased is ignored on POST — apply via PUT using full GET response
      if (result?.id && turnRelay !== "AnyMediaRegionForSite") {
        const current = await gc.getSite(api, orgId, result.id);
        await gc.updateSite(api, orgId, result.id, { ...current, mediaRegionsUseLatencyBased: true });
      }
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
