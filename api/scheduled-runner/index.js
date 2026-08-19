/**
 * Scheduled Export Runner — HTTP-triggered Azure Function.
 *
 * Called every 5 minutes by an Azure Timer Trigger (genesys-admin-timer
 * Function App) via POST. Protected by a shared secret (SCHEDULE_RUNNER_KEY).
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
const mailer = require("../lib/mailer");

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

  // Is the scheduled time already past for today (DK)?
  const scheduleMins = hh * 60 + mm;
  const nowMins = dk.hour * 60 + dk.minute;
  if (nowMins < scheduleMins) return false; // Not yet time

  // Is today the right day for this schedule type?
  if (schedule.scheduleType === "weekly") {
    if (dk.weekday !== schedule.scheduleDayOfWeek) return false;
  } else if (schedule.scheduleType === "monthly") {
    if (dk.day !== schedule.scheduleDayOfMonth) return false;
  }
  // daily: every day is the right day

  // Has it already run in the current period (DK date)?
  // This prevents double-runs AND acts as catch-up: if the runner
  // was delayed or missed the exact window, the next cycle will
  // still pick it up — as long as it hasn't run today yet.
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
    result = await handler.execute(context, schedule);
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

/**
 * Mail a finished export.
 *
 * @returns {Promise<string|null>} An error message, or null on success. The
 *   caller records this on the schedule as `lastError`, so the string is what
 *   an admin reads on the Scheduled Exports page.
 */
async function sendResultEmail(context, schedule, result) {
  const recipientList = mailer.parseRecipients(schedule.emailRecipients);
  if (!recipientList.length) {
    // Checked before composing: this run has nothing to say and no one to say
    // it to, and the message differs from the mailer's generic wording because
    // it points at the schedule's own configuration.
    return "No email recipients configured";
  }

  const timestamp = mailer.timestamp();
  const defaultBody =
    `Scheduled export: ${schedule.exportLabel}\n` +
    `Summary: ${result.summary || "N/A"}\n\n` +
    `Generated: ${timestamp}\n\n` +
    "Best regards,\nGenesys Admin App";

  // Handlers may supply their own subject/body to match upstream conventions
  // (e.g. Python's `[{customer}] {task_name} Export`). User-supplied
  // emailMessage on the schedule always wins over handler defaults.
  const subject = result.subject || `${schedule.exportLabel} — ${timestamp}`;
  const body    = schedule.emailMessage?.trim() || result.body || defaultBody;

  const sent = await mailer.sendMail({
    recipients: recipientList,
    subject,
    text: body,
    attachment: (result.base64 && result.filename)
      ? { filename: result.filename, base64: result.base64, mimeType: result.mimeType }
      : null,
    log: (msg) => context.log.error(msg),
  });

  // Addresses are NOT validated here, matching the behaviour this runner has
  // always had: a schedule with one malformed recipient still attempts its
  // send, and Mailjet's own verdict is what gets recorded. Rejecting the batch
  // ourselves would turn a typo into a silently skipped export.
  return sent.success ? null : sent.error;
}
