/**
 * Mailjet sender — the one place this app talks to Mailjet.
 *
 * Two copies of this existed: `api/send-email` (the endpoint the pages call)
 * and `api/scheduled-runner` (which mails a finished export). They had drifted
 * only where their callers genuinely differ — one validates addresses and
 * answers with an HTTP body, the other answers with an error string — while
 * duplicating everything that matters: credential loading, recipient parsing,
 * the v3.1 message shape, and the two separate ways Mailjet reports a failure.
 *
 * That second point is the reason this module exists rather than a helper each
 * caller keeps. Mailjet can fail twice over: the HTTP request can fail, and a
 * 200 response can still carry `Messages[0].Status === "error"`. A caller that
 * checks only the first reports success for mail that was never sent. Both
 * copies happened to get it right; a third written from memory might not.
 *
 * What stays with the caller: default body text, subject composition, and what
 * to do about a failure. Those are decisions, not plumbing.
 *
 * Nothing here throws. Callers get `{ success, error, reason }` and map it to
 * whatever their own contract is.
 *
 * Environment:
 *   MAILJET_API_KEY, MAILJET_SECRET_KEY   required
 *   MAILJET_FROM_EMAIL                    default noreply@versatech.nu
 *   MAILJET_FROM_NAME                     default "Genesys Admin App"
 */

const MAILJET_ENDPOINT = "https://api.mailjet.com/v3.1/send";

// Deliberately the same shape the browser uses in js/services/emailService.js:
// an address rejected here but accepted there (or the reverse) is a confusing
// bug to chase.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mailjet credentials and sender identity from app settings. */
function credentials() {
  return {
    apiKey: process.env.MAILJET_API_KEY,
    secretKey: process.env.MAILJET_SECRET_KEY,
    fromEmail: process.env.MAILJET_FROM_EMAIL || "noreply@versatech.nu",
    fromName: process.env.MAILJET_FROM_NAME || "Genesys Admin App",
  };
}

/** True when both Mailjet keys are present. */
function isConfigured() {
  const { apiKey, secretKey } = credentials();
  return !!(apiKey && secretKey);
}

/**
 * Split a recipient string on commas or semicolons.
 * @param {string|string[]} input
 * @returns {string[]} trimmed, non-empty addresses
 */
function parseRecipients(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(/[,;]/);
  return list.map((s) => String(s || "").trim()).filter(Boolean);
}

/**
 * First address that does not look like an email, or null.
 * @param {string[]} recipients
 * @returns {string|null}
 */
function findInvalidRecipient(recipients) {
  return recipients.find((addr) => !EMAIL_RE.test(addr)) || null;
}

/** A timestamp in the "2026-08-19 14:05:31" form both callers' bodies use. */
function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Send one message through Mailjet.
 *
 * @param {Object}   opts
 * @param {string|string[]} opts.recipients  Comma/semicolon string, or an array.
 * @param {string}   opts.subject
 * @param {string}   opts.text                Plain-text body.
 * @param {Object}   [opts.attachment]        { filename, base64, mimeType }
 * @param {boolean}  [opts.validate=false]    Reject malformed addresses first.
 * @param {Function} [opts.log]               Called with (message) on failure.
 * @returns {Promise<{ success: boolean, error?: string, reason?: string }>}
 *   `reason` is one of `not_configured`, `no_recipients`, `invalid_recipient`,
 *   `mailjet` — so a caller can choose an HTTP status without matching on the
 *   error text.
 */
async function sendMail({
  recipients,
  subject,
  text,
  attachment = null,
  validate = false,
  log = null,
} = {}) {
  const { apiKey, secretKey, fromEmail, fromName } = credentials();
  if (!apiKey || !secretKey) {
    return { success: false, error: "Email service not configured.", reason: "not_configured" };
  }

  const list = parseRecipients(recipients);
  if (!list.length) {
    return { success: false, error: "No email recipients provided.", reason: "no_recipients" };
  }

  if (validate) {
    const bad = findInvalidRecipient(list);
    if (bad) {
      return { success: false, error: `Invalid email address: ${bad}`, reason: "invalid_recipient" };
    }
  }

  const message = {
    From: { Email: fromEmail, Name: fromName },
    To: list.map((email) => ({ Email: email })),
    Subject: subject,
    TextPart: text,
  };

  if (attachment && attachment.base64 && attachment.filename) {
    message.Attachments = [
      {
        ContentType: attachment.mimeType || "application/octet-stream",
        Filename: attachment.filename,
        Base64Content: attachment.base64,
      },
    ];
  }

  try {
    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
    const resp = await fetch(MAILJET_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ Messages: [message] }),
    });

    const body = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const error =
        body.Messages?.[0]?.Errors?.[0]?.ErrorMessage ||
        body.ErrorMessage ||
        `Mailjet API error: ${resp.status}`;
      log?.(`Mailjet send error: ${JSON.stringify(body)}`);
      return { success: false, error, reason: "mailjet" };
    }

    // A 200 is not delivery. Mailjet reports a rejected message inside an
    // otherwise successful response, so this second check is not belt-and-braces
    // — without it a bad address reads as a sent mail.
    if (body.Messages?.[0]?.Status === "error") {
      const error = body.Messages[0].Errors?.[0]?.ErrorMessage || "Unknown Mailjet error";
      log?.(`Mailjet message rejected: ${JSON.stringify(body)}`);
      return { success: false, error, reason: "mailjet" };
    }

    return { success: true };
  } catch (err) {
    const error = `Email send failed: ${err.message}`;
    log?.(error);
    return { success: false, error, reason: "mailjet" };
  }
}

module.exports = {
  sendMail,
  parseRecipients,
  findInvalidRecipient,
  isConfigured,
  timestamp,
};
