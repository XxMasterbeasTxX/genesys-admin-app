/**
 * Activity Log API
 *
 * POST /api/activity-log         → write a log entry (any authenticated user)
 * GET  /api/activity-log         → read log entries
 *
 * GET query parameters:
 *   userEmail   {string}  Required — the caller's email address.
 *                         If email matches admin, can also pass all=true.
 *   all         {boolean} If "true" and caller is admin, returns all users' entries.
 *   limit       {number}  Max entries to return (default 500, max 1000).
 */
const store = require("../lib/activityLogStore");

module.exports = async function (context, req) {
  const method = req.method.toUpperCase();

  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  try {
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
      });

      context.res = json(201, entry);
      return;
    }

    // ── GET — read log entries ───────────────────────────
    if (method === "GET") {
      const callerEmail = (req.query.userEmail || "").trim();
      const wantsAll    = req.query.all === "true";
      const limit       = Math.min(parseInt(req.query.limit) || 500, 1000);

      if (!callerEmail) {
        context.res = json(400, { error: "userEmail query parameter is required" });
        return;
      }

      const isAdmin   = callerEmail.toLowerCase() === store.ADMIN_EMAIL;
      const filterBy  = (wantsAll && isAdmin) ? null : callerEmail;

      // Admin: silently purge stale entries while fetching
      if (isAdmin) {
        store.purgeOld().catch((err) =>
          context.log.warn("[activity-log] purge error (non-critical):", err?.message)
        );
      }

      const entries = await store.list({ userEmail: filterBy, limit });

      context.res = json(200, { entries, isAdmin });
      return;
    }

    context.res = json(405, { error: "Method not allowed" });
  } catch (err) {
    context.log.error("[activity-log] error:", err?.message || err);
    context.res = json(500, { error: err?.message || "Internal server error" });
  }
};
