/**
 * Server-side Users Queues/Skills export.
 *
 * Exports users (state=any) with one row per Queue x Skill x Language Skill
 * combination. Missing dimensions are represented as blanks.
 *
 * Requires:
 *   schedule.exportConfig.orgId — org to export
 *
 * Returns:
 *   { success, filename, base64, mimeType, summary, error? }
 */
const customers = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const XLSX = require("xlsx-js-style");
const { buildStyledWorkbook } = require("../excelStyles");

const HEADERS = ["Name", "Queue", "Skill", "Language Skill"];

function timestampedFilename(prefix, ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${ts}.${ext}`;
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

async function genesysGet(customerId, path) {
  const customer = customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);

  const envKey = `GENESYS_${customerId.replace(/-/g, "_").toUpperCase()}`;
  const clientId = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    throw new Error(`Credentials not configured for ${customerId}`);
  }

  const token = await getGenesysToken(customerId, customer.region, clientId, clientSecret);
  const url = `https://api.${customer.region}${path}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Genesys API ${resp.status} for ${customerId} ${path}: ${body.slice(0, 200)}`);
  }

  return resp.json();
}

async function genesysGetAllPages(customerId, path, pageSize = 100) {
  let page = 1;
  let all = [];

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const fullPath = `${path}${separator}pageSize=${pageSize}&pageNumber=${page}`;
    const resp = await genesysGet(customerId, fullPath);

    const items = resp.entities || [];
    all = all.concat(items);

    if (items.length < pageSize || page >= (resp.pageCount ?? page)) break;
    page++;
  }

  return all;
}

async function getUserQueues(customerId, userId) {
  const queues = await genesysGetAllPages(customerId, `/api/v2/users/${userId}/queues`, 100);
  return queues.map((q) => ({ queueId: q.id || "", queueName: q.name || "" }));
}

async function fetchQueuesForUsers(customerId, users, context) {
  const queueMap = new Map();
  const concurrency = 8;
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < users.length) {
      const i = idx++;
      const user = users[i];
      try {
        const queues = await getUserQueues(customerId, user.id);
        queueMap.set(user.id, queues);
      } catch {
        queueMap.set(user.id, []);
      }
      done++;
      if (done % 50 === 0 || done === users.length) {
        context.log(`Loaded queue assignments for ${done}/${users.length} users`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, users.length)) }, () => worker());
  await Promise.all(workers);
  return queueMap;
}

function buildRows(users, queueMap) {
  const rows = [];
  let usersWithRows = 0;

  for (const user of users) {
    const name = user.name || "N/A";

    const qVals = sortedUnique((queueMap.get(user.id) || []).map((q) => q.queueName));
    const sVals = sortedUnique((user.skills || []).map((s) => s.name || s.skillName || ""));
    const lVals = sortedUnique((user.languages || []).map((l) => l.name || l.languageName || ""));

    const queues = qVals.length ? qVals : [""];
    const skills = sVals.length ? sVals : [""];
    const languages = lVals.length ? lVals : [""];

    usersWithRows++;
    for (const q of queues) {
      for (const s of skills) {
        for (const l of languages) {
          rows.push({ name, queue: q, skill: s, languageSkill: l });
        }
      }
    }
  }

  return { rows, usersWithRows };
}

async function execute(context, schedule) {
  const config = schedule?.exportConfig || {};
  const orgId = config.orgId;

  if (!orgId) {
    return { success: false, error: "No orgId specified in export config" };
  }

  const customer = customers.find((c) => c.id === orgId);
  if (!customer) {
    return { success: false, error: `Unknown org: ${orgId}` };
  }

  context.log(`Queues/Skills export for ${customer.name} (${orgId})`);

  try {
    context.log("Fetching users (state=any) with skills/languages…");
    const users = await genesysGetAllPages(orgId, "/api/v2/users?state=any&expand=skills,languages", 500);
    context.log(`Fetched ${users.length} users`);

    context.log("Fetching queue assignments for users…");
    const queueMap = await fetchQueuesForUsers(orgId, users, context);

    context.log("Building rows and workbook…");
    const { rows, usersWithRows } = buildRows(users, queueMap);

    const wsData = [HEADERS];
    for (const r of rows) {
      wsData.push([r.name, r.queue, r.skill, r.languageSkill]);
    }
    const wb = buildStyledWorkbook(wsData, "Users Queues Skills Export");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = timestampedFilename(`QueuesSkills_${customer.name.replace(/\s+/g, "_")}`, "xlsx");

    return {
      success: true,
      filename,
      base64,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      summary: `${customer.name}: ${usersWithRows} users, ${rows.length} rows`,
    };
  } catch (err) {
    context.log.error(`Queues/Skills export error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { execute };
