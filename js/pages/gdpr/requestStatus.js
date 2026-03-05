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

    $loadBtn.disabled = true;
    $statusWrap.innerHTML = `<p class="gdpr-loading">Loading\u2026</p>`;

    try {
      const requests = await gc.gdprGetRequests(api, org.id);

      if (!requests.length) {
        $statusWrap.innerHTML = `<p class="gdpr-empty">No GDPR requests found for ${escapeHtml(org.name)}.</p>`;
        return;
      }

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
        if (type === "GDPR_EXPORT" && r.resultsUrl?.length) {
          detailsHtml = r.resultsUrl.map((url, i) =>
            `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="gdpr-download-link">` +
            `Download${r.resultsUrl.length > 1 ? ` (${i + 1})` : ""}</a>`
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
    } catch (err) {
      $statusWrap.innerHTML = `<p class="gdpr-empty gdpr-empty--error">Error loading requests: ${escapeHtml(err.message)}</p>`;
    } finally {
      $loadBtn.disabled = false;
    }
  });

  return el;
}
