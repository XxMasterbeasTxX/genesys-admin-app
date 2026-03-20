/**
 * Users › Direct Routing — Add user(s)
 *
 * Assign the `directrouting` integration tag to user addresses (phone / email),
 * manage the primary phone, and configure agent-level backup routing.
 *
 * Flow:
 *   1. Select users from multi-select
 *   2. Click "Load Details" → fetches addresses + backup settings
 *   3. Configure DR tags, primary phone, and backup per user
 *   4. Click "Apply Changes" → PATCHes only modified users
 *
 * API endpoints:
 *   GET    /api/v2/users                                          — list users
 *   GET    /api/v2/users/{id}                                     — user detail (addresses, version)
 *   PATCH  /api/v2/users/{id}                                     — update addresses / primary
 *   GET    /api/v2/routing/users/{id}/directroutingbackup/settings — read backup
 *   PUT    /api/v2/routing/users/{id}/directroutingbackup/settings — set backup
 *   DELETE /api/v2/routing/users/{id}/directroutingbackup/settings — remove backup
 *   GET    /api/v2/routing/queues                                  — queue list (backup picker)
 */
import { escapeHtml, sleep } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { logAction } from "../../../services/activityLogService.js";

// Phone address types relevant for direct routing
const PHONE_TYPES = [
  { type: "WORK",  label: "Work Phone" },
  { type: "WORK2", label: "Work Phone 2" },
  { type: "WORK3", label: "Work Phone 3" },
];

function phoneLabel(type) {
  return PHONE_TYPES.find(t => t.type === type)?.label || type;
}

/** Build a snapshot of the current DR / primary / backup state for change detection. */
function takeSnapshot(user, backup) {
  const addrs = user.addresses || [];
  const drPhone = addrs.find(a => a.mediaType === "PHONE" && a.integration === "directrouting");
  const drEmails = addrs
    .filter(a => a.mediaType === "EMAIL" && a.integration === "directrouting")
    .map(a => a.type);

  const primaryPhone = (user.primaryContactInfo || []).find(c => c.mediaType === "PHONE");

  return {
    drPhoneType: drPhone?.type || "NONE",
    drEmails,
    primaryPhoneType: primaryPhone?.type || null,
    backupType: backup?.type || "NONE",
    backupUserId: backup?.user?.id || null,
    backupQueueId: backup?.queue?.id || null,
    waitForAgent: backup?.waitForAgent || false,
    agentWaitSeconds: backup?.agentWaitSeconds ?? 70,
  };
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderAddUsers({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Users — Direct Routing — Add user(s)</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  // ── State ───────────────────────────────────────────
  let isRunning = false;
  let cancelled = false;
  const loaded = new Map(); // userId → { user, backup, orig }
  let queuesCache = null;

  // ── User multi-select ───────────────────────────────
  const userSelect = createMultiSelect({
    placeholder: "Loading users…",
    searchable: true,
    onChange: (sel) => {
      $loadBtn.disabled = sel.size === 0 || isRunning;
    },
  });

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Users — Direct Routing — Add user(s)</h1>
    <hr class="hr">

    <p class="page-desc">
      Assign the <code>directrouting</code> integration tag to user phone numbers
      or email addresses, manage the primary phone number, and configure
      agent-level backup routing.
    </p>

    <!-- User picker -->
    <div class="cs-controls">
      <div class="cs-control-group">
        <label class="cs-label">Select Users</label>
        <div id="drUserSlot"></div>
      </div>
    </div>

    <div class="cs-actions">
      <button class="btn" id="drLoadBtn" disabled>Load Details</button>
    </div>

    <!-- Bulk pre-select (shown after loading) -->
    <div class="dr-bulk-wrap" id="drBulkWrap" style="display:none">
      <label class="cs-label" style="margin-bottom:0">Auto-tag phone type for all:</label>
      <select class="input dr-bulk-select" id="drBulkSelect">
        <option value="">— Choose —</option>
        <option value="NONE">None</option>
        <option value="WORK">Work Phone</option>
        <option value="WORK2">Work Phone 2</option>
        <option value="WORK3">Work Phone 3</option>
      </select>
    </div>

    <!-- User cards -->
    <div id="drCards" style="display:none"></div>

    <!-- Apply / Cancel -->
    <div class="cs-actions" id="drApplyWrap" style="display:none">
      <button class="btn dr-btn-apply" id="drApplyBtn">Apply Changes</button>
      <button class="btn" id="drCancelBtn" style="display:none">Cancel</button>
    </div>

    <!-- Status -->
    <div class="cs-status" id="drStatus">Loading users…</div>

    <!-- Progress bar -->
    <div class="cs-progress-wrap" id="drProgressWrap" style="display:none">
      <div class="cs-progress-bar" id="drProgressBar"></div>
    </div>

    <!-- Summary -->
    <div class="wc-summary" id="drSummary" style="display:none"></div>
  `;

  // Inject multi-select
  el.querySelector("#drUserSlot").append(userSelect.el);

  // ── DOM refs ────────────────────────────────────────
  const $loadBtn      = el.querySelector("#drLoadBtn");
  const $bulkWrap     = el.querySelector("#drBulkWrap");
  const $bulkSelect   = el.querySelector("#drBulkSelect");
  const $cards        = el.querySelector("#drCards");
  const $applyWrap    = el.querySelector("#drApplyWrap");
  const $applyBtn     = el.querySelector("#drApplyBtn");
  const $cancelBtn    = el.querySelector("#drCancelBtn");
  const $status       = el.querySelector("#drStatus");
  const $progressWrap = el.querySelector("#drProgressWrap");
  const $progressBar  = el.querySelector("#drProgressBar");
  const $summary      = el.querySelector("#drSummary");

  // ── Helpers ─────────────────────────────────────────
  const orgId = orgContext.get();

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
    $loadBtn.disabled = running;
    $applyBtn.disabled = running;
    userSelect.setEnabled(!running);
    $cancelBtn.style.display = running ? "" : "none";
    if ($bulkSelect) $bulkSelect.disabled = running;
  }

  async function loadQueues() {
    if (queuesCache) return queuesCache;
    queuesCache = await gc.fetchAllQueues(api, orgId);
    queuesCache.sort((a, b) => a.name.localeCompare(b.name));
    return queuesCache;
  }

  // ── Render one user card ────────────────────────────
  function createUserCard(userId) {
    const { user, backup } = loaded.get(userId);
    const addrs = user.addresses || [];
    const card = document.createElement("div");
    card.className = "dr-user-card";
    card.dataset.userId = userId;

    // Header
    const header = document.createElement("div");
    header.className = "dr-user-header";
    header.innerHTML = `<strong>${escapeHtml(user.name)}</strong>`;
    if (user.email) {
      header.innerHTML += ` <span class="dr-user-email">${escapeHtml(user.email)}</span>`;
    }
    card.append(header);

    // Find current states
    const drPhoneAddr = addrs.find(a => a.mediaType === "PHONE" && a.integration === "directrouting");
    const drPhoneType = drPhoneAddr?.type || "NONE";
    const primaryPhone = (user.primaryContactInfo || []).find(c => c.mediaType === "PHONE");
    const primaryPhoneType = primaryPhone?.type || null;

    // Address table
    const table = document.createElement("table");
    table.className = "dr-addr-table";
    table.innerHTML = `<thead><tr>
      <th>Type</th><th>Address</th><th>Primary</th><th>Direct Routing</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");

    // Index addresses by type for quick lookup
    const phoneByType = {};
    for (const a of addrs) {
      if (a.mediaType === "PHONE") phoneByType[a.type] = a;
    }

    // Phone rows
    for (const { type, label } of PHONE_TYPES) {
      const addr = phoneByType[type];
      const tr = document.createElement("tr");

      const tdType = document.createElement("td");
      tdType.textContent = label;

      const tdAddr = document.createElement("td");
      if (addr) {
        tdAddr.textContent = addr.display || addr.address || "—";
      } else {
        tdAddr.textContent = "—";
        tdAddr.className = "dr-addr-missing";
      }

      // Primary radio
      const tdPri = document.createElement("td");
      if (addr) {
        const r = document.createElement("input");
        r.type = "radio";
        r.name = `primary_${userId}`;
        r.value = type;
        r.checked = primaryPhoneType === type;
        tdPri.append(r);
      } else {
        tdPri.textContent = "—";
        tdPri.className = "dr-addr-missing";
      }

      // DR radio
      const tdDR = document.createElement("td");
      if (addr) {
        const r = document.createElement("input");
        r.type = "radio";
        r.name = `dr_phone_${userId}`;
        r.value = type;
        r.checked = drPhoneType === type;
        tdDR.append(r);
      } else {
        tdDR.textContent = "—";
        tdDR.className = "dr-addr-missing";
      }

      tr.append(tdType, tdAddr, tdPri, tdDR);
      tbody.append(tr);
    }

    // "None" option for DR phone
    const noneRow = document.createElement("tr");
    noneRow.className = "dr-none-row";
    const noneSpacerPhone = document.createElement("td");
    noneSpacerPhone.colSpan = 3;
    const noneTd = document.createElement("td");
    const noneLabel = document.createElement("label");
    noneLabel.className = "dr-none-label";
    const noneRadio = document.createElement("input");
    noneRadio.type = "radio";
    noneRadio.name = `dr_phone_${userId}`;
    noneRadio.value = "NONE";
    noneRadio.checked = drPhoneType === "NONE";
    noneLabel.append(noneRadio, document.createTextNode(" None"));
    noneTd.append(noneLabel);
    noneRow.append(noneSpacerPhone, noneTd);
    tbody.append(noneRow);

    // Email rows
    const emails = addrs.filter(a => a.mediaType === "EMAIL");
    for (const emailAddr of emails) {
      const tr = document.createElement("tr");

      const tdType = document.createElement("td");
      tdType.textContent = "Email" + (emailAddr.type && emailAddr.type !== "WORK" ? ` (${emailAddr.type})` : "");

      const tdAddr = document.createElement("td");
      tdAddr.textContent = emailAddr.display || emailAddr.address || "—";

      const tdPri = document.createElement("td");
      tdPri.textContent = "—";
      tdPri.className = "dr-addr-na";

      const tdDR = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.drEmail = userId;
      cb.value = emailAddr.type || "WORK";
      cb.checked = emailAddr.integration === "directrouting";
      tdDR.append(cb);

      tr.append(tdType, tdAddr, tdPri, tdDR);
      tbody.append(tr);
    }

    table.append(tbody);
    card.append(table);

    // ── Backup section ──
    const backupType = backup?.type || "NONE";

    const toggle = document.createElement("div");
    toggle.className = "dr-backup-toggle";
    toggle.innerHTML = `<span class="dr-backup-arrow">&#x25B6;</span> Backup Settings`;

    const section = document.createElement("div");
    section.className = "dr-backup-section";
    section.hidden = true;

    // Backup type radios
    const typeRow = document.createElement("div");
    typeRow.className = "dr-backup-row";
    typeRow.innerHTML = `<span class="dr-backup-lbl">Type:</span>`;
    for (const val of ["NONE", "USER", "QUEUE"]) {
      const lbl = document.createElement("label");
      const r = document.createElement("input");
      r.type = "radio";
      r.name = `bk_type_${userId}`;
      r.value = val;
      r.checked = backupType === val;
      lbl.append(r, document.createTextNode(` ${val === "NONE" ? "None" : val === "USER" ? "User" : "Queue"}`));
      typeRow.append(lbl);
    }
    section.append(typeRow);

    // Backup target area
    const targetDiv = document.createElement("div");
    targetDiv.className = "dr-backup-target";
    targetDiv.id = `bk_target_${userId}`;
    if (backupType === "NONE") targetDiv.style.display = "none";
    section.append(targetDiv);

    // Wait options
    const optsDiv = document.createElement("div");
    optsDiv.className = "dr-backup-row";
    optsDiv.id = `bk_opts_${userId}`;
    if (backupType === "NONE") optsDiv.style.display = "none";

    const waitLbl = document.createElement("label");
    const waitCb = document.createElement("input");
    waitCb.type = "checkbox";
    waitCb.id = `bk_wait_${userId}`;
    waitCb.checked = backup?.waitForAgent || false;
    waitLbl.append(waitCb, document.createTextNode(" Wait for Agent"));

    const secsLbl = document.createElement("label");
    secsLbl.textContent = "Wait (sec): ";
    const secsInput = document.createElement("input");
    secsInput.type = "number";
    secsInput.id = `bk_secs_${userId}`;
    secsInput.className = "input dr-input-num";
    secsInput.value = backup?.agentWaitSeconds ?? 70;
    secsInput.min = 0;
    secsInput.max = 600;
    secsLbl.append(secsInput);

    optsDiv.append(waitLbl, secsLbl);
    section.append(optsDiv);

    // Toggle logic
    toggle.addEventListener("click", () => {
      section.hidden = !section.hidden;
      toggle.querySelector(".dr-backup-arrow").innerHTML = section.hidden ? "&#x25B6;" : "&#x25BC;";
    });

    // Backup type change logic
    section.querySelectorAll(`input[name="bk_type_${userId}"]`).forEach(r => {
      r.addEventListener("change", () => {
        const t = r.value;
        targetDiv.style.display = t === "NONE" ? "none" : "";
        optsDiv.style.display   = t === "NONE" ? "none" : "";
        if (t !== "NONE") renderBackupTarget(targetDiv, userId, t, backup);
      });
    });

    // Render initial target if backup exists
    if (backupType !== "NONE") {
      renderBackupTarget(targetDiv, userId, backupType, backup);
    }

    card.append(toggle, section);
    return card;
  }

  // ── Render backup target picker ─────────────────────
  function renderBackupTarget(container, userId, type, currentBackup) {
    container.innerHTML = "";

    if (type === "USER") {
      const wrap = document.createElement("div");
      wrap.className = "dr-backup-user-search";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "input";
      input.placeholder = "Search for a backup user…";

      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.id = `bk_user_id_${userId}`;

      if (currentBackup?.user) {
        input.value = currentBackup.user.name || "";
        hidden.value = currentBackup.user.id || "";
      }

      const results = document.createElement("div");
      results.className = "dr-backup-search-results";

      let timer;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        hidden.value = "";
        const q = input.value.trim();
        if (q.length < 2) { results.innerHTML = ""; return; }
        timer = setTimeout(async () => {
          try {
            const resp = await api.proxyGenesys(orgId, "POST", "/api/v2/users/search", {
              body: {
                query: [{ type: "STARTS_WITH", fields: ["name"], value: q }],
                pageSize: 10,
                pageNumber: 1,
              },
            });
            const users = resp.results || [];
            results.innerHTML = "";
            for (const u of users) {
              const div = document.createElement("div");
              div.className = "dr-backup-search-item";
              div.textContent = u.name;
              div.addEventListener("click", () => {
                input.value = u.name;
                hidden.value = u.id;
                results.innerHTML = "";
              });
              results.append(div);
            }
            if (!users.length) {
              results.innerHTML = `<div class="dr-backup-search-item" style="color:var(--muted)">No results</div>`;
            }
          } catch {
            results.innerHTML = `<div class="dr-backup-search-item" style="color:#f87171">Search failed</div>`;
          }
        }, 300);
      });

      // Close results on outside click
      document.addEventListener("pointerdown", (e) => {
        if (!wrap.contains(e.target)) results.innerHTML = "";
      });

      wrap.append(input, hidden, results);
      container.append(wrap);
    } else if (type === "QUEUE") {
      const select = document.createElement("select");
      select.className = "input";
      select.id = `bk_queue_id_${userId}`;
      select.innerHTML = `<option value="">Loading queues…</option>`;
      container.append(select);

      loadQueues().then(queues => {
        select.innerHTML = `<option value="">— Select a queue —</option>` +
          queues.map(q =>
            `<option value="${escapeHtml(q.id)}"${currentBackup?.queue?.id === q.id ? " selected" : ""}>${escapeHtml(q.name)}</option>`
          ).join("");
      }).catch(() => {
        select.innerHTML = `<option value="">Failed to load queues</option>`;
      });
    }
  }

  // ── Read current state from DOM ─────────────────────
  function readCurrentState(userId) {
    const drPhoneRadio = el.querySelector(`input[name="dr_phone_${userId}"]:checked`);
    const drPhoneType = drPhoneRadio?.value || "NONE";

    const drEmails = [];
    el.querySelectorAll(`input[data-dr-email="${userId}"]`).forEach(cb => {
      if (cb.checked) drEmails.push(cb.value);
    });

    const primaryRadio = el.querySelector(`input[name="primary_${userId}"]:checked`);
    const primaryPhoneType = primaryRadio?.value || null;

    const bkRadio = el.querySelector(`input[name="bk_type_${userId}"]:checked`);
    const backupType = bkRadio?.value || "NONE";

    let backupUserId = null;
    let backupQueueId = null;
    if (backupType === "USER") {
      backupUserId = el.querySelector(`#bk_user_id_${userId}`)?.value || null;
    } else if (backupType === "QUEUE") {
      backupQueueId = el.querySelector(`#bk_queue_id_${userId}`)?.value || null;
    }

    const waitForAgent = el.querySelector(`#bk_wait_${userId}`)?.checked || false;
    const agentWaitSeconds = parseInt(el.querySelector(`#bk_secs_${userId}`)?.value, 10) || 70;

    return { drPhoneType, drEmails, primaryPhoneType, backupType, backupUserId, backupQueueId, waitForAgent, agentWaitSeconds };
  }

  // ── Load Details handler ────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const selectedIds = [...userSelect.getSelected()];
    if (!selectedIds.length) return;

    cancelled = false;
    setRunning(true);
    loaded.clear();
    $cards.style.display = "none";
    $bulkWrap.style.display = "none";
    $applyWrap.style.display = "none";
    $summary.style.display = "none";
    hideProgress();

    const BATCH = 10;
    let completed = 0;

    try {
      for (let i = 0; i < selectedIds.length; i += BATCH) {
        if (cancelled) break;
        const batch = selectedIds.slice(i, i + BATCH);

        const promises = batch.flatMap(uid => [
          gc.getUser(api, orgId, uid),
          gc.getDirectRoutingBackup(api, orgId, uid),
        ]);
        const results = await Promise.allSettled(promises);

        for (let j = 0; j < batch.length; j++) {
          const uid = batch[j];
          const userResult = results[j * 2];
          const bkResult   = results[j * 2 + 1];

          if (userResult.status === "fulfilled") {
            const user = userResult.value;
            const backup = bkResult.status === "fulfilled" ? bkResult.value : null;
            loaded.set(uid, { user, backup, orig: takeSnapshot(user, backup) });
          }

          completed++;
          const pct = (completed / selectedIds.length) * 100;
          showProgress(pct);
          setStatus(`Loading user ${completed} of ${selectedIds.length}…`);
        }
      }

      if (!loaded.size) {
        setStatus("No user details could be loaded.", "error");
      } else {
        // Render cards
        $cards.innerHTML = "";
        for (const uid of loaded.keys()) {
          $cards.append(createUserCard(uid));
        }
        $cards.style.display = "";
        $bulkWrap.style.display = "";
        $bulkSelect.value = "";
        $applyWrap.style.display = "";
        setStatus(`Loaded ${loaded.size} user${loaded.size > 1 ? "s" : ""}. Review settings and click Apply Changes.`);
      }

      setTimeout(hideProgress, 600);
    } catch (err) {
      setStatus(`Error loading details: ${err.message}`, "error");
      console.error("DR load error:", err);
      hideProgress();
    } finally {
      setRunning(false);
    }
  });

  // ── Bulk pre-select handler ─────────────────────────
  $bulkSelect.addEventListener("change", () => {
    const val = $bulkSelect.value;
    if (!val) return;

    for (const uid of loaded.keys()) {
      if (val === "NONE") {
        const noneRadio = el.querySelector(`input[name="dr_phone_${uid}"][value="NONE"]`);
        if (noneRadio) noneRadio.checked = true;
      } else {
        // Only select if the user has that phone type
        const radio = el.querySelector(`input[name="dr_phone_${uid}"][value="${val}"]`);
        if (radio) radio.checked = true;
      }
    }
    $bulkSelect.value = "";
  });

  // ── Apply Changes handler ───────────────────────────
  $applyBtn.addEventListener("click", async () => {
    // Build list of changed users
    const changes = [];
    for (const [uid, data] of loaded) {
      const curr = readCurrentState(uid);
      const orig = data.orig;

      const addressChanged =
        orig.drPhoneType !== curr.drPhoneType ||
        JSON.stringify(orig.drEmails) !== JSON.stringify(curr.drEmails) ||
        orig.primaryPhoneType !== curr.primaryPhoneType;

      const backupChanged =
        orig.backupType !== curr.backupType ||
        orig.backupUserId !== curr.backupUserId ||
        orig.backupQueueId !== curr.backupQueueId ||
        orig.waitForAgent !== curr.waitForAgent ||
        orig.agentWaitSeconds !== curr.agentWaitSeconds;

      if (addressChanged || backupChanged) {
        changes.push({ uid, data, curr, addressChanged, backupChanged });
      }
    }

    if (!changes.length) {
      setStatus("No changes detected.", "error");
      return;
    }

    cancelled = false;
    setRunning(true);
    $summary.style.display = "none";
    hideProgress();

    let success = 0, failed = 0;
    const errors = [];

    try {
      for (let i = 0; i < changes.length; i++) {
        if (cancelled) break;
        const { uid, data, curr, addressChanged, backupChanged } = changes[i];

        setStatus(`Applying changes ${i + 1} of ${changes.length}… ${escapeHtml(data.user.name)}`);
        showProgress(((i + 1) / changes.length) * 100);

        try {
          // ── Address / primary PATCH ──
          if (addressChanged) {
            const updatedAddresses = (data.user.addresses || []).map(addr => {
              const clone = { ...addr };
              if (addr.mediaType === "PHONE") {
                clone.integration = curr.drPhoneType === addr.type ? "directrouting" : "";
              } else if (addr.mediaType === "EMAIL") {
                clone.integration = curr.drEmails.includes(addr.type || "WORK") ? "directrouting" : "";
              }
              return clone;
            });

            const body = { version: data.user.version, addresses: updatedAddresses };

            // Update primary phone if changed
            if (data.orig.primaryPhoneType !== curr.primaryPhoneType && curr.primaryPhoneType) {
              const newPrimary = updatedAddresses.find(
                a => a.mediaType === "PHONE" && a.type === curr.primaryPhoneType
              );
              if (newPrimary) {
                const otherPrimary = (data.user.primaryContactInfo || [])
                  .filter(c => c.mediaType !== "PHONE");
                body.primaryContactInfo = [
                  ...otherPrimary,
                  { address: newPrimary.address, display: newPrimary.display, mediaType: "PHONE", type: newPrimary.type },
                ];
              }
            }

            const patchResult = await gc.patchUser(api, orgId, uid, body);
            // Update cached version for potential reapply
            if (patchResult?.version) data.user.version = patchResult.version;
          }

          // ── Backup PUT / DELETE ──
          if (backupChanged) {
            if (curr.backupType === "NONE") {
              if (data.orig.backupType !== "NONE") {
                await gc.deleteDirectRoutingBackup(api, orgId, uid);
              }
            } else {
              const bkBody = {
                type: curr.backupType,
                waitForAgent: curr.waitForAgent,
                agentWaitSeconds: curr.agentWaitSeconds,
              };
              if (curr.backupType === "USER" && curr.backupUserId) {
                bkBody.user = { id: curr.backupUserId };
              } else if (curr.backupType === "QUEUE" && curr.backupQueueId) {
                bkBody.queue = { id: curr.backupQueueId };
              }
              await gc.putDirectRoutingBackup(api, orgId, uid, bkBody);
            }
          }

          success++;
        } catch (err) {
          failed++;
          errors.push(`${data.user.name}: ${(err.message || String(err)).slice(0, 120)}`);
        }

        if (i < changes.length - 1) await sleep(50);
      }

      // Summary
      showProgress(100);
      const parts = [];
      if (success) parts.push(`Success: ${success}`);
      if (failed)  parts.push(`Failed: ${failed}`);
      const summaryText = cancelled
        ? `Cancelled. ${parts.join("  •  ")}`
        : parts.join("  •  ");

      $summary.innerHTML = escapeHtml(summaryText);
      if (errors.length) {
        $summary.innerHTML += `<br><small style="color:#f87171">${errors.map(e => escapeHtml(e)).join("<br>")}</small>`;
      }
      $summary.style.display = "";

      setStatus(cancelled ? "Cancelled." : "Done.", failed ? "error" : "success");
      setTimeout(hideProgress, 800);

      logAction({
        me, orgId,
        action: "direct_routing_add",
        description: `DR updated for ${success} user${success !== 1 ? "s" : ""}${failed ? ` (${failed} failed)` : ""}${cancelled ? " [cancelled]" : ""}`,
        result: success === 0 && failed > 0 ? "failure" : failed > 0 || cancelled ? "partial" : "success",
        count: success + failed,
      });
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
      console.error("DR apply error:", err);
      hideProgress();
    } finally {
      setRunning(false);
    }
  });

  // ── Cancel ──────────────────────────────────────────
  $cancelBtn.addEventListener("click", () => { cancelled = true; });

  // ── Load users on mount ─────────────────────────────
  (async () => {
    try {
      const users = await gc.fetchAllUsers(api, orgId);
      userSelect.setItems(users.map(u => ({ id: u.id, label: u.name })));
      userSelect.setPlaceholder("Select users…");
      setStatus("Ready. Select users and click Load Details.");
    } catch (err) {
      setStatus(`Failed to load users: ${err.message}`, "error");
      console.error("User load error:", err);
    }
  })();

  return el;
}
