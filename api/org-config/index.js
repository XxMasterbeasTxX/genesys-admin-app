const { resolveOrgConfig } = require("../lib/orgConfigResolver");

module.exports = async function (context, req) {
  try {
    const result = await resolveOrgConfig(context, req);
    context.res = {
      status: result.status,
      headers: { "Content-Type": "application/json" },
      body: result.body,
    };
  } catch (err) {
    context.log.error("[org-config] Error:", err);
    // TEMP DIAGNOSTIC: surface the real error to pin down a 500 in the pre-login
    // path. Remove after diagnosis.
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        error: "internal_error",
        detail: (err && err.message) || String(err),
        stack: (err && err.stack) ? String(err.stack).split("\n").slice(0, 4) : undefined,
      },
    };
  }
};
