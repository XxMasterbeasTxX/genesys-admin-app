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
import { escapeHtml, exportXlsx, timestampedFilename } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { fetchCustomers } from "../../../services/customerService.js";
import { sendEmail, validateRecipients } from "../../../services/emailService.js";

// ── Known trustee org name variations → our internal customer id ────
const TRUSTEE_NAME_MAP = {
  "Netdesign DE": "demo",
  "NetDesign DE": "demo",
  "netdesign de": "demo",
  "Netdesign":    "test-ie",
  "NetDesign":    "test-ie",
  "netdesign":    "test-ie",
};

/** Normalise a trustee org name for display. */
function normaliseTrusteeOrg(name) {
  const lower = (name || "").toLowerCase();
  if (lower.includes("netdesign de")) return "Netdesign DE";
  if (lower === "netdesign") return "Netdesign";
  return name;
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

  // ── Helpers ───────────────────────────────────────────
  function setStatus(msg, type) {
    $status.textContent = msg;
    $status.className = "te-status" + (type ? ` te-status--${type}` : "");
  }
  function showProgress(pct) {
    $progressW.style.display = "";
    $progressBar.style.width = `${pct}%`;
  }

  /** Build and trigger Excel download. */
  function downloadExcel(byTrusteeOrg, customerNames) {
    const sheets = [];
    for (const trusteeOrg of Object.keys(byTrusteeOrg).sort()) {
      const users = byTrusteeOrg[trusteeOrg].sort((a, b) => a.name.localeCompare(b.name));
      const activeCols = customerNames.filter(cn => users.some(u => u.orgs[cn]));

      const rows = users.map(u => {
        const row = { Name: u.name, Email: u.email };
        for (const cn of activeCols) {
          row[cn] = u.orgs[cn] === true;
        }
        return row;
      });

      sheets.push({ name: trusteeOrg.slice(0, 31), rows });
    }

    if (sheets.length === 0) return;

    const wb = XLSX.utils.book_new();
    for (const sheet of sheets) {
      const ws = XLSX.utils.json_to_sheet(sheet.rows);
      const colCount = Object.keys(sheet.rows[0] || {}).length;
      ws["!cols"] = Array.from({ length: colCount }, (_, i) => ({
        wch: i < 2 ? 25 : 14,
      }));
      XLSX.utils.book_append_sheet(wb, ws, sheet.name);
    }

    const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
    const filename = timestampedFilename("trustee_export", "xlsx");
    const helperUrl = new URL("download.html", document.baseURI);
    helperUrl.hash = encodeURIComponent(filename) + "|" + b64;

    const popup = window.open(helperUrl.href, "_blank");
    if (!popup) {
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
    let processedOrgs = 0;

    try {
      // 1. Load all customers
      setStatus("Loading customer list…");
      const customers = await fetchCustomers();
      const totalOrgs = customers.length;

      // 2. Process each customer org
      for (const cust of customers) {
        if (cancelled) break;

        processedOrgs++;
        setStatus(`Processing ${processedOrgs}/${totalOrgs}: ${cust.name}…`);
        showProgress((processedOrgs / totalOrgs) * 100);

        try {
          // 2a. Get trustees for this customer org
          const trustees = await gc.fetchTrustees(api, cust.id);

          for (const trustee of trustees) {
            if (cancelled) break;
            const trusteeOrgName = trustee.organization?.name;
            if (!trusteeOrgName) continue;

            // Check if this is one of OUR trustee orgs
            const trusteeCustomerId = TRUSTEE_NAME_MAP[trusteeOrgName];
            if (!trusteeCustomerId) continue;

            const displayName = normaliseTrusteeOrg(trusteeOrgName);
            const trusteeId = trustee.id;
            if (!trusteeId) continue;

            // 2b. Get groups granted to this trustee in the customer org
            let groups = [];
            try {
              groups = await gc.fetchTrusteeGroups(api, cust.id, trusteeId);
            } catch (err) {
              console.warn(`Failed to get trustee groups for ${cust.name}:`, err);
              continue;
            }

            for (const group of groups) {
              if (cancelled) break;
              const groupId = group.id;
              if (!groupId) continue;

              // 2c. Get group members from the TRUSTEE org
              let members = [];
              try {
                members = await gc.fetchGroupMembers(api, trusteeCustomerId, groupId);
              } catch (err) {
                console.warn(`Failed to get group members for group ${groupId}:`, err);
                continue;
              }

              for (const member of members) {
                let userName = member.name || null;
                let userEmail = member.email || null;

                // Fallback: fetch full user if name/email missing
                if (!userName || !userEmail) {
                  try {
                    const full = await gc.getUser(api, trusteeCustomerId, member.id);
                    userName = userName || full.name;
                    userEmail = userEmail || full.email;
                  } catch (_) { /* best effort */ }
                }

                userName = userName || "Unknown";
                userEmail = userEmail || "N/A";

                const key = `${displayName}||${userEmail}`;
                if (!usersMap.has(key)) {
                  usersMap.set(key, {
                    trusteeOrg: displayName,
                    name: userName,
                    email: userEmail,
                    orgs: {},
                  });
                }
                usersMap.get(key).orgs[cust.name] = true;
              }
            }
          }
        } catch (err) {
          console.error(`Error processing ${cust.name}:`, err);
          // Continue to next org
        }
      }

      // 3. Build results
      showProgress(100);

      if (cancelled) {
        setStatus("Cancelled.", "error");
        isRunning = false;
        $exportBtn.disabled = false;
        $cancelBtn.style.display = "none";
        return;
      }

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
      const allCustomers = await fetchCustomers();
      const customerNames = allCustomers.map(c => c.name).sort();

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
        html += `<div class="te-table-scroll"><table class="te-table">`;
        html += `<thead><tr><th>Name</th><th>Email</th>`;
        for (const cn of activeCols) {
          html += `<th>${escapeHtml(cn)}</th>`;
        }
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
      $tableWrap.style.display = "";

      $summary.textContent = `Users: ${allUsers.length}  •  Orgs scanned: ${totalOrgs}  •  Trustee orgs: ${Object.keys(byTrusteeOrg).length}`;
      $summary.style.display = "";

      // 5. Show download button
      $download.style.display = "";
      $downloadBtn.onclick = () => downloadExcel(byTrusteeOrg, customerNames);

      // 6. Send email if enabled
      if ($emailChk.checked && $emailTo.value.trim()) {
        setStatus("Sending email…");
        try {
          // Build the Excel as base64 for attachment
          const wb2 = XLSX.utils.book_new();
          for (const tOrg of Object.keys(byTrusteeOrg).sort()) {
            const tUsers = byTrusteeOrg[tOrg].sort((a, b) => a.name.localeCompare(b.name));
            const tCols = customerNames.filter(cn => tUsers.some(u => u.orgs[cn]));
            const tRows = tUsers.map(u => {
              const r = { Name: u.name, Email: u.email };
              for (const cn of tCols) r[cn] = u.orgs[cn] === true;
              return r;
            });
            const ws2 = XLSX.utils.json_to_sheet(tRows);
            const cc = Object.keys(tRows[0] || {}).length;
            ws2["!cols"] = Array.from({ length: cc }, (_, i) => ({ wch: i < 2 ? 25 : 14 }));
            XLSX.utils.book_append_sheet(wb2, ws2, tOrg.slice(0, 31));
          }
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
