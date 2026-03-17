/**
 * Export › Users — Trustee
 *
 * Exports a matrix showing which trustee-org users have access to which
 * customer orgs. Access is determined by group membership:
 *
 * Flow:
 *   1. Iterate every customer org via the proxy backend
 *   2. GET /api/v2/orgauthorization/trustees → find YOUR trustee orgs
 *   3. GET /api/v2/orgauthorization/trustees/{id}/groups → granted groups
 *   4. Authenticate to the trustee org (Demo / Test IE) and
 *      GET /api/v2/groups/{groupId}/members → actual users in each group
 *   5. Build a matrix: users × customer orgs → True / False
 *   6. Display as HTML table + downloadable Excel
 *
 * API endpoints:
 *   GET /api/v2/orgauthorization/trustees
 *   GET /api/v2/orgauthorization/trustees/{id}/groups
 *   GET /api/v2/groups/{groupId}/members
 *   GET /api/v2/users/{id}
 */
import { escapeHtml, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { fetchCustomers } from "../../../services/customerService.js";
import { sendEmail, validateRecipients } from "../../../services/emailService.js";
import { createSchedulePanel } from "../../../components/schedulePanel.js";
import { attachColumnFilters } from "../../../utils/columnFilter.js";
import { STYLE_HEADER, STYLE_ROW_EVEN, STYLE_ROW_ODD } from "../../../utils/excelStyles.js";
import { logAction } from "../../../services/activityLogService.js";

// ── Automation: set to false to hide the schedule panel on this page ─
const AUTOMATION_ENABLED = true;
const AUTOMATION_EXPORT_TYPE = "trustee";
const AUTOMATION_EXPORT_LABEL = "Trustee Access Matrix";

// ── Known trustee org name variations → our internal customer id ────
const TRUSTEE_NAME_MAP = {
  "Netdesign DE": "demo",
  "NetDesign DE": "demo",
  "netdesign de": "demo",
  "Netdesign":    "test-ie",
  "NetDesign":    "test-ie",
  "netdesign":    "test-ie",
};

// ── Trustee org display name → Excel sheet name suffix ──────────────
const TRUSTEE_SHEET_SUFFIX = {
  "Netdesign DE": "DE",
  "Netdesign":    "IE",
};

/** Normalise a trustee org name for display. */
function normaliseTrusteeOrg(name) {
  const lower = (name || "").toLowerCase();
  if (lower.includes("netdesign de")) return "Netdesign DE";
  if (lower === "netdesign") return "Netdesign";
  return name;
}

/** Get Excel sheet name for a trustee org (matches Python format). */
function getTrusteeSheetName(trusteeOrg) {
  const suffix = TRUSTEE_SHEET_SUFFIX[trusteeOrg] || trusteeOrg;
  return `Trustee Org - ${suffix}`;
}

// ── Trustee-specific boolean cell styles ────────────────────────────────────
// STYLE_HEADER, STYLE_ROW_EVEN, STYLE_ROW_ODD come from the shared excelStyles module.
const STYLE_TRUE = {
  fill:      { fgColor: { rgb: "C6EFCE" } },
  font:      { color: { rgb: "006100" } },
  alignment: { horizontal: "center", vertical: "center" },
};

const STYLE_FALSE = {
  fill:      { fgColor: { rgb: "FFC7CE" } },
  font:      { color: { rgb: "9C0006" } },
  alignment: { horizontal: "center", vertical: "center" },
};

/**
 * Build a styled XLSX workbook matching the Python trustee export format.
 *
 * @param {Object} byTrusteeOrg  { "Netdesign DE": [{ name, email, orgs }] }
 * @param {string[]} customerNames  Sorted list of all customer org names.
 * @returns {Object} XLSX workbook object.
 */
function buildTrusteeWorkbook(byTrusteeOrg, customerNames) {
  const wb = XLSX.utils.book_new();

  for (const trusteeOrg of Object.keys(byTrusteeOrg).sort()) {
    const users = byTrusteeOrg[trusteeOrg].sort((a, b) => a.name.localeCompare(b.name));

    // Only include org columns where at least one user has access
    const activeCols = customerNames.filter(cn => users.some(u => u.orgs[cn]));

    // Build header row
    const headers = ["Name", "Email", ...activeCols];

    // Build data rows
    const rows = users.map(u => {
      const row = [u.name, u.email];
      for (const cn of activeCols) row.push(u.orgs[cn] === true);
      return row;
    });

    // Create worksheet from array of arrays (header + data)
    const wsData = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // ── Apply header styles ────────────────────────────────────
    for (let c = 0; c < headers.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = STYLE_HEADER;
    }

    // ── Apply data cell styles ───────────────────────────────────
    for (let r = 0; r < rows.length; r++) {
      const rowStyle = r % 2 === 0 ? STYLE_ROW_EVEN : STYLE_ROW_ODD;
      for (let c = 0; c < headers.length; c++) {
        const addr = XLSX.utils.encode_cell({ r: r + 1, c });
        if (!ws[addr]) continue;
        if (c < 2) {
          // Name and Email: shared alternating row style
          ws[addr].s = rowStyle;
        } else {
          // Boolean org-access columns: green (true) or red (false)
          ws[addr].s = ws[addr].v === true ? STYLE_TRUE : STYLE_FALSE;
        }
      }
    }

    // ── Auto-adjust column widths (text length + 2, max 50) ──
    const colWidths = headers.map((h, i) => {
      let maxLen = h.length;
      for (const row of rows) {
        const val = String(row[i] ?? "");
        if (val.length > maxLen) maxLen = val.length;
      }
      return { wch: Math.min(maxLen + 2, 50) };
    });
    ws["!cols"] = colWidths;

    // ── Freeze panes: header row + first two columns (C2) ──
    ws["!views"] = [{ state: "frozen", xSplit: 2, ySplit: 1 }];

    // ── Auto-filter on header row ──
    ws["!autofilter"] = { ref: ws["!ref"] };

    // Sheet name: "Trustee Org - DE" / "Trustee Org - IE"
    XLSX.utils.book_append_sheet(wb, ws, getTrusteeSheetName(trusteeOrg).slice(0, 31));
  }

  return wb;
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderTrusteeExport({ route, me, api }) {
  const el = document.createElement("section");
  el.className = "card";

  // ── State ─────────────────────────────────────────────
  let isRunning = false;
  let cancelled = false;

  // ── Build UI ──────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Export — Users — Trustee</h1>
    <hr class="hr">
    <p class="page-desc">
      Exports a matrix of trustee-org users and their access to each customer
      org. Access is determined by the groups granted to your trustee orgs
      (Netdesign DE / Netdesign) in each customer org.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="teExportBtn">Export Trustee Access</button>
      <button class="btn te-btn-cancel" id="teCancelBtn" style="display:none">Cancel</button>
    </div>

    <div class="te-status" id="teStatus"></div>

    <div class="te-progress-wrap" id="teProgressWrap" style="display:none">
      <div class="te-progress-bar" id="teProgressBar"></div>
    </div>

    <div id="teTableWrap" style="display:none"></div>

    <div class="wc-summary" id="teSummary" style="display:none"></div>

    <div id="teDownload" style="display:none">
      <button class="btn te-btn-export" id="teDownloadBtn">Download Excel</button>
    </div>

    <div class="em-section">
      <label class="em-toggle">
        <input type="checkbox" id="teEmailChk">
        <span>Send email with export</span>
      </label>

      <div class="em-fields" id="teEmailFields" style="display:none">
        <div class="em-field">
          <label class="em-label" for="teEmailTo">Recipients</label>
          <input type="text" class="em-input" id="teEmailTo"
                 placeholder="user@example.com, user2@example.com">
          <span class="em-hint">Separate multiple addresses with , or ;</span>
        </div>
        <div class="em-field">
          <label class="em-label" for="teEmailBody">Message (optional)</label>
          <textarea class="em-textarea" id="teEmailBody" rows="3"
                    placeholder="Leave empty for default message"></textarea>
        </div>
      </div>
    </div>`;

  // ── DOM refs ──────────────────────────────────────────
  const $exportBtn   = el.querySelector("#teExportBtn");
  const $cancelBtn   = el.querySelector("#teCancelBtn");
  const $status      = el.querySelector("#teStatus");
  const $progressW   = el.querySelector("#teProgressWrap");
  const $progressBar = el.querySelector("#teProgressBar");
  const $tableWrap   = el.querySelector("#teTableWrap");
  const $summary     = el.querySelector("#teSummary");
  const $download    = el.querySelector("#teDownload");
  const $downloadBtn = el.querySelector("#teDownloadBtn");
  const $emailChk    = el.querySelector("#teEmailChk");
  const $emailFields = el.querySelector("#teEmailFields");
  const $emailTo     = el.querySelector("#teEmailTo");
  const $emailBody   = el.querySelector("#teEmailBody");

  // Toggle email fields visibility
  $emailChk.addEventListener("change", () => {
    $emailFields.style.display = $emailChk.checked ? "" : "none";
  });

  // ── Automation panel ──────────────────────────────────
  if (AUTOMATION_ENABLED) {
    const schedulePanel = createSchedulePanel({
      exportType: AUTOMATION_EXPORT_TYPE,
      exportLabel: AUTOMATION_EXPORT_LABEL,
      me,
    });
    el.appendChild(schedulePanel);
  }

  // ── Helpers ───────────────────────────────────────────
  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "te-status" + (type ? ` te-status--${type}` : "");
  }
  function showProgress(pct) {
    $progressW.style.display = "";
    $progressBar.style.width = `${pct}%`;
  }

  /** Build and trigger Excel download (styled). */
  function downloadExcel(byTrusteeOrg, customerNames) {
    const wb = buildTrusteeWorkbook(byTrusteeOrg, customerNames);
    if (!wb.SheetNames.length) return;

    const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
    const filename = timestampedFilename("trustee_export", "xlsx");
    const key = "xlsx_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    window._xlsxDownload = window._xlsxDownload || {};
    window._xlsxDownload[key] = { filename, b64 };
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = key;
    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) {
      delete window._xlsxDownload[key];
      throw new Error("Pop-up blocked. Please allow pop-ups for this site and try again.");
    }
  }

  // ── Export logic ──────────────────────────────────────
  $exportBtn.addEventListener("click", async () => {
    if (isRunning) return;
    isRunning = true;
    cancelled = false;
    $exportBtn.disabled = true;
    $cancelBtn.style.display = "";
    $tableWrap.style.display = "none";
    $tableWrap.innerHTML = "";
    $summary.style.display = "none";
    $download.style.display = "none";

    // Data: { (trusteeOrgDisplay, email) → { name, email, trusteeOrg, orgs: { orgName: true } } }
    const usersMap = new Map();

    try {
      // 1. Load all customers
      setStatus("Loading customer list…");
      const customers = await fetchCustomers();
      const totalOrgs = customers.length;

      // 2. Process all customer orgs in parallel
      setStatus(`Processing ${totalOrgs} orgs in parallel…`);
      showProgress(10);

      const orgResults = await Promise.allSettled(
        customers.map(async (cust) => {
          const localMap = new Map();

          const trustees = await gc.fetchTrustees(api, cust.id);

          await Promise.allSettled(trustees.map(async (trustee) => {
            const trusteeOrgName = trustee.organization?.name;
            if (!trusteeOrgName) return;
            const trusteeCustomerId = TRUSTEE_NAME_MAP[trusteeOrgName];
            if (!trusteeCustomerId) return;
            const displayName = normaliseTrusteeOrg(trusteeOrgName);
            const trusteeId = trustee.id;
            if (!trusteeId) return;

            let groups = [];
            try {
              groups = await gc.fetchTrusteeGroups(api, cust.id, trusteeId);
            } catch (err) {
              console.warn(`Failed to get trustee groups for ${cust.name}:`, err);
              return;
            }

            await Promise.allSettled(groups.map(async (group) => {
              const groupId = group.id;
              if (!groupId) return;

              let members = [];
              try {
                members = await gc.fetchGroupMembers(api, trusteeCustomerId, groupId);
              } catch (err) {
                console.warn(`Failed to get group members for group ${groupId}:`, err);
                return;
              }

              const resolved = await Promise.allSettled(members.map(async (member) => {
                let userName = member.name || null;
                let userEmail = member.email || null;
                if (!userName || !userEmail) {
                  try {
                    const full = await gc.getUser(api, trusteeCustomerId, member.id);
                    userName = userName || full.name;
                    userEmail = userEmail || full.email;
                  } catch (_) { /* best effort */ }
                }
                return { name: userName || "Unknown", email: userEmail || "N/A" };
              }));

              for (const r of resolved) {
                if (r.status !== "fulfilled") continue;
                const { name: userName, email: userEmail } = r.value;
                const key = `${displayName}||${userEmail}`;
                if (!localMap.has(key)) {
                  localMap.set(key, { trusteeOrg: displayName, name: userName, email: userEmail, orgs: {} });
                }
                localMap.get(key).orgs[cust.name] = true;
              }
            }));
          }));

          return { custName: cust.name, localMap };
        })
      );

      if (cancelled) {
        setStatus("Cancelled.", "error");
        isRunning = false;
        $exportBtn.disabled = false;
        $cancelBtn.style.display = "none";
        return;
      }

      // Merge all per-org results into usersMap
      for (const result of orgResults) {
        if (result.status !== "fulfilled") {
          console.error("Error processing an org:", result.reason);
          continue;
        }
        for (const [key, entry] of result.value.localMap.entries()) {
          if (!usersMap.has(key)) {
            usersMap.set(key, { trusteeOrg: entry.trusteeOrg, name: entry.name, email: entry.email, orgs: {} });
          }
          Object.assign(usersMap.get(key).orgs, entry.orgs);
        }
      }

      // 3. Build results
      showProgress(100);

      const allUsers = Array.from(usersMap.values());

      if (!allUsers.length) {
        setStatus("No trustee access data found.", "error");
        isRunning = false;
        $exportBtn.disabled = false;
        $cancelBtn.style.display = "none";
        return;
      }

      // Group by trustee org
      const byTrusteeOrg = {};
      for (const u of allUsers) {
        if (!byTrusteeOrg[u.trusteeOrg]) byTrusteeOrg[u.trusteeOrg] = [];
        byTrusteeOrg[u.trusteeOrg].push(u);
      }

      // Get all customer org names that appear
      const customerNames = customers.map(c => c.name).sort();

      // 4. Build HTML table(s)
      let html = "";
      for (const trusteeOrg of Object.keys(byTrusteeOrg).sort()) {
        const users = byTrusteeOrg[trusteeOrg].sort((a, b) => a.name.localeCompare(b.name));

        // Only show org columns where at least one user has access
        const activeCols = customerNames.filter(cn =>
          users.some(u => u.orgs[cn])
        );

        html += `<details class="te-details">`;
        html += `<summary class="te-sheet-title">${escapeHtml(trusteeOrg)} <span class="te-user-count">${users.length} users</span></summary>`;
        html += `<div class="te-table-scroll"><table class="te-table data-table ll-preview-table">`;
        html += `<thead><tr><th>Name</th><th>Email</th>`;
        for (const cn of activeCols) {
          html += `<th>${escapeHtml(cn)}</th>`;
        }
        html += `</tr>`;
        html += `<tr class="ll-filter-row"><th></th><th></th>`;
        for (const cn of activeCols) html += `<th></th>`;
        html += `</tr></thead><tbody>`;

        for (const u of users) {
          html += `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td>`;
          for (const cn of activeCols) {
            const has = u.orgs[cn] === true;
            html += `<td class="te-cell-${has ? "yes" : "no"}">${has ? "✓" : "✗"}</td>`;
          }
          html += `</tr>`;
        }
        html += `</tbody></table></div></details>`;
      }

      $tableWrap.innerHTML = html;

      // Attach dropdown filters for Name + Email columns on each trustee-org block
      $tableWrap.querySelectorAll(".te-details").forEach(detailsEl => {
        const countEl = detailsEl.querySelector(".te-user-count");
        attachColumnFilters(detailsEl, { countEl, totalLabel: "users" });
      });
      $tableWrap.style.display = "";

      $summary.textContent = `Users: ${allUsers.length}  •  Orgs scanned: ${totalOrgs}  •  Trustee orgs: ${Object.keys(byTrusteeOrg).length}`;
      $summary.style.display = "";

      // 5. Show download button
      $download.style.display = "";
      $downloadBtn.onclick = () => downloadExcel(byTrusteeOrg, customerNames);
      logAction({ me, action: "export_run",
        description: `Exported '${AUTOMATION_EXPORT_LABEL}'` });

      // 6. Send email if enabled
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          // Build the styled Excel as base64 for attachment
          const wb2 = buildTrusteeWorkbook(byTrusteeOrg, customerNames);
          const xlsxB64 = XLSX.write(wb2, { bookType: "xlsx", type: "base64" });
          const xlsxName = timestampedFilename("trustee_export", "xlsx");

          const result = await sendEmail(api, {
            recipients: $emailTo.value,
            subject: `Trustee Export — ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
            body: $emailBody.value,
            attachment: {
              filename: xlsxName,
              base64: xlsxB64,
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          });

          if (result.success) {
            setStatus(`Done. Email sent to: ${$emailTo.value.trim()}`, "success");
          } else {
            setStatus(`Export completed but email failed: ${result.error}`, "error");
          }
        } catch (emailErr) {
          setStatus(`Export completed but email failed: ${emailErr.message}`, "error");
        }
      } else {
        setStatus("Done.", "success");
      }

    } catch (err) {
      setStatus(`Export failed: ${err.message}`, "error");
      console.error("Trustee export error:", err);
    } finally {
      isRunning = false;
      $exportBtn.disabled = false;
      $cancelBtn.style.display = "none";
    }
  });

  // Cancel button
  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    $cancelBtn.style.display = "none";
    setStatus("Cancelling…");
  });

  return el;
}
