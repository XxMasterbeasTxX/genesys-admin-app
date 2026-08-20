/**
 * Feature request notifications (design §7).
 *
 * Three messages, all sent server-side from the endpoint that performed the
 * write:
 *   - a request is submitted   → the superusers
 *   - its status changes       → the submitter
 *   - a thread message is sent → whichever party did not write it
 *
 * Everything here is best-effort. A send failure must never fail the write that
 * produced it: the record is the record, and the mail is a courtesy — with the
 * one exception of the thread, where a message nobody is told about is a
 * conversation that stalls. Even there the write stands and the failure is only
 * logged, because rolling back somebody's words because an SMTP relay was busy
 * is worse than a missed notification.
 *
 * Recipients are addresses the app already holds: the submitter's own, recorded
 * from their token when they filed, and the superusers' from `SUPERUSER_IDS`.
 * Nothing here mails an address supplied in a request body.
 */
const mailer = require("./mailer");
const { superuserEmails } = require("./superusers");

const STATUS_TEXT = {
  "new": "New",
  "triaged": "Looked at",
  "awaiting-submitter": "Waiting for you",
  "planned": "Planned",
  "in-progress": "Being built",
  "shipped": "Shipped",
  "declined": "Not planned",
  "duplicate": "Duplicate",
};

/** Send and swallow. Returns true when it went, false otherwise. */
async function send(context, { recipients, subject, text }) {
  if (!recipients || (Array.isArray(recipients) && !recipients.length)) return false;
  try {
    const result = await mailer.sendMail({
      recipients,
      subject,
      text,
      log: (msg) => context?.log?.warn?.(msg),
    });
    if (!result.success) {
      context?.log?.warn?.(`[feature-requests] notification not sent: ${result.error}`);
    }
    return result.success;
  } catch (err) {
    context?.log?.warn?.(`[feature-requests] notification threw: ${err.message}`);
    return false;
  }
}

/** The captured context, as a couple of lines a person can read. */
function contextLines(request) {
  const lines = [];
  if (request.pageLabel) lines.push(`Page:    ${request.pageLabel}`);
  if (request.orgName) lines.push(`Org:     ${request.orgName}`);
  if (request.appVersion) lines.push(`Version: ${request.appVersion}`);
  return lines;
}

/**
 * A new request was filed → tell the superusers.
 *
 * The body carries the captured context deliberately, so triage rarely needs to
 * open the app to know whether something is worth opening the app for.
 */
async function notifyNewRequest(context, request) {
  const all = await superuserEmails(context);
  // A superuser filing their own request already gets the confirmation below;
  // telling them about it a second time as a triager is noise.
  const own = String(request.userEmail || "").toLowerCase();
  const recipients = all.filter((e) => String(e).toLowerCase() !== own);
  const text = [
    `${request.userName || request.userEmail} filed a ${request.type} request.`,
    "",
    request.title,
    "",
    request.description,
    "",
    ...contextLines(request),
    `From:    ${request.userEmail || "unknown"}`,
  ].join("\n");

  return send(context, {
    recipients,
    subject: `[Requests] ${request.type}: ${request.title}`,
    text,
  });
}

/**
 * A status changed → tell the person who asked.
 *
 * This is the notification that decides whether the board gets used twice. A
 * request that visibly moves is worth filing; one that vanishes is not.
 */
async function notifyStatusChange(context, request, previousStatus) {
  if (!request.userEmail || request.status === previousStatus) return false;

  const lines = [
    `Your request "${request.title}" is now: ${STATUS_TEXT[request.status] || request.status}`,
  ];
  if (request.adminNote) lines.push("", request.adminNote);
  if (request.status === "shipped" && request.shippedVersion) {
    lines.push("", `Shipped in version ${request.shippedVersion} — see the release notes in the app.`);
  }
  if (request.status === "awaiting-submitter") {
    lines.push("", "We have asked you something on the request — open it in the app to reply.");
  }

  return send(context, {
    recipients: request.userEmail,
    subject: `[Requests] ${STATUS_TEXT[request.status] || request.status}: ${request.title}`,
    text: lines.join("\n"),
  });
}

/**
 * A thread message was posted → tell the other party (§3a.3).
 *
 * Never an echo to the author: the person who just typed it does not need
 * telling, and a notification that arrives for your own message trains people
 * to ignore the ones that matter.
 */
async function notifyThreadMessage(context, request, message) {
  const fromSubmitter = message.authorRole === "submitter";

  const recipients = fromSubmitter
    ? await superuserEmails(context)
    : request.userEmail;

  const text = [
    fromSubmitter
      ? `${message.authorName || "The submitter"} replied on "${request.title}":`
      : `There is a reply on your request "${request.title}":`,
    "",
    message.body,
    "",
    "Open the Requests board in the app to continue.",
  ].join("\n");

  return send(context, {
    recipients,
    subject: `[Requests] Reply: ${request.title}`,
    text,
  });
}

/**
 * A request was filed → confirm it to the person who filed it.
 *
 * The page already said "thank you", so this is not news. It is a receipt: the
 * words they wrote, in their own inbox, so a request is something they can find
 * again and forward rather than something they typed into a box and hoped about.
 * It also proves the address we hold for them works, before the first status
 * change depends on it.
 */
async function notifyRequestReceived(context, request) {
  if (!request.userEmail) return false;

  const text = [
    "Thank you — your request has been filed. Here is what we have:",
    "",
    request.title,
    "",
    request.description,
    "",
    ...contextLines(request),
    "",
    "You will get an email whenever its status changes, and if we need to ask",
    "you anything we will reply on the request itself in the app.",
  ].join("\n");

  return send(context, {
    recipients: request.userEmail,
    subject: `[Requests] Received: ${request.title}`,
    text,
  });
}

module.exports = {
  notifyNewRequest,
  notifyRequestReceived,
  notifyStatusChange,
  notifyThreadMessage,
};
