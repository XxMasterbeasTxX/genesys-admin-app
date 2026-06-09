/**
 * Utilities — Public IP Ranges (Genesys + AWS)
 *
 * Lists the public IP address ranges (CIDR blocks) for either:
 *   • Genesys Cloud — per regional API host (whitelisting Genesys traffic)
 *   • Amazon AWS    — global feed at ip-ranges.amazonaws.com (whitelisting AWS traffic)
 *
 * Backends:
 *   GET /api/ipranges?region=<aws-region-code>   (Genesys, client-credentials auth)
 *   GET /api/aws-ipranges                        (Amazon, anonymous, server-side cached)
 */
import { escapeHtml, exportXlsx, timestampedFilename } from "../../utils.js";
import { getValidAccessToken } from "../../services/authService.js";
import { orgContext } from "../../services/orgContext.js";

// ── Genesys regions ───────────────────────────────────────────────────
// AWS region code → Genesys API host (must match api/ipranges/index.js).
const GC_REGION_HOST_BY_CODE = {
  "us-east-1":      "mypurecloud.com",
  "us-east-2":      "use2.us-gov-pure.cloud",
  "us-west-2":      "usw2.pure.cloud",
  "ca-central-1":   "cac1.pure.cloud",
  "sa-east-1":      "sae1.pure.cloud",
  "eu-west-1":      "mypurecloud.ie",
  "eu-west-2":      "euw2.pure.cloud",
  "eu-central-1":   "mypurecloud.de",
  "eu-central-2":   "euc2.pure.cloud",
  "me-central-1":   "mec1.pure.cloud",
  "ap-south-1":     "aps1.pure.cloud",
  "ap-southeast-2": "mypurecloud.com.au",
  "ap-northeast-1": "mypurecloud.jp",
  "ap-northeast-2": "apne2.pure.cloud",
  "ap-northeast-3": "apne3.pure.cloud",
};

const GC_REGIONS = [
  { code: "us-east-1",      label: "Americas — US East (N. Virginia)" },
  { code: "us-east-2",      label: "Americas — US East 2 (Ohio)" },
  { code: "us-west-2",      label: "Americas — US West (Oregon)" },
  { code: "ca-central-1",   label: "Americas — Canada (Central)" },
  { code: "sa-east-1",      label: "Americas — São Paulo" },
  { code: "eu-west-1",      label: "EMEA — Ireland" },
  { code: "eu-west-2",      label: "EMEA — London" },
  { code: "eu-central-1",   label: "EMEA — Frankfurt" },
  { code: "eu-central-2",   label: "EMEA — Zurich" },
  { code: "me-central-1",   label: "Middle East — UAE" },
  { code: "ap-south-1",     label: "APAC — Mumbai" },
  { code: "ap-southeast-2", label: "APAC — Sydney" },
  { code: "ap-northeast-1", label: "APAC — Tokyo" },
  { code: "ap-northeast-2", label: "APAC — Seoul" },
  { code: "ap-northeast-3", label: "APAC — Osaka" },
];

const GC_DEFAULT_REGION = "eu-central-1";
const AWS_DEFAULT_REGION = "eu-central-1";

const DIRECTION_LABELS = {
  inbound:  "Inbound",
  outbound: "Outbound",
  both:     "Both",
};

function directionBadge(dir) {
  const cls =
    dir === "inbound"  ? "ipr-badge ipr-badge--in" :
    dir === "outbound" ? "ipr-badge ipr-badge--out" :
                         "ipr-badge ipr-badge--both";
  return `<span class="${cls}">${escapeHtml(DIRECTION_LABELS[dir] || dir || "—")}</span>`;
}

function ipTypeBadge(t) {
  const cls = t === "ipv6" ? "ipr-badge ipr-badge--out" : "ipr-badge ipr-badge--in";
  return `<span class="${cls}">${escapeHtml(t === "ipv6" ? "IPv6" : "IPv4")}</span>`;
}

function formatTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// ── Inline styles (scoped to this page) ───────────────────────────────
const PAGE_STYLES = `
.ipr-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.ipr-header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ipr-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
.ipr-filters { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; }
.ipr-status { font-size: 13px; color: var(--muted); margin: 12px 0; }
.ipr-status--error { color: #f87171; }
.ipr-summary { font-size: 13px; color: var(--muted); margin: 8px 0 12px; }
.ipr-actions-row { display: flex; gap: 8px; margin: 8px 0 12px; flex-wrap: wrap; }

.ipr-mode-toggle { display:flex; border:1px solid var(--border); border-radius:8px; overflow:hidden; margin-bottom:18px; width:fit-content; }
.ipr-mode-btn { padding:7px 22px; background:none; border:none; color:var(--muted); cursor:pointer; font:inherit; font-size:13px; font-weight:600; transition:background .12s,color .12s; }
.ipr-mode-btn.active { background:rgba(59,130,246,.22); color:#60a5fa; }
.ipr-mode-btn:not(.active):hover { background:rgba(255,255,255,.05); color:var(--text); }

.ipr-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.ipr-badge--in   { background: rgba(34, 197, 94, 0.18); color: #4ade80; }
.ipr-badge--out  { background: rgba(59, 130, 246, 0.18); color: #60a5fa; }
.ipr-badge--both { background: rgba(168, 85, 247, 0.18); color: #c084fc; }

.ipr-services { display: flex; flex-wrap: wrap; gap: 6px; max-width: 520px; max-height: 120px; overflow-y: auto; }
.ipr-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px;
  border: 1px solid var(--border); background: transparent; font-size: 12px; cursor: pointer; color: var(--muted); }
.ipr-chip--active { background: rgba(96, 165, 250, 0.18); color: #fff; border-color: rgba(96, 165, 250, 0.5); }
.ipr-chip-count { font-size: 10px; opacity: 0.7; }

.ipr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ipr-table th, .ipr-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.ipr-table th { font-weight: 600; color: var(--muted); cursor: pointer; user-select: none; white-space: nowrap; }
.ipr-table th[data-sort]:hover { color: #fff; }
.ipr-table td.ipr-cidr { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }

.ipr-group { margin: 8px 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.ipr-group > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; background: rgba(255,255,255,0.03); list-style: none; }
.ipr-group > summary::-webkit-details-marker { display: none; }
.ipr-group > summary::before { content: "▶ "; display: inline-block; transition: transform 0.15s; font-size: 10px; color: var(--muted); }
.ipr-group[open] > summary::before { transform: rotate(90deg); }
.ipr-group-count { font-weight: 400; font-size: 12px; color: var(--muted); margin-left: 6px; }
.ipr-group-body { padding: 0 12px 8px; }

.ipr-empty { padding: 20px; text-align: center; color: var(--muted); font-size: 13px; }
.ipr-copied { color: #4ade80; font-size: 12px; margin-left: 8px; }
`;

// ── Page renderer ─────────────────────────────────────────────────────
export default async function renderIpRanges() {
  const el = document.createElement("section");
  el.className = "card";

  const styleTag = document.createElement("style");
  styleTag.textContent = PAGE_STYLES;
  el.appendChild(styleTag);

  // Genesys regions: only those with a configured customer
  const customerHosts = new Set(
    (orgContext.getCustomers() || []).map((c) => c.region).filter(Boolean)
  );
  const gcAvailableRegions = GC_REGIONS.filter((r) =>
    customerHosts.has(GC_REGION_HOST_BY_CODE[r.code])
  );
  const gcInitialRegion =
    gcAvailableRegions.find((r) => r.code === GC_DEFAULT_REGION)?.code ||
    gcAvailableRegions[0]?.code ||
    null;

  el.insertAdjacentHTML("beforeend", `
    <div class="ipr-mode-toggle">
      <button class="ipr-mode-btn active" id="iprModeGenesys" data-mode="genesys">Genesys Public IP Ranges</button>
      <button class="ipr-mode-btn"        id="iprModeAws"     data-mode="aws">Amazon IP Ranges</button>
    </div>

    <div class="ipr-header">
      <div>
        <h2 class="h2" id="iprTitle">Genesys Public IP Ranges</h2>
        <p class="page-desc" id="iprDesc">
          Public IP ranges (CIDR blocks) published by Genesys Cloud for a given region.
          Useful for firewall whitelisting. Source: <code>GET /api/v2/ipranges</code>.
        </p>
        <div class="ipr-meta" id="iprMeta">No data loaded yet.</div>
      </div>
      <div class="ipr-header-actions">
        <button class="btn" id="iprRefreshBtn">Refresh</button>
      </div>
    </div>

    <hr class="hr">

    <!-- Filters -->
    <div class="ipr-filters">
      <div class="di-control-group">
        <label class="di-label" for="iprRegion"><span id="iprRegionLabel">Region</span></label>
        <select class="input" id="iprRegion"></select>
      </div>
      <div class="di-control-group">
        <label class="di-label" for="iprGroupBy">Group by</label>
        <select class="input" id="iprGroupBy">
          <option value="service" selected>Service</option>
          <option value="none">None (flat table)</option>
        </select>
      </div>
      <div class="di-control-group">
        <label class="di-label" for="iprDirection"><span id="iprDirectionLabel">Direction</span></label>
        <select class="input" id="iprDirection"></select>
      </div>
      <div class="di-control-group">
        <label class="di-label" for="iprSearch">CIDR search</label>
        <input type="text" class="input" id="iprSearch" placeholder="e.g. 23.228 or /24">
      </div>
      <div class="di-control-group" style="flex: 1; min-width: 280px;">
        <label class="di-label">Services</label>
        <div class="ipr-services" id="iprServices"></div>
      </div>
    </div>

    <p class="ipr-status" id="iprStatus">Loading…</p>

    <div class="ipr-actions-row" id="iprActionsRow" style="display:none">
      <button class="btn" id="iprCopyBtn">Copy CIDRs</button>
      <button class="btn" id="iprExportBtn">Export to Excel</button>
      <span class="ipr-copied" id="iprCopied" style="display:none">Copied!</span>
    </div>

    <div class="ipr-summary" id="iprSummary" style="display:none"></div>

    <div id="iprResults"></div>
  `);

  // ── DOM refs ─────────────────────────────────────────
  const $title       = el.querySelector("#iprTitle");
  const $desc        = el.querySelector("#iprDesc");
  const $modeBtns    = el.querySelectorAll(".ipr-mode-btn");
  const $region      = el.querySelector("#iprRegion");
  const $regionLabel = el.querySelector("#iprRegionLabel");
  const $groupBy     = el.querySelector("#iprGroupBy");
  const $direction   = el.querySelector("#iprDirection");
  const $dirLabel    = el.querySelector("#iprDirectionLabel");
  const $search      = el.querySelector("#iprSearch");
  const $services    = el.querySelector("#iprServices");
  const $status      = el.querySelector("#iprStatus");
  const $results     = el.querySelector("#iprResults");
  const $summary     = el.querySelector("#iprSummary");
  const $actions     = el.querySelector("#iprActionsRow");
  const $refresh     = el.querySelector("#iprRefreshBtn");
  const $copy        = el.querySelector("#iprCopyBtn");
  const $copied      = el.querySelector("#iprCopied");
  const $export      = el.querySelector("#iprExportBtn");
  const $meta        = el.querySelector("#iprMeta");

  // ── State ────────────────────────────────────────────
  let mode = "genesys";              // "genesys" | "aws"
  let allEntries = [];               // normalized entries
  let awsCache = null;               // cached AWS payload (per-page-load)
  let selectedServices = new Set();
  let sortKey = "cidr";
  let sortDir = "asc";

  // ── Mode wiring ──────────────────────────────────────
  function setMode(next) {
    if (mode === next) return;
    mode = next;
    $modeBtns.forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode)
    );
    sortKey = "cidr";
    sortDir = "asc";
    selectedServices = new Set();
    $search.value = "";
    rebuildModeUi();
  }

  function rebuildModeUi() {
    if (mode === "genesys") {
      $title.textContent = "Genesys Public IP Ranges";
      $desc.innerHTML = `Public IP ranges (CIDR blocks) published by Genesys Cloud for a given region.
        Useful for firewall whitelisting. Source: <code>GET /api/v2/ipranges</code>.`;
      $regionLabel.textContent = "Region";
      $dirLabel.textContent = "Direction";
      $direction.innerHTML = `
        <option value="">All</option>
        <option value="inbound">Inbound</option>
        <option value="outbound">Outbound</option>
        <option value="both">Both</option>
      `;
      // Region dropdown: regions that have a configured customer
      $region.disabled = !gcInitialRegion;
      $refresh.disabled = !gcInitialRegion;
      $region.innerHTML = gcAvailableRegions.length === 0
        ? `<option value="">No regions available</option>`
        : gcAvailableRegions.map((r) =>
            `<option value="${escapeHtml(r.code)}"${r.code === gcInitialRegion ? " selected" : ""}>${escapeHtml(r.label)} (${escapeHtml(r.code)})</option>`
          ).join("");
      if (gcInitialRegion) {
        loadGenesys(gcInitialRegion);
      } else {
        allEntries = [];
        $meta.textContent = "No data loaded.";
        $status.textContent = "No customers configured — add a customer org to enable IP range lookups.";
        $status.className = "ipr-status ipr-status--error";
        $status.style.display = "block";
        $services.innerHTML = "";
        $results.innerHTML = "";
        $summary.style.display = "none";
        $actions.style.display = "none";
      }
    } else {
      $title.textContent = "Amazon IP Ranges";
      $desc.innerHTML = `Public IP ranges (CIDR blocks) published by Amazon Web Services across all regions and services.
        Useful for firewall whitelisting. Source: <a href="https://ip-ranges.amazonaws.com/ip-ranges.json" target="_blank" rel="noopener">ip-ranges.amazonaws.com/ip-ranges.json</a>.`;
      $regionLabel.textContent = "Region";
      $dirLabel.textContent = "IP type";
      $direction.innerHTML = `
        <option value="">All</option>
        <option value="ipv4">IPv4</option>
        <option value="ipv6">IPv6</option>
      `;
      // Region dropdown will be populated after first load
      $region.disabled = false;
      $refresh.disabled = false;
      $region.innerHTML = `<option value="">All regions</option>`;
      loadAws({ force: false });
    }
  }

  // ── Data fetch: Genesys ──────────────────────────────
  async function loadGenesys(region) {
    $status.textContent = `Loading IP ranges for ${region}…`;
    $status.className = "ipr-status";
    $status.style.display = "block";
    $results.innerHTML = "";
    $summary.style.display = "none";
    $actions.style.display = "none";
    $services.innerHTML = "";
    selectedServices = new Set();

    try {
      const token = getValidAccessToken();
      if (!token) throw new Error("No valid access token — please refresh the page.");
      const resp = await fetch(`/api/ipranges?region=${encodeURIComponent(region)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      const entities = Array.isArray(json.entities) ? json.entities : [];
      allEntries = entities.map((e) => ({
        cidr: e.cidr,
        service: e.service || "Unknown",
        region: e.region || region,
        direction: e.direction || "both",
      }));
      const meta = json.meta || {};
      $meta.innerHTML = `Source: <strong>Genesys Cloud</strong>
        &nbsp;·&nbsp; Region: <strong>${escapeHtml(meta.region || region)}</strong>
        &nbsp;·&nbsp; Host: <code>api.${escapeHtml(meta.host || "?")}</code>
        &nbsp;·&nbsp; Fetched: ${escapeHtml(formatTime(meta.fetchedAt))}
        &nbsp;·&nbsp; Total entries: ${allEntries.length}`;

      $status.style.display = "none";
      $actions.style.display = "flex";
      $summary.style.display = "block";
      renderServiceChips();
      render();
    } catch (err) {
      allEntries = [];
      $status.textContent = `Failed to load IP ranges: ${err.message}`;
      $status.className = "ipr-status ipr-status--error";
      $status.style.display = "block";
      $meta.textContent = "No data loaded.";
    }
  }

  // ── Data fetch: AWS ──────────────────────────────────
  async function loadAws({ force }) {
    $status.textContent = "Loading AWS IP ranges…";
    $status.className = "ipr-status";
    $status.style.display = "block";
    $results.innerHTML = "";
    $summary.style.display = "none";
    $actions.style.display = "none";
    $services.innerHTML = "";
    selectedServices = new Set();

    try {
      let json;
      if (!force && awsCache) {
        json = awsCache;
      } else {
        const resp = await fetch(`/api/aws-ipranges${force ? "?force=true" : ""}`);
        json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
        awsCache = json;
      }

      const v4 = Array.isArray(json.prefixes) ? json.prefixes : [];
      const v6 = Array.isArray(json.ipv6_prefixes) ? json.ipv6_prefixes : [];
      const combined = [
        ...v4.map((p) => ({
          cidr: p.ip_prefix,
          service: p.service || "AMAZON",
          region: p.region || "GLOBAL",
          direction: "ipv4",
        })),
        ...v6.map((p) => ({
          cidr: p.ipv6_prefix,
          service: p.service || "AMAZON",
          region: p.region || "GLOBAL",
          direction: "ipv6",
        })),
      ];
      allEntries = combined;

      // Populate region dropdown from data
      const regions = [...new Set(combined.map((e) => e.region))].sort();
      // Preserve current selection if any; otherwise default to AWS_DEFAULT_REGION
      // (eu-central-1) if present, else "All regions".
      const desiredRegion = $region.value || AWS_DEFAULT_REGION;
      const selectedRegion = regions.includes(desiredRegion) ? desiredRegion : "";
      $region.innerHTML = `<option value=""${selectedRegion === "" ? " selected" : ""}>All regions</option>` +
        regions.map((r) => `<option value="${escapeHtml(r)}"${r === selectedRegion ? " selected" : ""}>${escapeHtml(r)}</option>`).join("");

      const meta = json.meta || {};
      const createDate = json.createDate ? `&nbsp;·&nbsp; Published: ${escapeHtml(json.createDate)}` : "";
      $meta.innerHTML = `Source: <strong>Amazon Web Services</strong>
        &nbsp;·&nbsp; Sync token: <code>${escapeHtml(json.syncToken || "?")}</code>
        ${createDate}
        &nbsp;·&nbsp; Fetched: ${escapeHtml(formatTime(meta.fetchedAt))}${meta.cached ? " (cached)" : ""}
        &nbsp;·&nbsp; Total entries: ${allEntries.length}`;

      $status.style.display = "none";
      $actions.style.display = "flex";
      $summary.style.display = "block";
      renderServiceChips();
      render();
    } catch (err) {
      allEntries = [];
      $status.textContent = `Failed to load AWS IP ranges: ${err.message}`;
      $status.className = "ipr-status ipr-status--error";
      $status.style.display = "block";
      $meta.textContent = "No data loaded.";
    }
  }

  // ── Service chips (multi-toggle filter) ──────────────
  function renderServiceChips() {
    const counts = new Map();
    for (const e of allEntries) {
      counts.set(e.service, (counts.get(e.service) || 0) + 1);
    }
    const services = [...counts.keys()].sort();

    $services.innerHTML = services
      .map((s) => {
        const active = selectedServices.has(s);
        return `<button type="button" class="ipr-chip${active ? " ipr-chip--active" : ""}" data-svc="${escapeHtml(s)}">
          ${escapeHtml(s)} <span class="ipr-chip-count">(${counts.get(s)})</span>
        </button>`;
      })
      .join("");

    $services.querySelectorAll(".ipr-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const svc = btn.dataset.svc;
        if (selectedServices.has(svc)) selectedServices.delete(svc);
        else selectedServices.add(svc);
        btn.classList.toggle("ipr-chip--active");
        render();
      });
    });
  }

  // ── Filtering ────────────────────────────────────────
  function getFiltered() {
    const dir = $direction.value;
    const q = $search.value.trim().toLowerCase();
    const regionFilter = mode === "aws" ? $region.value : "";
    return allEntries.filter((e) => {
      if (selectedServices.size > 0 && !selectedServices.has(e.service)) return false;
      if (dir && e.direction !== dir) return false;
      if (regionFilter && e.region !== regionFilter) return false;
      if (q && !(e.cidr || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // ── Sorting (flat mode) ──────────────────────────────
  function sortRows(rows) {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = String(a[sortKey] ?? "");
      const bv = String(b[sortKey] ?? "");
      return av.localeCompare(bv, undefined, { numeric: true }) * dir;
    });
  }

  function sortArrow(key) {
    if (key !== sortKey) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  function tagBadge(value) {
    return mode === "aws" ? ipTypeBadge(value) : directionBadge(value);
  }

  function tagColumnLabel() {
    return mode === "aws" ? "Type" : "Direction";
  }

  // ── Rendering ────────────────────────────────────────
  function render() {
    const filtered = getFiltered();
    $summary.textContent = `${filtered.length} entr${filtered.length === 1 ? "y" : "ies"} shown (of ${allEntries.length} total)`;

    if (filtered.length === 0) {
      $results.innerHTML = `<div class="ipr-empty">No entries match the current filters.</div>`;
      return;
    }

    if ($groupBy.value === "service") {
      renderGrouped(filtered);
    } else {
      renderFlat(filtered);
    }
  }

  function renderFlat(rows) {
    const sorted = sortRows(rows);
    const showRegion = mode === "aws";
    $results.innerHTML = `
      <table class="ipr-table">
        <thead>
          <tr>
            <th data-sort="cidr">CIDR${sortArrow("cidr")}</th>
            <th data-sort="service">Service${sortArrow("service")}</th>
            ${showRegion ? `<th data-sort="region">Region${sortArrow("region")}</th>` : ""}
            <th data-sort="direction">${tagColumnLabel()}${sortArrow("direction")}</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map((e) => `
            <tr>
              <td class="ipr-cidr">${escapeHtml(e.cidr)}</td>
              <td>${escapeHtml(e.service)}</td>
              ${showRegion ? `<td>${escapeHtml(e.region || "—")}</td>` : ""}
              <td>${tagBadge(e.direction)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    $results.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
        else { sortKey = k; sortDir = "asc"; }
        render();
      });
    });
  }

  function renderGrouped(rows) {
    const showRegion = mode === "aws";
    const byService = new Map();
    for (const e of rows) {
      if (!byService.has(e.service)) byService.set(e.service, []);
      byService.get(e.service).push(e);
    }
    const services = [...byService.keys()].sort();

    $results.innerHTML = services.map((svc) => {
      const items = byService.get(svc).sort((a, b) =>
        String(a.cidr).localeCompare(String(b.cidr), undefined, { numeric: true })
      );
      return `
        <details class="ipr-group">
          <summary>${escapeHtml(svc)}<span class="ipr-group-count">(${items.length})</span></summary>
          <div class="ipr-group-body">
            <table class="ipr-table">
              <thead>
                <tr>
                  <th>CIDR</th>
                  ${showRegion ? `<th>Region</th>` : ""}
                  <th>${tagColumnLabel()}</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((e) => `
                  <tr>
                    <td class="ipr-cidr">${escapeHtml(e.cidr)}</td>
                    ${showRegion ? `<td>${escapeHtml(e.region || "—")}</td>` : ""}
                    <td>${tagBadge(e.direction)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </details>
      `;
    }).join("");
  }

  // ── Copy CIDRs ───────────────────────────────────────
  function copyCidrs() {
    const filtered = getFiltered();
    const unique = [...new Set(filtered.map((e) => e.cidr))];
    const text = unique.join("\n");

    const finish = (ok) => {
      if (!ok) return;
      $copied.style.display = "inline";
      setTimeout(() => { $copied.style.display = "none"; }, 1500);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => finish(true)).catch(fallback);
    } else {
      fallback();
    }

    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); finish(true); }
      catch { finish(false); }
      document.body.removeChild(ta);
    }
  }

  // ── Excel export ─────────────────────────────────────
  function exportToExcel() {
    const filtered = getFiltered();
    if (filtered.length === 0) return;

    const rows = sortRows(filtered);
    const tagLabel = tagColumnLabel();
    const columns = [
      { key: "cidr",      label: "CIDR",    wch: 30 },
      { key: "service",   label: "Service", wch: 22 },
      { key: "region",    label: "Region",  wch: 18 },
      { key: "direction", label: tagLabel,  wch: 12 },
    ];
    const stem = mode === "aws"
      ? "AWS_IP_Ranges"
      : `Genesys_IP_Ranges_${$region.value || "all"}`;
    const filename = timestampedFilename(stem, "xlsx");

    try {
      exportXlsx([{ name: "IP Ranges", rows, columns }], filename);
    } catch (err) {
      $status.textContent = `Export failed: ${err.message}`;
      $status.className = "ipr-status ipr-status--error";
      $status.style.display = "block";
    }
  }

  // ── Event wiring ─────────────────────────────────────
  $modeBtns.forEach((btn) =>
    btn.addEventListener("click", () => setMode(btn.dataset.mode))
  );
  $region.addEventListener("change", () => {
    if (mode === "genesys") loadGenesys($region.value);
    else render(); // AWS: region is a client-side filter
  });
  $groupBy.addEventListener("change", render);
  $direction.addEventListener("change", render);
  $search.addEventListener("input", render);
  $refresh.addEventListener("click", () => {
    if (mode === "genesys") loadGenesys($region.value);
    else loadAws({ force: true });
  });
  $copy.addEventListener("click", copyCidrs);
  $export.addEventListener("click", exportToExcel);

  // Initial render (Genesys mode by default)
  rebuildModeUi();

  return el;
}
