/**
 * Billing data processor.
 *
 * Pure functions that transform a Genesys
 * `BillingOverview` response into the rows + summary the Excel builder
 * needs. No DOM, no API calls.
 *
 * Ported from Python: GUI_Billing_Export.py (data layer).
 *
 * The Genesys response shape (relevant fields):
 *   {
 *     billingPeriodStartDate, billingPeriodEndDate, currency, subscriptionType,
 *     usages: [{
 *       name, grouping, prepayQuantity, usageQuantity, bundleQuantity,
 *       prepayPrice, overagePrice, partNumber, unitOfMeasureType,
 *       isThirdParty, isCancellable
 *     }, ...]
 *   }
 *
 * Grouping values drive section placement:
 *   - "fair-use"     → AI allowance (used only for AI summary)
 *   - "rollup"       → AI total used (used only for AI summary)
 *   - "rollup-usage" → individual AI service breakdown rows
 *   - anything else  → regular licence row
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

  // ── Detect license type from any name containing "Concurrent" ─────
  const isConcurrent = usages.some((u) => /Concurrent/i.test(u?.name || ""));
  const licenseType  = isConcurrent ? "Concurrent" : "Named";

  // ── AI allowance + rollup ─────────────────────────────────────────
  // Per Python logic: fair-use allowance is a fixed per-license token
  // count (250 named / 350 concurrent), NOT the API's fair-use quantity.
  // The "rollup" row gives the total tokens consumed across all AI services.
  let aiRollup = 0;
  let hasAiFairUse = false;
  let hasAiRollup  = false;

  for (const u of usages) {
    const g = groupingOf(u);
    if (g === GROUP_FAIR_USE)   hasAiFairUse = true;
    if (g === GROUP_ROLLUP)   { hasAiRollup  = true; aiRollup = num(u.usageQuantity); }
  }
  const hasAi      = hasAiFairUse || hasAiRollup;
  const aiFairUse  = isConcurrent ? AI_TOKENS_PER_CONCURRENT : AI_TOKENS_PER_NAMED;
  // Python edge-case: if there's a fair-use row but no actual rollup usage,
  // show the allocation as the "total used" (so Free == Total Used, Billable == 0).
  if (hasAiFairUse && !hasAiRollup) aiRollup = aiFairUse;
  const aiBillable = aiRollup > aiFairUse ? aiRollup - aiFairUse : 0;

  // ── Count CX licences for BYOC committed calculation ──────────────
  let cxLicenseCount = 0;
  for (const u of usages) {
    if (CX_LICENCE_PATTERN.test(u?.name || "")) {
      // prepayQuantity is the committed CX count (per period)
      cxLicenseCount += num(u.prepayQuantity);
    }
  }
  const byocCommitted = cxLicenseCount * (isConcurrent ? BYOC_MINS_PER_CONCURRENT : BYOC_MINS_PER_NAMED);

  // ── Walk usages and build rows ───────────────────────────────────
  const regularRows     = [];
  const aiBreakdownRows = [];
  const overageRows     = [];

  for (const u of usages) {
    const g          = groupingOf(u);
    const name       = String(u?.name || "").trim();
    const usageQty   = num(u.usageQuantity);
    const prepayQty  = num(u.prepayQuantity);
    const overagePrc = num(u.overagePrice);

    // Skip rows with no consumption (matches Python filter).
    if (usageQty <= 0) continue;

    // AI summary inputs — already captured above; do not emit as rows.
    if (g === GROUP_FAIR_USE || g === GROUP_ROLLUP) continue;

    // ── AI service breakdown rows ──────────────────────────────────
    if (g === GROUP_ROLLUP_USAGE) {
      aiBreakdownRows.push({
        name,
        committed:   "",         // AI services have no per-service prepay
        actualUsage: usageQty,
        onDemand:    "",         // breakdown is informational only
      });
      continue;
    }

    // ── Regular licence row with per-licence-name overrides ────────
    let committed = prepayQty;
    let onDemand;

    if (name === CALL_LICENCE) {
      // Call licences: no prepay — committed equals usage, no on-demand
      committed = usageQty;
      onDemand  = "";
    } else if (name === COLLABORATE_LICENCE) {
      // Collaborate: free, no overage column
      committed = usageQty;
      onDemand  = "";
    } else if (name === BYOC_LICENCE_NAME) {
      // BYOC minutes: committed = CX licences × multiplier; overage = usage − committed
      committed = byocCommitted;
      onDemand  = Math.max(0, usageQty - byocCommitted);
    } else {
      // Default: on-demand = max(0, usage − committed)
      onDemand = Math.max(0, usageQty - committed);
    }

    const row = { name, committed, actualUsage: usageQty, onDemand };
    regularRows.push(row);

    // Anything with a real numeric on-demand > 0 OR a positive overage
    // price applied to non-zero usage is treated as a billable/overage item.
    if (typeof onDemand === "number" && onDemand > 0) {
      overageRows.push({
        ...row,
        overageCost: overagePrc > 0 ? onDemand * overagePrc : 0,
      });
    }
  }

  // ── AI billable also gets surfaced in the overage section ────────
  // Python writes the integer billable count in the On-Demand column only;
  // Committed and Actual Usage are blank for this row.
  if (hasAi && aiBillable > 0) {
    overageRows.push({
      name:        "AI Tokens - Billable",
      committed:   "",
      actualUsage: "",
      onDemand:    Math.round(aiBillable),
      overageCost: 0,
    });
  }

  // ── Stable name sort within each section ─────────────────────────
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
