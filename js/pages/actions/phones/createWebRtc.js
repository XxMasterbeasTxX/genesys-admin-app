/**
 * Phones › WebRTC — Create
 *
 * Bulk-creates WebRTC phones for all non-collaborate licensed users
 * in the selected org + site.
 *
 * Flow:
 *   1. User selects a site from the dropdown
 *   2. Script discovers WebRTC phone base settings automatically
 *   3. Iterates all licensed users, skipping collaborate-only
 *   4. Creates a WebRTC phone per user (skips if one already exists)
 *   5. Shows summary text + optional Excel download of the log
 *
 * API endpoints:
 *   GET  /api/v2/telephony/providers/edges/sites
 *   GET  /api/v2/telephony/providers/edges/phonebasesettings
 *   GET  /api/v2/telephony/providers/edges/phonebasesettings/{id}
 *   GET  /api/v2/license/users
 *   GET  /api/v2/users/{id}
 *   POST /api/v2/telephony/providers/edges/phones
 *   GET  /api/v2/authorization/divisions
 */
import { escapeHtml, formatDateTime, sleep, exportXlsx, timestampedFilename } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";

// ── Page renderer ───────────────────────────────────────────────────

export default function renderWebRtcCreate({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Phones — WebRTC — Create</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  let sites = [];
  let isRunning = false;
  let cancelled = false;
  let logRows = [];   // full log for Excel export

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Phones — WebRTC — Create</h1>
    <hr class="hr">

    <p class="wc-desc">
      Creates WebRTC phones for all users in the organization. Users with a
      <strong>collaborate</strong>-only license are automatically skipped.
      Users who already have a WebRTC phone are also skipped.
    </p>

    <!-- Site selector -->
    <div class="wc-controls">
      <div class="wc-control-group">
        <label class="wc-label">Site</label>
        <select class="input wc-site-select" id="wcSite" disabled>
          <option value="">Loading sites…</option>
        </select>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="wc-actions">
      <button class="btn wc-btn-run" id="wcRunBtn" disabled>Create WebRTC Phones</button>
      <button class="btn" id="wcCancelBtn" style="display:none">Cancel</button>
    </div>

    <!-- Status -->
    <div class="wc-status" id="wcStatus">Loading sites…</div>

    <!-- Progress bar -->
    <div class="wc-progress-wrap" id="wcProgressWrap" style="display:none">
      <div class="wc-progress-bar" id="wcProgressBar"></div>
    </div>

    <!-- Summary (hidden until job finishes) -->
    <div class="wc-summary" id="wcSummary" style="display:none"></div>

    <!-- Download Excel button (hidden until job finishes) -->
    <div class="wc-download" id="wcDownload" style="display:none">
      <button class="btn wc-btn-download" id="wcDownloadBtn">Download Excel Log</button>
    </div>
  `;

  // ── DOM refs ────────────────────────────────────────
  const $site       = el.querySelector("#wcSite");
  const $runBtn     = el.querySelector("#wcRunBtn");
  const $cancelBtn  = el.querySelector("#wcCancelBtn");
  const $status     = el.querySelector("#wcStatus");
  const $progressWrap = el.querySelector("#wcProgressWrap");
  const $progressBar  = el.querySelector("#wcProgressBar");
  const $summary    = el.querySelector("#wcSummary");
  const $download   = el.querySelector("#wcDownload");
  const $downloadBtn = el.querySelector("#wcDownloadBtn");

  // ── Helpers ─────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "wc-status" + (type ? ` wc-status--${type}` : "");
  }
  function showProgress(pct) {
    $progressWrap.style.display = "";
    $progressBar.style.width = `${Math.min(pct, 100)}%`;
  }
  function hideProgress() {
    $progressWrap.style.display = "none";
    $progressBar.style.width = "0%";
  }
  function setRunning(running) {
    isRunning = running;
    $runBtn.disabled = running;
    $site.disabled = running;
    $cancelBtn.style.display = running ? "" : "none";
  }

  // ── Find WebRTC phone base settings ────────────────
  async function findWebRtcBase(orgId) {
    const bases = await gc.fetchAllPhoneBaseSettings(api, orgId);
    const webrtcBase = bases.find(b => b.name?.toLowerCase().includes("webrtc"));
    if (!webrtcBase) return null;

    // Get the full base setting (includes lines array)
    const full = await gc.getPhoneBaseSetting(api, orgId, webrtcBase.id);
    const lineBaseId = full.lines?.[0]?.id ?? null;

    return { phoneBaseSettingsId: webrtcBase.id, lineBaseSettingsId: lineBaseId };
  }

  // ── Build divisions lookup ─────────────────────────
  async function buildDivisionMap(orgId) {
    const divs = await gc.fetchAllDivisions(api, orgId);
    const map = {};
    for (const d of divs) map[d.id] = d.name;
    return map;
  }

  // ── Core: create phones ────────────────────────────
  $runBtn.addEventListener("click", async () => {
    const siteId = $site.value;
    if (!siteId) { setStatus("Please select a site.", "error"); return; }

    cancelled = false;
    setRunning(true);
    logRows = [];
    $summary.style.display = "none";
    $download.style.display = "none";

    const orgId = orgContext.get();
    let created = 0, skippedExists = 0, skippedLicense = 0, failed = 0;

    try {
      // Step 1 — Discover WebRTC phone base settings
      setStatus("Discovering WebRTC phone base settings…");
      showProgress(2);

      const base = await findWebRtcBase(orgId);
      if (!base) {
        setStatus("No WebRTC phone base settings found in this org.", "error");
        setRunning(false);
        hideProgress();
        return;
      }
      if (!base.lineBaseSettingsId) {
        setStatus("WebRTC phone base has no line base settings configured.", "error");
        setRunning(false);
        hideProgress();
        return;
      }

      // Step 2 — Load divisions map
      setStatus("Loading divisions…");
      showProgress(5);
      const divMap = await buildDivisionMap(orgId);

      // Step 3 — Fetch all licensed users
      setStatus("Fetching licensed users…");
      showProgress(8);
      const licUsers = await gc.fetchAllLicenseUsers(api, orgId, {
        onProgress: (n) => showProgress(8 + Math.min(n / 100, 2)),
      });

      if (!licUsers.length) {
        setStatus("No licensed users found.", "error");
        setRunning(false);
        hideProgress();
        return;
      }

      if (cancelled) { setStatus("Cancelled."); setRunning(false); hideProgress(); return; }

      // Step 4 — Process each user
      const totalUsers = licUsers.length;

      for (let i = 0; i < totalUsers; i++) {
        if (cancelled) break;

        const lu = licUsers[i];
        const pct = 10 + (i / totalUsers) * 89;
        setStatus(`Processing user ${i + 1} of ${totalUsers}…`);
        showProgress(pct);

        const now = new Date().toISOString().replace("T", " ").slice(0, 19);

        // Check for collaborate-only license
        const licenses = (lu.licenses || []).map(l => l.name || l.id || "").join(", ");
        if (licenses.toLowerCase().includes("collaborate")) {
          skippedLicense++;
          logRows.push({
            division: divMap[lu.division?.id] || lu.division?.id || "—",
            userId: lu.id,
            name: lu.name || "—",
            email: lu.email || "—",
            licenses,
            status: "Skipped (collaborate)",
            timestamp: now,
          });
          continue;
        }

        // Fetch user details for name/email if not on licUser object
        let userName = lu.name || lu.username || "";
        let userEmail = lu.email || "";
        let userDivision = divMap[lu.division?.id] || lu.division?.id || "—";

        if (!userName) {
          try {
            const usr = await api.proxyGenesys(orgId, "GET", `/api/v2/users/${lu.id}`);
            userName = usr.name || usr.username || lu.id;
            userEmail = usr.email || "";
            if (usr.division?.id) userDivision = divMap[usr.division.id] || usr.division.id;
          } catch {
            userName = lu.id;
          }
        }

        // Attempt to create phone
        try {
          await gc.createPhone(api, orgId, {
            name: `${userName} - WebRTC`,
            site: { id: siteId },
            phoneBaseSettings: { id: base.phoneBaseSettingsId },
            lines: [{ lineBaseSettings: { id: base.lineBaseSettingsId } }],
            webRtcUser: { id: lu.id, type: "USER" },
            owner: { id: lu.id, type: "USER" },
          });

          created++;
          logRows.push({
            division: userDivision,
            userId: lu.id,
            name: userName,
            email: userEmail,
            licenses,
            status: "Created",
            timestamp: now,
          });
        } catch (err) {
          const msg = err.message || String(err);
          if (msg.toLowerCase().includes("already been assigned") ||
              msg.toLowerCase().includes("already exists") ||
              msg.includes("409") || msg.includes("400")) {
            skippedExists++;
            logRows.push({
              division: userDivision,
              userId: lu.id,
              name: userName,
              email: userEmail,
              licenses,
              status: "Skipped (already exists)",
              timestamp: now,
            });
          } else {
            failed++;
            logRows.push({
              division: userDivision,
              userId: lu.id,
              name: userName,
              email: userEmail,
              licenses,
              status: `Failed: ${msg.slice(0, 120)}`,
              timestamp: now,
            });
          }
        }

        // Rate limit: 50ms between creates
        if (i < totalUsers - 1) await sleep(50);
      }

      // Done
      showProgress(100);
      const parts = [];
      if (created)        parts.push(`Created: ${created}`);
      if (skippedExists)  parts.push(`Already existed: ${skippedExists}`);
      if (skippedLicense)  parts.push(`Skipped (collaborate): ${skippedLicense}`);
      if (failed)         parts.push(`Failed: ${failed}`);

      const summaryText = cancelled
        ? `Cancelled. ${parts.join("  •  ")}`
        : parts.join("  •  ");

      setStatus(cancelled ? "Cancelled." : "Done.", failed ? "error" : "success");

      // Show summary
      $summary.textContent = summaryText;
      $summary.style.display = "";

      // Show download button if there are log rows
      if (logRows.length) $download.style.display = "";

      setTimeout(hideProgress, 800);
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      console.error("WebRTC create error:", err);
      hideProgress();
    } finally {
      setRunning(false);
    }
  });

  // ── Cancel ──────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  // ── Download Excel ─────────────────────────────────
  $downloadBtn.addEventListener("click", () => {
    if (!logRows.length) return;

    const columns = [
      { key: "division",  label: "Division",      wch: 22 },
      { key: "userId",    label: "User ID",        wch: 38 },
      { key: "name",      label: "Name",           wch: 28 },
      { key: "email",     label: "Email",          wch: 32 },
      { key: "licenses",  label: "Licenses",       wch: 30 },
      { key: "status",    label: "Status",         wch: 30 },
      { key: "timestamp", label: "Timestamp",      wch: 20 },
    ];

    // Build styled workbook
    const wb = XLSX.utils.book_new();

    // Header data
    const headerRow = columns.map(c => c.label);
    const dataRows = logRows.map(r => columns.map(c => r[c.key] ?? ""));
    const allRows = [headerRow, ...dataRows];

    const ws = XLSX.utils.aoa_to_sheet(allRows);

    // Column widths
    ws["!cols"] = columns.map(c => ({ wch: c.wch || 15 }));

    // Style header row (bold + blue background)
    const headerStyle = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "3B82F6" } },
      alignment: { horizontal: "center" },
    };
    for (let c = 0; c < columns.length; c++) {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[cellRef]) ws[cellRef].s = headerStyle;
    }

    // Colour-code status column
    const statusCol = columns.findIndex(c => c.key === "status");
    for (let r = 1; r <= logRows.length; r++) {
      const cellRef = XLSX.utils.encode_cell({ r, c: statusCol });
      if (!ws[cellRef]) continue;
      const val = String(ws[cellRef].v || "").toLowerCase();
      if (val.startsWith("created")) {
        ws[cellRef].s = { font: { color: { rgb: "16A34A" }, bold: true } };
      } else if (val.startsWith("failed")) {
        ws[cellRef].s = { font: { color: { rgb: "DC2626" }, bold: true } };
      } else if (val.startsWith("skipped")) {
        ws[cellRef].s = { font: { color: { rgb: "D97706" } } };
      }
    }

    // Auto-filter
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: logRows.length, c: columns.length - 1 } }) };

    XLSX.utils.book_append_sheet(wb, ws, "WebRTC Phones");

    // Encode and download
    const orgName = org.name || orgContext.get();
    const filename = timestampedFilename(`WebRTC_Phones_${orgName}`, "xlsx");
    const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = encodeURIComponent(filename) + "|" + b64;

    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) {
      alert("Pop-up blocked. Please allow pop-ups for this site and try again.");
    }
  });

  // ── Load sites on mount ────────────────────────────
  (async () => {
    try {
      sites = await gc.fetchAllSites(api, orgContext.get());
      sites.sort((a, b) => a.name.localeCompare(b.name));

      $site.innerHTML = `<option value="">— Select a site —</option>`
        + sites.map(s =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
        ).join("");

      $site.disabled = false;
      $runBtn.disabled = false;
      setStatus("Ready. Select a site and click Create.");
    } catch (err) {
      setStatus(`Failed to load sites: ${err.message}`, "error");
      console.error("Site load error:", err);
    }
  })();

  return el;
}
