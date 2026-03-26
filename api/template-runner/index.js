/**
 * Template Runner — HTTP-triggered Azure Function.
 *
 * Executes a template schedule: applies or resets skills, languages,
 * and queues for all users assigned to a template.
 *
 * Called by the Azure Timer Trigger (genesys-admin-timer Function App)
 * via POST.  Protected by a shared secret (SCHEDULE_RUNNER_KEY).
 *
 * Modes:
 *   reset — Remove ALL skills, languages, and queue memberships from
 *           each assigned user, then re-apply only the template's
 *           properties.  Roles are NOT touched.
 *   add   — Additively apply the template's skills, languages, and
 *           queues to each assigned user.  Roles are NOT touched.
 *
 * POST body:
 *   { scheduleId }   — the template schedule to execute
 */
const templateStore = require("../lib/templateStore");
const scheduleStore = require("../lib/templateScheduleStore");
const customers = require("../lib/customers.json");
const { getGenesysToken } = require("../lib/genesysAuth");

module.exports = async function (context, req) {
  // ── Verify shared secret ──────────────────────────────
  const expectedKey = process.env.SCHEDULE_RUNNER_KEY;
  if (!expectedKey) {
    context.res = json(500, { error: "SCHEDULE_RUNNER_KEY not configured" });
    return;
  }

  const providedKey =
    req.headers["x-runner-key"] ||
    (req.query && req.query.key) ||
    (req.body && req.body.key);

  if (providedKey !== expectedKey) {
    context.res = json(403, { error: "Invalid runner key" });
    return;
  }

  const { scheduleId } = req.body || {};
  if (!scheduleId) {
    context.res = json(400, { error: "scheduleId is required" });
    return;
  }

  context.log(`Template runner triggered for schedule ${scheduleId}`);

  try {
    // 1. Load the schedule
    const schedule = await scheduleStore.getById(scheduleId);
    if (!schedule) {
      context.res = json(404, { error: "Schedule not found" });
      return;
    }
    if (!schedule.enabled) {
      context.res = json(200, { message: "Schedule is disabled", ran: false });
      return;
    }

    const { templateId, orgId, mode } = schedule;

    // 2. Load the template
    const template = await templateStore.getById(orgId, templateId);
    if (!template) {
      await scheduleStore.updateRunStatus(scheduleId, "error", "Template not found");
      context.res = json(404, { error: "Template not found" });
      return;
    }

    // 3. Find the customer and get a Genesys token
    const customer = customers.find((c) => c.id === orgId);
    if (!customer) {
      await scheduleStore.updateRunStatus(scheduleId, "error", "Unknown customer org");
      context.res = json(400, { error: `Unknown customer org: ${orgId}` });
      return;
    }

    const envKey = `GENESYS_${orgId.replace(/-/g, "_").toUpperCase()}`;
    const clientId = process.env[`${envKey}_CLIENT_ID`];
    const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) {
      await scheduleStore.updateRunStatus(scheduleId, "error", "Genesys credentials not configured");
      context.res = json(500, { error: `Credentials not configured for ${orgId}` });
      return;
    }

    const token = await getGenesysToken(orgId, customer.region, clientId, clientSecret);
    const baseUrl = `https://api.${customer.region}`;

    // 4. Resolve targets from the schedule
    const targets = Array.isArray(schedule.targets) ? schedule.targets : [];
    if (!targets.length) {
      await scheduleStore.updateRunStatus(scheduleId, "success", null);
      context.res = json(200, { message: "No targets in schedule", ran: true, users: 0 });
      return;
    }

    const userIds = new Set();
    const errors = [];

    // Direct user targets
    for (const t of targets.filter((t) => t.type === "user")) {
      if (t.id) userIds.add(t.id);
    }

    // Group targets — resolve members
    for (const t of targets.filter((t) => t.type === "group")) {
      try {
        const members = await fetchGroupMembers(baseUrl, token, t.id);
        for (const m of members) userIds.add(m.id);
      } catch (err) {
        errors.push(`Failed to resolve group ${t.name || t.id}: ${err.message}`);
      }
    }

    // Work team targets — resolve members
    for (const t of targets.filter((t) => t.type === "workteam")) {
      try {
        const members = await fetchTeamMembers(baseUrl, token, t.id);
        for (const m of members) userIds.add(m.id);
      } catch (err) {
        errors.push(`Failed to resolve work team ${t.name || t.id}: ${err.message}`);
      }
    }

    if (!userIds.size && errors.length) {
      const errMsg = errors.join("; ");
      await scheduleStore.updateRunStatus(scheduleId, "error", errMsg);
      context.res = json(500, { error: errMsg });
      return;
    }

    context.log(`Processing ${userIds.size} users in ${mode} mode for template "${template.name}"`);

    // 5. Execute per user
    let successCount = 0;
    for (const userId of userIds) {
      try {
        if (mode === "reset") {
          await resetUser(baseUrl, token, userId, template, context);
        } else {
          await addToUser(baseUrl, token, userId, template, context);
        }
        successCount++;
      } catch (err) {
        errors.push(`User ${userId}: ${err.message}`);
      }
    }

    // 6. Update run status
    const status = errors.length ? (successCount > 0 ? "partial" : "error") : "success";
    const errorMsg = errors.length ? errors.join("; ") : null;
    await scheduleStore.updateRunStatus(scheduleId, status, errorMsg);

    context.log(`Template runner complete: ${successCount}/${userIds.size} users, ${errors.length} errors`);
    context.res = json(200, {
      message: "Runner complete",
      ran: true,
      total: userIds.size,
      success: successCount,
      errors: errors.length,
      errorDetails: errors.slice(0, 20),
    });
  } catch (err) {
    context.log.error("Template runner error:", err);
    try { await scheduleStore.updateRunStatus(scheduleId, "error", err.message); } catch (_) {}
    context.res = json(500, { error: err.message || "Internal server error" });
  }
};

// ── Helper: JSON response ───────────────────────────────
function json(status, body) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body,
  };
}

// ── Genesys API helpers (direct, server-side) ───────────

async function genesysCall(baseUrl, token, method, path, body) {
  const url = `${baseUrl}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 204) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Genesys ${method} ${path} → ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function fetchAllPages(baseUrl, token, path, pageSize = 100) {
  const results = [];
  let pageNumber = 1;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const resp = await genesysCall(baseUrl, token, "GET",
      `${path}${sep}pageSize=${pageSize}&pageNumber=${pageNumber}`);
    const entities = resp.entities || resp.results || [];
    results.push(...entities);
    if (!resp.nextUri || entities.length < pageSize) break;
    pageNumber++;
  }
  return results;
}

async function fetchGroupMembers(baseUrl, token, groupId) {
  return fetchAllPages(baseUrl, token, `/api/v2/groups/${groupId}/members`);
}

async function fetchTeamMembers(baseUrl, token, teamId) {
  // Work teams use POST for member queries
  const results = [];
  let after = "";
  while (true) {
    const body = { pageSize: 100 };
    if (after) body.after = after;
    const resp = await genesysCall(baseUrl, token, "POST",
      `/api/v2/teams/${teamId}/members/query`, body);
    const members = resp.results || resp.entities || [];
    results.push(...members);
    if (!resp.nextUri && !resp.cursor || members.length < 100) break;
    after = resp.cursor || "";
    if (!after) break;
  }
  return results;
}

// ── Reset mode ──────────────────────────────────────────
// Remove ALL skills, languages, queue memberships, then re-apply template.
// Roles are NOT touched.

async function resetUser(baseUrl, token, userId, template, context) {
  // 1. Get current skills and remove all
  try {
    const skills = await fetchAllPages(baseUrl, token,
      `/api/v2/users/${userId}/routingskills`);
    for (const s of skills) {
      await genesysCall(baseUrl, token, "DELETE",
        `/api/v2/users/${userId}/routingskills/${s.id}`);
    }
  } catch (err) {
    context.log.warn(`Failed to clear skills for ${userId}: ${err.message}`);
  }

  // 2. Get current languages and remove all
  try {
    const langs = await fetchAllPages(baseUrl, token,
      `/api/v2/users/${userId}/routinglanguages`);
    for (const l of langs) {
      await genesysCall(baseUrl, token, "DELETE",
        `/api/v2/users/${userId}/routinglanguages/${l.id}`);
    }
  } catch (err) {
    context.log.warn(`Failed to clear languages for ${userId}: ${err.message}`);
  }

  // 3. Get current queue memberships and remove all
  try {
    const queues = await fetchAllPages(baseUrl, token,
      `/api/v2/users/${userId}/queues`);
    for (const q of queues) {
      await genesysCall(baseUrl, token, "DELETE",
        `/api/v2/routing/queues/${q.id}/members/${userId}`);
    }
  } catch (err) {
    context.log.warn(`Failed to clear queues for ${userId}: ${err.message}`);
  }

  // 4. Re-apply template properties
  await addToUser(baseUrl, token, userId, template, context);
}

// ── Add mode ────────────────────────────────────────────
// Additively apply template skills, languages, and queues.
// Roles are NOT touched.

async function addToUser(baseUrl, token, userId, template, context) {
  // Skills (bulk PATCH — additive)
  if (template.skills?.length) {
    const skills = template.skills.map((s) => ({
      id: s.skillId,
      proficiency: s.proficiency || 0,
    }));
    await genesysCall(baseUrl, token, "PATCH",
      `/api/v2/users/${userId}/routingskills/bulk`, skills);
  }

  // Languages (bulk PATCH — additive)
  if (template.languages?.length) {
    const langs = template.languages.map((l) => ({
      id: l.languageId,
      proficiency: l.proficiency || 0,
    }));
    await genesysCall(baseUrl, token, "PATCH",
      `/api/v2/users/${userId}/routinglanguages/bulk`, langs);
  }

  // Queues (add member — one per queue)
  for (const q of template.queues || []) {
    await genesysCall(baseUrl, token, "POST",
      `/api/v2/routing/queues/${q.queueId}/members`,
      [{ id: userId }]);
  }
}
