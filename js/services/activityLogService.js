/**
 * Activity Log Service — fire-and-forget activity log writer.
 *
 * Call logAction() after any significant user-initiated mutation.
 * All errors are silently swallowed — the log must never block a user action.
 *
 * Usage:
 *   import { logAction } from '../../services/activityLogService.js';
 *
 *   logAction({
 *     me,          // { id, email, name } from page context
 *     orgId,       // customer org id (e.g. "acme") — omit for org-agnostic actions
 *     orgName,     // customer org display name
 *     action,      // machine-readable action type (see constants below)
 *     description, // human-readable description, e.g. "Moved 5 Users to 'Support'"
 *     result,      // "success" (default) | "partial" | "failure"
 *     errorMessage,// error text when result !== "success"
 *     count,       // number of affected items (optional)
 *     details,     // optional structured breakdown, rendered as an expandable
 *                  // row on the Activity Log page:
 *                  //   { summary: {…}, phases: [ { phase, items: [
 *                  //       { old, new, status: "ok"|"error"|"skipped", detail }
 *                  //     ] } ], warnings: [ "…" ] }
 *                  // Oversized payloads are truncated server-side, not rejected.
 *   });
 *
 * Action type constants (use these strings for consistency):
 *   division_move        — Reassign objects between divisions
 *   interaction_move     — Move interactions between queues
 *   interaction_disconnect — Force-disconnect interactions
 *   datatable_create     — Create a new data table
 *   datatable_copy       — Copy a data table
 *   dataaction_copy      — Copy a data action between orgs
 *   dataaction_save      — Save a data action draft
 *   dataaction_publish   — Publish a data action draft
 *   phone_create         — Bulk-create WebRTC phones
 *   phone_move           — Move phones to a different site
 *   schedule_create      — Create an automated schedule
 *   schedule_update      — Update an automated schedule
 *   schedule_delete      — Delete an automated schedule
 *   gdpr_request         — Submit a GDPR data subject request
 *   export_run           — Run an on-demand export
 *   deployment_basic     — Basic deployment (sites, queues, users, …)
 *   deployment_onboarding — Onboarding deploy (written by the runner, not here)
 *   flow_delete          — Delete a callflow and its orphaned dependencies
 */
import { withUserToken } from "./apiAuth.js";

/**
 * Read this organisation's activity log.
 *
 * `userEmail` identifies the caller; it does not narrow the result. The
 * endpoint scopes the read to the caller's own organisation, so what comes
 * back is the whole org's activity, newest first.
 *
 * Resolves to `[]` rather than throwing when there is no caller identity —
 * callers that use the log to enrich a page should degrade quietly rather than
 * take the page down with them.
 *
 * @param {object}  opts.me     The signed-in user; `email` is required.
 * @param {number} [opts.limit] Max entries (server default 500, max 1000).
 * @returns {Promise<Array>}    Log entries, newest first.
 */
export async function fetchActivityLog({ me, limit } = {}) {
  if (!me?.email) return [];
  const params = new URLSearchParams({ userEmail: me.email });
  if (limit) params.set("limit", String(limit));
  const resp = await fetch(`/api/activity-log?${params}`, { headers: withUserToken() });
  if (!resp.ok) throw new Error(`Activity log read failed: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.entries || [];
}

export function logAction({
  me,
  orgId        = "",
  orgName      = "",
  action,
  description,
  result       = "success",
  errorMessage = null,
  count        = null,
  details      = null,
} = {}) {
  if (!me?.email) return; // Nothing to log without user identity

  fetch("/api/activity-log", {
    method:  "POST",
    headers: withUserToken({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      userId:       me.id    || "",
      userEmail:    me.email,
      userName:     me.name  || "",
      orgId,
      orgName,
      action,
      description,
      result,
      errorMessage,
      count,
      details,
    }),
  }).catch((err) =>
    console.warn("[activityLog] write failed (non-critical):", err?.message || err)
  );
}
