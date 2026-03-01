/**
 * Scheduled Export Runner — Timer-triggered Azure Function.
 *
 * Fires every 5 minutes. For each enabled schedule whose time is due,
 * it runs the corresponding export handler, builds the Excel file,
 * and emails the result via Mailjet.
 *
 * Schedule evaluation:
 *   - daily:   runs once per day at scheduleTime (UTC)
 *   - weekly:  runs once per week on scheduleDayOfWeek at scheduleTime (UTC)
 *   - monthly: runs once per month on scheduleDayOfMonth at scheduleTime (UTC)
 *
 * A schedule is considered "due" if:
 *   1. It is enabled
 *   2. The current UTC time is past the configured time
 *   3. It hasn't already run in the current period (day/week-day/month-day)
 */
const store = require("../lib/scheduleStore");
const { getHandler } = require("../lib/exportHandlers");

module.exports = async function (context) {
  context.log("Scheduled runner triggered at", new Date().toISOString());

  let schedules;
  try {
    schedules = await store.listAll();
  } catch (err) {
    context.log.error("Failed to load schedules:", err.message);
    return;
  }

  const enabled = schedules.filter((s) => s.enabled);
  if (!enabled.length) {
    context.log("No enabled schedules. Exiting.");
    return;
  }

  const now = new Date();
  const dueSchedules = enabled.filter((s) => isDue(s, now));

  if (!dueSchedules.length) {
    context.log(`${enabled.length} enabled schedules, none due right now.`);
    return;
  }

  context.log(`${dueSchedules.length} schedule(s) due. Processing…`);

  for (const schedule of dueSchedules) {
    await runExport(context, schedule);
  }

  context.log("Scheduled runner complete.");
};

// ── Due check ───────────────────────────────────────────

function isDue(schedule, now) {
  const [hh, mm] = (schedule.scheduleTime || "08:00").split(":").map(Number);
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  // The timer fires every 5 minutes. We consider a schedule "due" if
  // the current 5-minute window contains the scheduled time AND it
  // hasn't already run in the current period.

  // Check if current time is within ~5min past the scheduled time
  const scheduleMins = hh * 60 + mm;
  const nowMins = utcH * 60 + utcM;
  const diff = nowMins - scheduleMins;
  if (diff < 0 || diff >= 5) return false;

  // Check schedule type
  if (schedule.scheduleType === "weekly") {
    if (now.getUTCDay() !== schedule.scheduleDayOfWeek) return false;
  } else if (schedule.scheduleType === "monthly") {
    if (now.getUTCDate() !== schedule.scheduleDayOfMonth) return false;
  }
  // daily: no extra day check needed

  // Avoid double-runs: check if lastRun is already today (for this time window)
  if (schedule.lastRun) {
    const lastRun = new Date(schedule.lastRun);
    const lastRunDate = lastRun.toISOString().slice(0, 10);
    const nowDate = now.toISOString().slice(0, 10);
    if (lastRunDate === nowDate) return false; // Already ran today
  }

  return true;
}

// ── Execute a single export + email ─────────────────────

async function runExport(context, schedule) {
  const { id, exportType, exportLabel } = schedule;
  context.log(`Running export: ${exportLabel} (${exportType}) [${id}]`);

  const handler = getHandler(exportType);
  if (!handler) {
    context.log.error(`No handler registered for exportType "${exportType}"`);
    await store.updateRunStatus(id, {
      lastRun: new Date().toISOString(),
      lastStatus: "error",
      lastError: `No handler for exportType: ${exportType}`,
    });
    return;
  }

  // 1. Run the export
  let result;
  try {
    result = await handler.execute(context);
  } catch (err) {
    context.log.error(`Export handler threw: ${err.message}`);
    await store.updateRunStatus(id, {
      lastRun: new Date().toISOString(),
      lastStatus: "error",
      lastError: err.message,
    });
    return;
  }

  if (!result.success) {
    context.log.error(`Export failed: ${result.error}`);
    await store.updateRunStatus(id, {
      lastRun: new Date().toISOString(),
      lastStatus: "error",
      lastError: result.error || "Export returned failure",
    });
    return;
  }

  // 2. Send email with the result
  const emailError = await sendResultEmail(context, schedule, result);

  // 3. Update run status
  await store.updateRunStatus(id, {
    lastRun: new Date().toISOString(),
    lastStatus: emailError ? "email-failed" : "success",
    lastError: emailError || null,
  });

  context.log(
    emailError
      ? `Export OK but email failed: ${emailError}`
      : `Export + email OK for ${exportLabel}`
  );
}

// ── Email via Mailjet ───────────────────────────────────

async function sendResultEmail(context, schedule, result) {
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const fromEmail = process.env.MAILJET_FROM_EMAIL || "noreply@versatech.nu";
  const fromName = process.env.MAILJET_FROM_NAME || "Genesys Admin App";

  if (!apiKey || !secretKey) {
    return "Mailjet credentials not configured";
  }

  const recipientList = (schedule.emailRecipients || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!recipientList.length) {
    return "No email recipients configured";
  }

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const defaultBody =
    `Scheduled export: ${schedule.exportLabel}\n` +
    `Summary: ${result.summary || "N/A"}\n\n` +
    `Generated: ${timestamp}\n\n` +
    "Best regards,\nGenesys Admin App";

  const message = {
    From: { Email: fromEmail, Name: fromName },
    To: recipientList.map((email) => ({ Email: email })),
    Subject: `${schedule.exportLabel} — ${timestamp}`,
    TextPart: schedule.emailMessage?.trim() || defaultBody,
  };

  if (result.base64 && result.filename) {
    message.Attachments = [
      {
        ContentType: result.mimeType || "application/octet-stream",
        Filename: result.filename,
        Base64Content: result.base64,
      },
    ];
  }

  try {
    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
    const resp = await fetch("https://api.mailjet.com/v3.1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ Messages: [message] }),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const errMsg =
        body.Messages?.[0]?.Errors?.[0]?.ErrorMessage ||
        body.ErrorMessage ||
        `Mailjet API error: ${resp.status}`;
      context.log.error("Mailjet send error:", JSON.stringify(body));
      return errMsg;
    }

    const body = await resp.json().catch(() => ({}));
    const msgStatus = body.Messages?.[0]?.Status;
    if (msgStatus === "error") {
      return body.Messages[0].Errors?.[0]?.ErrorMessage || "Mailjet error";
    }

    return null; // success
  } catch (err) {
    return `Email send failed: ${err.message}`;
  }
}
