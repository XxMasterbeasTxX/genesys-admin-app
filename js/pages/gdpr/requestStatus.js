/**
 * GDPR — Request Status
 *
 * Shows all GDPR requests previously submitted for the selected customer org,
 * with their current processing status, completion date, and (for Article 15
 * Access requests) signed download links once the export is fulfilled.
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml } from "../../utils.js";

const TYPE_LABELS  = { GDPR_DELETE: "Erasure", GDPR_EXPORT: "Access", GDPR_UPDATE: "Rectification" };
const TYPE_CLASSES = { GDPR_DELETE: "gdpr-badge--delete", GDPR_EXPORT: "gdpr-badge--export", GDPR_UPDATE: "gdpr-badge--update" };
const STATUS_LABEL = {
  INITIATED:   "Initiated",
  DELETING:    "Deleting\u2026",
  IN_PROGRESS: "In Progress",
  FULFILLED:   "Fulfilled",
  COMPLETE:    "Fulfilled",
  COMPLETED:   "Fulfilled",
  FAILED:      "Failed",
  REJECTED:    "Rejected",
  ERROR:       "Error",
};
const STATUS_CLASS = {
  INITIATED:   "inprogress",
  DELETING:    "inprogress",
  IN_PROGRESS: "inprogress",
  FULFILLED:   "completed",
  COMPLETE:    "completed",
  COMPLETED:   "completed",
  FAILED:      "failed",
  REJECTED:    "failed",
  ERROR:       "failed",
};

export default function renderRequestStatus({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  // Track current org for download handler
  let currentOrg = null;

  el.innerHTML = `
    <h2>GDPR \u2014 Request Status</h2>
    <p class="page-desc">
      View the status of all GDPR requests previously submitted for the selected customer org.
      For Article 15 (Access) requests, download links appear here once Genesys has fulfilled the export &mdash;
      typically within 1&ndash;2 business days.
    </p>

    <div class="te-actions">
      <button class="btn te-btn-export" id="gdprStatusLoad">Load / Refresh</button>
    </div>

    <div id="gdprStatusWrap" style="margin-top:12px"></div>
  `;

  const $loadBtn    = el.querySelector("#gdprStatusLoad");
  const $statusWrap = el.querySelector("#gdprStatusWrap");

  $loadBtn.addEventListener("click", async () => {
    const org = orgContext?.getDetails?.();
    if (!org) {
      $statusWrap.innerHTML = `<p class="gdpr-empty">Please select a customer org first.</p>`;
      return;
    }
    currentOrg = org;

    $loadBtn.disabled = true;
    $statusWrap.innerHTML = `<p class="gdpr-loading">Loading\u2026</p>`;

    try {
      const requests = await gc.gdprGetRequests(api, org.id);

      if (!requests.length) {
        $statusWrap.innerHTML = `<p class="gdpr-empty">No GDPR requests found for ${escapeHtml(org.name)}.</p>`;
        return;
      }

      // For completed Access requests, fetch individual details to get resultsUrl
      const completedExports = requests.filter(r =>
        r.requestType === "GDPR_EXPORT" && ["FULFILLED", "COMPLETE", "COMPLETED"].includes(r.status)
      );
      const detailMap = new Map();
      await Promise.all(completedExports.map(async (r) => {
        try {
          const detail = await gc.gdprGetRequest(api, org.id, r.id);
          detailMap.set(r.id, detail);
        } catch { /* ignore — row will just show no link */ }
      }));

      const rows = requests.map((r) => {
        const date        = r.createdDate ? new Date(r.createdDate).toLocaleString() : "\u2014";
        const type        = r.requestType ?? "\u2014";
        const typeLabel   = TYPE_LABELS[type] ?? type;
        const badgeClass  = TYPE_CLASSES[type] ?? "";
        const rawStatus   = r.status ?? "\u2014";
        const statusLabel = STATUS_LABEL[rawStatus] ?? rawStatus;
        const statusClass = STATUS_CLASS[rawStatus] ?? "inprogress";

        const rawId       = r.subject?.userId ?? r.subject?.externalContactId ?? r.subject?.dialerContactId?.id ?? null;
        const nameDisplay = escapeHtml(r.subject?.name ?? rawId ?? "\u2014");

        const subjectType = r.subject?.userId            ? "User"
                          : r.subject?.externalContactId ? "Ext. Contact"
                          : r.subject?.dialerContactId   ? "Dialer Contact"
                          : "\u2014";

        const completedDate = r.resolutionDate ? new Date(r.resolutionDate).toLocaleString() : "\u2014";

        // Details — contextual per request type
        let detailsHtml = "\u2014";
        const detail = detailMap.get(r.id) || r;
        // API returns resultsUrl (single string) and/or resultsUrls (array of strings)
        const urls = detail.resultsUrls?.length ? detail.resultsUrls
                   : detail.resultsUrl           ? [detail.resultsUrl]
                   : [];
        if (type === "GDPR_EXPORT" && urls.length) {
          detailsHtml = urls.map((url, i) =>
            `<a href="#" class="gdpr-download-link" data-gdpr-url="${escapeHtml(url)}">` +
            `Download${urls.length > 1 ? ` (${i + 1})` : ""}</a>`
          ).join("<br>");
        } else if (type === "GDPR_UPDATE" && r.replacements?.length) {
          const fieldList = r.replacements.map(rep => escapeHtml(rep.fieldName ?? "?")).join(", ");
          detailsHtml = `<span class="gdpr-replacements-summary" title="${fieldList}">` +
            `${r.replacements.length} field${r.replacements.length !== 1 ? "s" : ""} updated: ${fieldList}</span>`;
        }

        const reqId = escapeHtml(r.id ?? "\u2014");
        return `
          <tr>
            <td>${escapeHtml(date)}</td>
            <td><span class="gdpr-badge ${badgeClass}">${typeLabel}</span></td>
            <td><span class="gdpr-subject-name">${nameDisplay}</span></td>
            <td><span class="gdpr-subject-type-badge">${escapeHtml(subjectType)}</span></td>
            <td><span class="gdpr-status-dot gdpr-status-dot--${statusClass}">${escapeHtml(statusLabel)}</span></td>
            <td>${escapeHtml(completedDate)}</td>
            <td class="gdpr-details-cell">${detailsHtml}</td>
            <td class="gdpr-mono">${reqId}</td>
          </tr>
        `;
      });

      $statusWrap.innerHTML = `
        <div class="gdpr-table-wrap">
          <table class="gdpr-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Subject Type</th>
                <th>Status</th>
                <th>Completed</th>
                <th>Details</th>
                <th>Request ID</th>
              </tr>
            </thead>
            <tbody>${rows.join("")}</tbody>
          </table>
        </div>
        <p class="gdpr-last-loaded">Last loaded: ${new Date().toLocaleTimeString()}</p>
      `;

      // Attach download handlers — fetch via proxy with auth, then trigger browser download
      $statusWrap.querySelectorAll("a[data-gdpr-url]").forEach(link => {
        link.addEventListener("click", async (e) => {
          e.preventDefault();
          const url = link.dataset.gdprUrl;
          if (!currentOrg) return;
          link.textContent = "Downloading…";
          link.style.pointerEvents = "none";
          try {
            // Extract the API path from the full URL (strip the region host)
            let apiPath = url;
            try { apiPath = new URL(url).pathname + new URL(url).search; } catch { /* already a path */ }
            const resp = await api.proxyGenesysRaw
              ? api.proxyGenesysRaw(currentOrg.id, "GET", apiPath)
              : await api.proxyGenesys(currentOrg.id, "GET", apiPath);
            // If the response is a JSON with a downloadUrl or presignedUrl, open that
            if (resp?.downloadUrl) {
              window.open(resp.downloadUrl, "_blank");
            } else if (resp?.presignedUrl) {
              window.open(resp.presignedUrl, "_blank");
            } else if (resp?.url) {
              window.open(resp.url, "_blank");
            } else {
              // Response might be the data itself — try to download as JSON
              const blob = new Blob([JSON.stringify(resp, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `gdpr_export_${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(a.href);
            }
          } catch (err) {
            const msg = err.message || "";
            if (msg.includes("not be found") || msg.includes("not found") || msg.includes("expired")) {
              link.textContent = "Expired";
              link.style.pointerEvents = "none";
              link.style.opacity = "0.5";
              link.title = "This download has expired. Submit a new GDPR Access request.";
              return;  // skip the finally restore
            }
            alert(`Download failed: ${msg}`);
          } finally {
            // Only restore if not marked as expired
            if (link.textContent !== "Expired") {
              link.textContent = link.dataset.originalText || "Download";
              link.style.pointerEvents = "";
            }
          }
        });
        link.dataset.originalText = link.textContent;
      });
    } catch (err) {
      $statusWrap.innerHTML = `<p class="gdpr-empty gdpr-empty--error">Error loading requests: ${escapeHtml(err.message)}</p>`;
    } finally {
      $loadBtn.disabled = false;
    }
  });

  return el;
}
