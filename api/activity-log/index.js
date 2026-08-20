/**
 * Activity Log API
 *
 * POST /api/activity-log         → write a log entry (any authenticated user)
 * GET  /api/activity-log         → read log entries
 *
 * A read returns the caller's OWN ORGANISATION's activity, in full. The
 * isolation boundary is the org, not the user: internal sessions get the
 * internal-owned entries, customer sessions get their own org's, and neither
 * ever sees the other's.
 *
 * GET query parameters:
 *   userEmail   {string}  Required — the caller's email address. Identifies who
 *                         is asking (for the retention purge); it no longer
 *                         narrows what comes back.
 *   limit       {number}  Max entries to return (default 500, max 1000).
 */
const store = require("../lib/activityLogStore");
const { getCallerContext } = require("../lib/callerContext");

module.exports = async function (context, req) {
  const method = req.method.toUpperCase();

  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  try {    // Owner-scoped store: customers see only their own org's activity; internal
    // sessions never see customer-created entries. (Step 6)
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) {
      context.res = json(caller.status || 401, { error: caller.error || "unauthorized" });
      return;
    }
    // ── POST — write a log entry ─────────────────────────
    if (method === "POST") {
      const b = req.body || {};

      if (!b.action || !b.description || !b.userEmail) {
        context.res = json(400, {
          error: "Missing required fields: action, description, userEmail",
        });
        return;
      }

      const entry = await store.create({
        ownerOrgId:   caller.ownerOrgId,
        userId:       b.userId       || "",
        userEmail:    b.userEmail,
        userName:     b.userName     || "",
        orgId:        b.orgId        || "",
        orgName:      b.orgName      || "",
        action:       b.action,
        description:  b.description,
        result:       b.result       || "success",
        errorMessage: b.errorMessage || null,
        count:        b.count        ?? null,
        details:      b.details      ?? null,
      });

      context.res = json(201, entry);
      return;
    }

    // ── GET — read log entries ───────────────────────────
    if (method === "GET") {
      const callerEmail = (req.query.userEmail || "").trim();
      const limit       = Math.min(parseInt(req.query.limit) || 500, 1000);

      if (!callerEmail) {
        context.res = json(400, { error: "userEmail query parameter is required" });
        return;
      }

      // `userEmail` is supplied by the client, so this is a claim, not proof —
      // it decides only whether the retention purge runs, never what is
      // returned. Customer sessions are excluded outright: they used to return
      // before this check existed on their path, and a customer naming the
      // admin address must not be able to set a maintenance job running inside
      // the internal partition. Step 2 of docs/feature-requests-design.md
      // replaces this with the caller's token-derived user id.
      const isAdmin =
        caller.mode !== "customer" && callerEmail.toLowerCase() === store.ADMIN_EMAIL;

      // One rule for everyone: you see your own organisation's activity, all of
      // it. Customer sessions always worked this way. Internal sessions were
      // narrowed to the caller's own entries unless they were the admin, which
      // left staff as the only people who could not see what their own
      // organisation had done — the opposite of what an activity log is for.
      //
      // The boundary that matters is unchanged and is the org: internal never
      // sees customer-owned entries, one customer never sees another's.
      const ownerOrgId = caller.mode === "customer" ? caller.customerId : "internal";

      // Admin: silently purge stale entries while fetching.
      if (isAdmin) {
        store.purgeOld().catch((err) =>
          context.log.warn("[activity-log] purge error (non-critical):", err?.message)
        );
      }

      const entries = await store.list({ ownerOrgId, limit });

      // `isAdmin` no longer changes what comes back — it survives only so the
      // page can name who the retention purge runs for.
      context.res = json(200, { entries, isAdmin });
      return;
    }

    context.res = json(405, { error: "Method not allowed" });
  } catch (err) {
    context.log.error("[activity-log] error:", err?.message || err);
    context.res = json(500, { error: err?.message || "Internal server error" });
  }
};
