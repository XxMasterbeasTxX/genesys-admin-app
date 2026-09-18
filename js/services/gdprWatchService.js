/**
 * GDPR Watch Service — "email me when Genesys completes this".
 *
 * One call after a successful submission registers the request ids Genesys
 * minted against an email address. The hourly sweep in api/scheduled-runner
 * mails once per request when it completes, fails, or has run for 30 days.
 *
 * Throws on failure: the page shows the warning beside the submitted ids,
 * because a person who ticked the box and hears nothing would otherwise
 * assume the request is still running.
 *
 * See docs/gdpr-completion-notify-design.md.
 */
import { withUserToken } from "./apiAuth.js";

// The same test the mailer applies server-side.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerGdprWatch({ orgId, orgName, requestType, requestIds, email }) {
  const resp = await fetch("/api/gdpr-watches", {
    method:  "POST",
    headers: withUserToken({ "Content-Type": "application/json" }),
    body:    JSON.stringify({ orgId, orgName, requestType, requestIds, email }),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { msg = (await resp.json()).error || msg; } catch { /* keep the status */ }
    throw new Error(msg);
  }
  return resp.json();
}
