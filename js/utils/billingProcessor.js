/**
 * Billing data processor.
 *
 * Pure functions that transform a Genesys `BillingOverview` response into
 * the rows + summary the Excel builder needs. No DOM, no API calls.
 *
 * Ported line-for-line from Python: GUI_Billing_Export.py
 *   - get_billing_data()  → buildRawRows()
 *   - export_to_excel()   → processBillingOverview()  (data layer only)
 *
 * Key behaviours (must match Python exactly — affects customer billing):
 *
 *   1. NON-AI FAIR-USE ALLOCATIONS (Voice Transcription, etc.)
 *      Pass 1 collects every fair-use row whose name is NOT an "AI Token"
 *      into a dict keyed by license name. Pass 2 skips those fair-use rows
 *      from the output, BUT when a regular usage row's name matches an
 *      allocation we use the allocation as its committed (prepay) quantity.
 *
 *   2. AI ITEMS ARE DETECTED BY NAME (not just by grouping)
 *      An item is "AI" if ANY of:
 *        - partNumber === "GC-170-NV-AITC"
 *        - name contains "AI" AND "Token"
 *        - name matches: AI Guide | AI Scoring | AI Summary | AI Translate
 *        - name contains: Speech and Text Analytics | Agent Copilot
 *                        | Virtual Agent | Predictive Routing
 *                        | Predictive Engagement | Bot Flow
 *      AI items NEVER appear in Regular Licences, regardless of grouping.
 *
 *   3. AI SUMMARY (fair-use / rollup / rollup-usage among AI items only)
 *      - ai_fair_use = AI row with grouping="fair-use"   (else 250/350 fallback)
 *      - ai_rollup   = AI row with grouping="rollup"     (else = fair-use)
 *      - ai_breakdown= AI rows with grouping="rollup-usage"
 *      - ai_billable = max(0, rollup - fair_use)
 *
 *   4. REGULAR-LICENCE OVERRIDES (per Python adjusted_*_values)
 *      - "Call":                          committed = actual, no on-demand
 *      - "Genesys Cloud Collaborate User":committed = actual, no on-demand
 *      - "Genesys Cloud BYOC Cloud":      committed = CX count × multiplier
 *                                         on-demand = max(0, actual − committed)
 *      - everything else:                 committed = prepay (possibly from
 *                                         non-AI fair-use); on-demand = max(0, actual − committed)
 */

// ── Constants (match Python) ─────────────────────────────────────────

const AI_TOKENS_PER_CONCURRENT = 350;
const AI_TOKENS_PER_NAMED      = 250;
const BYOC_MINS_PER_CONCURRENT = 6500;
const BYOC_MINS_PER_NAMED      = 5000;

const BYOC_LICENCE_NAME       = "Genesys Cloud BYOC Cloud";
const COLLABORATE_LICENCE     = "Genesys Cloud Collaborate User";
const CALL_LICENCE            = "Call";
// Python uses substring check: 'CX 1' in name or 'CX 2' in name or 'CX 3' in name.
// License names look like "Genesys Cloud CX 2 Concurrent" — must match substring, not prefix.
const CX_LICENCE_PATTERN      = /\bCX\s*[123]\b/i;

const GROUP_FAIR_USE     = "fair-use";
const GROUP_ROLLUP       = "rollup";
const GROUP_ROLLUP_USAGE = "rollup-usage";

// ── AI detection patterns (must mirror df_ai mask in Python) ─────────

const AI_PART_NUMBER = "GC-170-NV-AITC";

// Single combined regex of all the case-insensitive substring patterns
// Python checks via str.contains. Order matters only for readability.
const AI_NAME_PATTERN = new RegExp(
  [
    "AI Guide",
    "AI Scoring",
    "AI Summary",
    "AI Translate",
    "Speech and Text Analytics",
    "Agent Copilot",
    "Virtual Agent",        // also catches "Agentic Virtual Agent"
    "Predictive Routing",
    "Predictive Engagement",
    "Bot Flow",
  ].join("|"),
  "i"
);

/** Broad AI mask — matches Python df_ai filter. */
function isAiItem(name, partNumber) {
  if (partNumber === AI_PART_NUMBER) return true;
  const n = String(name || "");
  // "AI" and "Token" both present (case-insensitive)
  if (/AI/i.test(n) && /Token/i.test(n)) return true;
  if (AI_NAME_PATTERN.test(n)) return true;
  return false;
}

/** Narrower check — matches Python `is_ai_token` used for fair-use skip. */
function isAiTokenStrict(name) {
  const n = String(name || "");
  return /AI/i.test(n) && /Token/i.test(n);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Tolerant numeric coercion — Genesys sometimes returns strings. */
function num(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalise grouping for comparison (case-insensitive, trimmed). */
function groupingOf(usage) {
  return String(usage.grouping || "").trim().toLowerCase();
}

/** Format an integer with thousands separators (en-US style). */
function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

/** Format a "N,NNN tokens" label. */
function fmtTokens(n) {
  return `${fmtInt(n)} tokens`;
}

/** Pretty date — YYYY-MM-DD. */
function fmtDate(d) {
  if (!d) return "";
  const date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date)) return String(d);
  const yyyy = date.getUTCFullYear();
  const mm   = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Transform a single `BillingOverview` response into the structured data
 * the Excel builder consumes.
 *
 * @param {object} overview  Raw Genesys BillingOverview response.
 * @returns {{
 *   summary: {
 *     licenseType: "Concurrent" | "Named",
 *     startDate: string,
 *     endDate: string,
 *     billableItems: number,
 *     aiFairUse: number,
 *     aiRollup: number,
 *     aiBillable: number,
 *     hasAi: boolean,
 *     currency: string,
 *     subscriptionType: string,
 *   },
 *   regularRows: Array<{ name, committed, actualUsage, onDemand }>,
 *   aiBreakdownRows: Array<{ name, committed: "", actualUsage, onDemand }>,
 *   overageRows: Array<{ name, committed, actualUsage, onDemand, overageCost }>,
 * }}
 */
export function processBillingOverview(overview) {
  const usages = Array.isArray(overview?.usages) ? overview.usages : [];

  // ── Pass 1: collect non-AI fair-use allocations ──────────────────
  // Python: fair_use_allocations[license_name] = usage_quantity
  // Only when grouping=="fair-use" AND name is NOT an AI-Token AND usageQty>0.
  // These become the committed quantity for the matching regular usage row.
  const fairUseAllocations = new Map();
  for (const u of usages) {
    const g    = groupingOf(u);
    const name = String(u?.name || "");
    const qty  = num(u?.usageQuantity);
    if (g === GROUP_FAIR_USE && !isAiTokenStrict(name) && qty > 0) {
      fairUseAllocations.set(name, qty);
    }
  }

  // ── Pass 2: build the expanded row list (Python `rows`) ──────────
  // Mirrors the second loop in Python's get_billing_data().
  const rawRows = [];
  for (const u of usages) {
    const g          = groupingOf(u);
    const name       = String(u?.name || "");
    const usageQty   = num(u?.usageQuantity);
    const partNumber = String(u?.partNumber || "");

    if (usageQty <= 0) continue;
    if (g === GROUP_FAIR_USE && !isAiTokenStrict(name)) continue; // skip allocation rows

    let prepayQty = num(u?.prepayQuantity);
    if (fairUseAllocations.has(name) && prepayQty === 0) {
      prepayQty = fairUseAllocations.get(name);
    }

    rawRows.push({
      name,
      grouping:    g,
      partNumber,
      committed:   prepayQty,           // raw — adjusted again below for Call/BYOC/Collab
      actualUsage: usageQty,
      onDemand:    Math.max(0, usageQty - prepayQty),
    });
  }

  // ── Split: AI vs Regular (by name/part-number mask) ──────────────
  const aiRowsAll  = rawRows.filter((r) => isAiItem(r.name, r.partNumber));
  const regularSrc = rawRows.filter((r) => !isAiItem(r.name, r.partNumber));

  // ── Licence type (Concurrent vs Named) — detected from REGULAR rows
  // only, matching Python's df_regular scan.
  const isConcurrent = regularSrc.some((r) => /Concurrent/i.test(r.name));
  const licenseType  = isConcurrent ? "Concurrent" : "Named";
  const expectedFairUse = isConcurrent ? AI_TOKENS_PER_CONCURRENT : AI_TOKENS_PER_NAMED;

  // ── AI summary (from AI rows only) ───────────────────────────────
  let aiFairUse = 0;
  let aiRollup  = 0;
  const aiBreakdownRows = [];
  for (const r of aiRowsAll) {
    if (r.grouping === GROUP_FAIR_USE) {
      aiFairUse = r.actualUsage;
    } else if (r.grouping === GROUP_ROLLUP) {
      aiRollup = r.actualUsage;
    } else if (r.grouping === GROUP_ROLLUP_USAGE && r.actualUsage > 0) {
      aiBreakdownRows.push({
        name:        r.name,
        committed:   "",
        actualUsage: r.actualUsage,
        onDemand:    "",
      });
    }
  }
  // Python fallbacks
  if (aiFairUse === 0 && aiRollup > 0) aiFairUse = expectedFairUse;
  if (aiFairUse > 0  && aiRollup === 0) aiRollup  = aiFairUse;
  const aiBillable = aiRollup > aiFairUse ? aiRollup - aiFairUse : 0;
  // Python gates the AI summary lines on `if ai_rollup > 0`. The breakdown
  // section is gated independently on `ai_breakdown_rows`.
  const hasAi      = aiRollup > 0;

  // ── Regular licences: count CX 1/2/3 for BYOC + concurrent flag ──
  // Python uses the original Committed Quantity (= prepay_qty after pass 2),
  // before per-license adjustments below.
  let cxLicenseCount        = 0;
  let licenseTypeForByoc    = "named";
  for (const r of regularSrc) {
    if (CX_LICENCE_PATTERN.test(r.name)) {
      if (typeof r.committed === "number" && r.committed > 0) {
        cxLicenseCount += r.committed;
      }
      if (/Concurrent/i.test(r.name)) licenseTypeForByoc = "concurrent";
    }
  }
  const byocMultiplier = licenseTypeForByoc === "concurrent"
    ? BYOC_MINS_PER_CONCURRENT
    : BYOC_MINS_PER_NAMED;
  // Python: int(cx_license_count * multiplier) if cx_license_count > 0 else ''
  const byocCommitted = cxLicenseCount > 0
    ? Math.trunc(cxLicenseCount * byocMultiplier)
    : "";

  // ── Apply per-licence-name overrides ─────────────────────────────
  const regularRows = [];
  const overageRows = [];
  for (const r of regularSrc) {
    let committed   = r.committed;
    let actualUsage = r.actualUsage;
    let onDemand    = r.onDemand;

    if (r.name === CALL_LICENCE) {
      committed = actualUsage;
      onDemand  = "";
    } else if (r.name === COLLABORATE_LICENCE) {
      committed = actualUsage;
      onDemand  = "";
    } else if (r.name === BYOC_LICENCE_NAME) {
      committed = byocCommitted;
      if (typeof committed === "number" && actualUsage > committed) {
        onDemand = actualUsage - committed;
      } else {
        onDemand = "";
      }
    }
    // else: keep committed = prepay (possibly from fair-use allocation),
    //       onDemand = max(0, actualUsage - committed) already computed.

    const out = { name: r.name, committed, actualUsage, onDemand };
    regularRows.push(out);

    if (typeof onDemand === "number" && onDemand > 0) {
      overageRows.push({ ...out, overageCost: 0 });
    }
  }

  // ── AI billable also surfaced in the overage section ─────────────
  if (hasAi && aiBillable > 0) {
    overageRows.push({
      name:        "AI Tokens - Billable",
      committed:   "",
      actualUsage: "",
      onDemand:    Math.round(aiBillable),
      overageCost: 0,
    });
  }

  // ── Stable name sort within each section (matches Python sort) ──
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  regularRows.sort(byName);
  aiBreakdownRows.sort(byName);
  overageRows.sort(byName);

  const summary = {
    licenseType,
    startDate:        fmtDate(overview?.billingPeriodStartDate),
    endDate:          fmtDate(overview?.billingPeriodEndDate),
    billableItems:    overageRows.length,
    aiFairUse,
    aiRollup,
    aiBillable,
    hasAi,
    currency:         overview?.currency || "",
    subscriptionType: overview?.subscriptionType || "",
  };

  return { summary, regularRows, aiBreakdownRows, overageRows };
}

// ── Exposed helpers (tests / other variants) ─────────────────────────

export { fmtInt, fmtTokens, fmtDate };
