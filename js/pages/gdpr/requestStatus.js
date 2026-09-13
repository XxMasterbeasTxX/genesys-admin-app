/**
 * GDPR — Request Status
 *
 * Shows all GDPR requests previously submitted for the selected customer org,
 * with their current processing status, completion date, and (for Article 15
 * Access requests) download links once the export is fulfilled.
 */
import * as gc from "../../services/genesysApi.js";
import { escapeHtml, makeStatus } from "../../utils.js";
import { logAction, fetchActivityLog } from "../../services/activityLogService.js";

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
  // Genesys id → display name, filled in after the listing loads.
  const nameCache = new Map();
  // Ids both the directory listing and the single get declined to name.
  const unresolvable = new Set();
  // GDPR request id → the person who submitted it, from this app's own log.
  const submitters = new Map();

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
        <li><strong>Access</strong> downloads are a <strong>ZIP archive</strong> &mdash; the link opens a new
            tab and the browser saves it. Inside: one file per conversation from analytics, the subject's
            <strong>call recordings as .opus audio</strong>, external-contact data, quality surveys and billing
            records, all as flat <code>service!id</code> files. Large exports may produce several archives,
            each with its own link.</li>
        <li>Download links are minted when this page loads and do not last forever. If one has gone
            stale, <strong>Load / Refresh</strong> mints fresh ones; if Genesys no longer holds the
            export, the link reads Expired &mdash; submit a new Access request.</li>
        <li><strong>Erasure</strong> redacts personal data and leaves the interaction records
            themselves in place, so a completed erasure does not empty the org's history.</li>
        <li><strong>Submitted by</strong> is what Genesys recorded. Requests raised from this app
            arrive through its integration, so Genesys attributes them to the API client rather
            than to a person &mdash; <strong>Admin &rsaquo; Activity Log</strong> is where the
            individual who raised one is recorded.</li>
        <li><strong>Rectification says what was requested, not what changed.</strong> Genesys
            reports the terms the request carried, never which records it rewrote, and a request
            that matched nothing to replace still completes. It also acts on GDPR-scoped data
            &mdash; conversations, analytics, external contacts &mdash; so a Genesys user's own
            directory profile is not where to check whether it worked.</li>
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
   * Turn each completed export's `resultsUrl` into a link the browser will
   * actually download from, BEFORE the table is drawn.
   *
   * What `resultsUrl` is, observed live: an API endpoint —
   * `…/api/v2/downloads/<id>` — that exchanges an authenticated call for a
   * signed URL on `api-downloads.<region>`. `gdprResolveDownloadUrl` makes that
   * call through the proxy with `issueRedirect=false` so the signed URL comes
   * back as JSON rather than a 302 the proxy would follow into the archive.
   *
   * What the browser then does with the signed URL turned out to be the whole
   * problem, and it was settled empirically rather than by reasoning:
   *
   *   - navigating a script-opened about:blank popup to it: no download
   *   - clicking an anchor INSIDE that popup: no download
   *   - "open link in new tab" on that anchor: downloads
   *
   * So the tab that fetches the archive has to be a fresh one whose FIRST
   * navigation is the signed URL. That is exactly what a plain
   * `<a href target="_blank">` does on a click, and nothing else in the app
   * needs to happen at click time — which is why the URLs are resolved up
   * front and the table gets ordinary anchors. One click, no popup, no
   * "Preparing…", nothing for a blocker to refuse.
   *
   * The cost is a proxy call per completed export on load, small JSON each,
   * capped. The trade is a signed URL that can go stale while the page sits
   * open; Load / Refresh mints fresh ones, and the help text says so.
   */
  const signedUrls = new Map();   // request id → [{ url } | { error, gone }]

  async function resolveDownloadUrls(orgId) {
    const jobs = [];
    let budget = 20;
    for (const r of allRequests) {
      if (r.requestType !== "GDPR_EXPORT" || r.status !== "COMPLETED") continue;
      const raw = r.resultsUrls?.length ? r.resultsUrls : r.resultsUrl ? [r.resultsUrl] : [];
      if (!raw.length) continue;
      const slots = raw.map(() => ({ pending: true }));
      signedUrls.set(r.id, slots);
      raw.forEach((u, i) => {
        if (budget-- <= 0) {
          slots[i] = { error: "Not resolved — too many exports on one page. Filter the list." };
          return;
        }
        jobs.push(
          gc.gdprResolveDownloadUrl(api, orgId, u)
            .then(url => { slots[i] = { url }; })
            .catch(err => {
              const gone = err?.status === 404 || /not found/i.test(err?.message || "");
              slots[i] = { error: err?.message || String(err), gone };
            }),
        );
      });
    }
    await Promise.all(jobs);
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

      // A named subject reads as a name; an unnamed one falls back to a name we
      // resolved from its id, and only then to the id itself — in mono and
      // truncated, since a GUID in bold body text wrapped over two lines and
      // pushed the column out.
      const subjectName = r.subject?.name ?? (rawId ? nameCache.get(rawId) : null);
      const subjectHtml = subjectName
        ? `<span class="gdpr-subject-name">${escapeHtml(subjectName)}</span>`
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

      // No completion timestamp: GDPRRequest carries createdDate and nothing
      // else date-shaped. A Completed column used to read `resolutionDate`, a
      // field that is not in the spec and never arrived, so it was "—" on every
      // row forever.
      // Three sources, strongest first. The app's own log is the only one that
      // names a person for a request raised here; Genesys can only name one
      // for a request raised elsewhere. They are marked differently because
      // they are different strengths of evidence, and an audit reader should
      // not have to guess which they are looking at.
      const fromLog = submitters.get(r.id);
      const fromGenesys = r.createdBy?.name
                       ?? (r.createdBy?.id ? nameCache.get(r.createdBy.id) : null);
      const submittedHtml = fromLog
        ? `<span class="gdpr-attrib-app" title="Recorded by this app when the request was submitted${fromLog.email ? ` (${escapeHtml(fromLog.email)})` : ""}. Genesys itself attributes the request to the integration.">${escapeHtml(fromLog.who)}</span>`
        : fromGenesys
          ? escapeHtml(fromGenesys)
          : r.createdBy?.id
            ? `<span class="gdpr-api-client" title="Genesys returned no user record for ${escapeHtml(r.createdBy.id)}, and this app has no log entry naming who raised it — it predates that record, or was raised by another integration. See Admin › Activity Log.">API client</span>`
            : "—";

      // Details — contextual per request type. `resultsUrl`/`resultsUrls` come
      // back on the listing itself, so no per-row follow-up GET is needed.
      let detailsHtml = "—";
      const urls = r.resultsUrls?.length ? r.resultsUrls
                 : r.resultsUrl          ? [r.resultsUrl]
                 : [];
      if (type === "GDPR_EXPORT" && urls.length) {
        const slots = signedUrls.get(r.id) || [];
        detailsHtml = urls.map((_, i) => {
          const label = `Download${urls.length > 1 ? ` (${i + 1})` : ""}`;
          const slot = slots[i];
          if (slot?.url) {
            // A real anchor to a fresh tab: the one shape of click that
            // reliably produced a file. No handler intercepts it.
            return `<a href="${escapeHtml(slot.url)}" target="_blank" rel="noopener" class="gdpr-download-link"`
              + ` data-req-id="${escapeHtml(r.id ?? "")}" title="Opens in a new tab and downloads a .zip">${label}</a>`;
          }
          if (slot?.gone) {
            return `<span class="gdpr-download-link gdpr-download-link--dead" title="Genesys returned 404 for this download. Submit a new Access request.">Expired</span>`;
          }
          const why = slot?.error || "No download link was resolved for this export.";
          return `<span class="gdpr-download-link gdpr-download-link--dead" title="${escapeHtml(why)}">Unavailable</span>`;
        }).join("<br>");
      } else if (type === "GDPR_UPDATE" && r.replacementTerms?.length) {
        // `replacementTerms` is the request's own INPUT echoed back — the terms
        // that were submitted. Genesys does not report what it actually
        // changed, so this used to read "1 field updated: NAME" and assert an
        // outcome nobody had claimed. Paired with a COMPLETED status it made a
        // rectification that replaced nothing look like one that worked.
        const fieldList = r.replacementTerms.map(t => escapeHtml(t.type ?? "?")).join(", ");
        detailsHtml = `<span class="gdpr-replacements-summary"`
          + ` title="The fields this request asked Genesys to replace. Genesys does not report`
          + ` which records it changed, so this is the request, not a confirmation.">`
          + `Requested: ${fieldList}</span>`;
      }

      const reqId = escapeHtml(r.id ?? "—");
      return `
        <tr>
          <td>${escapeHtml(date)}</td>
          <td><span class="gdpr-badge ${badgeClass}">${typeLabel}</span></td>
          <td>${subjectHtml}</td>
          <td><span class="gdpr-subject-type-badge">${escapeHtml(subjectType)}</span></td>
          <td><span class="gdpr-status-dot gdpr-status-dot--${statusClass}">${escapeHtml(statusLabel)}</span></td>
          <td>${submittedHtml}</td>
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
    // The anchor does the work. This only records that a subject's personal
    // data was pulled out of a customer tenant — and never preventDefaults,
    // because the default is the one thing that works.
    $statusWrap.querySelectorAll("a.gdpr-download-link[href]").forEach(link => {
      link.addEventListener("click", () => {
        if (!currentOrg) return;
        const reqId = link.dataset.reqId;
        setStatus("Opening the export in a new tab — the browser will save the .zip.", "success");
        logAction({ me, orgId: currentOrg.id, orgName: currentOrg.name || "",
          action: "gdpr_export_download",
          description: `Opened GDPR Access export archive for request ${reqId || "(unknown)"}`,
          count: 1 });
      });
    });
  }

  /**
   * Resolve the ids Genesys returns into names people recognise.
   *
   * `createdBy` comes back as a DomainEntityRef carrying an id and a selfUri
   * but no name, and `subject.name` is frequently absent on the listing too —
   * so both the Subject and Submitted by columns printed raw GUIDs. On a page
   * whose job is to answer "who asked for this, and about whom", a GUID is not
   * an answer.
   *
   * Users go out in one batched call (`fetchUsersByIds` chunks and repeats the
   * `id` parameter). External contacts have no bulk-by-id endpoint, so they are
   * fetched individually and capped — a page of them is a handful, and a row
   * that cannot be resolved simply keeps showing its id.
   */
  async function resolveNames(orgId) {
    const userIds = new Set();
    const contactIds = new Set();
    for (const r of allRequests) {
      if (r.createdBy?.id && !r.createdBy?.name) userIds.add(r.createdBy.id);
      if (!r.subject?.name) {
        if (r.subject?.userId) userIds.add(r.subject.userId);
        else if (r.subject?.externalContactId) contactIds.add(r.subject.externalContactId);
      }
    }
    if (!userIds.size && !contactIds.size) return;

    const jobs = [];

    if (userIds.size) {
      jobs.push(
        gc.fetchUsersByIds(api, orgId, [...userIds])
          .then(users => {
            for (const u of users) if (u?.id && u?.name) nameCache.set(u.id, u.name);
          })
          .catch(() => { /* falls through to the single gets below */ }),
      );
    }

    // Cap the individual gets: a full page of unnamed external contacts should
    // not turn one page load into fifty requests.
    for (const id of [...contactIds].slice(0, 25)) {
      jobs.push(
        gc.getExternalContact(api, orgId, id)
          .then(c => {
            const name = [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim()
              || c?.name || null;
            if (name) nameCache.set(id, name);
          })
          .catch(() => { /* ids stay as ids */ }),
      );
    }

    await Promise.all(jobs);

    // Second pass, for ids the LIST endpoint declined to return.
    //
    // `GET /api/v2/users?id=…` and `GET /api/v2/users/{id}` do not answer the
    // same question. The list filters the directory; the single get resolves an
    // identity. An OAuth client's identity is the case that matters here —
    // `createdBy` on a request raised through this app carries a `selfUri` of
    // `/api/v2/users/<id>`, so Genesys does consider it a user, but the
    // directory listing has never heard of it. One request per unresolved id,
    // deduplicated, and in practice that is a single call for the whole table.
    const stragglers = [...userIds].filter(id => !nameCache.has(id));
    if (!stragglers.length) return;

    await Promise.all(stragglers.slice(0, 10).map(id =>
      gc.getUser(api, orgId, id)
        .then(u => { if (u?.name) nameCache.set(id, u.name); })
        .catch(() => { unresolvable.add(id); }),
    ));
    for (const id of stragglers) if (!nameCache.has(id)) unresolvable.add(id);
  }

  /**
   * Map GDPR request ids to the person who submitted them, from this app's own
   * activity log.
   *
   * Genesys cannot answer this. A request raised here reaches it through the
   * app's OAuth client, so `createdBy` is the integration on every row — the
   * app is the only place a human being is recorded against a GDPR request.
   * Since 5.4 the submit path writes the ids Genesys minted into the log
   * entry's `details`, and this reads them back.
   *
   * Bounded on purpose, and the bounds are why the column degrades rather than
   * lies: requests submitted before that shipped carry no ids, entries age out
   * at twelve months, and the read is capped. Anything unmatched falls back to
   * what Genesys recorded. See docs/gdpr-submitter-attribution-design.md.
   */
  async function resolveSubmitters(orgId) {
    let entries = [];
    try {
      entries = await fetchActivityLog({ me, limit: 1000 });
    } catch {
      return;   // enrichment only — the page is fine without it
    }
    for (const e of entries) {
      if (e.action !== "gdpr_request") continue;
      if (orgId && e.orgId && e.orgId !== orgId) continue;
      const ids = e.details?.gdprRequestIds;
      if (!Array.isArray(ids)) continue;
      const who = e.userName || e.userEmail;
      if (!who) continue;
      for (const id of ids) {
        // Newest first, so the first writer of an id wins; an id should only
        // ever appear once anyway.
        if (!submitters.has(id)) submitters.set(id, { who, email: e.userEmail || "" });
      }
    }
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
      await Promise.all([
        fillMissingResultUrls(org.id).then(() => resolveDownloadUrls(org.id)),
        resolveNames(org.id),
        resolveSubmitters(org.id),
      ]);
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
