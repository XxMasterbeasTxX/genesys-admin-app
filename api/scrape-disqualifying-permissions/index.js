/**
 * GET /api/scrape-disqualifying-permissions
 *
 * Scrapes the Genesys Cloud help page that lists permissions which
 * disqualify a user from the Hourly Interacting license.
 *
 * Returns a sorted JSON array of permission strings.
 *
 * The page renders its table via DataTables; all rows are present in the
 * HTML source but unicode-escaped (\u003e instead of >).  We extract them
 * with a regex rather than a DOM parser.
 *
 * Cache-Control: 24 h — the list changes very rarely.
 */

const SOURCE_URL =
  "https://help.genesys.cloud/articles/hourly-interacting-license-disqualifying-permissions/";

const PERM_REGEX = /\\u003e([a-zA-Z]+:[a-zA-Z*]+:[a-zA-Z*]+)\\u003c/g;

module.exports = async function (context) {
  try {
    const resp = await fetch(SOURCE_URL, {
      headers: { "User-Agent": "GenesysAdminApp/1.0" },
    });

    if (!resp.ok) {
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: `Upstream returned HTTP ${resp.status}` },
      };
      return;
    }

    const html = await resp.text();

    const permissions = new Set();
    let match;
    while ((match = PERM_REGEX.exec(html)) !== null) {
      permissions.add(match[1]);
    }

    if (permissions.size === 0) {
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: {
          error:
            "Could not extract any permissions from the Genesys help page. " +
            "The page format may have changed.",
        },
      };
      return;
    }

    const sorted = [...permissions].sort();

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      },
      body: sorted,
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: `Scraper error: ${err.message}` },
    };
  }
};
