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
