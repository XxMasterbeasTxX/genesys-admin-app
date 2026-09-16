/**
 * Access rules that a Genesys permission cannot express.
 *
 * Almost everything an internal user may see or do is decided by their own
 * Genesys permissions in the company org, through featurePermissionMap.js —
 * 92 of the 95 features carry a permission, and the rest are app-owned or
 * public data open to any named user. This file holds the exceptions: the
 * two features whose gate is WHO you are in the app, not what Genesys lets
 * you do. Both are checked server-side as well; this copy only decides what
 * the sidebar draws.
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
 * Superusers, and internal colleagues whose own row says "customer-manager".
 * Naming a customer user starts a charge; the right to do that is granted in
 * the app by a superuser, never derived from Genesys.
 */
export const CUSTOMER_MANAGER_KEYS = Object.freeze([
  "customers.access",
]);
