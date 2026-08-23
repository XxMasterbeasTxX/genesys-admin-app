/**
 * Users › Direct Routing — Add user(s)
 *
 * Assign the `directrouting` integration tag to user addresses (phone / email)
 * and configure agent-level backup routing.
 *
 * Genesys allows one `directrouting` tag per media type, so the phone and the
 * email choices are each one-of-N. Primary phone is shown but not editable:
 * `primaryContactInfo` is readOnly and auto-populated from `addresses`.
 *
 * Flow:
 *   1. Select users, optionally narrowed by group
 *   2. Click "Load Details" → fetches addresses + backup settings
 *   3. Configure DR tags and backup per user
 *   4. Click "Apply Changes" → PATCHes only modified users
 *
 * API endpoints:
 *   GET    /api/v2/users                                          — list users
 *   GET    /api/v2/users/{id}                                     — user detail (addresses, version)
 *   PATCH  /api/v2/users/{id}                                     — update addresses
 *   GET    /api/v2/groups, /api/v2/groups/{id}/members             — group filter
 *   GET    /api/v2/routing/email/domains                           — inbound domain check
 *   GET    /api/v2/routing/users/{id}/directroutingbackup/settings — read backup
 *   PUT    /api/v2/routing/users/{id}/directroutingbackup/settings — set backup
 *   DELETE /api/v2/routing/users/{id}/directroutingbackup/settings — remove backup
 *   GET    /api/v2/routing/queues                                  — queue list (backup picker)
 */
import { escapeHtml, sleep, makeStatus } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";
import { createMultiSelect } from "../../../components/multiSelect.js";
import { logAction } from "../../../services/activityLogService.js";

// Phone address types relevant for direct routing
const PHONE_TYPES = [
  { type: "WORK",  label: "Work Phone" },
  { type: "WORK2", label: "Work Phone 2" },
  { type: "WORK3", label: "Work Phone 3" },
];

/**
 * Narrow the user picker's options to the selected groups.
 *
 * Pure — no API, no DOM — so the rule can be read and tested on its own. It
 * mirrors `applyUserFilters` in createWebRtc, with one addition that page does
 * not need: **a filter narrows what is offered, never what is already held.**
 * An already-selected user survives a filter that excludes them, labelled so
 * the reason is legible. Dropping them instead would silently untick people the
 * operator picked before reaching for the filter, and they would find out after
 * Apply.
 *
 * @param {{id: string, name: string}[]} users  Active users, already loaded.
 * @param {Set<string>|null} groupMemberIds     Union of the selected groups'
 *   members, or null when no group filter is set.
 * @param {Set<string>} selectedIds             Currently ticked user ids.
 * @returns {{id: string, label: string}[]}
 */
export function filterUserOptions(users, groupMemberIds, selectedIds) {
  return users
    .filter((u) => !groupMemberIds || groupMemberIds.has(u.id) || selectedIds.has(u.id))
    .map((u) => ({
      id: u.id,
      label: groupMemberIds && !groupMemberIds.has(u.id)
        ? `${u.name} (not in filter)`
        : u.name,
    }));
}

// ── Page renderer ───────────────────────────────────────────────────

export default function renderAddUsers({ route, me, api, orgContext, access }) {
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
  let emailDomainsCache = null; // Set<string> of inbound email domains
  let emailDomainsAvailable = false; // false = the lookup failed, not "none exist"
  let allUsers = [];                 // [{ id, name }] — active users, loaded once
  const groupMembers = new Map();    // groupId → Set<userId>, memoised for the page
  let filterToken = 0;               // guards against a slow fetch landing late

  // ── User multi-select ───────────────────────────────
  const userSelect = createMultiSelect({
    placeholder: "Loading users…",
    searchable: true,
    onChange: (sel) => {
      $loadBtn.disabled = sel.size === 0 || isRunning;
    },
  });

  // ── Group filter ────────────────────────────────────
  // Narrows the user picker. Optional: "All groups" means no filter, and a
  // failure to load groups hides the filter rather than taking the page with
  // it — the same rule createWebRtc states, where sites gate the page and the
  // filters do not.
  const groupSelect = createMultiSelect({
    placeholder: "All groups",
    searchable: true,
    onChange: () => { applyGroupFilter(); },
  });

  // ── Build UI ────────────────────────────────────────
  el.innerHTML = `
    <h1 class="h1">Users — Direct Routing — Add user(s)</h1>
    <hr class="hr">

    <p class="page-desc">
      Assign the <code>directrouting</code> integration tag to one phone number
      and one email address per user, and configure agent-level backup routing.
      Primary phone is shown for reference — Genesys derives it from the
      addresses and it cannot be set here.
    </p>

    <!-- User picker, with an optional group filter beside it that narrows
         what the picker offers; leaving it empty considers every active user. -->
    <div class="cs-controls">
      <div class="cs-control-group">
        <label class="cs-label">Select Users</label>
        <div id="drUserSlot"></div>
      </div>
      <div class="cs-control-group" id="drGroupWrap" hidden>
        <label class="cs-label">Filter by Group</label>
        <div id="drGroupSlot"></div>
        <div class="dr-filter-note" id="drGroupNote"></div>
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

  // Inject multi-selects
  el.querySelector("#drUserSlot").append(userSelect.el);
  el.querySelector("#drGroupSlot").append(groupSelect.el);

  // ── DOM refs ────────────────────────────────────────
  const $loadBtn      = el.querySelector("#drLoadBtn");
  const $groupWrap    = el.querySelector("#drGroupWrap");
  const $groupNote    = el.querySelector("#drGroupNote");
  const $bulkWrap     = el.querySelector("#drBulkWrap");
  const $bulkSelect   = el.querySelector("#drBulkSelect");
  const $cards        = el.querySelector("#drCards");
  const $applyWrap    = el.querySelector("#drApplyWrap");
  const $applyBtn     = el.querySelector("#drApplyBtn");
  const $cancelBtn    = el.querySelector("#drCancelBtn");
  const $status       = el.querySelector("#drStatus");
  const $progressWrap = el.querySelector("#drProgressWrap");
  const $progressBar  = el.querySelector("#drProgressBar");

  // Per-action permission gating (internal refinement): only apply the changes
  // the user holds the Genesys permission for (addresses vs. backup routing).
  const canEditAddresses = access && access.can ? access.can("users.directRouting.add", "addresses") : true;
  const canEditBackup    = access && access.can ? access.can("users.directRouting.add", "backup") : true;
  const $summary      = el.querySelector("#drSummary");

  // ── Helpers ─────────────────────────────────────────
  const orgId = orgContext.get();

  const setStatus = makeStatus($status, "cs-status");
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
    groupSelect.setEnabled(!running);
    $cancelBtn.style.display = running ? "" : "none";
    if ($bulkSelect) $bulkSelect.disabled = running;
  }

  /**
   * Re-offer the user picker for the current group selection.
   *
   * Membership costs one call per group, so results are memoised for the life
   * of the page and only groups not seen before are fetched. A group whose
   * members cannot be read contributes nothing rather than failing the filter.
   */
  async function applyGroupFilter() {
    const groupIds = [...groupSelect.getSelected()];
    const token = ++filterToken;

    if (!groupIds.length) {
      $groupNote.textContent = "";
      userSelect.setItemsKeepSelection(
        filterUserOptions(allUsers, null, userSelect.getSelected())
      );
      return;
    }

    const missing = groupIds.filter((id) => !groupMembers.has(id));
    const announced = missing.length > 0;
    if (missing.length) {
      setStatus(`Reading members of ${missing.length} group${missing.length === 1 ? "" : "s"}…`);
      const lists = await Promise.all(
        missing.map((id) =>
          gc.fetchGroupMembers(api, orgId, id)
            .then((ms) => ms.map((m) => m.id))
            .catch(() => [])
        )
      );
      missing.forEach((id, i) => groupMembers.set(id, new Set(lists[i])));
      // A newer selection landed while this was in flight — that one owns the
      // picker now. The members just fetched stay cached and are not wasted.
      if (token !== filterToken) return;
    }

    const memberIds = new Set();
    for (const id of groupIds) {
      for (const uid of groupMembers.get(id) || []) memberIds.add(uid);
    }

    // Group membership ignores user state; the picker holds active users only.
    // Say so rather than offering a group of 14 that quietly yields 12.
    const activeIds = new Set(allUsers.map((u) => u.id));
    const inactive = [...memberIds].filter((id) => !activeIds.has(id)).length;
    $groupNote.textContent = inactive
      ? `${inactive} member${inactive === 1 ? " is" : "s are"} not an active user and cannot be configured here.`
      : "";

    userSelect.setItemsKeepSelection(
      filterUserOptions(allUsers, memberIds, userSelect.getSelected())
    );
    // Only take the status line back if this call borrowed it. Filtering after
    // a load would otherwise wipe the "Loaded N users" message while the cards
    // it describes are still on screen.
    if (announced) setStatus("Ready. Select users and click Load Details.");
  }

  async function loadQueues() {
    if (queuesCache) return queuesCache;
    queuesCache = await gc.fetchAllQueues(api, orgId);
    queuesCache.sort((a, b) => a.name.localeCompare(b.name));
    return queuesCache;
  }

  async function loadEmailDomains() {
    if (emailDomainsCache) return emailDomainsCache;
    try {
      const domains = await gc.fetchAllEmailDomains(api, orgId);
      emailDomainsCache = new Set(domains.map(d => (d.id || d.name || "").toLowerCase()));
      emailDomainsAvailable = true;
    } catch {
      // Could not check — most often a missing `routing:email:manage`, which is
      // not implied by the permission this page is gated on. An empty set here
      // must not be read as "no domains are configured": see the render, which
      // keys on `emailDomainsAvailable` rather than on the set being empty.
      emailDomainsCache = new Set();
      emailDomainsAvailable = false;
    }
    return emailDomainsCache;
  }

  /** Make a radio deselectable: clicking a checked radio unchecks it. */
  function makeDeselectable(radio, onDeselect) {
    radio.addEventListener("mousedown", function () { this._wasChecked = this.checked; });
    radio.addEventListener("click", function () {
      if (this._wasChecked) {
        this.checked = false;
        if (onDeselect) onDeselect();
      }
    });
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

    // ── Collapsible Addresses section ──
    const addrToggle = document.createElement("div");
    addrToggle.className = "dr-backup-toggle";
    addrToggle.innerHTML = `<span class="dr-backup-arrow">&#x25B6;</span> Addresses`;

    const addrSection = document.createElement("div");
    addrSection.className = "dr-backup-section dr-addr-section";
    addrSection.hidden = true;

    addrToggle.addEventListener("click", () => {
      addrSection.hidden = !addrSection.hidden;
      addrToggle.querySelector(".dr-backup-arrow").innerHTML = addrSection.hidden ? "&#x25B6;" : "&#x25BC;";
    });

    // Address table.
    // Integration is shown because this page writes it: without the column,
    // replacing a foreign tag (microsoftteams and the like) was invisible both
    // before and after it happened.
    const table = document.createElement("table");
    table.className = "dr-addr-table";
    table.innerHTML = `<thead><tr>
      <th>Type</th><th>Address</th><th>Integration</th><th>Primary</th><th>Direct Routing</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");

    // Index addresses by type for quick lookup
    const phoneByType = {};
    for (const a of addrs) {
      if (a.mediaType === "PHONE") phoneByType[a.type] = a;
    }

    // Create the NONE radio first so phone DR radios can reference it on deselect
    const noneRadio = document.createElement("input");
    noneRadio.type = "radio";
    noneRadio.name = `dr_phone_${userId}`;
    noneRadio.value = "NONE";
    noneRadio.checked = drPhoneType === "NONE";

    /** One cell showing an address's current integration tag. */
    function integrationCell(addr) {
      const td = document.createElement("td");
      if (!addr || !addr.integration) {
        td.textContent = "—";
        td.className = "dr-addr-na";
      } else if (addr.integration === "directrouting") {
        td.textContent = "directrouting";
      } else {
        // A tag this page does not own. It is preserved on save unless the
        // address is chosen for direct routing, which replaces it — so it is
        // called out rather than shown as ordinary text.
        td.textContent = addr.integration;
        td.className = "dr-addr-foreign";
        td.title = `${addr.integration} — choosing this address for direct routing replaces this tag`;
      }
      return td;
    }

    /** Address cell that keeps the full value reachable when it truncates. */
    function addressCell(text, missing) {
      const td = document.createElement("td");
      td.textContent = text || "—";
      if (missing) td.className = "dr-addr-missing";
      else if (text) td.title = text;
      return td;
    }

    // Phone rows
    for (const { type, label } of PHONE_TYPES) {
      const addr = phoneByType[type];
      const tr = document.createElement("tr");

      const tdType = document.createElement("td");
      tdType.textContent = label;

      const tdAddr = addressCell(addr ? (addr.display || addr.address) : "", !addr);
      const tdInt = integrationCell(addr);

      // Primary is read-only: primaryContactInfo is readOnly on both User and
      // UpdateUser and is auto-populated from addresses, so the radio that used
      // to live here promised an edit the API does not accept. Showing which
      // address Genesys reports as primary keeps the information without the
      // promise. See §4 of the design doc.
      const tdPri = document.createElement("td");
      if (!addr) {
        tdPri.textContent = "—";
        tdPri.className = "dr-addr-missing";
      } else if (primaryPhoneType === type) {
        tdPri.textContent = "✓";
        tdPri.className = "dr-addr-primary";
        tdPri.title = "Genesys reports this as the primary phone";
      } else {
        tdPri.textContent = "—";
        tdPri.className = "dr-addr-na";
      }

      // DR radio
      const tdDR = document.createElement("td");
      if (addr) {
        const r = document.createElement("input");
        r.type = "radio";
        r.name = `dr_phone_${userId}`;
        r.value = type;
        r.checked = drPhoneType === type;
        makeDeselectable(r, () => { noneRadio.checked = true; });
        tdDR.append(r);
      } else {
        tdDR.textContent = "—";
        tdDR.className = "dr-addr-missing";
      }

      tr.append(tdType, tdAddr, tdInt, tdPri, tdDR);
      tbody.append(tr);
    }

    // "None" option for DR phone
    const noneRow = document.createElement("tr");
    noneRow.className = "dr-none-row";
    const noneSpacerPhone = document.createElement("td");
    noneSpacerPhone.colSpan = 4;
    const noneTd = document.createElement("td");
    const noneLabel = document.createElement("label");
    noneLabel.className = "dr-none-label";
    noneLabel.append(noneRadio, document.createTextNode(" None"));
    noneTd.append(noneLabel);
    noneRow.append(noneSpacerPhone, noneTd);
    tbody.append(noneRow);

    // Email rows.
    // Genesys supports one directrouting tag per media type, so these are a
    // radio group like the phones, not the checkboxes that used to allow two
    // emails to be tagged at once. Keyed by index: two EMAIL addresses can
    // share a type, and keying on type silently merged them.
    const emails = addrs.filter(a => a.mediaType === "EMAIL");
    const emailNoneRadio = document.createElement("input");
    emailNoneRadio.type = "radio";
    emailNoneRadio.name = `dr_email_${userId}`;
    emailNoneRadio.value = "NONE";
    emailNoneRadio.checked = !emails.some(a => a.integration === "directrouting");

    emails.forEach((emailAddr, idx) => {
      const tr = document.createElement("tr");
      const address = emailAddr.display || emailAddr.address || "";
      const domain = address.includes("@") ? address.split("@")[1].toLowerCase() : "";
      // Three states, not two. When the lookup itself failed we do not know
      // whether the domain is routable, and must not claim that it is not.
      const domainKnown = emailDomainsAvailable && !!domain;
      const domainExists = domainKnown && emailDomainsCache.has(domain);

      const tdType = document.createElement("td");
      tdType.textContent = "Email" + (emailAddr.type && emailAddr.type !== "WORK" ? ` (${emailAddr.type})` : "");

      const tdAddr = addressCell(address, false);
      const tdInt = integrationCell(emailAddr);

      const tdPri = document.createElement("td");
      tdPri.textContent = "—";
      tdPri.className = "dr-addr-na";

      // Offered whenever the domain is not known to be absent: a missing
      // routing:email:manage must not remove a write the admin does hold.
      // An address already tagged still gets its control even on an absent
      // domain — disabled, so the tag cannot be added here, but visible and
      // removable via None. Rendering nothing would hide a live tag and let
      // the row read as untagged.
      const tagged = emailAddr.integration === "directrouting";
      const tdDR = document.createElement("td");
      if (!domainKnown || domainExists || tagged) {
        const r = document.createElement("input");
        r.type = "radio";
        r.name = `dr_email_${userId}`;
        r.value = String(idx);
        r.checked = tagged;
        if (domainKnown && !domainExists) {
          r.disabled = true;
          r.title = "The domain is not configured for inbound email — this tag can be removed but not re-added here.";
        } else {
          makeDeselectable(r, () => { emailNoneRadio.checked = true; });
        }
        tdDR.append(r);
      } else {
        tdDR.textContent = "—";
        tdDR.className = "dr-addr-na";
      }

      tr.append(tdType, tdAddr, tdInt, tdPri, tdDR);
      tbody.append(tr);

      const note = !domainKnown
        ? "Inbound email domains could not be read (requires routing:email:manage) — the domain is not being checked."
        : !domainExists
          ? `Domain "${domain}" is not configured as an inbound email domain in Genesys — emails cannot be routed to this address.`
          : "";
      if (note) {
        const warnTr = document.createElement("tr");
        warnTr.className = "dr-email-warn-row";
        const warnTd = document.createElement("td");
        warnTd.colSpan = 5;
        warnTd.className = domainKnown ? "dr-email-warn" : "dr-email-note";
        warnTd.textContent = note;
        warnTr.append(warnTd);
        tbody.append(warnTr);
      }
    });

    if (emails.length) {
      const eNoneRow = document.createElement("tr");
      eNoneRow.className = "dr-none-row";
      const eSpacer = document.createElement("td");
      eSpacer.colSpan = 4;
      const eNoneTd = document.createElement("td");
      const eNoneLabel = document.createElement("label");
      eNoneLabel.className = "dr-none-label";
      eNoneLabel.append(emailNoneRadio, document.createTextNode(" None"));
      eNoneTd.append(eNoneLabel);
      eNoneRow.append(eSpacer, eNoneTd);
      tbody.append(eNoneRow);
    }

    table.append(tbody);
    addrSection.append(table);
    card.append(addrToggle, addrSection);

    // ── Backup section ──
    // Derived from the flat model the API actually returns. `type` never
    // existed, so this used to be "NONE" for every user with a backup set —
    // which then read back as a deliberate "no backup" and cleared it on Apply.
    // §2.2 replaces the radio group with two independent pickers, at which
    // point a user and a queue can be set at once; until then the user backup
    // wins the display, matching its precedence as the primary.
    const backupType = backup?.userId ? "USER" : backup?.queueId ? "QUEUE" : "NONE";

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

    // ── Per-section permission gating (internal refinement) ──
    // Lock the section(s) the user lacks the Genesys permission for.
    if (!canEditAddresses) {
      addrSection.style.pointerEvents = "none";
      addrSection.style.opacity = "0.5";
      addrToggle.title = "Requires Genesys permission: directory:user:edit";
      const note = document.createElement("div");
      note.style.cssText = "color:var(--muted);font-size:12px;margin:4px 0";
      note.textContent = "You lack the Genesys permission to change addresses / direct routing (directory:user:edit).";
      addrSection.prepend(note);
    }
    if (!canEditBackup) {
      section.style.pointerEvents = "none";
      section.style.opacity = "0.5";
      toggle.title = "Requires Genesys permission: routing:directRoutingBackup:edit";
      const note = document.createElement("div");
      note.style.cssText = "color:var(--muted);font-size:12px;margin:4px 0";
      note.textContent = "You lack the Genesys permission to change backup routing (routing:directRoutingBackup:edit).";
      section.prepend(note);
    }

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

      // The API returns only `userId` — no name. Holding the id in the hidden
      // field is what stops an existing backup being cleared by an Apply that
      // never touched it; resolving the id to a display name is §2.2's job.
      if (currentBackup?.userId) {
        hidden.value = currentBackup.userId;
        input.placeholder = "Current backup user — search to change";
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

      // No label on this row, so the throbber sits beside the select itself.
      const spin = document.createElement("span");
      spin.className = "spin spin--sm spin--label";
      spin.setAttribute("aria-hidden", "true");
      container.append(spin);

      loadQueues().then(queues => {
        select.innerHTML = `<option value="">— Select a queue —</option>` +
          queues.map(q =>
            `<option value="${escapeHtml(q.id)}"${currentBackup?.queueId === q.id ? " selected" : ""}>${escapeHtml(q.name)}</option>`
          ).join("");
      }).catch(() => {
        select.innerHTML = `<option value="">Failed to load queues</option>`;
      }).finally(() => spin.remove());
    }
  }

  // ── Read current state from DOM ─────────────────────
  function readCurrentState(userId) {
    const drPhoneRadio = el.querySelector(`input[name="dr_phone_${userId}"]:checked`);
    const drPhoneType = drPhoneRadio?.value || "NONE";

    // One email at most: Genesys allows a single directrouting tag per media
    // type. The value is the address's index, since two EMAIL addresses can
    // share a type.
    const drEmailRadio = el.querySelector(`input[name="dr_email_${userId}"]:checked`);
    const drEmailIndex = drEmailRadio && drEmailRadio.value !== "NONE"
      ? Number(drEmailRadio.value)
      : null;

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

    return { drPhoneType, drEmailIndex, backupType, backupUserId, backupQueueId, waitForAgent, agentWaitSeconds };
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
      // Fetch email domains in parallel with user details
      const emailDomainPromise = loadEmailDomains();

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
            const userAddrs = user.addresses || [];
            const workPhoneTypes = new Set(PHONE_TYPES.map(t => t.type));
            const hasPhone = userAddrs.some(a => a.mediaType === "PHONE" && workPhoneTypes.has(a.type));
            const hasEmail = userAddrs.some(a => a.mediaType === "EMAIL");
            // Skip users with no phone and no email addresses
            if (hasPhone || hasEmail) {
              // getDirectRoutingBackup now reports which of "none" / "denied" /
              // "ok" it got. The tagged result is kept whole — the backup
              // section needs the distinction — and `settings` is what the
              // existing render and snapshot read.
              // A rejection is not a refusal: it may be a 500 or a dropped
              // connection. Only the helper can say "denied", so anything that
              // reaches here as a rejection is tagged "error" and rendered as a
              // failure to read rather than as a missing permission.
              const backupResult = bkResult.status === "fulfilled"
                ? bkResult.value
                : { state: "error", settings: null };
              const backup = backupResult.settings;
              // `orig` is taken from the DOM once the card is rendered, so the baseline
              // is literally what the form shows rather than a parallel derivation
              // of it that could disagree.
              loaded.set(uid, { user, backup, backupResult, orig: null });
            }
          }

          completed++;
          const pct = (completed / selectedIds.length) * 100;
          showProgress(pct);
          setStatus(`Loading user ${completed} of ${selectedIds.length}…`);
        }
      }

      // Ensure email domains are loaded before rendering
      await emailDomainPromise;

      if (!loaded.size) {
        const skipped = selectedIds.length - loaded.size;
        setStatus(skipped ? `No users with phone or email addresses found (${skipped} skipped).` : "No user details could be loaded.", "error");
      } else {
        // Render cards
        $cards.innerHTML = "";
        for (const uid of loaded.keys()) {
          $cards.append(createUserCard(uid));
          // Snapshot from DOM after rendering so baseline matches what the UI shows
          loaded.get(uid).orig = readCurrentState(uid);
        }
        $cards.style.display = "";
        $bulkWrap.style.display = "";
        $bulkSelect.value = "";
        $applyWrap.style.display = "";
        const skipped = selectedIds.length - completed + (completed - loaded.size);
        const skippedNote = selectedIds.length > loaded.size ? ` (${selectedIds.length - loaded.size} without addresses skipped)` : "";
        setStatus(`Loaded ${loaded.size} user${loaded.size > 1 ? "s" : ""}${skippedNote}. Review settings and click Apply Changes.`);
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

      // Primary is no longer part of this: it is read-only, so it can never
      // differ between the baseline and the form.
      const addressChanged =
        canEditAddresses && (
          orig.drPhoneType !== curr.drPhoneType ||
          orig.drEmailIndex !== curr.drEmailIndex);

      const backupChanged =
        canEditBackup && (
          orig.backupType !== curr.backupType ||
          orig.backupUserId !== curr.backupUserId ||
          orig.backupQueueId !== curr.backupQueueId ||
          orig.waitForAgent !== curr.waitForAgent ||
          orig.agentWaitSeconds !== curr.agentWaitSeconds);

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
          // ── Address PATCH ──
          if (addressChanged) {
            // Genesys replaces the whole addresses array, so every existing
            // address goes back. Only `integration` is rewritten, and only for
            // the value this page owns: blanking every tag it found is how a
            // direct-routing change used to strip an unrelated microsoftteams
            // tag off a number nobody had selected.
            let emailIdx = -1;
            const updatedAddresses = (data.user.addresses || []).map(addr => {
              const clone = {
                address: addr.address,
                mediaType: addr.mediaType,
                type: addr.type,
                integration: addr.integration,
              };
              if (addr.extension)   clone.extension = addr.extension;
              if (addr.countryCode) clone.countryCode = addr.countryCode;

              let chosen = false;
              if (addr.mediaType === "PHONE") {
                chosen = curr.drPhoneType === addr.type;
              } else if (addr.mediaType === "EMAIL") {
                emailIdx++;
                chosen = curr.drEmailIndex === emailIdx;
              } else {
                return clone; // SMS and anything else: untouched.
              }

              if (chosen) clone.integration = "directrouting";
              else if (addr.integration === "directrouting") clone.integration = "";
              // Any other value is left exactly as found.
              return clone;
            });

            // primaryContactInfo is readOnly and auto-populated from addresses;
            // sending it was at best ignored. See §4 of the design doc.
            const patchResult = await gc.patchUser(api, orgId, uid, {
              version: data.user.version,
              addresses: updatedAddresses,
            });
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
              // Flat userId / queueId — the shape the API actually reads. The
              // radio group still allows only one at a time; §2.2 replaces it
              // with two independent pickers, at which point both can be set.
              await gc.putDirectRoutingBackup(api, orgId, uid, {
                userId:  curr.backupType === "USER"  ? curr.backupUserId  : null,
                queueId: curr.backupType === "QUEUE" ? curr.backupQueueId : null,
                waitForAgent: curr.waitForAgent,
                agentWaitSeconds: curr.agentWaitSeconds,
              });
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

  // ── Load users and groups on mount ──────────────────
  // Users gate the page; the group filter does not. allSettled so a failure to
  // read groups costs the filter and nothing else.
  (async () => {
    const [usersRes, groupsRes] = await Promise.allSettled([
      gc.fetchAllUsers(api, orgId),
      gc.fetchAllGroups(api, orgId),
    ]);

    if (usersRes.status !== "fulfilled") {
      const err = usersRes.reason;
      setStatus(`Failed to load users: ${err.message}`, "error");
      console.error("User load error:", err);
      return;
    }

    allUsers = usersRes.value.map(u => ({ id: u.id, name: u.name }));
    userSelect.setItems(filterUserOptions(allUsers, null, new Set()));
    userSelect.setPlaceholder("Select users…");

    if (groupsRes.status === "fulfilled") {
      const groups = (groupsRes.value || [])
        .filter(g => g.state === "active")
        .map(g => ({
          id: g.id,
          // The count makes an empty group obvious before it is picked.
          label: Number.isFinite(g.memberCount) ? `${g.name} (${g.memberCount})` : g.name,
        }));
      if (groups.length) {
        groupSelect.setItems(groups);
        $groupWrap.hidden = false;
      }
    } else {
      console.error("Group load error:", groupsRes.reason);
    }

    setStatus("Ready. Select users and click Load Details.");
  })();

  return el;
}
