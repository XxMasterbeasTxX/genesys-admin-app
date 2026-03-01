/**
 * Scheduled Export Runner — HTTP-triggered Azure Function.
 *
 * Called by a GitHub Actions cron workflow every 5 minutes via POST.
 * Protected by a shared secret (SCHEDULE_RUNNER_KEY env var).
 *
 * For each enabled schedule whose time is due, it runs the corresponding
 * export handler, builds the Excel file, and emails the result via Mailjet.
 *
 * Schedule evaluation (all times in Europe/Copenhagen — CET/CEST):
 *   - daily:   runs once per day at scheduleTime
 *   - weekly:  runs once per week on scheduleDayOfWeek at scheduleTime
 *   - monthly: runs once per month on scheduleDayOfMonth at scheduleTime
 *
 * A schedule is considered "due" if:
 *   1. It is enabled
 *   2. The current UTC time is past the configured time
 *   3. It hasn't already run in the current period (day/week-day/month-day)
 */
const store = require("../lib/scheduleStore");
const { getHandler } = require("../lib/exportHandlers");

module.exports = async function (context, req) {
  // ── Verify shared secret ──────────────────────────────
  const expectedKey = process.env.SCHEDULE_RUNNER_KEY;
  if (!expectedKey) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "SCHEDULE_RUNNER_KEY not configured" },
    };
    return;
  }

  const providedKey =
    req.headers["x-runner-key"] ||
    (req.query && req.query.key) ||
    (req.body && req.body.key);

  if (providedKey !== expectedKey) {
    context.res = {
      status: 403,
      headers: { "Content-Type": "application/json" },
      body: { error: "Invalid runner key" },
    };
    return;
  }

  context.log("Scheduled runner triggered at", new Date().toISOString());

  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  let schedules;
  try {
    schedules = await store.listAll();
  } catch (err) {
    context.log.error("Failed to load schedules:", err.message);
    context.res = json(500, { error: "Failed to load schedules: " + err.message });
    return;
  }

  const enabled = schedules.filter((s) => s.enabled);
  if (!enabled.length) {
    context.log("No enabled schedules. Exiting.");
    context.res = json(200, { message: "No enabled schedules", ran: 0 });
    return;
  }

  const now = new Date();
  const dueSchedules = enabled.filter((s) => isDue(s, now));

  if (!dueSchedules.length) {
    context.log(`${enabled.length} enabled schedules, none due right now.`);
    context.res = json(200, { message: "No schedules due", enabled: enabled.length, ran: 0 });
    return;
  }

  context.log(`${dueSchedules.length} schedule(s) due. Processing…`);
  const results = [];

  for (const schedule of dueSchedules) {
    const result = await runExport(context, schedule);
    results.push(result);
  }

  context.log("Scheduled runner complete.");
  context.res = json(200, { message: "Runner complete", ran: results.length, results });
};

// ── Due check ───────────────────────────────────────────

function getDenmarkTime(date) {
  // Get current time components in Europe/Copenhagen (CET/CEST)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short", hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function isDue(schedule, now) {
  const dk = getDenmarkTime(now);
  const [hh, mm] = (schedule.scheduleTime || "08:00").split(":").map(Number);

  // The timer fires every 5 minutes. We consider a schedule "due" if
  // the current 5-minute window contains the scheduled time AND it
  // hasn't already run in the current period.

  // Check if current DK time is within ~5min past the scheduled time
  const scheduleMins = hh * 60 + mm;
  const nowMins = dk.hour * 60 + dk.minute;
  const diff = nowMins - scheduleMins;
  if (diff < 0 || diff >= 5) return false;

  // Check schedule type (using DK day/date)
  if (schedule.scheduleType === "weekly") {
    if (dk.weekday !== schedule.scheduleDayOfWeek) return false;
  } else if (schedule.scheduleType === "monthly") {
    if (dk.day !== schedule.scheduleDayOfMonth) return false;
  }
  // daily: no extra day check needed

  // Avoid double-runs: check if lastRun is already today (DK date)
  if (schedule.lastRun) {
    const lastRunDk = getDenmarkTime(new Date(schedule.lastRun));
    if (lastRunDk.dateStr === dk.dateStr) return false;
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
    return { id, exportType, status: "error", error: "No handler" };
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
    return { id, exportType, status: "error", error: err.message };
  }

  if (!result.success) {
    context.log.error(`Export failed: ${result.error}`);
    await store.updateRunStatus(id, {
      lastRun: new Date().toISOString(),
      lastStatus: "error",
      lastError: result.error || "Export returned failure",
    });
    return { id, exportType, status: "error", error: result.error };
  }

  // 2. Send email with the result
  const emailError = await sendResultEmail(context, schedule, result);

  // 3. Update run status
  const finalStatus = emailError ? "email-failed" : "success";
  await store.updateRunStatus(id, {
    lastRun: new Date().toISOString(),
    lastStatus: finalStatus,
    lastError: emailError || null,
  });

  context.log(
    emailError
      ? `Export OK but email failed: ${emailError}`
      : `Export + email OK for ${exportLabel}`
  );

  return { id, exportType, status: finalStatus, error: emailError || null };
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
