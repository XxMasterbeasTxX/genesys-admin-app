/**
 * Centralized Email Service
 *
 * Sends outbound emails via the Mailjet API through the Azure Function
 * backend (/api/send-email).  Any page that needs to send email should
 * import `sendEmail` and `validateRecipients` from this module.
 *
 * Sender identity and Mailjet credentials are configured server-side
 * via Azure app settings (MAILJET_API_KEY, MAILJET_SECRET_KEY,
 * MAILJET_FROM_EMAIL, MAILJET_FROM_NAME).
 */

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
 * Send an outbound email via Mailjet (through /api/send-email).
 *
 * @param {Object} _api             Unused — kept for backward compatibility.
 * @param {Object} opts
 * @param {string} opts.recipients   Comma / semicolon separated emails.
 * @param {string} opts.subject      Email subject line.
 * @param {string} [opts.body]       Custom message body (falls back to server default).
 * @param {Object} [opts.attachment] Optional file to attach.
 * @param {string} opts.attachment.filename   e.g. "trustee_export_2026-03-01.xlsx"
 * @param {string} opts.attachment.base64     Base64-encoded file content.
 * @param {string} opts.attachment.mimeType   e.g. "application/vnd.openxmlformats-…"
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendEmail(_api, { recipients, subject, body, attachment }) {
  try {
    // Validate on the client side first (fast feedback)
    validateRecipients(recipients);

    const payload = { recipients, subject };

    if (body && body.trim()) {
      payload.body = body.trim();
    }

    if (attachment) {
      payload.attachment = {
        filename: attachment.filename,
        base64:   attachment.base64,
        mimeType: attachment.mimeType,
      };
    }

    const res = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `Server returned ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Email send error:", err);
    return { success: false, error: err.message || "Unknown email error" };
  }
}
