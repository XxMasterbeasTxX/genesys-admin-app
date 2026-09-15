/**
 * GDPR completion sweep — the hourly step inside api/scheduled-runner.
 *
 * For every org that has open watches (gdprWatchStore), one paged
 * GET /api/v2/gdpr/requests with the org's client credentials, then one
 * decision per watch. A watch is mailed exactly once, whatever happens:
 *
 *   COMPLETED                         → "completed"
 *   ERROR                             → "failed"
 *   still running after WATCH_DAYS    → "still not complete"
 *   request no longer listed          → "no longer listed"
 *   no credentials / 403 / other fail → "could not check"   (the org's client
 *                                        lacks gdpr:request:view, or the org
 *                                        has no client credentials at all)
 *
 * The mail carries the request id, the org, the type, who raised it and the
 * status seen. Nothing about the data subject, and no link: the archive URL
 * is signed, per session, and belongs behind the app's login.
 *
 * Genesys has no notification topic for GDPR requests — the full
 * availabletopics list was read on 2026-09-15 — so polling is the mechanism.
 * See docs/gdpr-completion-notify-design.md.
 */
const store  = require("./gdprWatchStore");
const mailer = require("./mailer");
const activityLog = require("./activityLogStore");
const { genesysGetAllPages } = require("./genesysFetch");

/** Sweep no more often than this; the runner itself fires every 5 minutes. */
const SWEEP_MINUTES = 55;

const TYPE_LABEL = { GDPR_EXPORT: "Access", GDPR_UPDATE: "Rectification", GDPR_DELETE: "Erasure" };

/**
 * Run the sweep if it is due. Never throws: the export schedules after it
 * must run whatever happens here.
 *
 * @returns {Promise<object>} A summary for the runner's response body.
 */
async function sweepIfDue(context, now = new Date()) {
  const log = (m) => context.log(`[gdpr-notify] ${m}`);
  try {
    const last = await store.getLastSweep();
    if (last && now - new Date(last) < SWEEP_MINUTES * 60000) {
      return { ran: false, reason: "not due", lastSweep: last };
    }
    await store.setLastSweep(now.toISOString());

    const byOrg = await store.listOpenByOrg();
    const purged = await store.purgeNotified();
    if (!byOrg.size) {
      log(`no open watches${purged ? `, purged ${purged}` : ""}`);
      return { ran: true, orgs: 0, mailed: 0, purged };
    }

    let mailed = 0;
    const perOrg = [];
    for (const [orgId, watches] of byOrg) {
      const r = await sweepOrg(context, orgId, watches, now);
      mailed += r.mailed;
      perOrg.push({ orgId, ...r });
    }
    log(`${byOrg.size} org(s), ${mailed} mail(s), purged ${purged}`);
    return { ran: true, orgs: byOrg.size, mailed, purged, perOrg };
  } catch (err) {
    context.log.error(`[gdpr-notify] sweep failed: ${err.message}`);
    return { ran: false, error: err.message };
  }
}

async function sweepOrg(context, orgId, watches, now) {
  let requests;
  try {
    requests = await genesysGetAllPages(orgId, "/api/v2/gdpr/requests", 100);
  } catch (err) {
    // No credentials for this org, or the client cannot read GDPR requests.
    // Either way the person waiting must hear it from us, once, this hour —
    // not discover it by the request never being mentioned again.
    context.log.warn(`[gdpr-notify] ${orgId}: could not list requests — ${err.message}`);
    let mailed = 0;
    for (const w of watches) {
      if (await notify(context, w, "unchecked", { error: err.message })) mailed++;
    }
    return { mailed, checked: 0, error: err.message };
  }

  const byId = new Map(requests.map((r) => [r.id, r]));
  let mailed = 0;
  for (const w of watches) {
    const req = byId.get(w.requestId);
    const status = req?.status || null;
    const ageDays = (now - new Date(w.createdAt)) / 86400000;

    let outcome = null;
    if (!req)                           outcome = "unlisted";
    else if (status === "COMPLETED")    outcome = "completed";
    else if (status === "ERROR")        outcome = "failed";
    else if (ageDays >= store.WATCH_DAYS) outcome = "timeout";

    if (!outcome) {
      await store.touch(orgId, w.requestId, { lastStatus: status });
      continue;
    }
    if (await notify(context, w, outcome, { status })) mailed++;
  }
  return { mailed, checked: watches.length };
}

// ── The mail ────────────────────────────────────────────

const WORDING = {
  completed: {
    subject: (t, org) => `GDPR ${t} request completed — ${org}`,
    line:    (t)      => `has completed.`,
    next:    (t)      => t === "Access"
      ? "For an Access request, the export archive is downloaded from there."
      : "",
  },
  failed: {
    subject: (t, org) => `GDPR ${t} request failed — ${org}`,
    line:    ()       => `has ended in ERROR at Genesys.`,
    next:    ()       => "Genesys reports no reason. Raise the request again; if it fails again, contact Genesys support with the request id.",
  },
  timeout: {
    subject: (t, org) => `GDPR ${t} request still not complete — ${org}`,
    line:    ()       => `has not completed after ${store.WATCH_DAYS} days.`,
    next:    ()       => "The Genesys Admin Tool has stopped checking. The request may still finish; check Request Status, or contact Genesys support with the request id.",
  },
  unlisted: {
    subject: (t, org) => `GDPR ${t} request no longer listed — ${org}`,
    line:    ()       => `is no longer in the list of requests Genesys returns for the org.`,
    next:    ()       => "The Genesys Admin Tool has stopped checking. If you expected this request to exist, contact Genesys support with the request id.",
  },
  unchecked: {
    subject: (t, org) => `GDPR ${t} request could not be checked — ${org}`,
    line:    ()       => `could not be checked.`,
    next:    ()       => "The Genesys Admin Tool could not read the org's GDPR requests. Ask your administrator to confirm the app's OAuth client is configured for this org and holds the permission gdpr:request:view. The tool will not check again for this request; look it up under Request Status instead.",
  },
};

function fmtDate(iso) {
  if (!iso) return "unknown";
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Copenhagen" })
      .format(new Date(iso));
  } catch { return iso; }
}

/**
 * Send one mail and close the watch. Returns true when the mail went.
 * A failed send still closes the watch, with the error recorded, so the
 * sweep does not retry every hour into the same Mailjet failure; the
 * Activity Log row says what happened.
 */
async function notify(context, w, outcome, { status = null, error = null } = {}) {
  const t   = TYPE_LABEL[w.requestType] || w.requestType || "GDPR";
  const org = w.orgName || w.orgId;
  const wd  = WORDING[outcome];
  const who = w.submittedBy ? `raised by ${w.submittedBy} ` : "";

  const text =
    `The GDPR ${t} request ${who}on ${fmtDate(w.createdAt)} ${wd.line(t)}\n\n` +
    `Request id:   ${w.requestId}\n` +
    `Org:          ${org}\n` +
    `Status:       ${status ? titleCase(status) : "unknown"} (seen ${fmtDate(new Date().toISOString())})\n\n` +
    `You can view the request under GDPR › Request Status in the Genesys Admin Tool.\n` +
    (wd.next(t) ? `${wd.next(t)}\n` : "") +
    `\nThis is the only email you will receive about this request.\n`;

  const sent = await mailer.sendMail({
    recipients: w.email,
    subject: wd.subject(t, org),
    text,
    log: (m) => context.log.error(`[gdpr-notify] ${m}`),
  });

  await store.markNotified(w.orgId, w.requestId, {
    outcome,
    lastStatus: status,
    lastError: sent.success ? (error || null) : `mail: ${sent.error}`,
  });

  // Recipient domain only: the address itself stays in the watch row and
  // leaves with it. The log answers "did it mail, when, where to?" — not the
  // address a person typed.
  const domain = w.email.includes("@") ? "@" + w.email.split("@").pop() : "";
  try {
    await activityLog.create({
      ownerOrgId:   w.ownerOrgId,
      userId:       w.submittedById || "",
      userEmail:    "scheduled-runner",
      userName:     "Genesys Admin App",
      orgId:        w.orgId,
      orgName:      org,
      action:       "gdpr_notify_sent",
      description:  `GDPR ${t} request ${w.requestId}: ${outcome} — notification ${sent.success ? "sent" : "FAILED"} to ${domain}`,
      result:       sent.success ? "success" : "failure",
      errorMessage: sent.success ? null : sent.error,
      count:        1,
      details:      { gdprRequestIds: [w.requestId], outcome, status, recipientDomain: domain, error: error || null },
    });
  } catch (err) {
    context.log.warn(`[gdpr-notify] activity log write failed: ${err.message}`);
  }

  return sent.success;
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

module.exports = { sweepIfDue, SWEEP_MINUTES };
