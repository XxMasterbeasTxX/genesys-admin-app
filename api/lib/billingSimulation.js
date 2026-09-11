/**
 * Simulated billing for orgs that cannot show real billing.
 *
 * Test IE has no trustee, so Genesys will never give this app its billing
 * overview. What needs testing on Test IE is not Genesys's numbers but the
 * app's own row — Admin Tool named users, at the period's peak — and how it
 * lands in the sheets. So for an org named in BILLING_SIMULATION_ORGS the
 * server answers the overview itself with a fixed, made-up subscription that
 * exercises every section (Regular, AI Tokens, Overage), while the Admin
 * Tool count stays REAL, read from the licence store for the synthetic
 * period (docs/billing-apps-section-design.md §4).
 *
 * The simulation is unmistakable in the output: the organisation name is
 * suffixed "(SIMULATED)" and the body carries `simulated: true`. It is
 * deterministic — the same period index always yields the same numbers —
 * and it applies only where the setting names the org. The scheduled exports
 * never consult it.
 */

const SIMULATED_ORGS = new Set(
  String(process.env.BILLING_SIMULATION_ORGS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
);

/** True if BILLING_SIMULATION_ORGS names this org. */
function isSimulated(customerId) {
  return SIMULATED_ORGS.has(String(customerId || ""));
}

/** [start, end] of the calendar month `index` months before the current one, UTC. */
function periodBounds(index) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth() - index;
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  const end   = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * A synthetic TrusteeBillingOverview for `customer` and billing period
 * `index` (0 = current month, 1 = previous, …). Same shape Genesys returns,
 * so everything downstream — processor, sheets, comparison — is unchanged.
 */
function syntheticOverview(customer, index) {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  const { start, end } = periodBounds(i);
  // A little movement between periods so Period Comparison has deltas.
  const drift = (n) => n + ((i * 7) % 5) - 2;

  return {
    simulated: true,
    id: `simulated-${customer.id}-${i}`,
    name: `${customer.name} (SIMULATED)`,
    organization: { id: customer.orgId || customer.id, name: `${customer.name} (SIMULATED)` },
    currency: "DKK",
    subscriptionType: "Named",
    billingPeriodStartDate: start,
    billingPeriodEndDate: end,
    enabledProducts: ["CX3", "AI"],
    usages: [
      // prepaid within commitment
      { name: "Genesys Cloud CX 3 Named User", partNumber: "PC-170-3", grouping: "usage",
        unitOfMeasureType: "users", usageQuantity: String(drift(18)), prepayQuantity: "20" },
      // prepaid OVER commitment → lands in the overage section
      { name: "Genesys Cloud WEM Add-On Named User", partNumber: "PC-171-WEM", grouping: "usage",
        unitOfMeasureType: "users", usageQuantity: String(drift(9)), prepayQuantity: "5" },
      // AI tokens: fair-use allocation, rollup, and one breakdown line
      { name: "AI Tokens - Fair Use", partNumber: "AI-FU", grouping: "fair-use",
        unitOfMeasureType: "tokens", usageQuantity: "250000", prepayQuantity: "250000" },
      { name: "AI Tokens", partNumber: "AI-RU", grouping: "rollup",
        unitOfMeasureType: "tokens", usageQuantity: String(300000 + drift(0) * 10000), prepayQuantity: "0" },
      { name: "AI Summary", partNumber: "AI-SUM", grouping: "rollup-usage",
        unitOfMeasureType: "tokens", usageQuantity: String(120000 + drift(0) * 5000), prepayQuantity: "0" },
    ],
  };
}

module.exports = { isSimulated, syntheticOverview, periodBounds };
