/**
 * Phones › WebRTC — Change Site
 *
 * Move phones from one site to another. Users can move all phones at
 * the source site or select specific phones via a searchable multi-select.
 *
 * Flow:
 *   1. User selects a source site ("From") and destination site ("To")
 *   2. Click "Load Phones" → fetches all phones at the source site
 *   3. Select phones via the searchable multi-select (individual, filtered, or all)
 *   4. Click "Move Selected" → PUTs each phone with the new site
 *   5. Shows summary text + optional Excel download of the log
 *
 * API endpoints:
 *   GET /api/v2/telephony/providers/edges/sites            — list sites
 *   GET /api/v2/telephony/providers/edges/phones            — list all phones
 *   PUT /api/v2/telephony/providers/edges/phones/{id}       — update phone site
 */
import { escapeHtml, sleep, exportXlsx, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";

// ── Page renderer ───────────────────────────────────────────────────

export default function renderChangeSite({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Phones — WebRTC — Change Site</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  let sites = [];
  let phonesAtSource = [];   // phones filtered to source site
  let isRunning = false;
  let cancelled = false;
  let logRows = [];

  // ── Multi-select for phones ─────────────────────────
  const phoneSelect = createMultiSelect({
    placeholder: "Load phones first…",
    searchable: true,
    onChange: (sel) => {
      $moveBtn.disabled = sel.size === 0 || isRunning;
      $moveBtn.textContent = sel.size
        ? `Move ${sel.size} Phone${sel.size > 1 ? "s" : ""}`
        : "Move Selected";
    },
  });

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Phones — WebRTC — Change Site</h1>
    <hr class="hr">

    <p class="page-desc">
      Move phones from one site to another. Load the phones at the source
      site, then select individual phones or all of them to move.
    </p>

    <!-- Site selectors -->
    <div class="cs-controls">
      <div class="cs-control-group">
        <label class="cs-label">From Site</label>
        <select class="input cs-site-select" id="csFromSite" disabled>
          <option value="">Loading sites…</option>
        </select>
      </div>
      <div class="cs-control-group">
        <label class="cs-label">To Site</label>
        <select class="input cs-site-select" id="csToSite" disabled>
          <option value="">Loading sites…</option>
        </select>
      </div>
    </div>

    <!-- Load phones button -->
    <div class="cs-actions">
      <button class="btn" id="csLoadBtn" disabled>Load Phones</button>
    </div>

    <!-- Phone selector (multi-select injected here) -->
    <div class="cs-controls" id="csPhoneWrap" style="display:none">
      <div class="cs-control-group">
        <label class="cs-label">Phones</label>
        <div id="csPhoneSlot"></div>
      </div>
    </div>

    <!-- Move button -->
    <div class="cs-actions" id="csMoveWrap" style="display:none">
      <button class="btn cs-btn-move" id="csMoveBtn" disabled>Move Selected</button>
      <button class="btn" id="csCancelBtn" style="display:none">Cancel</button>
    </div>

    <!-- Status -->
    <div class="cs-status" id="csStatus">Loading sites…</div>

    <!-- Progress bar -->
    <div class="cs-progress-wrap" id="csProgressWrap" style="display:none">
      <div class="cs-progress-bar" id="csProgressBar"></div>
    </div>

    <!-- Summary -->
    <div class="wc-summary" id="csSummary" style="display:none"></div>

    <!-- Download Excel button -->
    <div class="wc-download" id="csDownload" style="display:none">
      <button class="btn wc-btn-download" id="csDownloadBtn">Download Excel Log</button>
    </div>
  `;

  // Inject multi-select into its slot
  el.querySelector("#csPhoneSlot").append(phoneSelect.el);

  // ── DOM refs ────────────────────────────────────────
  const $fromSite     = el.querySelector("#csFromSite");
  const $toSite       = el.querySelector("#csToSite");
  const $loadBtn      = el.querySelector("#csLoadBtn");
  const $phoneWrap    = el.querySelector("#csPhoneWrap");
  const $moveWrap     = el.querySelector("#csMoveWrap");
  const $moveBtn      = el.querySelector("#csMoveBtn");
  const $cancelBtn    = el.querySelector("#csCancelBtn");
  const $status       = el.querySelector("#csStatus");
  const $progressWrap = el.querySelector("#csProgressWrap");
  const $progressBar  = el.querySelector("#csProgressBar");
  const $summary      = el.querySelector("#csSummary");
  const $download     = el.querySelector("#csDownload");
  const $downloadBtn  = el.querySelector("#csDownloadBtn");

  // ── Helpers ─────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "cs-status" + (type ? ` cs-status--${type}` : "");
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
    $moveBtn.disabled = running;
    $fromSite.disabled = running;
    $toSite.disabled = running;
    $loadBtn.disabled = running;
    phoneSelect.setEnabled(!running);
    $cancelBtn.style.display = running ? "" : "none";
  }

  // Enable load button only when both sites are selected and different
  function checkLoadReady() {
    $loadBtn.disabled = !$fromSite.value || !$toSite.value || $fromSite.value === $toSite.value;
  }
  $fromSite.addEventListener("change", () => {
    checkLoadReady();
    // Reset phone selection when source changes
    $phoneWrap.style.display = "none";
    $moveWrap.style.display = "none";
    phonesAtSource = [];
  });
  $toSite.addEventListener("change", checkLoadReady);

  // ── Load phones at source site ─────────────────────
  $loadBtn.addEventListener("click", async () => {
    const fromId = $fromSite.value;
    if (!fromId) return;

    $summary.style.display = "none";
    $download.style.display = "none";

    try {
      setStatus("Loading phones…");
      const orgId = orgContext.get();
      const allPhones = await gc.fetchAllPhones(api, orgId);

      phonesAtSource = allPhones.filter(p => p.site?.id === fromId);

      if (!phonesAtSource.length) {
        setStatus("No phones found at the selected source site.", "error");
        $phoneWrap.style.display = "none";
        $moveWrap.style.display = "none";
        return;
      }

      // Populate the multi-select
      phoneSelect.setPlaceholder("Select phones\u2026");
      phoneSelect.setItems(
        phonesAtSource.map(p => ({
          id: p.id,
          label: p.name || p.id,
        }))
      );

      $phoneWrap.style.display = "";
      $moveWrap.style.display = "";
      $moveBtn.disabled = true;
      $moveBtn.textContent = "Move Selected";
      setStatus(`Found ${phonesAtSource.length} phone${phonesAtSource.length > 1 ? "s" : ""} at source site. Select phones to move.`);
    } catch (err) {
      setStatus(`Failed to load phones: ${err.message}`, "error");
      console.error("Phone load error:", err);
    }
  });

  // ── Move selected phones ───────────────────────────
  $moveBtn.addEventListener("click", async () => {
    const selectedIds = phoneSelect.getSelected();
    if (!selectedIds.size) { setStatus("No phones selected.", "error"); return; }

    const toId = $toSite.value;
    const toSite = sites.find(s => s.id === toId);
    if (!toId || !toSite) { setStatus("Please select a destination site.", "error"); return; }

    cancelled = false;
    setRunning(true);
    logRows = [];
    $summary.style.display = "none";
    $download.style.display = "none";

    const orgId = orgContext.get();
    const fromSite = sites.find(s => s.id === $fromSite.value);
    let moved = 0, failed = 0;
    const phonesToMove = phonesAtSource.filter(p => selectedIds.has(p.id));
    const total = phonesToMove.length;

    try {
      for (let i = 0; i < total; i++) {
        if (cancelled) break;

        const phone = phonesToMove[i];
        const pct = (i / total) * 100;
        setStatus(`Moving phone ${i + 1} of ${total}… ${escapeHtml(phone.name || phone.id)}`);
        showProgress(pct);

        const now = new Date().toISOString().replace("T", " ").slice(0, 19);

        try {
          // Build updated phone body with new site
          const updatedPhone = { ...phone, site: { id: toId, name: toSite.name } };
          // Remove read-only / server-generated fields that cause 400 errors
          delete updatedPhone.status;
          delete updatedPhone.statusSummary;
          delete updatedPhone.userAgentInfo;
          delete updatedPhone.primaryEdge;
          delete updatedPhone.secondaryEdge;
          delete updatedPhone.selfUri;

          await gc.updatePhone(api, orgId, phone.id, updatedPhone);
          moved++;
          logRows.push({
            phoneName: phone.name || "—",
            phoneId: phone.id,
            fromSite: fromSite?.name || $fromSite.value,
            toSite: toSite.name,
            status: "Moved",
            timestamp: now,
          });
        } catch (err) {
          failed++;
          logRows.push({
            phoneName: phone.name || "—",
            phoneId: phone.id,
            fromSite: fromSite?.name || $fromSite.value,
            toSite: toSite.name,
            status: `Failed: ${(err.message || String(err)).slice(0, 120)}`,
            timestamp: now,
          });
        }

        // Rate limit: 50ms between PUTs
        if (i < total - 1) await sleep(50);
      }

      // Done
      showProgress(100);
      const parts = [];
      if (moved)  parts.push(`Moved: ${moved}`);
      if (failed) parts.push(`Failed: ${failed}`);

      const summaryText = cancelled
        ? `Cancelled. ${parts.join("  •  ")}`
        : parts.join("  •  ");

      setStatus(cancelled ? "Cancelled." : "Done.", failed ? "error" : "success");

      $summary.textContent = summaryText;
      $summary.style.display = "";

      if (logRows.length) $download.style.display = "";

      setTimeout(hideProgress, 800);
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      console.error("Change site error:", err);
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
      { key: "phoneName", label: "Phone Name",  wch: 30 },
      { key: "phoneId",   label: "Phone ID",    wch: 38 },
      { key: "fromSite",  label: "From Site",   wch: 22 },
      { key: "toSite",    label: "To Site",     wch: 22 },
      { key: "status",    label: "Status",      wch: 30 },
      { key: "timestamp", label: "Timestamp",   wch: 20 },
    ];

    const wb = XLSX.utils.book_new();
    const headerRow = columns.map(c => c.label);
    const dataRows = logRows.map(r => columns.map(c => r[c.key] ?? ""));
    const allRows = [headerRow, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    // Column widths
    ws["!cols"] = columns.map(c => ({ wch: c.wch || 15 }));

    // Style header row
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
      if (val.startsWith("moved")) {
        ws[cellRef].s = { font: { color: { rgb: "16A34A" }, bold: true } };
      } else if (val.startsWith("failed")) {
        ws[cellRef].s = { font: { color: { rgb: "DC2626" }, bold: true } };
      }
    }

    // Auto-filter
    ws["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: logRows.length, c: columns.length - 1 },
      }),
    };

    XLSX.utils.book_append_sheet(wb, ws, "Phone Site Changes");

    const orgName = org.name || orgContext.get();
    const filename = timestampedFilename(`Phone_Site_Changes_${orgName}`, "xlsx");
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

      const siteOptions = `<option value="">— Select a site —</option>`
        + sites.map(s =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
        ).join("");

      $fromSite.innerHTML = siteOptions;
      $toSite.innerHTML = siteOptions;

      $fromSite.disabled = false;
      $toSite.disabled = false;
      setStatus("Ready. Select source and destination sites, then load phones.");
    } catch (err) {
      setStatus(`Failed to load sites: ${err.message}`, "error");
      console.error("Site load error:", err);
    }
  })();

  return el;
}
