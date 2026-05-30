/**
 * Server-side Billing — Calendar Year export (scheduled).
 *
 * No Python equivalent exists (Python only has scheduled Single Org + All
 * Orgs Latest). Per agreed design, the scheduled handler always exports
 * the PREVIOUS calendar year (`new Date().getUTCFullYear() - 1`). This
 * matches the typical use case: schedule for early January each year to
 * produce the prior year's report.
 *
 * Iterates every billable customer (non-trustee). For each org it walks
 * billing period indices 1..13, stops on 404, and includes periods whose
 * start OR end year matches the target calendar year. Caps at 12 most
 * recent. Per-org failures are tolerated.
 *
 * Schedule config shape: none required.
 *   schedule.exportConfig = {}        // ignored
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const {
  processBillingOverview,
  buildCalendarYearWorkbook,
} = require("../billingWorkbook");

// ── Billing trustee mapping (mirror of js/utils/billingTrustees.js) ──
const BILLING_ORG_TRUSTEE_MAP = {
  "demo":        null,        // trustee — not exportable
  "test-ie":     null,        // trustee — not exportable
  "dktv":        "test-ie",
  "nuuday-test": "test-ie",
};
const DEFAULT_TRUSTEE_ID = "demo";

function getTrusteeForOrg(customerId) {
  if (customerId in BILLING_ORG_TRUSTEE_MAP) return BILLING_ORG_TRUSTEE_MAP[customerId];
  return DEFAULT_TRUSTEE_ID;
}
function isTrusteeOrg(customerId) {
  return BILLING_ORG_TRUSTEE_MAP[customerId] === null;
}
function filterBillableCustomers(list) {
  return (list || []).filter((c) => !isTrusteeOrg(c.id));
}

// ── Genesys API wrapper (per-customer credentials) ───────────────────

async function genesysCall(customerId, method, path) {
  const customer = customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);

  const envKey       = `GENESYS_${customerId.replace(/-/g, "_").toUpperCase()}`;
  const clientId     = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(`Credentials not configured for ${customerId} (${envKey}_CLIENT_ID/SECRET)`);
  }

  const token = await getGenesysToken(customerId, customer.region, clientId, clientSecret);
  const url   = `https://api.${customer.region}${path}`;
  const resp  = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err  = new Error(`Genesys API ${resp.status} for ${customerId} ${method} ${path}: ${body.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// ── Period walking (mirror of fetchBillingPeriodsForCalendarYear) ────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchPeriodsForCalendarYear(context, customerId, trusteeId, trustorOrgId, year) {
  const periods = [];

  for (let idx = 1; idx <= 13; idx++) {
    let ov;
    try {
      ov = await genesysCall(
        trusteeId,
        "GET",
        `/api/v2/billing/trusteebillingoverview/${trustorOrgId}?billingPeriodIndex=${idx}`
      );
    } catch (err) {
      if (err.status === 404) break;
      context.log.warn(`[billingCalendarYear] ${customerId} period ${idx} failed: ${err.message}`);
      continue;
    }
    if (!ov) continue;

    const startIso = ov.billingPeriodStartDate;
    const endIso   = ov.billingPeriodEndDate;
    const start    = startIso ? new Date(startIso) : null;
    const end      = endIso   ? new Date(endIso)   : null;
    if (!start || isNaN(start) || !end || isNaN(end)) continue;

    if (start.getUTCFullYear() !== year && end.getUTCFullYear() !== year) continue;

    const label = `${MONTH_ABBR[start.getUTCMonth()]} ${start.getUTCFullYear()} - ` +
                  `${MONTH_ABBR[end.getUTCMonth()]} ${end.getUTCFullYear()}`;

    periods.push({
      index:     idx,
      label,
      startDate: fmtDate(startIso),
      endDate:   fmtDate(endIso),
      overview:  ov,
    });
  }

  periods.sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (periods.length > 12) periods.splice(0, periods.length - 12);
  return periods;
}

// ── Single-org pipeline ──────────────────────────────────────────────

async function exportOneOrg(context, customer, year) {
  const trusteeId = getTrusteeForOrg(customer.id);
  if (trusteeId === null) {
    throw new Error(`${customer.name} is a trustee org and cannot be exported as a trustor.`);
  }

  const orgMe = await genesysCall(customer.id, "GET", "/api/v2/organizations/me");
  const trustorOrgId = orgMe && orgMe.id;
  if (!trustorOrgId) {
    throw new Error(`Could not resolve trustor org UUID for ${customer.name}.`);
  }

  const rawPeriods = await fetchPeriodsForCalendarYear(
    context, customer.id, trusteeId, trustorOrgId, year
  );
  if (!rawPeriods.length) {
    throw new Error(`no periods in ${year}`);
  }

  const periods = rawPeriods.map((p) => ({
    label:     p.label,
    processed: processBillingOverview(p.overview),
  }));

  return { orgName: customer.name, periods };
}

// ── Filename helper ──────────────────────────────────────────────────

function timestampedFilename(prefix, ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

// ── Main entry point ─────────────────────────────────────────────────

async function execute(context, schedule) {
  try {
    // Always export PREVIOUS calendar year.
    const year = new Date().getUTCFullYear() - 1;

    const billable = filterBillableCustomers(customers);
    if (billable.length === 0) {
      return { success: false, error: "No billable customers configured." };
    }

    context.log(`[billingCalendarYear] Processing ${billable.length} billable org(s) for ${year}…`);

    const orgsData = [];
    const failures = [];

    for (const customer of billable) {
      try {
        context.log(`[billingCalendarYear] → ${customer.id}`);
        const result = await exportOneOrg(context, customer, year);
        orgsData.push(result);
      } catch (err) {
        context.log.warn(`[billingCalendarYear] ${customer.id} failed: ${err.message}`);
        failures.push({ orgName: customer.name, error: err.message });
      }
    }

    if (orgsData.length === 0) {
      const detail = failures.map((f) => `${f.orgName}: ${f.error}`).join("; ");
      return { success: false, error: `No data exported. ${detail}` };
    }

    const buffer = buildCalendarYearWorkbook({ year, orgsData });
    const filename = timestampedFilename(`Billing_Calendar_Year_${year}`, "xlsx");

    const totalPeriods = orgsData.reduce((s, o) => s + o.periods.length, 0);
    const successLine =
      `${orgsData.length}/${billable.length} org(s) exported | ` +
      `${totalPeriods} period(s) total | year ${year}`;
    const failLine = failures.length
      ? ` | failed: ${failures.map((f) => `${f.orgName} (${f.error})`).join(", ")}`
      : "";
    const summary = successLine + failLine;

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const subject = `[All Orgs] Billing — Calendar Year ${year} Export`;
    const orgList = orgsData.map((o) => `  • ${o.orgName} (${o.periods.length} periods)`).join("\n");
    const failBlock = failures.length
      ? `\n\nFailed orgs:\n${failures.map((f) => `  • ${f.orgName}: ${f.error}`).join("\n")}`
      : "";
    const body =
      `Please find the scheduled export attached.\n\n` +
      `Task: Billing — Calendar Year ${year}\n` +
      `Total Periods: ${totalPeriods}\n` +
      `Orgs Exported (${orgsData.length}):\n${orgList}\n` +
      `Execution Time: ${timestamp}` +
      `${failBlock}\n\n` +
      `Best regards,\nGenesys Automation`;

    return {
      success:  true,
      filename,
      base64:   buffer.toString("base64"),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary,
      subject,
      body,
    };
  } catch (err) {
    context.log.error("[billingCalendarYear] Export failed:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
