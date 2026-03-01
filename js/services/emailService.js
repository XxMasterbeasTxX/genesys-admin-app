/**
 * Centralized Email Service
 *
 * Sends outbound emails via the Genesys Cloud Email API through the
 * existing proxy backend.  Any page that needs to send email should
 * import `sendEmail` and `validateRecipients` from this module.
 *
 * Flow:
 *   1. POST /api/v2/conversations/emails        → create outbound draft
 *   2. POST …/messages/draft/attachments         → upload file (optional)
 *   3. PATCH …/messages/draft                    → set body & send
 *
 * Configuration:
 *   Org:   Netdesign DE  ("demo")
 *   Queue: 97f48c1f-0b3b-4495-af91-fa58c93dea4b
 *   From:  genesysadmintool@netdesignde.mypurecloud.de
 */

// ── Config ──────────────────────────────────────────────────────────

const EMAIL_ORG_ID   = "demo";
const EMAIL_QUEUE_ID = "97f48c1f-0b3b-4495-af91-fa58c93dea4b";
const EMAIL_FROM     = "genesysadmintool@netdesignde.mypurecloud.de";
const EMAIL_FROM_NAME = "Genesys Admin App";

const DEFAULT_BODY =
  "Please find the attached export.\n\n" +
  "Generated: {timestamp}\n\n" +
  "Best regards,\n" +
  "Genesys Admin App";

// ── Helpers ─────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse and validate a recipient string (comma or semicolon separated).
 *
 * @param {string} str  Raw recipients text.
 * @returns {string[]}  Array of trimmed, validated email addresses.
 * @throws {Error}      If no valid recipients or any address is invalid.
 */
export function validateRecipients(str) {
  if (!str || !str.trim()) {
    throw new Error("No email recipients provided.");
  }

  const list = str
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (list.length === 0) {
    throw new Error("No email recipients provided.");
  }

  for (const addr of list) {
    if (!EMAIL_RE.test(addr)) {
      throw new Error(`Invalid email address: ${addr}`);
    }
  }

  return list;
}

// ── Main send function ──────────────────────────────────────────────

/**
 * Send an outbound email via Genesys Cloud.
 *
 * @param {Object} api              apiClient instance (needs proxyGenesys).
 * @param {Object} opts
 * @param {string} opts.recipients   Comma / semicolon separated emails.
 * @param {string} opts.subject      Email subject line.
 * @param {string} [opts.body]       Custom message body (falls back to default).
 * @param {Object} [opts.attachment] Optional file to attach.
 * @param {string} opts.attachment.filename   e.g. "trustee_export_2026-03-01.xlsx"
 * @param {string} opts.attachment.base64     Base64-encoded file content.
 * @param {string} opts.attachment.mimeType   e.g. "application/vnd.openxmlformats-…"
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendEmail(api, { recipients, subject, body, attachment }) {
  try {
    const recipientList = validateRecipients(recipients);

    // Build email body text
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const textBody = (body && body.trim())
      ? body.trim()
      : DEFAULT_BODY.replace("{timestamp}", timestamp);

    // 1. Create outbound email conversation (draft)
    const conversation = await api.proxyGenesys(EMAIL_ORG_ID, "POST",
      "/api/v2/conversations/emails", {
        body: {
          queueId:     EMAIL_QUEUE_ID,
          toAddress:   recipientList[0],
          toName:      recipientList[0],
          fromAddress: EMAIL_FROM,
          fromName:    EMAIL_FROM_NAME,
          subject:     subject,
          direction:   "OUTBOUND",
        },
      });

    const conversationId = conversation.id;
    if (!conversationId) {
      return { success: false, error: "Failed to create email conversation — no ID returned." };
    }

    // 2. Upload attachment (if provided)
    if (attachment) {
      try {
        await api.proxyGenesys(EMAIL_ORG_ID, "POST",
          `/api/v2/conversations/emails/${conversationId}/messages/draft/attachments`, {
            body: {
              __fileUpload: {
                fileName:     attachment.filename,
                fileBase64:   attachment.base64,
                fileMimeType: attachment.mimeType,
              },
            },
          });
      } catch (uploadErr) {
        console.warn("Attachment upload failed, sending email without attachment:", uploadErr);
        // Continue — email will be sent without the attachment
      }
    }

    // 3. Send the email by patching the draft
    await api.proxyGenesys(EMAIL_ORG_ID, "PATCH",
      `/api/v2/conversations/emails/${conversationId}/messages/draft`, {
        body: {
          to:       recipientList.map((email) => ({ email })),
          from:     { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
          subject:  subject,
          textBody: textBody,
        },
      });

    return { success: true };
  } catch (err) {
    console.error("Email send error:", err);
    return { success: false, error: err.message || "Unknown email error" };
  }
}
