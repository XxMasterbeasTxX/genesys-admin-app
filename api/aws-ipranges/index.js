/**
 * GET /api/aws-ipranges
 *
 * Proxies AWS' public IP-ranges feed:
 *   GET https://ip-ranges.amazonaws.com/ip-ranges.json
 *
 * The endpoint is anonymous and returns the same payload regardless of caller.
 * Result is cached in-process for AWS_CACHE_TTL_MS to reduce upstream load
 * (AWS updates this file at most a few times a day).
 *
 * Response: forwards AWS' JSON body verbatim, with an extra
 *   meta: { fetchedAt, cached }
 * field for client-side display.
 */

const AWS_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
const AWS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

let cached = null; // { body, fetchedAt: number }

module.exports = async function (context, req) {
  try {
    const force = String(req.query.force || "").toLowerCase() === "true";
    const now = Date.now();

    if (!force && cached && now - cached.fetchedAt < AWS_CACHE_TTL_MS) {
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: {
          ...cached.body,
          meta: {
            fetchedAt: new Date(cached.fetchedAt).toISOString(),
            cached: true,
            ttlMs: AWS_CACHE_TTL_MS,
          },
        },
      };
      return;
    }

    const awsResp = await fetch(AWS_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const text = await awsResp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!awsResp.ok) {
      context.log.warn(`aws-ipranges: AWS returned ${awsResp.status}`);
      context.res = {
        status: awsResp.status,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `AWS ip-ranges call failed (${awsResp.status})`,
          detail: parsed,
        },
      };
      return;
    }

    cached = { body: parsed, fetchedAt: now };

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        ...parsed,
        meta: {
          fetchedAt: new Date(now).toISOString(),
          cached: false,
          ttlMs: AWS_CACHE_TTL_MS,
        },
      },
    };
  } catch (err) {
    context.log.error("aws-ipranges error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message || "Internal error" },
    };
  }
};
