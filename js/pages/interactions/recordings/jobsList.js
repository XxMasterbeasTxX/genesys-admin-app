/**
 * Interactions › Recordings › Export Jobs
 *
 * Lists all recording bulk export jobs for the selected org.
 * Supports execute (READY), cancel, and delete actions.
 * Each row can be expanded to see the original query filters.
 *
 * API endpoints used (all via genesys-proxy):
 *   GET    /api/v2/recording/jobs             — list all jobs
 *   GET    /api/v2/recording/jobs/{id}        — get single job (for refresh)
 *   PUT    /api/v2/recording/jobs/{id}        — execute (set state PROCESSING)
 *   DELETE /api/v2/recording/jobs/{id}        — delete job
 *   GET    /api/v2/integrations/{id}          — resolve integration name
 *   GET    /api/v2/routing/queues/{id}        — resolve queue names
 *   GET    /api/v2/users/{id}                 — resolve user names
 */
import { escapeHtml, formatDateTime } from "../../../utils.js";

// ── State badge colours ──────────────────────────────────────────────
const STATE_BADGE = {
  PENDING:    "badge--grey",
  PROCESSING: "badge--blue",
  READY:      "badge--green",
  FULFILLED:  "badge--teal",
  FAILED:     "badge--red",
  CANCELLED:  "badge--grey",
};

function stateBadge(state) {
  const cls = STATE_BADGE[state] || "badge--grey";
  return `<span class="badge ${cls}">${escapeHtml(state || "—")}</span>`;
}

// ── Format interval ───────────────────────────────────────────────────
function formatInterval(interval) {
  if (!interval) return "—";
  const [start, end] = interval.split("/");
  const fmt = (iso) => {
    if (!iso) return "?";
    try { return new Date(iso).toLocaleDateString("sv-SE"); } catch { return iso; }
  };
  return `${fmt(start)} → ${fmt(end)}`;
}

export default function renderRecordingJobsList({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Recording Export Jobs</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  el.innerHTML = `
    <h1 class="h1">Recording Export Jobs</h1>
    <hr class="hr">

    <p class="page-desc">
      All recording bulk export jobs for <strong>${escapeHtml(org.name)}</strong>.
      Once a job reaches <strong>READY</strong> state, click <em>Execute</em> to start
      the export to the configured storage integration.
      Recordings are delivered directly by Genesys Cloud — not downloaded here.
    </p>

    <div class="rj-toolbar">
      <button class="btn btn-sm" id="rjlRefresh">&#8635; Refresh</button>
      <a href="#/interactions/recordings/create" class="btn btn-primary btn-sm">+ Create New Job</a>
    </div>

    <div class="rj-status" id="rjlStatus"></div>

    <div id="rjlBody">
      <p class="sp-empty">Loading…</p>
    </div>
  `;

  const $status  = el.querySelector("#rjlStatus");
  const $body    = el.querySelector("#rjlBody");
  const $refresh = el.querySelector("#rjlRefresh");

  // ── State ────────────────────────────────────────────────────────
  let jobs           = [];
  let expandedJobId  = null;
  // Caches so we don't repeatedly re-fetch names
  const nameCache    = {}; // integrationId/userId/queueId → name

  // ── Status helper ─────────────────────────────────────────────────
  function setStatus(msg, type = "") {
    $status.textContent = msg;
    $status.className = "rj-status" + (type ? ` rj-status--${type}` : "");
  }

  // ── Resolve a single entity name via the proxy ────────────────────
  async function resolveName(path) {
    if (nameCache[path]) return nameCache[path];
    try {
      const data = await api.proxyGenesys(org.id, "GET", path);
      const name = data.name || data.id || path;
      nameCache[path] = name;
      return name;
    } catch {
      return path; // fallback to raw ID
    }
  }

  // ── Build a human-readable filter summary from a job ─────────────
  async function buildFilterSummary(job) {
    const q   = job.conversationQuery || {};
    const sf  = q.segmentFilters || [];

    // Integration name
    let integrationName = job.integrationId || "—";
    if (job.integrationId) {
      integrationName = await resolveName(`/api/v2/integrations/${job.integrationId}`);
    }

    // Collect queue and user IDs from segmentFilters
    const queueIds = [];
    const userIds  = [];
    for (const filter of sf) {
      for (const clause of filter.clauses || []) {
        for (const pred of clause.predicates || []) {
          if (pred.dimension === "queueId") queueIds.push(pred.value);
          if (pred.dimension === "userId")  userIds.push(pred.value);
        }
      }
    }

    // Resolve names in parallel
    const [queueNames, userNames] = await Promise.all([
      Promise.all(queueIds.map((id) => resolveName(`/api/v2/routing/queues/${id}`))),
      Promise.all(userIds.map((id) => resolveName(`/api/v2/users/${id}`))),
    ]);

    return {
      interval:       q.interval || "—",
      integrationName,
      queues:         queueNames,
      users:          userNames,
      screenRec:      job.includeScreenRecordings,
      actionDate:     job.actionDate,
      createdBy:      job.createdBy?.name || job.createdBy?.id || "—",
    };
  }

  // ── Render the full table ─────────────────────────────────────────
  function renderTable() {
    if (!jobs.length) {
      $body.innerHTML = `
        <p class="sp-empty">
          No recording export jobs found for this org.
          <a href="#/interactions/recordings/create" class="is-link">Create one now</a>.
        </p>`;
      return;
    }

    // Sort: newest first
    const sorted = [...jobs].sort((a, b) =>
      (b.dateCreated || "").localeCompare(a.dateCreated || "")
    );

    const table = document.createElement("table");
    table.className = "data-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th></th>
          <th>Created</th>
          <th>State</th>
          <th>Conversations</th>
          <th>Recordings (est.)</th>
          <th>Created By</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="rjlTbody"></tbody>
    `;

    const tbody = table.querySelector("tbody");

    for (const job of sorted) {
      // Main row
      const tr = document.createElement("tr");
      tr.className = "rjl-row";
      tr.dataset.jobId = job.id;

      const canExecute = job.state === "READY";
      const canCancel  = ["PENDING", "PROCESSING", "READY"].includes(job.state);

      tr.innerHTML = `
        <td class="rjl-expand-cell">
          <button class="rjl-expand-btn" data-job="${escapeHtml(job.id)}" title="Show filters">&#9654;</button>
        </td>
        <td>${escapeHtml(formatDateTime(job.dateCreated))}</td>
        <td>${stateBadge(job.state)}</td>
        <td>${job.totalConversations ?? "—"}</td>
        <td>${job.totalRecordings ?? "—"}</td>
        <td>${escapeHtml(job.createdBy?.name || job.createdBy?.id || "—")}</td>
        <td class="rjl-actions-cell">
          ${canExecute
            ? `<button class="btn btn-sm btn-primary rjl-execute" data-job="${escapeHtml(job.id)}">Execute</button>`
            : ""}
          ${canCancel
            ? `<button class="btn btn-sm btn-danger rjl-cancel" data-job="${escapeHtml(job.id)}">Cancel</button>`
            : ""}
          <button class="btn btn-sm rjl-delete" data-job="${escapeHtml(job.id)}">Delete</button>
        </td>
      `;

      tbody.append(tr);

      // Detail row (hidden by default)
      const trDetail = document.createElement("tr");
      trDetail.className = "rjl-detail-row";
      trDetail.dataset.jobId = job.id;
      trDetail.setAttribute("data-job-id", job.id);
      trDetail.hidden = (expandedJobId !== job.id);

      const tdDetail = document.createElement("td");
      tdDetail.colSpan = 7;
      tdDetail.className = "rjl-detail-cell";
      tdDetail.innerHTML = `<p class="sp-empty">Loading filters…</p>`;
      trDetail.append(tdDetail);
      tbody.append(trDetail);

      // If this row is expanded, load its summary
      if (expandedJobId === job.id) {
        loadDetailCell(job, tdDetail);
      }
    }

    $body.innerHTML = "";
    $body.append(table);

    // ── Wire expand buttons ────────────────────────────────────────
    tbody.querySelectorAll(".rjl-expand-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const jobId   = btn.dataset.job;
        const isOpen  = expandedJobId === jobId;

        // Close any open row
        tbody.querySelectorAll(".rjl-detail-row").forEach((r) => (r.hidden = true));
        tbody.querySelectorAll(".rjl-expand-btn").forEach((b) => (b.textContent = "▶"));

        if (isOpen) {
          expandedJobId = null;
          return;
        }

        expandedJobId = jobId;
        btn.textContent = "▼";

        const detailRow  = tbody.querySelector(`.rjl-detail-row[data-job-id="${jobId}"]`);
        if (detailRow) {
          detailRow.hidden = false;
          const cell = detailRow.querySelector(".rjl-detail-cell");
          const job  = jobs.find((j) => j.id === jobId);
          if (job && cell) loadDetailCell(job, cell);
        }
      });
    });

    // ── Wire Execute ───────────────────────────────────────────────
    tbody.querySelectorAll(".rjl-execute").forEach((btn) => {
      btn.addEventListener("click", () => handleExecute(btn.dataset.job, btn));
    });

    // ── Wire Cancel ───────────────────────────────────────────────
    tbody.querySelectorAll(".rjl-cancel").forEach((btn) => {
      btn.addEventListener("click", () => handleCancel(btn.dataset.job, btn));
    });

    // ── Wire Delete ───────────────────────────────────────────────
    tbody.querySelectorAll(".rjl-delete").forEach((btn) => {
      btn.addEventListener("click", () => handleDelete(btn.dataset.job, btn));
    });
  }

  // ── Load detail cell content ─────────────────────────────────────
  async function loadDetailCell(job, cell) {
    cell.innerHTML = `<p class="sp-empty">Loading filters…</p>`;
    try {
      const s = await buildFilterSummary(job);

      cell.innerHTML = `
        <div class="rjl-detail">
          <div class="rjl-detail-grid">
            <span class="rjl-detail-key">Date Range</span>
            <span class="rjl-detail-val">${escapeHtml(formatInterval(s.interval))}</span>

            <span class="rjl-detail-key">Integration</span>
            <span class="rjl-detail-val">${escapeHtml(s.integrationName)}</span>

            <span class="rjl-detail-key">Queues</span>
            <span class="rjl-detail-val">${s.queues.length ? escapeHtml(s.queues.join(", ")) : "<em>All</em>"}</span>

            <span class="rjl-detail-key">Users</span>
            <span class="rjl-detail-val">${s.users.length ? escapeHtml(s.users.join(", ")) : "<em>All</em>"}</span>

            <span class="rjl-detail-key">Screen Recordings</span>
            <span class="rjl-detail-val">${s.screenRec ? "Included" : "Excluded"}</span>

            <span class="rjl-detail-key">Action Date</span>
            <span class="rjl-detail-val">${s.actionDate ? escapeHtml(formatDateTime(s.actionDate)) : "—"}</span>

            <span class="rjl-detail-key">Created By</span>
            <span class="rjl-detail-val">${escapeHtml(s.createdBy)}</span>
          </div>
        </div>
      `;
    } catch (err) {
      cell.innerHTML = `<p class="rj-error">Failed to load details: ${escapeHtml(err.message)}</p>`;
    }
  }

  // ── Action: Execute ───────────────────────────────────────────────
  async function handleExecute(jobId, btn) {
    if (!confirm("Execute this job? Genesys will begin exporting recordings to the storage integration.")) return;
    btn.disabled = true;
    btn.textContent = "Executing…";
    try {
      await api.proxyGenesys(org.id, "PUT", `/api/v2/recording/jobs/${jobId}`, {
        body: { state: "PROCESSING" },
      });
      setStatus("Job execution started.", "ok");
      await loadJobs();
    } catch (err) {
      setStatus(`Execute failed: ${err.message}`, "error");
      btn.disabled = false;
      btn.textContent = "Execute";
    }
  }

  // ── Action: Cancel ───────────────────────────────────────────────
  async function handleCancel(jobId, btn) {
    if (!confirm("Cancel this job?")) return;
    btn.disabled = true;
    btn.textContent = "Cancelling…";
    try {
      // Genesys cancels by setting state to CANCELLED via PUT
      await api.proxyGenesys(org.id, "PUT", `/api/v2/recording/jobs/${jobId}`, {
        body: { state: "CANCELLED" },
      });
      setStatus("Job cancelled.", "ok");
      await loadJobs();
    } catch (err) {
      setStatus(`Cancel failed: ${err.message}`, "error");
      btn.disabled = false;
      btn.textContent = "Cancel";
    }
  }

  // ── Action: Delete ───────────────────────────────────────────────
  async function handleDelete(jobId, btn) {
    if (!confirm("Delete this job? This cannot be undone.")) return;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await api.proxyGenesys(org.id, "DELETE", `/api/v2/recording/jobs/${jobId}`);
      setStatus("Job deleted.", "ok");
      await loadJobs();
    } catch (err) {
      setStatus(`Delete failed: ${err.message}`, "error");
      btn.disabled = false;
      btn.textContent = "Delete";
    }
  }

  // ── Load all jobs ─────────────────────────────────────────────────
  async function loadJobs() {
    try {
      $refresh.disabled = true;
      $refresh.textContent = "Loading…";

      // Fetch all job types
      const [exportJobs, deleteJobs, archiveJobs] = await Promise.all([
        api.proxyGenesys(org.id, "GET", "/api/v2/recording/jobs", {
          query: { pageSize: "100", jobType: "EXPORT" },
        }).catch(() => ({ entities: [] })),
        api.proxyGenesys(org.id, "GET", "/api/v2/recording/jobs", {
          query: { pageSize: "100", jobType: "DELETE" },
        }).catch(() => ({ entities: [] })),
        api.proxyGenesys(org.id, "GET", "/api/v2/recording/jobs", {
          query: { pageSize: "100", jobType: "ARCHIVE" },
        }).catch(() => ({ entities: [] })),
      ]);

      jobs = [
        ...(exportJobs.entities  || []),
        ...(deleteJobs.entities  || []),
        ...(archiveJobs.entities || []),
      ];

      renderTable();
    } catch (err) {
      $body.innerHTML = `<p class="rj-error">Failed to load jobs: ${escapeHtml(err.message)}</p>`;
    } finally {
      $refresh.disabled = false;
      $refresh.textContent = "↻ Refresh";
    }
  }

  $refresh.addEventListener("click", loadJobs);

  // ── Initial load ──────────────────────────────────────────────────
  loadJobs();

  return el;
}
