/**
 * Users › Direct Routing — Add user(s)
 *
 * Assign the `directrouting` integration tag to user addresses (phone / email)
 * and configure agent-level backup routing.
 *
 * Genesys allows one `directrouting` tag per media type, so the phone and the
 * email choices are each one-of-N. Email tagging is offered only for addresses
 * on a verified inbound domain — direct routing to an email does not work
 * otherwise. Primary phone is shown but never editable: `primaryContactInfo`
 * is readOnly, and Genesys advises against direct routing on the primary.
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
import { createMultiSelect, createSingleSelect } from "../../../components/multiSelect.js";
import { logAction } from "../../../services/activityLogService.js";

// Genesys accepts [60, 864000] for agentWaitSeconds.
const BACKUP_WAIT_MIN = 60;
const BACKUP_WAIT_MAX = 864000;

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

/** Digits only, so "+45 76 77 65 57" and "+4576776557" compare equal. */
function digitsOf(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Reduce DID pools to numeric ranges once, for repeated membership tests.
 * A pool whose bounds are not usable numbers is dropped rather than matched
 * loosely — a wrong "yes" here enables a tag that cannot route.
 */
export function didPoolRanges(pools) {
  const ranges = [];
  for (const pool of pools || []) {
    const start = Number(digitsOf(pool.startPhoneNumber));
    const end   = Number(digitsOf(pool.endPhoneNumber || pool.startPhoneNumber));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !start) continue;
    ranges.push({ start, end: Math.max(start, end), name: pool.name || "" });
  }
  return ranges;
}

/**
 * Is this number inside a DID pool?
 *
 * Direct routing on a phone works by a call route pointing at the number, which
 * means the number has to be one the org actually owns — a DID. A tag on
 * anything else is inert, exactly like an email on an unconfigured domain.
 *
 * @returns {{ name: string }|null} the matching pool, or null.
 */
export function findDidPool(number, ranges) {
  const n = Number(digitsOf(number));
  if (!Number.isSafeInteger(n) || !n) return null;
  return (ranges || []).find(r => n >= r.start && n <= r.end) || null;
}

/**
 * Index call routes by the numbers they carry.
 *
 * Keyed on digits, and additionally on the last eight, because a DNIS and a
 * user's address are not guaranteed to be written the same way — one may carry
 * a country code the other omits. An exact match always wins; the suffix is
 * only consulted when there is no exact one.
 */
export function indexRoutesByNumber(routes) {
  const exact = new Map();
  const suffix = new Map();
  for (const r of routes || []) {
    for (const n of r.dnis || []) {
      const d = digitsOf(n);
      if (!d) continue;
      if (!exact.has(d)) exact.set(d, r);
      if (d.length >= 8 && !suffix.has(d.slice(-8))) suffix.set(d.slice(-8), r);
    }
  }
  return { exact, suffix };
}

/** The route carrying this number, per the index. Null when none matches. */
export function routeForNumber(index, number) {
  const d = digitsOf(number);
  if (!d || !index) return null;
  return index.exact.get(d)
    || (d.length >= 8 ? index.suffix.get(d.slice(-8)) : null)
    || null;
}

/**
 * Is there anything this page can actually do for this user?
 *
 * A card with no usable switch on it is noise: it takes a screenful and offers
 * nothing. "Has an email" is not the test, because direct routing to an email
 * only works on a domain configured for inbound email — a user whose only
 * address is an unroutable email has nothing to tag.
 *
 * An email that is *already* tagged counts even on an unverified domain, since
 * removing it is a real action and this is the only place to do it.
 *
 * @param {Object} user
 * @param {Set<string>} emailDomains  Lowercased inbound domains.
 * @param {boolean} domainsKnown      False when the email lookup failed.
 * @param {{start:number,end:number}[]} didRanges  DID pool ranges.
 * @param {boolean} didsKnown         False when the DID pool lookup failed.
 */
export function hasRoutableAddress(user, emailDomains, domainsKnown, didRanges, didsKnown) {
  const addrs = user.addresses || [];
  const phoneTypes = new Set(PHONE_TYPES.map(t => t.type));

  // An extension is deliberately not enough: it is not a DID, so nothing can
  // route to it. Neither is a number outside every pool.
  const hasPhone = addrs.some(a => {
    if (a.mediaType !== "PHONE" || !phoneTypes.has(a.type)) return false;
    if (a.integration === "directrouting") return true;
    if (!didsKnown) return false;
    return !!findDidPool(a.address || a.display, didRanges);
  });
  if (hasPhone) return true;

  return addrs.some(a => {
    if (a.mediaType !== "EMAIL") return false;
    if (a.integration === "directrouting") return true;
    if (!domainsKnown) return false;
    const value = a.display || a.address || "";
    const domain = value.includes("@") ? value.split("@")[1].toLowerCase() : "";
    return !!domain && emailDomains.has(domain);
  });
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
  let didRanges = null;              // DID pool ranges, numeric
  let didPoolsAvailable = false;     // false = the lookup failed, not "no pools"
  let callRoutes = null;             // [{ id, name, dnis }]
  let callRoutesAvailable = false;   // false = the lookup failed, not "no routes"
  let routeIndex = null;             // number → route, built once from callRoutes
  const routeSelects = new Map();    // `${userId}|${phoneType}` → singleSelect
  let allUsers = [];                 // [{ id, name }] — active users, loaded once
  const groupMembers = new Map();    // groupId → Set<userId>, memoised for the page
  let filterToken = 0;               // guards against a slow fetch landing late
  const userNameById = new Map();    // id → name, for resolving backup targets
  let searchPanels = [];             // open backup-user result panels, for outside-click

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
      Email can only be tagged on a domain configured for inbound email in
      Genesys. Primary phone is shown for reference only — Genesys derives it
      from the addresses, and advises against direct routing on the primary.
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

    <!-- Apply / Cancel. Cancel sits outside the apply wrapper: Load Details
         hides that wrapper, which used to take the Cancel button with it and
         leave a running load with no way to stop it. -->
    <div class="cs-actions" id="drApplyWrap" style="display:none">
      <button class="btn dr-btn-apply" id="drApplyBtn">Apply Changes</button>
    </div>
    <div class="cs-actions">
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
  const canDeleteBackup  = access && access.can ? access.can("users.directRouting.add", "backupDelete") : true;
  const canEditCallRoute = access && access.can ? access.can("users.directRouting.add", "callRoute") : true;
  const $summary      = el.querySelector("#drSummary");

  // ── Helpers ─────────────────────────────────────────
  const orgId = orgContext.get();

  // One listener for the page, not one per backup picker. The old code added a
  // `document` handler on every render — per card, and again on every change of
  // backup type — none of which were ever removed.
  function onDocPointerDown(e) {
    for (const { wrap, results } of searchPanels) {
      if (!wrap.contains(e.target)) results.innerHTML = "";
    }
  }
  document.addEventListener("pointerdown", onDocPointerDown);
  el.__destroy = () => {
    document.removeEventListener("pointerdown", onDocPointerDown);
    searchPanels = [];
  };

  /** Name for a user id — from the list already loaded, else one GET. */
  async function resolveUserName(id) {
    if (userNameById.has(id)) return userNameById.get(id);
    try {
      const u = await gc.getUser(api, orgId, id);
      const name = u?.name || id;
      userNameById.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

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

  async function loadDidPools() {
    if (didRanges) return didRanges;
    try {
      didRanges = didPoolRanges(await gc.fetchAllDidPools(api, orgId));
      didPoolsAvailable = true;
    } catch {
      // Requires telephony:plugin:all, which directory:user:edit does not
      // imply. An empty list here is "could not check", not "no pools exist".
      didRanges = [];
      didPoolsAvailable = false;
    }
    return didRanges;
  }

  async function loadCallRoutes() {
    if (callRoutes) return callRoutes;
    try {
      callRoutes = await gc.fetchAllCallRoutes(api, orgId);
      callRoutes.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      // dnis is unique across routes, so one number maps to at most one route.
      routeIndex = indexRoutesByNumber(callRoutes);
      callRoutesAvailable = true;
    } catch {
      // Requires routing:callRoute:view. An empty list is "could not read",
      // not "no routes exist" — the column disables rather than offering an
      // empty dropdown that would read as the latter.
      callRoutes = [];
      routeIndex = indexRoutesByNumber([]);
      callRoutesAvailable = false;
    }
    return callRoutes;
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

  /**
   * One direct-routing switch.
   *
   * Genesys allows a single `directrouting` tag per media type, which a radio
   * group also expressed — but a radio cannot be un-ticked, so clearing a tag
   * needed a whole extra "None" row per media type per user. A switch turns
   * itself off, so the constraint is kept by turning the others in the group
   * off when one comes on, and the None rows go away entirely.
   *
   * @param {string} group  Exclusion group, e.g. `phone_<userId>`.
   * @param {string} value  Read back by readCurrentState.
   */
  function drSwitch(group, value, checked) {
    const lbl = document.createElement("label");
    lbl.className = "dt-toggle dt-toggle--sm";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.drGroup = group;
    cb.dataset.drValue = value;
    cb.checked = checked;
    cb.setAttribute("aria-label", "Direct routing");

    cb.addEventListener("change", () => {
      if (!cb.checked) return;
      for (const other of el.querySelectorAll(`input[data-dr-group="${group}"]`)) {
        if (other !== cb) other.checked = false;
      }
    });

    const slider = document.createElement("span");
    slider.className = "dt-toggle-slider";
    lbl.append(cb, slider);
    return { lbl, cb };
  }

  /**
   * Make a switch remove-only: it can be turned off, never on.
   *
   * Refused on click, not on change: preventDefault reverts the state and
   * suppresses `change`, so the exclusion handler never runs. Blocking it
   * afterwards would already have switched off a valid selection elsewhere.
   * The flag is what keeps `setGroupValue` — and so the bulk control — from
   * turning it on programmatically, which no click handler would catch.
   */
  function lockSwitchOn(cb, title, lbl) {
    cb.dataset.drLocked = "1";
    if (lbl) lbl.title = title;
    cb.addEventListener("click", (e) => { if (cb.checked) e.preventDefault(); });
  }

  /**
   * Enable each Call Routing picker only while its own Direct Routing switch
   * is on, and grey the rest.
   *
   * A route assignment is only meaningful for a number that carries the tag,
   * so the picker follows the toggle rather than standing on its own.
   *
   * Disabling also **reverts the picker to the value it loaded with**. Turning
   * the toggle off after choosing a route would otherwise leave a change that
   * is invisible — greyed out, unreachable, and still queued for Apply. Off
   * means out of play, in both directions.
   */
  function syncRouteSelects(userId) {
    for (const [key, entry] of routeSelects) {
      const sep = key.indexOf("|");
      if (key.slice(0, sep) !== userId) continue;
      const type = key.slice(sep + 1);
      const sw = el.querySelector(
        `input[data-dr-group="phone_${userId}"][data-dr-value="${type}"]`);
      const on = !!sw?.checked;
      if (on) {
        // Switching the tag back on undoes a clear that was agreed to while
        // switching it off — the route is only dropped if the number stays
        // untagged when Apply runs.
        if (entry.pendingClear) {
          entry.pendingClear = false;
          entry.select.setValue(entry.originalRouteId);
        }
      } else {
        entry.select.setValue(entry.pendingClear ? "" : entry.originalRouteId);
      }
      entry.select.setEnabled(canEditCallRoute && on);
    }
  }

  /**
   * Switching a tag off leaves the number on its call route, which is right as
   * a default — one control, one effect — but leaves an assignment that now
   * routes to an untagged number, and the picker greys the moment the switch
   * goes off, so it cannot be cleared afterwards without switching the tag
   * back on. So ask, once, at the only moment the answer is obvious.
   *
   * Only for a switch the operator turned off themselves. Turning a different
   * number on turns this one off as a side effect, and that is a move — the
   * old number keeping its route is not something to interrupt anyone about.
   */
  function offerRouteClear(userId, type) {
    if (!canEditCallRoute) return;
    const entry = routeSelects.get(`${userId}|${type}`);
    if (!entry) return;
    const assigned = entry.select.getValue() || entry.originalRouteId;
    if (!assigned) return;
    const name = callRoutes?.find(r => r.id === assigned)?.name || "a call route";
    entry.pendingClear = confirm(
      `This number is assigned to the call route "${name}".\n\n` +
      `Direct routing is being switched off. ` +
      `Remove the number from that call route as well?`);
  }

  /**
   * Turn on the switch for `value` in a group, or all off when value is null.
   *
   * A group with no match is left **untouched**, not cleared. The radio version
   * behaved that way by construction — setting a radio the user did not have
   * simply did nothing — and clearing here would mean bulk-tagging "Work Phone
   * 2" silently stripped the existing tag from everyone who has no Work Phone 2.
   *
   * @returns {boolean} whether the group ended up matching the request.
   */
  function setGroupValue(group, value) {
    const boxes = [...el.querySelectorAll(`input[data-dr-group="${group}"]`)];
    if (value === null) {
      for (const cb of boxes) cb.checked = false;
      return true;
    }
    const target = boxes.find(cb =>
      cb.dataset.drValue === value && !cb.dataset.drLocked && !cb.disabled);
    if (!target) return false;
    for (const cb of boxes) cb.checked = cb === target;
    return true;
  }

  /**
   * Grey out a section and say which permission is missing.
   *
   * `inert` rather than `pointer-events: none` alone: the toggles and switches
   * are real focusable controls now, so a greyed-out section was still fully
   * reachable by keyboard — Tab into it, flip a switch, and Apply would send a
   * request the user has no permission for. `inert` takes the subtree out of
   * the focus order as well as out of the pointer's reach.
   *
   * The toggle stays outside the section and stays live, so the section can
   * still be opened to read why it is locked.
   */
  function lockSection(sectionEl, toggleEl, permission, message) {
    sectionEl.inert = true;
    sectionEl.classList.add("dr-locked");
    if (permission) toggleEl.title = `Requires Genesys permission: ${permission}`;
    const note = document.createElement("div");
    note.className = "dr-perm-note";
    note.textContent = message;
    sectionEl.prepend(note);
  }

  // ── Render one user card ────────────────────────────
  function createUserCard(userId) {
    const { user, backup, backupResult } = loaded.get(userId);
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
    // A real button, not a div: these were the only way into either section
    // and nothing on the card could be reached from the keyboard.
    const addrToggle = document.createElement("button");
    addrToggle.type = "button";
    addrToggle.className = "dr-backup-toggle";
    addrToggle.setAttribute("aria-expanded", "true");
    addrToggle.innerHTML = `<span class="dr-backup-arrow">&#x25BC;</span> Addresses`;

    // Expanded by render: the addresses are the task. Leaving both sections
    // shut cost two clicks per user before anything could be read, and made
    // the bulk auto-tag control look as though it did nothing at all.
    const addrSection = document.createElement("div");
    addrSection.className = "dr-backup-section dr-addr-section";

    addrToggle.addEventListener("click", () => {
      addrSection.hidden = !addrSection.hidden;
      addrToggle.setAttribute("aria-expanded", String(!addrSection.hidden));
      addrToggle.querySelector(".dr-backup-arrow").innerHTML = addrSection.hidden ? "&#x25B6;" : "&#x25BC;";
    });

    // Address table.
    // Integration is shown because this page writes it: without the column,
    // replacing a foreign tag (microsoftteams and the like) was invisible both
    // before and after it happened.
    const table = document.createElement("table");
    table.className = "dr-addr-table";
    table.innerHTML = `<thead><tr>
      <th>Type</th><th>Address</th><th>Integration</th><th>Primary</th><th>Direct Routing</th><th>Call Routing</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");

    // Index addresses by type for quick lookup
    const phoneByType = {};
    for (const a of addrs) {
      if (a.mediaType === "PHONE") phoneByType[a.type] = a;
    }

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

      // Direct routing on a phone works by a call route pointing at the
      // number, so the number has to be one the org owns. A tag on anything
      // else is inert — the same failure as an email on an unconfigured
      // domain, and gated the same way.
      const inPool = addr ? findDidPool(addr.address || addr.display, didRanges) : null;
      const phoneTagged = addr?.integration === "directrouting";
      const canTagPhone = didPoolsAvailable && !!inPool;

      // Primary is read-only, permanently — not pending a better write path.
      // Two independent reasons: primaryContactInfo is readOnly on both User
      // and UpdateUser and auto-populated from addresses, so the radio that
      // used to live here promised an edit the API does not accept; and Genesys
      // advises against routing on the primary phone in the first place, so
      // this page should not be making it easy to set. Showing which address
      // Genesys reports as primary keeps the information without the promise.
      // See §4 of the design doc.
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

      const tdDR = document.createElement("td");
      if (addr && (canTagPhone || phoneTagged)) {
        const { lbl, cb } = drSwitch(`phone_${userId}`, type, drPhoneType === type);
        // Re-reads every row: turning one switch on turns its siblings off
        // programmatically, and that fires no change event of its own.
        cb.addEventListener("change", () => {
          // Before the sync, which is what applies the answer.
          if (!cb.checked) offerRouteClear(userId, type);
          syncRouteSelects(userId);
        });
        if (!canTagPhone) {
          lockSwitchOn(cb, didPoolsAvailable
            ? "This number is not in any DID pool — the tag can be removed but not re-added here."
            : "DID pools could not be read, so this number cannot be verified — the tag can be removed but not re-added here.", lbl);
        } else if (inPool.name) {
          lbl.title = `In DID pool: ${inPool.name}`;
        }
        tdDR.append(lbl);
      } else {
        tdDR.textContent = "—";
        tdDR.className = addr ? "dr-addr-na" : "dr-addr-missing";
      }

      // Call Routing. A tagged number that no call route points at routes
      // nothing, so this is the other half of making direct routing work.
      // Shown whenever the number is on a route, and editable regardless of
      // the Direct Routing switch — hiding it would conceal real config and
      // mean enabling direct routing just to clear a stale assignment.
      const tdRoute = document.createElement("td");
      if (addr && callRoutesAvailable) {
        const current = routeForNumber(routeIndex, addr.address || addr.display);
        const select = createSingleSelect({
          placeholder: "— No call route —",
          searchable: true,
        });
        // No empty entry here: createSingleSelect renders the placeholder
        // itself as the clear option, and it already selects "".
        select.setItems(callRoutes.map(r => ({ id: r.id, label: r.name || r.id })));
        if (current) select.setValue(current.id);
        if (!canEditCallRoute) select.setEnabled(false);
        routeSelects.set(`${userId}|${type}`, {
          select,
          number: addr.address || addr.display,
          originalRouteId: current?.id || "",
        });
        tdRoute.append(select.el);
      } else {
        tdRoute.textContent = "—";
        tdRoute.className = "dr-addr-na";
        if (addr && !callRoutesAvailable) {
          tdRoute.title = "Call routes could not be read (requires routing:callRoute:view).";
        }
      }

      tr.append(tdType, tdAddr, tdInt, tdPri, tdDR, tdRoute);
      tbody.append(tr);

      if (addr && !canTagPhone) {
        const warnTr = document.createElement("tr");
        warnTr.className = "dr-email-warn-row";
        const warnTd = document.createElement("td");
        warnTd.colSpan = 6;
        warnTd.className = "dr-email-warn";
        warnTd.textContent = didPoolsAvailable
          ? "This number is not in a Genesys DID pool — calls cannot be routed to it."
          : "DID pools could not be read (requires telephony:plugin:all), so this number cannot be verified — direct routing is unavailable for it here.";
        warnTr.append(warnTd);
        tbody.append(warnTr);
      }
    }

    // Email rows.
    // Genesys supports one directrouting tag per media type, so these are a
    // radio group like the phones, not the checkboxes that used to allow two
    // emails to be tagged at once. Keyed by index: two EMAIL addresses can
    // share a type, and keying on type silently merged them.
    const emails = addrs.filter(a => a.mediaType === "EMAIL");

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

      // Tagging is offered only when the domain is *positively known* to be an
      // inbound domain in Genesys. Direct routing to an email simply does not
      // work otherwise, so offering the control on an unverified domain would
      // let an admin tag an address believing it routes when it cannot — a
      // worse outcome than being told the check could not run.
      //
      // An address already tagged keeps a disabled control so the tag stays
      // visible and can still be removed via None; rendering nothing would let
      // a live tag read as untagged.
      const tagged = emailAddr.integration === "directrouting";
      const tdDR = document.createElement("td");
      if (domainExists || tagged) {
        const { lbl, cb } = drSwitch(`email_${userId}`, String(idx), tagged);
        if (!domainExists) {
          // Off but not on: an existing tag stays visible and can be switched
          // off, which is always safe. Adding one needs the domain proven.
          lockSwitchOn(cb, domainKnown
            ? "The domain is not configured for inbound email — this tag can be removed but not re-added here."
            : "The inbound domain list could not be read, so this cannot be verified — the tag can be removed but not re-added here.", lbl);
        }
        tdDR.append(lbl);
      } else {
        tdDR.textContent = "—";
        tdDR.className = "dr-addr-na";
      }

      // Call routing is a phone concept; email rows keep the column shape.
      const tdRoute = document.createElement("td");
      tdRoute.textContent = "—";
      tdRoute.className = "dr-addr-na";

      tr.append(tdType, tdAddr, tdInt, tdPri, tdDR, tdRoute);
      tbody.append(tr);

      const note = !domainKnown
        ? "Inbound email domains could not be read (requires routing:email:manage), so this address cannot be verified — direct routing for email is unavailable here."
        : !domainExists
          ? `Domain "${domain}" is not configured as an inbound email domain in Genesys — emails cannot be routed to this address.`
          : "";
      if (note) {
        const warnTr = document.createElement("tr");
        warnTr.className = "dr-email-warn-row";
        const warnTd = document.createElement("td");
        warnTd.colSpan = 6;
        // Both cases block tagging, so both read as warnings.
        warnTd.className = "dr-email-warn";
        warnTd.textContent = note;
        warnTr.append(warnTd);
        tbody.append(warnTr);
      }
    });

    table.append(tbody);
    addrSection.append(table);
    card.append(addrToggle, addrSection);

    // ── Backup section ──
    // Two independent pickers, not a three-way type. The API carries flat
    // userId and queueId and allows both at once — user as the primary backup,
    // queue as the secondary — which a radio group cannot express. "No backup"
    // is simply both being empty.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dr-backup-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `<span class="dr-backup-arrow">&#x25B6;</span> Backup Settings`;

    const section = document.createElement("div");
    section.className = "dr-backup-section";
    section.hidden = true;

    toggle.addEventListener("click", () => {
      section.hidden = !section.hidden;
      toggle.setAttribute("aria-expanded", String(!section.hidden));
      toggle.querySelector(".dr-backup-arrow").innerHTML = section.hidden ? "&#x25B6;" : "&#x25BC;";
    });

    const userRow  = buildBackupUserRow(userId, backup);
    const queueRow = buildBackupQueueRow(userId, backup);
    section.append(userRow.el, queueRow.el);

    // The precedence only means anything when both are set; naming one
    // "primary" while the other is empty sends the reader hunting for a
    // secondary that does not exist.
    function syncPrecedenceHints() {
      const both = !!userRow.getValue() && !!queueRow.getValue();
      userRow.hint.textContent  = both ? "(primary)" : "";
      queueRow.hint.textContent = both ? "(secondary)" : "";
    }
    userRow.onChange  = syncPrecedenceHints;
    queueRow.onChange = syncPrecedenceHints;
    syncPrecedenceHints();

    // Wait options.
    // `waitForAgent` false means "go straight to the backup", which is what the
    // Genesys queue-level screen calls "Assign to backup immediately". Labelling
    // the raw flag "Wait for Agent" beside a seconds box read as though ticking
    // it was what enabled the wait — backwards.
    const optsDiv = document.createElement("div");
    optsDiv.className = "dr-backup-row";

    const immediateLbl = document.createElement("label");
    const immediateCb = document.createElement("input");
    immediateCb.type = "checkbox";
    immediateCb.id = `bk_now_${userId}`;
    immediateCb.checked = backup ? !backup.waitForAgent : false;
    immediateLbl.append(immediateCb, document.createTextNode(" Send to backup immediately"));

    const secsLbl = document.createElement("label");
    secsLbl.textContent = "Wait for agent (sec): ";
    const secsInput = document.createElement("input");
    secsInput.type = "number";
    secsInput.id = `bk_secs_${userId}`;
    secsInput.className = "input dr-input-num";
    secsInput.value = backup?.agentWaitSeconds ?? 70;
    // Genesys accepts [60, 864000]. The old 0–600 was wrong at both ends: 0 is
    // rejected outright and the ceiling excluded most of the valid range.
    secsInput.min = String(BACKUP_WAIT_MIN);
    secsInput.max = String(BACKUP_WAIT_MAX);
    secsLbl.append(secsInput);

    const secsHint = document.createElement("span");
    secsHint.className = "dr-backup-hint";
    secsHint.textContent = `${BACKUP_WAIT_MIN}–${BACKUP_WAIT_MAX}`;

    function syncWaitEnabled() {
      secsInput.disabled = immediateCb.checked;
      secsLbl.classList.toggle("dr-disabled", immediateCb.checked);
    }
    immediateCb.addEventListener("change", syncWaitEnabled);
    syncWaitEnabled();

    optsDiv.append(immediateLbl, secsLbl, secsHint);
    section.append(optsDiv);

    card.append(toggle, section);

    // ── Per-section permission gating (internal refinement) ──
    // Lock the section(s) the user lacks the Genesys permission for.
    if (!canEditAddresses) {
      lockSection(addrSection, addrToggle,
        "directory:user:edit",
        "You lack the Genesys permission to change addresses / direct routing (directory:user:edit).");
    }
    if (!canEditBackup) {
      lockSection(section, toggle,
        "routing:directRoutingBackup:edit",
        "You lack the Genesys permission to change backup routing (routing:directRoutingBackup:edit).");
    } else if (backupResult?.state === "denied") {
      // Genesys refused the read. The form below is empty because nothing could
      // be loaded, not because nothing is configured — offering it as editable
      // would let an Apply overwrite a backup we were never allowed to see.
      lockSection(section, toggle,
        "routing:directRoutingBackup:view",
        "Backup settings could not be read (requires routing:directRoutingBackup:view), so they are not shown or editable here.");
    } else if (backupResult?.state === "error") {
      lockSection(section, toggle, null,
        "Backup settings could not be read for this user. Reload to try again.");
    } else if (!canDeleteBackup) {
      // Edit without delete: setting or changing a backup is fine, removing one
      // is not. Only bite when there is something to remove.
      const hadBackup = !!(backup?.userId || backup?.queueId);
      if (hadBackup) {
        for (const b of section.querySelectorAll(".dr-backup-clear")) {
          b.disabled = true;
          b.title = "Requires Genesys permission: routing:directRoutingBackup:delete";
        }
        const note = document.createElement("div");
        note.className = "dr-perm-note";
        note.textContent = "You can change this backup but not remove it (requires routing:directRoutingBackup:delete).";
        section.prepend(note);
      }
    }

    return card;
  }

  // ── Backup pickers ──────────────────────────────────
  // Each row is independently clearable. Empty means "not set"; both empty
  // means no backup at all, which is a DELETE rather than a write.

  /** One labelled row with a clear button and a slot for the control. */
  function backupRow(labelText) {
    const row = document.createElement("div");
    row.className = "dr-backup-row dr-backup-picker-row";

    const label = document.createElement("span");
    label.className = "dr-backup-lbl";
    label.textContent = labelText;

    const hint = document.createElement("span");
    hint.className = "dr-backup-hint";

    const slot = document.createElement("div");
    slot.className = "dr-backup-slot";

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "dr-backup-clear";
    clear.textContent = "×";
    clear.title = `Clear ${labelText.toLowerCase()}`;

    row.append(label, hint, slot, clear);
    return { row, slot, clear, hint };
  }

  function buildBackupUserRow(userId, currentBackup) {
    const { row, slot, clear, hint } = backupRow("Backup user");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "input";
    input.placeholder = "Search for a backup user…";

    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.id = `bk_user_id_${userId}`;

    const results = document.createElement("div");
    results.className = "dr-backup-search-results";

    const wrap = document.createElement("div");
    wrap.className = "dr-backup-user-search";
    wrap.append(input, hidden, results);
    slot.append(wrap);
    searchPanels.push({ wrap, results });

    const api_ = { onChange: null };

    // The API stores only an id. Most backups point at an active user, who is
    // already in `allUsers`, so the name usually costs nothing; anyone else
    // takes one GET.
    if (currentBackup?.userId) {
      hidden.value = currentBackup.userId;
      input.value = "…";
      resolveUserName(currentBackup.userId).then((name) => {
        // Only fill in if nothing has been typed or cleared meanwhile.
        if (hidden.value === currentBackup.userId && input.value === "…") input.value = name;
      });
    }

    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      hidden.value = "";
      api_.onChange?.();
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
              userNameById.set(u.id, u.name);
              results.innerHTML = "";
              api_.onChange?.();
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

    clear.addEventListener("click", () => {
      input.value = "";
      hidden.value = "";
      results.innerHTML = "";
      api_.onChange?.();
    });

    return {
      el: row,
      hint,
      getValue: () => hidden.value || "",
      set onChange(fn) { api_.onChange = fn; },
      get onChange() { return api_.onChange; },
    };
  }

  function buildBackupQueueRow(userId, currentBackup) {
    const { row, slot, clear, hint } = backupRow("Backup queue");

    const select = document.createElement("select");
    select.className = "input";
    select.id = `bk_queue_id_${userId}`;
    select.innerHTML = `<option value="">Loading queues…</option>`;
    slot.append(select);

    const spin = document.createElement("span");
    spin.className = "spin spin--sm spin--label";
    spin.setAttribute("aria-hidden", "true");
    slot.append(spin);

    const api_ = { onChange: null };

    loadQueues().then(queues => {
      select.innerHTML = `<option value="">— No queue backup —</option>` +
        queues.map(q =>
          `<option value="${escapeHtml(q.id)}"${currentBackup?.queueId === q.id ? " selected" : ""}>${escapeHtml(q.name)}</option>`
        ).join("");
      api_.onChange?.();
    }).catch(() => {
      select.innerHTML = `<option value="">Failed to load queues</option>`;
    }).finally(() => spin.remove());

    select.addEventListener("change", () => api_.onChange?.());
    clear.addEventListener("click", () => {
      select.value = "";
      api_.onChange?.();
    });

    return {
      el: row,
      hint,
      getValue: () => select.value || "",
      set onChange(fn) { api_.onChange = fn; },
      get onChange() { return api_.onChange; },
    };
  }

  // ── Read current state from DOM ─────────────────────
  function readCurrentState(userId) {
    const drPhoneSwitch = el.querySelector(`input[data-dr-group="phone_${userId}"]:checked`);
    const drPhoneType = drPhoneSwitch?.dataset.drValue || "NONE";

    // One email at most: Genesys allows a single directrouting tag per media
    // type. The value is the address's index, since two EMAIL addresses can
    // share a type.
    const drEmailSwitch = el.querySelector(`input[data-dr-group="email_${userId}"]:checked`);
    const drEmailIndex = drEmailSwitch ? Number(drEmailSwitch.dataset.drValue) : null;

    // Both targets are read unconditionally: they are independent, and setting
    // both is legal — user is the primary backup, queue the secondary.
    const backupUserId  = el.querySelector(`#bk_user_id_${userId}`)?.value || null;
    const backupQueueId = el.querySelector(`#bk_queue_id_${userId}`)?.value || null;
    const hasBackup = !!(backupUserId || backupQueueId);

    // The checkbox is the inverse of the API's flag: ticked means "go straight
    // to the backup", i.e. waitForAgent false.
    const nowCb = el.querySelector(`#bk_now_${userId}`);
    const waitForAgent = nowCb ? !nowCb.checked : false;
    const agentWaitSeconds = parseInt(el.querySelector(`#bk_secs_${userId}`)?.value, 10);

    return { drPhoneType, drEmailIndex, backupUserId, backupQueueId, hasBackup, waitForAgent, agentWaitSeconds };
  }

  /**
   * Every call-route reassignment the operator has made, across all cards.
   *
   * Kept apart from the per-user `changes` list because a call route is not
   * the user's object: two users' numbers can live on one route, so these are
   * applied grouped by route rather than user by user (§9.4).
   */
  function collectRouteChanges() {
    if (!canEditCallRoute || !callRoutesAvailable) return [];
    const out = [];
    for (const [key, entry] of routeSelects) {
      const to = entry.select.getValue() || "";
      if (to === entry.originalRouteId) continue;
      out.push({
        key,
        number: entry.number,
        from: entry.originalRouteId,
        to,
        userName: loaded.get(key.split("|")[0])?.user?.name || "",
      });
    }
    return out;
  }

  /**
   * Apply the collected reassignments, one write per affected route.
   *
   * Removals run before additions, always: a number may appear on only one
   * call route, so adding before removing is rejected as in use. A route that
   * both loses and gains numbers is written twice, which is correct and cheap.
   *
   * Each route is read immediately before it is written — the PUT is a
   * whole-object write carrying a version, and a route touched by the removal
   * pass has a new one by the time the addition pass reaches it.
   */
  async function applyRouteChanges(routeChanges, errors) {
    const removals = new Map();
    const additions = new Map();
    const bucket = (map, key) => {
      if (!map.has(key)) map.set(key, []);
      return map.get(key);
    };

    // Ask Genesys who actually holds each number rather than trusting the
    // index built at load. The two disagree whenever a DNIS is stored in a
    // different format from the user's address, or when the owning route sits
    // where this account cannot list it — and the cost of being wrong is the
    // addition failing with "already assigned" and no removal having run.
    for (const ch of routeChanges) {
      if (cancelled) break;
      try {
        const owner = await gc.findCallRouteByDnis(api, orgId, ch.number);
        ch.from = owner?.id || "";
      } catch {
        // Fall back to what the page loaded with; the write may still fail,
        // and it will say so.
      }
      // Genesys already has it where it is wanted.
      if (ch.from && ch.from === ch.to) ch.to = ch.from = "";
    }

    for (const ch of routeChanges) {
      if (ch.from) bucket(removals, ch.from).push(ch);
      if (ch.to)   bucket(additions, ch.to).push(ch);
    }

    let done = 0, failedRoutes = 0;

    async function writeRoute(routeId, mutate, involved) {
      try {
        const route = await gc.getCallRoute(api, orgId, routeId);
        const next = mutate([...(route.dnis || [])]);
        await gc.putCallRouteDnis(api, orgId, route, next);
        done++;
      } catch (err) {
        failedRoutes++;
        const who = [...new Set(involved.map(c => c.userName).filter(Boolean))].join(", ");
        errors.push(`Call route${who ? ` (${who})` : ""}: ${(err.message || String(err)).slice(0, 120)}`);
      }
    }

    for (const [routeId, chs] of removals) {
      if (cancelled) break;
      const drop = new Set(chs.map(c => digitsOf(c.number)));
      await writeRoute(routeId, dnis => dnis.filter(n => !drop.has(digitsOf(n))), chs);
    }
    for (const [routeId, chs] of additions) {
      if (cancelled) break;
      await writeRoute(routeId, (dnis) => {
        const have = new Set(dnis.map(digitsOf));
        for (const c of chs) if (!have.has(digitsOf(c.number))) dnis.push(c.number);
        return dnis;
      }, chs);
    }
    return { done, failedRoutes };
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
    // The two reasons a selected user does not get a card are different, and
    // reporting a run of failed reads as "users without addresses" hid real
    // errors behind a benign-sounding message.
    let noAddresses = 0;
    let failedReads = 0;

    try {
      // Fetch email domains in parallel with user details
      const emailDomainPromise = loadEmailDomains();
      const didPoolPromise = loadDidPools();
      const callRoutePromise = loadCallRoutes();

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

          if (userResult.status !== "fulfilled") failedReads++;
          if (userResult.status === "fulfilled") {
            const user = userResult.value;
            const userAddrs = user.addresses || [];
            // Whether there is anything to do for this user depends on the
            // inbound domain list, which is still in flight. Keep everyone for
            // now and prune once it lands.
            //
            // getDirectRoutingBackup reports which of "none" / "denied" / "ok"
            // it got. The tagged result is kept whole — the backup section
            // needs the distinction — and `settings` is what the render and
            // the snapshot read.
            //
            // A rejection is not a refusal: it may be a 500 or a dropped
            // connection. Only the helper can say "denied", so anything that
            // reaches here as a rejection is tagged "error" and rendered as a
            // failure to read rather than as a missing permission.
            const backupResult = bkResult.status === "fulfilled"
              ? bkResult.value
              : { state: "error", settings: null };
            const backup = backupResult.settings;
            // `orig` is taken from the DOM once the card is rendered, so the
            // baseline is literally what the form shows rather than a parallel
            // derivation of it that could disagree.
            loaded.set(uid, { user, backup, backupResult, orig: null });
          }

          completed++;
          const pct = (completed / selectedIds.length) * 100;
          showProgress(pct);
          setStatus(`Loading user ${completed} of ${selectedIds.length}…`);
        }
      }

      // Ensure email domains are loaded before rendering
      await Promise.all([emailDomainPromise, didPoolPromise, callRoutePromise]);

      // Drop anyone this page cannot do anything for. A card with no usable
      // switch is a screenful of nothing.
      // (call-route verification follows the prune, so it only runs for cards
      //  that will actually be rendered)
      for (const [uid, data] of [...loaded]) {
        if (hasRoutableAddress(data.user, emailDomainsCache, emailDomainsAvailable,
                               didRanges, didPoolsAvailable)) continue;
        loaded.delete(uid);
        noAddresses++;
      }

      // Say which of the two happened, and how many of each.
      const skipParts = [];
      if (noAddresses) skipParts.push(`${noAddresses} with no phone or routable email`);
      if (failedReads) skipParts.push(`${failedReads} could not be read`);
      const skipNote = skipParts.length ? ` (${skipParts.join(", ")})` : "";

      // The load index matches DNIS to addresses on digits, which fails when
      // Genesys stores the two in different formats, and cannot see a route
      // this account may not list. Both show up as "no route" — the one answer
      // that must not be guessed, since it is what an operator clears against.
      // An index hit is trusted; every miss is checked against Genesys, which
      // compares numbers the way it stores them.
      if (callRoutesAvailable && !cancelled) {
        const unknown = [];
        for (const { user } of loaded.values()) {
          for (const a of user.addresses || []) {
            if (a.mediaType !== "PHONE") continue;
            const number = a.address || a.display;
            if (!number || routeForNumber(routeIndex, number)) continue;
            if (!unknown.includes(number)) unknown.push(number);
          }
        }
        for (let i = 0; i < unknown.length && !cancelled; i += 10) {
          const slice = unknown.slice(i, i + 10);
          setStatus(`Checking call routes… ${Math.min(i + slice.length, unknown.length)} of ${unknown.length}`);
          const found = await Promise.all(slice.map(n =>
            gc.findCallRouteByDnis(api, orgId, n).catch(() => null)));
          slice.forEach((n, j) => {
            if (found[j]) routeIndex.exact.set(digitsOf(n), found[j]);
          });
        }
      }

      if (!loaded.size) {
        setStatus(
          failedReads && !noAddresses
            ? `No user details could be loaded — ${failedReads} could not be read.`
            : `None of the selected users have a phone number or an email on a routable domain${skipNote}.`,
          "error");
      } else {
        // Render cards
        $cards.innerHTML = "";
        searchPanels = [];
        routeSelects.clear();
        for (const uid of loaded.keys()) {
          $cards.append(createUserCard(uid));
          // Both of these read through `el`, so they run after the card is
          // attached — inside createUserCard it is still detached and every
          // lookup comes back empty.
          syncRouteSelects(uid);
          // Snapshot from DOM after rendering so baseline matches what the UI shows
          loaded.get(uid).orig = readCurrentState(uid);
        }
        $cards.style.display = "";
        $bulkWrap.style.display = "";
        $bulkSelect.value = "";
        $applyWrap.style.display = "";
        setStatus(`Loaded ${loaded.size} user${loaded.size === 1 ? "" : "s"}${skipNote}. Review settings and click Apply Changes.`);
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
  // Writes into the address sections, so it follows the same permission. Left
  // enabled it would flip switches inside locked cards that Apply then ignores.
  if (!canEditAddresses) {
    $bulkSelect.disabled = true;
    $bulkSelect.title = "Requires Genesys permission: directory:user:edit";
  }
  $bulkSelect.addEventListener("change", () => {
    const val = $bulkSelect.value;
    if (!val) return;

    let applied = 0;
    for (const uid of loaded.keys()) {
      // null turns the whole group off; otherwise it only lands on users who
      // actually have that phone type, and leaves the rest alone.
      if (setGroupValue(`phone_${uid}`, val === "NONE" ? null : val)) applied++;
      syncRouteSelects(uid);
    }

    // Without this the control looks inert: it flips radios inside cards that
    // may be scrolled well off screen, and says nothing about the ones it could
    // not apply to.
    const label = val === "NONE"
      ? "None"
      : $bulkSelect.options[$bulkSelect.selectedIndex].text;
    const missed = loaded.size - applied;
    setStatus(missed
      ? `${label} selected for ${applied} of ${loaded.size} users; ${missed} have no ${label}.`
      : `${label} selected for all ${applied} user${applied === 1 ? "" : "s"}.`);
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

      // Wait settings only count when a backup exists to apply them to;
      // otherwise editing the seconds box on a user with no backup would
      // register a change and issue a pointless DELETE.
      const backupChanged =
        canEditBackup && (
          orig.backupUserId !== curr.backupUserId ||
          orig.backupQueueId !== curr.backupQueueId ||
          (curr.hasBackup && (
            orig.waitForAgent !== curr.waitForAgent ||
            orig.agentWaitSeconds !== curr.agentWaitSeconds)));

      if (addressChanged || backupChanged) {
        changes.push({ uid, data, curr, addressChanged, backupChanged });
      }
    }

    const routeChanges = collectRouteChanges();

    if (!changes.length && !routeChanges.length) {
      setStatus("No changes detected.", "error");
      return;
    }

    // Refuse out-of-range wait times here rather than letting Genesys 400 them
    // partway through a batch, with some users already written and some not.
    const badWait = changes.filter(({ curr }) =>
      curr.hasBackup && curr.waitForAgent &&
      !(Number.isFinite(curr.agentWaitSeconds) &&
        curr.agentWaitSeconds >= BACKUP_WAIT_MIN &&
        curr.agentWaitSeconds <= BACKUP_WAIT_MAX));
    if (badWait.length) {
      const names = badWait.map(c => c.data.user.name).join(", ");
      setStatus(
        `Wait for agent must be between ${BACKUP_WAIT_MIN} and ${BACKUP_WAIT_MAX} seconds: ${names}`,
        "error");
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

        setStatus(`Applying changes ${i + 1} of ${changes.length}… ${data.user.name}`);
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
          // Four cases, and no null sentinels: a PUT replaces, so clearing one
          // side is a PUT carrying the survivor and clearing both is a DELETE.
          if (backupChanged) {
            const hadBackup = !!(data.orig.backupUserId || data.orig.backupQueueId);
            if (!curr.hasBackup) {
              if (hadBackup) {
                // The clear buttons are disabled without this permission, but
                // the queue dropdown has its own empty option — so the guard
                // belongs here too, where the request is actually made.
                if (!canDeleteBackup) {
                  throw new Error("Removing a backup requires routing:directRoutingBackup:delete");
                }
                await gc.deleteDirectRoutingBackup(api, orgId, uid);
              }
            } else {
              await gc.putDirectRoutingBackup(api, orgId, uid, {
                userId: curr.backupUserId,
                queueId: curr.backupQueueId,
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

      // ── Phase 3: call routes, grouped by route ──
      let routesDone = 0, routesFailed = 0;
      if (!cancelled && routeChanges.length) {
        setStatus(`Updating call routes…`);
        const r = await applyRouteChanges(routeChanges, errors);
        routesDone = r.done;
        routesFailed = r.failedRoutes;
      }

      // Summary
      showProgress(100);
      const parts = [];
      if (success) parts.push(`Success: ${success}`);
      if (failed)  parts.push(`Failed: ${failed}`);
      if (routesDone)   parts.push(`Call routes updated: ${routesDone}`);
      if (routesFailed) parts.push(`Call routes failed: ${routesFailed}`);
      const summaryText = cancelled
        ? `Cancelled. ${parts.join("  •  ")}`
        : parts.join("  •  ");

      $summary.innerHTML = escapeHtml(summaryText);
      if (errors.length) {
        $summary.innerHTML += `<br><small style="color:#f87171">${errors.map(e => escapeHtml(e)).join("<br>")}</small>`;
      }
      $summary.style.display = "";

      setStatus(cancelled ? "Cancelled." : "Done.", (failed || routesFailed) ? "error" : "success");
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
    // Doubles as the lookup for resolving a backup user id to a name: most
    // backups point at an active user, so that costs no extra request.
    for (const u of allUsers) userNameById.set(u.id, u.name);
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
