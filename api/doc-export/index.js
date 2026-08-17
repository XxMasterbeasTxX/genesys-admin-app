/**
 * POST /api/doc-export
 *
 * On-demand trigger for the Documentation export.
 * Body: { orgId: string, includeDataTables?: boolean }
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary }
 *   mimeType is application/zip when both workbooks exist,
 *   otherwise application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 */
const handler = require("../lib/exports/documentation");
const { getCallerContext } = require("../lib/callerContext");

module.exports = async function (context, req) {
  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  try {
    const { orgId, includeDataTables } = req.body || {};

    if (!orgId) {
      context.res = json(400, { error: "Missing required field: orgId" });
      return;
    }

    // Authenticate, and lock a customer to their own org.
    //
    // This endpoint runs a full documentation export using the app's client
    // credentials for whichever org the body names, and returns the workbook.
    // Azure Static Web Apps serves /api/* anonymously unless a route rule says
    // otherwise and staticwebapp.config.json declares none, so until now the
    // org id in the body was the only thing deciding whose configuration got
    // exported — to an unauthenticated caller.
    //
    // `orgId` is passed as the region hint so a cross-region customer token is
    // verified against the right Genesys region (see callerContext).
    const caller = await getCallerContext(context, req, { hintId: orgId });
    if (!caller.authorized) {
      context.res = json(caller.status || 401, { error: caller.error || "unauthorized" });
      return;
    }
    if (caller.mode === "customer" && orgId !== caller.customerId) {
      context.res = json(403, { error: "org_locked" });
      return;
    }

    const result = await handler.execute(context, {
      exportConfig: { orgId, includeDataTables: includeDataTables !== false },
    });

    if (!result.success) {
      context.res = json(500, { error: result.error || "Export failed" });
      return;
    }

    context.res = json(200, result);
  } catch (err) {
    context.log.error("doc-export error:", err.message);
    context.res = json(500, { error: err.message });
  }
};
