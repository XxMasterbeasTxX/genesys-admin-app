/**
 * POST /api/send-email
 *
 * Sends email via Mailjet's v3.1 Send API.
 *
 * Request body:
 *   {
 *     recipients: "a@b.com, c@d.com",   // comma or semicolon separated
 *     subject:    "Export Report",
 *     body:       "Optional message",    // plain text
 *     attachment?: {
 *       filename:  "report.xlsx",
 *       base64:    "...",                // base64-encoded file content
 *       mimeType:  "application/vnd.openxmlformats-..."
 *     }
 *   }
 *
 * The Mailjet call itself lives in ../lib/mailer.js, shared with the scheduled
 * runner. This endpoint owns the HTTP contract: which failure is a 400, which
 * is a 500, and which is a 200 carrying { success: false }.
 *
 * Environment variables (set in Azure app settings): see ../lib/mailer.js.
 */
const { getCallerContext } = require("../lib/callerContext");
const mailer = require("../lib/mailer");

module.exports = async function (context, req) {
  try {
    // Authenticated callers only.
    //
    // This sends mail from the app's own Mailjet identity with a caller-chosen
    // recipient list, subject, body and attachment. Azure Static Web Apps
    // serves /api/* anonymously unless a route rule says otherwise, and
    // staticwebapp.config.json declares none — so this was an open relay: any
    // caller could send arbitrary mail, with attachments, from the app's
    // sending domain.
    //
    // The scheduled export runner does NOT come through here — it calls the
    // shared mailer itself, with no HTTP hop — so requiring a user token costs
    // it nothing.
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) {
      context.res = {
        status: caller.status || 401,
        headers: { "Content-Type": "application/json" },
        body: { success: false, error: caller.error || "unauthorized" },
      };
      return;
    }

    const { recipients, subject, body, attachment } = req.body || {};

    // --- Validate input ---
    if (!recipients || !subject) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Missing required fields: recipients, subject" },
      };
      return;
    }

    // Validation, the send, and Mailjet's two failure modes all live in the
    // mailer. What stays here is the mapping to HTTP: a caller mistake is a
    // 400, an unconfigured service is a 500, and a Mailjet refusal is a 200
    // carrying success:false — which is the contract the pages already expect.
    const timestamp = mailer.timestamp();
    const defaultBody =
      "Please find the attached export.\n\n" +
      `Generated: ${timestamp}\n\n` +
      "Best regards,\n" +
      "Genesys Admin App";

    const result = await mailer.sendMail({
      recipients,
      subject,
      text: (body && body.trim()) ? body.trim() : defaultBody,
      attachment,
      validate: true,
      log: (msg) => context.log.error(msg),
    });

    if (result.success) {
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { success: true },
      };
      return;
    }

    const status =
      result.reason === "not_configured" ? 500 :
      (result.reason === "no_recipients" || result.reason === "invalid_recipient") ? 400 :
      200; // Mailjet said no — the request itself was fine
    context.res = {
      status,
      headers: { "Content-Type": "application/json" },
      body: { success: false, error: result.error },
    };
  } catch (err) {
    context.log.error("Send email error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message || "Internal error sending email" },
    };
  }
};
