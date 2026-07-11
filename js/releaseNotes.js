/**
 * Release notes — newest entry first.
 *
 * This file is the single source of truth for the app version. Each entry
 * carries an explicit two-number `version` (e.g. "1.0", "1.1", "2.0").
 * The newest entry's version is exported as APP_VERSION and shown in the
 * sidebar footer, so the footer and the latest release note never drift.
 *
 * To cut a release: add a new object at the TOP with the next version
 * number and that release's changes.
 */
export const RELEASE_NOTES = [
  {
    version: "1.5",
    date: "2026-07-08",
    title: "Fix: Data Tables schema edit no longer drops columns",
    changes: [
      "Fixed a bug in Data Tables > Edit (Schema mode) where saving could fail with \"Field '…' is missing from the proposed schema\" and, in some cases, drop an existing column.",
      "The editor now preserves each column's original schema property key across the load/save round-trip, instead of re-keying properties by their display title.",
      "Column titles can still be edited freely; new columns continue to key by their name. Adding a column no longer surfaces the pre-existing key/title mismatch.",
    ],
  },
  {
    version: "1.4",
    date: "2026-07-07",
    title: "Step 4: server-side proxy tenant enforcement",
    changes: [
      "The Genesys proxy now decides mode from the caller's own token (verified server-side via organizations/me, cached), never from the request body.",
      "The elevated client-credentials path now requires a verified internal-org token, closing the previous unauthenticated access path to /api/genesys-proxy.",
      "Customer sessions are token-forwarded and locked to their own org/region; any attempt to target another org via the request body is rejected (403 org_locked).",
      "Added a customer-mode denylist for internal/trustee/billing endpoints, plus an optional positive entitlement allowlist (ENFORCE_ENTITLEMENT_ALLOWLIST, default off).",
      "Internal/demo behavior is unchanged; deployments without org env configured keep the legacy behavior via a compatibility fallback.",
    ],
  },
  {
    version: "1.3",
    date: "2026-07-07",
    title: "Step 3 foundation: server-owned org context",
    changes: [
      "Added `GET /api/org-config` to resolve auth mode server-side from the signed-in user's org (`/api/v2/organizations/me`) and return safe org context.",
      "Added org-hint support (`?org=`) through the PKCE login flow so customer deep links can be validated after authentication.",
      "App startup now uses `/api/org-config` before rendering org selection: customer mode locks to one org; internal mode keeps the existing selector behavior.",
      "Introduced compatibility fallback for existing internal deployments where `INTERNAL_COMPANY_ORG_ID` and `CUSTOMER_REGISTRY_JSON` are not configured yet.",
    ],
  },
  {
    version: "1.2",
    date: "2026-07-06",
    title: "Permission-aware access for write actions",
    changes: [
      "Write features are now gated by your own Genesys permissions in addition to app group membership: you can only perform an action (create, edit, delete, apply) if your Genesys role includes the matching permission.",
      "Read-only features (Export, Audit, Flows, Roles Compare/Search, Interaction Search) are unaffected and remain governed by group access alone.",
      "Features you can't use appear disabled in the sidebar with a tooltip naming the required permission; opening one directly shows which permission is missing.",
      "Within a page, individual actions and sections you lack the permission for are disabled too — e.g. Delete rows, Publish/Test a data action, backup routing, and per-category template application (roles/skills/languages/queues).",
      "Create/Edit Template now requires the same permissions as Manage Templates.",
      "Full-access administrators and superusers are unaffected.",
    ],
  },
  {
    version: "1.1",
    date: "2026-07-06",
    title: "Permission Catalog page",
    changes: [
      "Added Utilities > Permission Catalog — an internal, admin-only page that lists the full Genesys Cloud permission catalog (domain:entity:action) for the selected org.",
      "Live filter over the permission string and label, sortable columns, and summary counts of domains, entities, and permissions.",
      "Copy permissions (all filtered strings, one per line) with an iframe-safe clipboard fallback, plus Export to Excel.",
      "Read-only; built to author and verify the feature → permission map for the upcoming customer-facing expansion.",
    ],
  },
  {
    version: "1.0",
    date: "2026-07-04",
    title: "Azure migration & Dev/Prod environments",
    changes: [
      "Migrated the app to the company Azure subscription — new Static Web App, Key Vault, Storage account, and Timer Function App.",
      "Introduced separate Dev and Prod environments with independent Azure resources and CI/CD (the main branch deploys to Dev, the production branch deploys to Prod).",
      "The OAuth redirect now derives from the current site origin, so the same build runs unchanged on both the Dev and Prod URLs.",
      "Added this Release Notes page and a version indicator in the sidebar footer — click the version to open it.",
    ],
  },
];

/** Current app version — the newest release note. Single source of truth. */
export const APP_VERSION = RELEASE_NOTES[0].version;
