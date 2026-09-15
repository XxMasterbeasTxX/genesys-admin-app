/**
 * POST /api/gdpr-watches — "email me when Genesys completes this".
 *
 * Called by Subject Request straight after a successful submission, once per
 * batch, with the request ids Genesys minted. One watch row per id. The
 * hourly sweep in api/scheduled-runner does the rest.
 *
 * The caller is identified server-side from their own Genesys token
 * (callerContext), so a customer session can only register watches for its
 * own org, and the submitter recorded on the watch is the verified identity,
 * not a claim in the body.
 *
 * Body: { orgId, orgName, requestType, requestIds: [..], email }
 *
 * See docs/gdpr-completion-notify-design.md.
 */
const store = require("../lib/gdprWatchStore");
const { getCallerContext } = require("../lib/callerContext");

// The same test the mailer applies (api/lib/mailer.js EMAIL_RE) and the pages
// apply (js/services/emailService.js): an address accepted in one place and
// refused in another is a confusing bug to chase.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES    = new Set(["GDPR_EXPORT", "GDPR_UPDATE", "GDPR_DELETE"]);

module.exports = async function (context, req) {
  const json = (status, body) => ({ status, headers: { "Content-Type": "application/json" }, body });

  try {
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) {
      context.res = json(caller.status || 401, { error: caller.error || "unauthorized" });
      return;
    }

    const b = req.body || {};
    const email = String(b.email || "").trim();
    const requestIds = Array.isArray(b.requestIds) ? b.requestIds.map(String) : [];
    const requestType = String(b.requestType || "");

    // A customer session is locked to its own org; an internal session says
    // which org it acted on.
    const orgId = caller.mode === "customer" ? caller.customerId : String(b.orgId || "").trim();

    if (!orgId)                       { context.res = json(400, { error: "orgId is required" }); return; }
    if (!EMAIL_RE.test(email))        { context.res = json(400, { error: "A valid email address is required" }); return; }
    if (!TYPES.has(requestType))      { context.res = json(400, { error: "requestType must be GDPR_EXPORT, GDPR_UPDATE or GDPR_DELETE" }); return; }
    if (!requestIds.length)           { context.res = json(400, { error: "requestIds must name at least one request" }); return; }
    if (!requestIds.every((id) => UUID_RE.test(id))) { context.res = json(400, { error: "requestIds must be Genesys request ids" }); return; }
    if (requestIds.length > 100)      { context.res = json(400, { error: "Too many request ids in one call" }); return; }

    const created = [];
    for (const requestId of requestIds) {
      created.push(await store.create({
        orgId,
        requestId,
        ownerOrgId:    caller.ownerOrgId,
        orgName:       String(b.orgName || "").slice(0, 200),
        email,
        requestType,
        submittedBy:   caller.userName || caller.userEmail || "",
        submittedById: caller.userId || "",
      }));
    }

    context.res = json(201, { watched: created.length, requestIds: created.map((w) => w.requestId) });
  } catch (err) {
    context.log.error("[gdpr-watches] error:", err?.message || err);
    context.res = json(500, { error: err?.message || "Internal error" });
  }
};
