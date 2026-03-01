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
 * Environment variables (set in Azure app settings):
 *   MAILJET_API_KEY
 *   MAILJET_SECRET_KEY
 *   MAILJET_FROM_EMAIL   (e.g. "noreply@versatech.nu")
 *   MAILJET_FROM_NAME    (e.g. "Genesys Admin App")
 */
module.exports = async function (context, req) {
  try {
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

    // Parse recipients (comma or semicolon separated)
    const recipientList = recipients
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (recipientList.length === 0) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { success: false, error: "No valid email recipients provided." },
      };
      return;
    }

    // Basic email validation
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const addr of recipientList) {
      if (!emailRe.test(addr)) {
        context.res = {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { success: false, error: `Invalid email address: ${addr}` },
        };
        return;
      }
    }

    // --- Load Mailjet credentials ---
    const apiKey = process.env.MAILJET_API_KEY;
    const secretKey = process.env.MAILJET_SECRET_KEY;
    const fromEmail = process.env.MAILJET_FROM_EMAIL || "noreply@versatech.nu";
    const fromName = process.env.MAILJET_FROM_NAME || "Genesys Admin App";

    if (!apiKey || !secretKey) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Email service not configured." },
      };
      return;
    }

    // --- Build Mailjet message ---
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const defaultBody =
      "Please find the attached export.\n\n" +
      `Generated: ${timestamp}\n\n` +
      "Best regards,\n" +
      "Genesys Admin App";

    const message = {
      From: { Email: fromEmail, Name: fromName },
      To: recipientList.map((email) => ({ Email: email })),
      Subject: subject,
      TextPart: (body && body.trim()) ? body.trim() : defaultBody,
    };

    // Add attachment if provided
    if (attachment && attachment.base64 && attachment.filename) {
      message.Attachments = [
        {
          ContentType: attachment.mimeType || "application/octet-stream",
          Filename: attachment.filename,
          Base64Content: attachment.base64,
        },
      ];
    }

    // --- Send via Mailjet v3.1 API ---
    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");

    const mjResp = await fetch("https://api.mailjet.com/v3.1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ Messages: [message] }),
    });

    const mjBody = await mjResp.json().catch(() => ({}));

    if (!mjResp.ok) {
      const errMsg =
        mjBody.Messages?.[0]?.Errors?.[0]?.ErrorMessage ||
        mjBody.ErrorMessage ||
        `Mailjet API error: ${mjResp.status}`;
      context.log.error("Mailjet send error:", JSON.stringify(mjBody));
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { success: false, error: errMsg },
      };
      return;
    }

    // Check per-message status
    const msgStatus = mjBody.Messages?.[0]?.Status;
    if (msgStatus === "error") {
      const errMsg =
        mjBody.Messages[0].Errors?.[0]?.ErrorMessage || "Unknown Mailjet error";
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { success: false, error: errMsg },
      };
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { success: true },
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
