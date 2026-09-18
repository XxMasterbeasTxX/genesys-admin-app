/**
 * Access rules that a Genesys permission cannot express.
 *
 * What an internal user may see is their role (docs/internal-roles-design.md):
 * a Master Admin every page, a Super User the pages ticked for them from
 * the internal org's Super User scope. What they may DO on a page is their
 * own Genesys permissions in the company org, through
 * featurePermissionMap.js. This file holds the exceptions: the features whose
 * gate is WHO you are in the app, not what Genesys lets you do, and which no
 * scope can hold. All are checked server-side as well; this copy only
 * decides what the sidebar draws.
 *
 * Whether a person may use the app at all is not decided here either. They
 * must be named for the internal org by a superuser (the SUPERUSER_IDS app
 * setting — the server's, never a list in this bundle), or be a superuser
 * themselves. See docs/internal-user-access-design.md.
 *
 * HOW ACCESS KEYS WORK
 * ────────────────────
 * Each leaf page in navConfig.js has an `access` field — e.g.
 * "interactions.search". The URL path is NOT used for access checks — only
 * that field. featurePermissionMap.js maps a key to the permission(s) it
 * needs; a key with no entry there and no rule here is open to any named
 * user.
 */

/** Superusers only. Nothing in Genesys means "may onboard a customer org". */
export const SUPERUSER_ONLY_KEYS = Object.freeze([
  "deployment.onboarding",
]);

/**
 * Superusers, and internal colleagues whose own row says they manage customer
 * access. Naming a customer user starts a charge; the right to do that is
 * granted in the app by a superuser, never derived from Genesys — and never
 * from a Super User scope: it is a capability, independent of the role.
 */
export const CUSTOMER_MANAGER_KEYS = Object.freeze([
  "customers.access",
  "customers.supervisorAccess",
]);

/**
 * Never available to a customer session, whatever they hold. Internal
 * tooling, cross-org copies, and the multi-org exports. A prefix here hides
 * everything under it. Read by accessService for the sidebar, and by
 * scripts/build-customer-pages.mjs to produce api/lib/customerPages.json —
 * the server's list of every page a customer may be given, which the
 * Super User scope and a Super User's pages are validated against.
 */
export const CUSTOMER_EXCLUDED_KEYS = [
  "data-actions.copy.betweenOrgs",
  "data-tables.copy.betweenOrgs",
  "roles.copy.betweenOrgs",
  "export.users.trustee",
  "export.roles.allOrgs",
  // Billing: the four multi-org / arbitrary-range reports stay internal. Billing
  // Period and Period Comparison are customer-visible — a customer's own
  // overage, read for them by the server as their trustee
  // (docs/customer-billing-design.md). Named individually rather than as the
  // `export.billing` prefix, because the prefix would hide those two.
  "export.billing.allOrgsLatest",
  "export.billing.calendarYear",
  "export.billing.dateRange",
  "export.billing.customOrgs",
  "utilities",
  "deployment",
  // Who may use the app is Netdesign's list about the customer, never the
  // customer's page (docs/customer-user-licensing-design.md §6).
  "customers",
  // Flows is otherwise a customer-suitable module, so a `flows.*` entitlement
  // would hand a customer the ability to permanently delete a callflow and its
  // dependencies — irreversibly, with no rollback. Listed explicitly because the
  // wildcard would grant it silently.
  "flows.delete",
  // Recording export jobs pull the org's actual call recordings out in bulk.
  // That is customer data egress, not an interaction operation, and it arrived
  // bundled with Disconnect and Move because `interaction-ops` is the whole
  // `interactions.*` namespace — so both the package wildcard and `demo` granted
  // it silently. Same shape as `flows.delete` above: the module is otherwise
  // customer-suitable, and only the named leaf is held back.
  "interactions.recordings",
];

/**
 * A customer Master Admin's own pages: the Super User scope, and their
 * org's users (role and pages only — never who is named). Shown to a
 * customer session whose row is "administrator", hidden from Super Users,
 * and never shown to internal sessions, who have Customers › … instead.
 */
export const CUSTOMER_ADMIN_KEYS = Object.freeze([
  "administrator.supervisorAccess",
  "administrator.users",
]);
