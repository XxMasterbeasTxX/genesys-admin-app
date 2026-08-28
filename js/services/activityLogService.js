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
 *   dataaction_test      — Run a data action (executes it for real)
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
