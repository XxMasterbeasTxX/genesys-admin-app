/**
 * Billing — Overage Alert (scheduled).
 *
 * Not an export: reads the org's CURRENT billing period, checks the licences
 * the creator chose to watch, and mails only when something is over
 * (docs/billing-overage-alerts-design.md). Registered as a schedule type so
 * it rides the existing store, runner, creator re-check and mailer.
 *
 * exportConfig:
 *   orgId, orgName        the customer slug and display name
 *   items: [ { kind: "licence", name },          over when On-Demand > 0
 *            { kind: "aiTokens" },               over when billable tokens > 0
 *            { kind: "adminTool", threshold } ]  over when named-user peak > threshold
 *   mode:  "always"   — report every item over, every run (a daily reminder)
 *          "onChange" — report only items that went from clear to over
 *                       since the last run; per-item state kept in
 *                       exportConfig.lastState by this handler
 *
 * The org is resolved server-side from the slug — never from anything the
 * schedule body could have carried besides the slug the endpoint already
 * locked to the caller's org. No prices appear anywhere in the mail.
 */
const { verifyCreator, INTERNAL_OWNER } = require("../creatorAuth");
const { fetchOverviewForCustomer, resolveTrustorOrgId } = require("../billingOverview");
const { isSimulated, syntheticOverview } = require("../billingSimulation");
const { processBillingOverview } = require("../billingWorkbook");
const licenseStore = require("../licenseStore");
const scheduleStore = require("../scheduleStore");
const { parseRegistry } = require("../orgConfigResolver");
const customers = require("../customers.json");

// The permission Genesys requires of a customer to see their own billing;
// internal staff read as the trustee, so the affiliate permission for them.
const CUSTOMER_PERMISSIONS = ["billing:subscription:view", "billing:subscription:read"];
const INTERNAL_PERMISSIONS = ["affiliateOrganization:clientBilling:view"];

function itemKey(item) {
  if (!item) return "";
  if (item.kind === "licence") return "licence:" + String(item.name || "");
  if (item.kind === "aiTokens") return "aiTokens";
  if (item.kind === "adminTool") return "adminTool";
  return String(item.kind || "");
}

function fmtDate(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toISOString().slice(0, 10);
}

/**
 * Evaluate every watched item against the processed period.
 * @returns {Array<{ key, label, over: boolean, missing?: boolean, lines: string[] }>}
 */
function evaluate(items, processed, adminToolUsers) {
  const out = [];
  for (const item of items || []) {
    const key = itemKey(item);
    if (item.kind === "licence") {
      const row = processed.regularRows.find((r) => r.name === item.name);
      if (!row) { out.push({ key, label: item.name, over: false, missing: true, lines: [] }); continue; }
      const over = typeof row.onDemand === "number" && row.onDemand > 0;
      out.push({ key, label: item.name, over, lines: [
        `Committed: ${row.committed === "" ? "—" : row.committed}`,
        `Actual usage: ${row.actualUsage}`,
        `Over by: ${over ? row.onDemand : 0}`,
      ] });
    } else if (item.kind === "aiTokens") {
      const s = processed.summary;
      if (!s.hasAi) { out.push({ key, label: "AI Tokens", over: false, missing: true, lines: [] }); continue; }
      const over = s.aiBillable > 0;
      out.push({ key, label: "AI Tokens", over, lines: [
        `Free: ${Math.round(s.aiFairUse).toLocaleString("en-US")} tokens`,
        `Used: ${Math.round(s.aiRollup).toLocaleString("en-US")} tokens`,
        `Billable: ${Math.round(s.aiBillable).toLocaleString("en-US")} tokens`,
      ] });
    } else if (item.kind === "adminTool") {
      const threshold = Number.isFinite(Number(item.threshold)) ? Number(item.threshold) : 0;
      if (adminToolUsers === null) { out.push({ key, label: "Admin Tool", over: false, missing: true, lines: [] }); continue; }
      const over = adminToolUsers > threshold;
      out.push({ key, label: `Admin Tool (more than ${threshold} named users)`, over, lines: [
        `Named users this period (peak): ${adminToolUsers}`,
        `Threshold: ${threshold}`,
      ] });
    }
  }
  return out;
}

async function execute(context, schedule) {
  const log = (m) => context && context.log && context.log(`[billingOverageAlert] ${m}`);
  try {
    const cfg = schedule.exportConfig || {};
    const customerId = String(cfg.orgId || "").trim();
    const orgName    = cfg.orgName || customerId;
    const items      = Array.isArray(cfg.items) ? cfg.items : [];
    const mode       = cfg.mode === "onChange" ? "onChange" : "always";
    if (!customerId) return { success: false, error: "exportConfig.orgId is required" };
    if (!items.length) return { success: false, error: "no items to watch" };

    const isCustomerOwned = !!schedule.ownerOrgId && schedule.ownerOrgId !== INTERNAL_OWNER;

    // 1. The creator must still be allowed to see this org's billing — and, for
    //    a customer, must still be on the org's named-user list.
    const creator = await verifyCreator(schedule.ownerOrgId || INTERNAL_OWNER, {
      userId: schedule.createdById,
      requiredPermissions: isCustomerOwned ? CUSTOMER_PERMISSIONS : INTERNAL_PERMISSIONS,
    });
    if (creator.verified && !creator.ok) return { success: false, error: "Refused: " + creator.reason };
    if (isCustomerOwned) {
      if (!schedule.createdById) return { success: false, error: "Refused: the alert does not record who created it" };
      const named = await licenseStore.isActive(schedule.ownerOrgId, schedule.createdById);
      if (!named) return { success: false, error: "Refused: the user who created this alert no longer has access to the Admin Tool" };
    }
    if (!creator.verified) log("creator NOT verified — " + creator.reason);

    // 2. The current period (index 0). Simulated orgs get the synthetic overview.
    let overview;
    if (isSimulated(customerId)) {
      const row = customers.find((c) => c.id === customerId) || parseRegistry(context).find((c) => c.id === customerId) || { name: orgName };
      overview = syntheticOverview({ id: customerId, name: row.name || orgName, orgId: row.orgId }, 0);
    } else {
      const orgId = await resolveTrustorOrgId(context, customerId);
      if (!orgId) return { success: false, error: `Could not resolve the Genesys org id for ${orgName}` };
      const r = await fetchOverviewForCustomer(context, { customerId, orgId, billingPeriodIndex: 0 });
      if (!r.ok) return { success: false, error: r.error === "no_trustee" ? `${orgName} has no trustee this app can read billing as` : r.error };
      overview = r.overview;
    }

    // 3. Named users at the period's peak — only if watched.
    let adminToolUsers = null;
    if (items.some((i) => i.kind === "adminTool")) {
      try { adminToolUsers = await licenseStore.peakAssigned(customerId, overview.billingPeriodStartDate, overview.billingPeriodEndDate); }
      catch (err) { log(`Admin Tool count unavailable: ${err.message || err}`); }
    }

    // 4. Process and evaluate.
    const processed = processBillingOverview(overview, { adminToolUsers });
    const results   = evaluate(items, processed, adminToolUsers);

    // 5. Decide what to report.
    const prev = (cfg.lastState && typeof cfg.lastState === "object") ? cfg.lastState : {};
    let report;
    if (mode === "onChange") {
      report = results.filter((r) => r.over && prev[r.key] !== true);
      const lastState = {};
      for (const r of results) lastState[r.key] = r.over;
      try { await scheduleStore.update(schedule.id, { exportConfig: { ...cfg, lastState } }); }
      catch (err) { log(`could not persist lastState: ${err.message || err}`); }
    } else {
      report = results.filter((r) => r.over);
    }
    const missing = results.filter((r) => r.missing);
    const period  = `${fmtDate(overview.billingPeriodStartDate)} to ${fmtDate(overview.billingPeriodEndDate)}`;

    if (!report.length) {
      const clear = results.filter((r) => !r.missing).length;
      return { success: true, skipEmail: true,
        summary: `${orgName} | ${period} | all clear: ${clear} item(s) checked, nothing to report${mode === "onChange" ? " (on change)" : ""}${missing.length ? `; ${missing.length} not in this period` : ""}` };
    }

    // 6. The mail — quantities only, never a price.
    const lines = [];
    lines.push(`Overage alert for ${orgName}${overview.simulated ? " (SIMULATED billing data)" : ""}`);
    lines.push(`Current billing period: ${period}`);
    lines.push("");
    for (const r of report) {
      lines.push(`• ${r.label} — OVER`);
      for (const l of r.lines) lines.push(`    ${l}`);
      lines.push("");
    }
    if (missing.length) {
      lines.push("Not in this period's subscription (nothing to compare):");
      for (const r of missing) lines.push(`    ${r.label}`);
      lines.push("");
    }
    lines.push(mode === "onChange"
      ? "You receive this because an item entered overage since the last check. It will not be repeated while the item stays over."
      : "You receive this on every scheduled check while an item is in overage.");
    lines.push("");
    lines.push("Best regards,\nGenesys Automation");

    return {
      success: true,
      subject: `[${orgName}] Overage alert — ${report.length} item${report.length === 1 ? "" : "s"} over`,
      body: lines.join("\n"),
      summary: `${orgName} | ${period} | ${report.length} item(s) over: ${report.map((r) => r.label).join(", ")}`,
    };
  } catch (err) {
    context && context.log && context.log.error && context.log.error("[billingOverageAlert] failed:", err.message || err);
    return { success: false, error: err.message || String(err) };
  }
}

module.exports = { execute, evaluate, itemKey };
