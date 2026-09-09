/**
 * GDPR — Request Status
 *
 * Shows all GDPR requests previously submitted for the selected customer org,
 * with their current processing status, completion date, and (for Article 15
 * Access requests) download links once the export is fulfilled.
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml, makeStatus } from "../../utils.js";
import { logAction } from "../../services/activityLogService.js";

const TYPE_LABELS  = { GDPR_DELETE: "Erasure", GDPR_EXPORT: "Access", GDPR_UPDATE: "Rectification" };
const TYPE_CLASSES = { GDPR_DELETE: "gdpr-badge--delete", GDPR_EXPORT: "gdpr-badge--export", GDPR_UPDATE: "gdpr-badge--update" };

/**
 * The GDPRRequest status enum, read from `x-inin-requires-permissions`'s
 * neighbour in the OpenAPI spec rather than from memory:
 *   INITIATED, SEARCHING, UPDATING, DELETING, COMPLETED, ERROR, FINALIZING
 *
 * The previous map was mostly invented — FULFILLED, COMPLETE, IN_PROGRESS,
 * FAILED and REJECTED are not values Genesys returns, while SEARCHING,
 * UPDATING and FINALIZING are, and fell through to render as raw enum
 * shouting. Unknown values now get title-cased instead of a longer list of
 * guesses, so a status Genesys adds later reads as English on its own.
 */
const STATUS_LABEL = {
  INITIATED:  "Initiated",
  SEARCHING:  "Searching…",
  UPDATING:   "Updating…",
  DELETING:   "Deleting…",
  FINALIZING: "Finalizing…",
  COMPLETED:  "Completed",
  ERROR:      "Error",
};
const STATUS_CLASS = {
  INITIATED:  "inprogress",
  SEARCHING:  "inprogress",
  UPDATING:   "inprogress",
  DELETING:   "inprogress",
  FINALIZING: "inprogress",
  COMPLETED:  "completed",
  ERROR:      "failed",
};

/** "IN_REVIEW" → "In review", for a status the spec gains after this was written. */
function titleCase(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, c => c.toUpperCase());
}

const FILTER_ALL = "__all__";

export default function renderRequestStatus({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  // Track current org for the download handler
  let currentOrg = null;
  let allRequests = [];

  el.innerHTML = `
    <h2>GDPR — Request Status</h2>
    <p class="page-desc">
      View the status of all GDPR requests previously submitted for the selected customer org.
      For Article 15 (Access) requests, the download link appears here once Genesys has completed
      the export &mdash; typically within 1&ndash;2 business days.
    </p>

    <div class="gdpr-expect">
      <p class="gdpr-expect-title">Reading this page</p>
      <ul class="gdpr-expect-list">
        <li><strong>Completed means Genesys accepted and processed the request</strong>, not
            necessarily that every record has caught up. Erasures in particular have been reported
            to finish redacting days after the status here changes.</li>
        <li><strong>Access</strong> downloads are a <strong>ZIP archive</strong> on Genesys's own
            storage &mdash; the link opens in a new tab and the browser saves it. Large exports may
            produce several archives, and each gets its own link. Call recordings are not included.</li>
        <li>The archive holds raw platform data rather than a report. Genesys does not document its
            contents, so expect to interpret it before it can go to the data subject.</li>
        <li><strong>Erasure</strong> redacts personal data and leaves the interaction records
            themselves in place, so a completed erasure does not empty the org's history.</li>
        <li>Download links are signed by Genesys and do not last forever. If one stops working,
            submit a fresh Access request rather than retrying it.</li>
      </ul>
    </div>

    <div class="te-actions">
      <button class="btn te-btn-export" id="gdprStatusLoad">Load / Refresh</button>
      <select class="gdpr-filter" id="gdprTypeFilter" aria-label="Filter by request type">
        <option value="${FILTER_ALL}">All types</option>
        ${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
      </select>
      <select class="gdpr-filter" id="gdprStatusFilter" aria-label="Filter by status">
        <option value="${FILTER_ALL}">All statuses</option>
        <option value="__open__">In progress</option>
        <option value="COMPLETED">Completed</option>
        <option value="ERROR">Error</option>
      </select>
    </div>

    <div class="te-status" id="gdprStatusMsg"></div>
    <div id="gdprStatusWrap" style="margin-top:12px"></div>
  `;

  const $loadBtn      = el.querySelector("#gdprStatusLoad");
  const $statusWrap   = el.querySelector("#gdprStatusWrap");
  const $statusMsg    = el.querySelector("#gdprStatusMsg");
  const $typeFilter   = el.querySelector("#gdprTypeFilter");
  const $statusFilter = el.querySelector("#gdprStatusFilter");

  // The throbber comes from the "…" in the message; makeStatus detects it.
  const setStatus = makeStatus($statusMsg, "te-status");

  // ── Download ──────────────────────────────────────────────────────
  /**
   * Hand the export's results URL straight to the browser.
   *
   * The export is a **ZIP archive** — `resultsUrls` is documented as "the
   * locations where the results can be retrieved if multiple archive files
   * created", and Genesys staff on the community forum confirm a zip. There is
   * also no `/results` endpoint anywhere under `/api/v2/gdpr` in the OpenAPI
   * spec, and every comparable `downloadUrl` in that spec is described as a
   * signed or presigned URL. So `resultsUrl` points at storage Genesys has
   * signed, not at an API path.
   *
   * That rules out both of the obvious-looking implementations:
   *
   *   - `URL.createObjectURL` + `a.click()` (what this page used to do) is
   *     inert inside the Genesys Cloud iframe.
   *   - Routing it through `/api/genesys-proxy` would be worse than useless:
   *     the proxy reads every response with `.text()`, which silently destroys
   *     a zip, and it sits behind the 45-second Static Web Apps cap that a
   *     large archive would blow through. It would have produced a corrupt
   *     file that looked like a successful download.
   *
   * Opening the signed URL lets the browser do what it is for: it carries its
   * own auth, the server sets the filename and content type, and the download
   * is the browser's, not ours. `window.open` is the same mechanism the Excel
   * exports already rely on to reach download.html, so it is proven in the
   * iframe.
   */
  function openExport(url) {
    const win = window.open(url, "_blank", "noopener");
    if (!win) {
      throw new Error("Pop-up blocked. Allow pop-ups for this site and try the download again.");
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────
  function visibleRequests() {
    const type   = $typeFilter.value;
    const status = $statusFilter.value;
    return allRequests.filter(r => {
      if (type !== FILTER_ALL && r.requestType !== type) return false;
      if (status === FILTER_ALL) return true;
      if (status === "__open__") return r.status !== "COMPLETED" && r.status !== "ERROR";
      return r.status === status;
    });
  }

  function renderTable() {
    const requests = visibleRequests();

    if (!requests.length) {
      $statusWrap.innerHTML = allRequests.length
        ? `<p class="gdpr-empty">No requests match the current filters.</p>`
        : `<p class="gdpr-empty">No GDPR requests found for ${escapeHtml(currentOrg?.name ?? "this org")}.</p>`;
      return;
    }

    const rows = requests.map((r) => {
      const date        = r.createdDate ? new Date(r.createdDate).toLocaleString() : "—";
      const type        = r.requestType ?? "—";
      const typeLabel   = TYPE_LABELS[type] ?? type;
      const badgeClass  = TYPE_CLASSES[type] ?? "";
      const rawStatus   = r.status ?? "—";
      const statusLabel = STATUS_LABEL[rawStatus] ?? titleCase(rawStatus);
      const statusClass = STATUS_CLASS[rawStatus] ?? "inprogress";

      const rawId = r.subject?.userId
                 ?? r.subject?.externalContactId
                 ?? r.subject?.dialerContactId?.id
                 ?? r.subject?.journeyCustomer?.id
                 ?? r.subject?.externalId
                 ?? null;

      // A named subject reads as a name; an unnamed one is an id, and an id in
      // bold body text wrapped over two lines and pushed the column out. Ids
      // get the same mono/truncated treatment as the Request ID column.
      const subjectHtml = r.subject?.name
        ? `<span class="gdpr-subject-name">${escapeHtml(r.subject.name)}</span>`
        : rawId
          ? `<span class="gdpr-mono gdpr-subject-ref" title="${escapeHtml(rawId)}">${escapeHtml(truncId(rawId))}</span>`
          : "—";

      const subjectType = r.subject?.userId            ? "User"
                        : r.subject?.externalContactId ? "Ext. Contact"
                        : r.subject?.dialerContactId   ? "Dialer Contact"
                        : r.subject?.journeyCustomer   ? "Journey Cust."
                        : r.subject?.socialHandle      ? "Social"
                        : r.subject?.externalId        ? "External ID"
                        : "—";

      const completedDate = r.resolutionDate ? new Date(r.resolutionDate).toLocaleString() : "—";
      const submittedBy   = r.createdBy?.name ?? r.createdBy?.id ?? "—";

      // Details — contextual per request type. `resultsUrl`/`resultsUrls` come
      // back on the listing itself, so no per-row follow-up GET is needed.
      let detailsHtml = "—";
      const urls = r.resultsUrls?.length ? r.resultsUrls
                 : r.resultsUrl          ? [r.resultsUrl]
                 : [];
      if (type === "GDPR_EXPORT" && urls.length) {
        detailsHtml = urls.map((url, i) =>
          `<a href="#" class="gdpr-download-link" data-gdpr-url="${escapeHtml(url)}" data-req-id="${escapeHtml(r.id ?? "")}">` +
          `Download${urls.length > 1 ? ` (${i + 1})` : ""}</a>`
        ).join("<br>");
      } else if (type === "GDPR_UPDATE" && r.replacementTerms?.length) {
        const fieldList = r.replacementTerms.map(t => escapeHtml(t.type ?? "?")).join(", ");
        detailsHtml = `<span class="gdpr-replacements-summary" title="${fieldList}">` +
          `${r.replacementTerms.length} field${r.replacementTerms.length !== 1 ? "s" : ""} updated: ${fieldList}</span>`;
      }

      const reqId = escapeHtml(r.id ?? "—");
      return `
        <tr>
          <td>${escapeHtml(date)}</td>
          <td><span class="gdpr-badge ${badgeClass}">${typeLabel}</span></td>
          <td>${subjectHtml}</td>
          <td><span class="gdpr-subject-type-badge">${escapeHtml(subjectType)}</span></td>
          <td><span class="gdpr-status-dot gdpr-status-dot--${statusClass}">${escapeHtml(statusLabel)}</span></td>
          <td>${escapeHtml(completedDate)}</td>
          <td>${escapeHtml(submittedBy)}</td>
          <td class="gdpr-details-cell">${detailsHtml}</td>
          <td class="gdpr-mono">${reqId}</td>
        </tr>
      `;
    });

    const hidden = allRequests.length - requests.length;
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
              <th>Submitted by</th>
              <th>Details</th>
              <th>Request ID</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
      <p class="gdpr-last-loaded">
        Showing ${requests.length} of ${allRequests.length} request${allRequests.length !== 1 ? "s" : ""}${hidden ? ` (${hidden} hidden by filters)` : ""}
        &middot; last loaded ${new Date().toLocaleTimeString()}
      </p>
    `;

    attachDownloadHandlers();
  }

  function truncId(id) {
    const s = String(id);
    return s.length > 24 ? s.substring(0, 24) + "…" : s;
  }

  function attachDownloadHandlers() {
    $statusWrap.querySelectorAll("a[data-gdpr-url]").forEach(link => {
      link.dataset.originalText = link.textContent;
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        if (!currentOrg) return;
        const url = link.dataset.gdprUrl;
        const reqId = link.dataset.reqId;
        try {
          openExport(url);
          // The archive opens on Genesys's own storage, so this is the last
          // point we can see. Whether the signed URL is still valid is between
          // the browser and Genesys — if it has expired, that shows in the new
          // tab, and claiming otherwise here would be inventing a result.
          setStatus(
            "Opening the export archive in a new tab. If it does not download, "
            + "the signed link may have expired — submit a new Access request.",
            "success",
          );
          // Pulling a subject's personal data out of a customer tenant is the
          // other action on these pages worth a trail, and it left none.
          logAction({ me, orgId: currentOrg.id, orgName: currentOrg.name || "",
            action: "gdpr_export_download",
            description: `Opened GDPR Access export archive for request ${reqId || "(unknown)"}`,
            count: 1 });
        } catch (err) {
          setStatus(err.message, "error");
          logAction({ me, orgId: currentOrg.id, orgName: currentOrg.name || "",
            action: "gdpr_export_download",
            description: `GDPR Access export could not be opened for request ${reqId || "(unknown)"}`,
            result: "failure", errorMessage: err.message });
        }
      });
    });
  }

  /**
   * Top up any completed export that came back without its download URL.
   *
   * The spec says a listing entity is a full GDPRRequest, `resultsUrl` and
   * `resultsUrls` included, so the page no longer fetches every completed
   * export's detail just to find a link it was already handed — that was one
   * extra GET per row. But a lean listing would take the Download link away
   * entirely, which is a worse failure than a few requests, so anything that
   * actually arrives without one is still fetched individually. On a listing
   * that behaves as documented this does nothing at all.
   */
  async function fillMissingResultUrls(orgId) {
    const gaps = allRequests.filter(r =>
      r.requestType === "GDPR_EXPORT"
      && r.status === "COMPLETED"
      && !r.resultsUrl
      && !r.resultsUrls?.length
    );
    if (!gaps.length) return;

    await Promise.all(gaps.map(async (r) => {
      try {
        const detail = await gc.gdprGetRequest(api, orgId, r.id);
        if (detail?.resultsUrl)   r.resultsUrl  = detail.resultsUrl;
        if (detail?.resultsUrls)  r.resultsUrls = detail.resultsUrls;
      } catch { /* ignore — the row just shows no link */ }
    }));
  }

  // ── Load ──────────────────────────────────────────────────────────
  async function load() {
    const org = orgContext?.getDetails?.();
    if (!org) {
      allRequests = [];
      $statusWrap.innerHTML = `<p class="gdpr-empty">Please select a customer org first.</p>`;
      return;
    }
    currentOrg = org;

    $loadBtn.disabled = true;
    setStatus("Loading GDPR requests…");
    $statusWrap.innerHTML = "";

    try {
      allRequests = await gc.gdprGetRequests(api, org.id);
      await fillMissingResultUrls(org.id);
      setStatus("");
      renderTable();
    } catch (err) {
      allRequests = [];
      $statusWrap.innerHTML = `<p class="gdpr-empty gdpr-empty--error">Error loading requests: ${escapeHtml(err.message)}</p>`;
      setStatus("");
    } finally {
      $loadBtn.disabled = false;
    }
  }

  $loadBtn.addEventListener("click", load);
  [$typeFilter, $statusFilter].forEach(sel =>
    sel.addEventListener("change", () => { if (allRequests.length) renderTable(); })
  );

  // Read-only page against the already-selected org: making the user press a
  // button to see anything is a step with no decision in it.
  load();

  return el;
}
