/**
 * Server-side Billing — Single Org export.
 *
 * Mirrors the browser-side page (js/pages/export/billing/singleOrg.js) but
 * runs headless via client credentials — no browser required.
 *
 * Period selection: ALWAYS the latest complete period (billingPeriodIndex=1),
 * matching the Python script GUI_Billing_Export_Scheduled_Single.py.
 *
 * Schedule config shape:
 *   schedule.exportConfig = {
 *     orgId:   "facitbank",        // customer slug from customers.json
 *     orgName: "FacitBank",        // display label (used in sheet + filename)
 *   }
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const { processBillingOverview, buildSingleOrgWorkbook, safeSheetName } = require("../billingWorkbook");

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

// ── Main entry point ─────────────────────────────────────────────────

async function execute(context, schedule) {
  try {
    const cfg     = schedule.exportConfig || {};
    const orgId   = cfg.orgId;
    const orgName = cfg.orgName || orgId;

    if (!orgId) {
      return { success: false, error: "exportConfig.orgId is required" };
    }

    const customer = customers.find((c) => c.id === orgId);
    if (!customer) {
      return { success: false, error: `Unknown customer: ${orgId}` };
    }

    const trusteeId = getTrusteeForOrg(orgId);
    if (trusteeId === null) {
      return { success: false, error: `${orgName} is a trustee org and cannot be exported as a trustor.` };
    }

    // Step 1: resolve trustor org UUID via /organizations/me as the trustor.
    context.log(`[billingSingleOrg] Resolving trustor UUID for ${orgId}…`);
    const orgMe = await genesysCall(orgId, "GET", "/api/v2/organizations/me");
    const trustorOrgId = orgMe && orgMe.id;
    if (!trustorOrgId) {
      return { success: false, error: "Could not resolve trustor org UUID from /organizations/me." };
    }

    // Step 2: fetch latest-complete billing period (index 1) as the trustee.
    context.log(`[billingSingleOrg] Fetching billing overview (index 1) for ${orgId} via trustee ${trusteeId}…`);
    const overview = await genesysCall(
      trusteeId,
      "GET",
      `/api/v2/billing/trusteebillingoverview/${trustorOrgId}?billingPeriodIndex=1`
    );

    // Step 3: process + build workbook.
    const processed = processBillingOverview(overview);
    const buffer    = buildSingleOrgWorkbook({ orgName, processed });

    const orgSlug   = orgName.replace(/\s+/g, "_");
    const filename  = timestampedFilename(
      `Billing_${orgSlug}_${processed.summary.startDate}_to_${processed.summary.endDate}`,
      "xlsx"
    );

    const billable = processed.summary.billableItems;
    const regular  = processed.regularRows.length;
    const summary  =
      `${orgName} | ${processed.summary.startDate} to ${processed.summary.endDate} | ` +
      `${regular} licence rows, ${billable} billable item(s).`;

    // Match Python templates (GUI_email_notifier.py)
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const subject = `[${orgName}] Billing — Single Org Export`;
    const body =
      `Please find the scheduled export attached.\n\n` +
      `Task: Billing — Single Org\n` +
      `Customer: ${orgName}\n` +
      `Billing Period: ${processed.summary.startDate} to ${processed.summary.endDate}\n` +
      `Execution Time: ${timestamp}\n\n` +
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
    context.log.error("[billingSingleOrg] Export failed:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
