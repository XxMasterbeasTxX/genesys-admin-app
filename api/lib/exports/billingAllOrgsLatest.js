/**
 * Server-side Billing — All Orgs (Latest Period) export.
 *
 * Mirrors the Python script GUI_Billing_Export_Scheduled_All.py:
 *   - Iterates every billable customer (non-trustee).
 *   - For each: fetches the latest complete billing period (index=1).
 *   - Emits a single .xlsx file (not multi-sheet) with all orgs stacked
 *     on one worksheet, separated by per-org summary banners.
 *
 * Per-org failures are tolerated: the org is skipped and reported in the
 * summary. If ALL orgs fail the export is reported as failed.
 *
 * Schedule config shape: none required.
 *   schedule.exportConfig = {}        // ignored
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error?, subject?, body? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const {
  processBillingOverview,
  buildAllOrgsLatestWorkbook,
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
    throw new Error(`Genesys API ${resp.status} for ${customerId} ${method} ${path}: ${body.slice(0, 200)}`);
  }
  return resp.json();
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

// ── Single-org pipeline (resolve UUID + fetch overview + process) ────

async function exportOneOrg(context, customer) {
  const trusteeId = getTrusteeForOrg(customer.id);
  if (trusteeId === null) {
    throw new Error(`${customer.name} is a trustee org and cannot be exported as a trustor.`);
  }

  // Step 1: resolve trustor org UUID via /organizations/me as the trustor.
  const orgMe = await genesysCall(customer.id, "GET", "/api/v2/organizations/me");
  const trustorOrgId = orgMe && orgMe.id;
  if (!trustorOrgId) {
    throw new Error(`Could not resolve trustor org UUID for ${customer.name}.`);
  }

  // Step 2: fetch latest-complete billing period (index 1) as the trustee.
  const overview = await genesysCall(
    trusteeId,
    "GET",
    `/api/v2/billing/trusteebillingoverview/${trustorOrgId}?billingPeriodIndex=1`
  );

  // Step 3: process.
  const processed = processBillingOverview(overview);
  return { orgName: customer.name, processed };
}

// ── Main entry point ─────────────────────────────────────────────────

async function execute(context, schedule) {
  try {
    const billable = filterBillableCustomers(customers);
    if (billable.length === 0) {
      return { success: false, error: "No billable customers configured." };
    }

    context.log(`[billingAllOrgsLatest] Processing ${billable.length} billable org(s)…`);

    const orgsData = [];
    const failures = [];

    // Sequential to avoid hammering Genesys + token endpoints in parallel.
    for (const customer of billable) {
      try {
        context.log(`[billingAllOrgsLatest] → ${customer.id}`);
        const result = await exportOneOrg(context, customer);
        orgsData.push(result);
      } catch (err) {
        context.log.warn(`[billingAllOrgsLatest] ${customer.id} failed: ${err.message}`);
        failures.push({ orgName: customer.name, error: err.message });
      }
    }

    if (orgsData.length === 0) {
      const detail = failures.map((f) => `${f.orgName}: ${f.error}`).join("; ");
      return { success: false, error: `All orgs failed. ${detail}` };
    }

    // Build single-sheet workbook with all orgs stacked.
    const buffer = buildAllOrgsLatestWorkbook({ orgsData });

    // Filename uses the first org's period range for context (Python convention).
    const firstSummary = orgsData[0].processed.summary;
    const filename = timestampedFilename(
      `Billing_All_Orgs_Latest_${firstSummary.startDate}_to_${firstSummary.endDate}`,
      "xlsx"
    );

    const totalBillable = orgsData.reduce(
      (sum, o) => sum + (o.processed.summary.billableItems || 0),
      0
    );
    const successLine =
      `${orgsData.length}/${billable.length} org(s) exported | ` +
      `${totalBillable} billable item(s) total | period ${firstSummary.startDate} to ${firstSummary.endDate}`;
    const failLine = failures.length
      ? ` | failed: ${failures.map((f) => f.orgName).join(", ")}`
      : "";
    const summary = successLine + failLine;

    // Match Python template (GUI_email_notifier.py).
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const subject = `[All Orgs] Billing — All Orgs Latest Export`;
    const orgList = orgsData.map((o) => `  • ${o.orgName}`).join("\n");
    const failBlock = failures.length
      ? `\n\nFailed orgs:\n${failures.map((f) => `  • ${f.orgName}: ${f.error}`).join("\n")}`
      : "";
    const body =
      `Please find the scheduled export attached.\n\n` +
      `Task: Billing — All Orgs Latest\n` +
      `Billing Period: ${firstSummary.startDate} to ${firstSummary.endDate}\n` +
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
    context.log.error("[billingAllOrgsLatest] Export failed:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
