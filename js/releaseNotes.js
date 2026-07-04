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
