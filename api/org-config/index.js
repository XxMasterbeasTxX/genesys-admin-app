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
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "internal_error" },
    };
  }
};
