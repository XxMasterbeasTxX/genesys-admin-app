/**
 * Template Schedule Orchestrator — Durable Functions orchestrator.
 *
 * Receives schedule config as input, computes the exact next fire time
 * (in Europe/Copenhagen timezone), sleeps via a durable timer until that
 * moment, then calls the activity to execute the template runner.
 *
 * For recurring schedules (daily/weekly/monthly), the orchestrator loops
 * by calling `continueAsNew`.  For one-time schedules, it exits after
 * a single execution.
 *
 * Orchestrator instances survive Function App restarts — Durable
 * Functions replays them from Azure Storage history automatically.
 */
const df = require("durable-functions");

module.exports = df.orchestrator(function* (context) {
  const schedule = context.df.getInput();

  if (!schedule || !schedule.id) {
    return { completed: false, error: "No schedule input" };
  }

  // Use replay-safe current time
  const now = context.df.currentUtcDateTime;

  // Compute next fire time in UTC
  const nextFireUTC = computeNextFireUTC(schedule, now);

  if (!nextFireUTC) {
    return {
      completed: true,
      scheduleId: schedule.id,
      reason: "No upcoming fire time (one-time schedule in the past)",
    };
  }

  if (!context.df.isReplaying) {
    context.log(`Schedule ${schedule.id}: next fire at ${nextFireUTC.toISOString()}`);
  }

  // Sleep until the exact moment
  yield context.df.createTimer(nextFireUTC);

  // Execute the template runner (with retry: 10s interval, 3 attempts)
  const retryOptions = new df.RetryOptions(10000, 3);
  yield context.df.callActivityWithRetry(
    "template-schedule-activity",
    retryOptions,
    { scheduleId: schedule.id }
  );

  // Recurring → loop; one-time → exit
  if (schedule.scheduleType !== "once") {
    context.df.continueAsNew(schedule);
  }

  return {
    completed: true,
    scheduleId: schedule.id,
    executedAt: context.df.currentUtcDateTime.toISOString(),
  };
});

// ── Timezone helpers ────────────────────────────────────
// All schedule times are in Europe/Copenhagen (CET/CEST).
// We compute the next fire time and convert it to UTC.

/**
 * Get date/time components in the Copenhagen timezone for a given UTC Date.
 */
function getCopenhagenParts(utcDate) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(utcDate);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayNames.indexOf(get("weekday")),
  };
}

/**
 * Convert a Copenhagen local date/time to a UTC Date.
 *
 * Approach: create a "guess" UTC Date using the Copenhagen values, then
 * measure the Copenhagen offset at that instant, and subtract it.
 */
function copenhagenToUTC(year, month, day, hour, minute) {
  // Guess: treat Copenhagen values as UTC
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // What Copenhagen time is it at this UTC instant?
  const cphParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(guess);

  const get = (type) => Number(cphParts.find((p) => p.type === type)?.value);
  const cphAtGuess = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    0,
    0
  );

  // Offset = how far Copenhagen is ahead of UTC (in ms)
  const offsetMs = cphAtGuess - guess.getTime();

  // The true UTC time for the intended Copenhagen time
  return new Date(guess.getTime() - offsetMs);
}

/**
 * Compute the next fire time (as a UTC Date) for a template schedule.
 *
 * @param {Object} schedule  – { scheduleType, scheduleTime, scheduleDayOfWeek,
 *                               scheduleDayOfMonth, scheduleDate }
 * @param {Date}   nowUTC    – Current UTC time (replay-safe)
 * @returns {Date|null}      – Next fire time in UTC, or null if none
 */
function computeNextFireUTC(schedule, nowUTC) {
  const [hh, mm] = (schedule.scheduleTime || "08:00").split(":").map(Number);
  const cph = getCopenhagenParts(nowUTC);

  if (schedule.scheduleType === "once") {
    // scheduleDate is "YYYY-MM-DD"
    if (!schedule.scheduleDate) return null;
    const [y, m, d] = schedule.scheduleDate.split("-").map(Number);
    const fireUTC = copenhagenToUTC(y, m, d, hh, mm);
    // Only fire if in the future
    return fireUTC > nowUTC ? fireUTC : null;
  }

  if (schedule.scheduleType === "daily") {
    // Try today first
    let fireUTC = copenhagenToUTC(cph.year, cph.month, cph.day, hh, mm);
    if (fireUTC > nowUTC) return fireUTC;
    // Already past → tomorrow
    const tomorrow = new Date(Date.UTC(cph.year, cph.month - 1, cph.day + 1));
    const tmCph = getCopenhagenParts(tomorrow);
    return copenhagenToUTC(tmCph.year, tmCph.month, tmCph.day, hh, mm);
  }

  if (schedule.scheduleType === "weekly") {
    const targetDay = schedule.scheduleDayOfWeek; // 0=Sun … 6=Sat
    // Find the next occurrence of targetDay
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(
        Date.UTC(cph.year, cph.month - 1, cph.day + offset)
      );
      const candCph = getCopenhagenParts(candidate);
      if (candCph.weekday === targetDay) {
        const fireUTC = copenhagenToUTC(
          candCph.year, candCph.month, candCph.day, hh, mm
        );
        if (fireUTC > nowUTC) return fireUTC;
      }
    }
    return null; // Should never happen
  }

  if (schedule.scheduleType === "monthly") {
    const targetDom = schedule.scheduleDayOfMonth; // 1–31
    // Try this month
    let fireUTC = copenhagenToUTC(cph.year, cph.month, targetDom, hh, mm);
    if (fireUTC > nowUTC) return fireUTC;
    // Next month
    const nextMonth = cph.month === 12 ? 1 : cph.month + 1;
    const nextYear = cph.month === 12 ? cph.year + 1 : cph.year;
    return copenhagenToUTC(nextYear, nextMonth, targetDom, hh, mm);
  }

  return null;
}
