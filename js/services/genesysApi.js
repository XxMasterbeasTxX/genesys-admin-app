/**
 * Genesys Cloud API service layer.
 *
 * Centralises all Genesys API call patterns so page modules never
 * need to know raw endpoint paths or pagination mechanics.
 *
 * Every function takes `api` (the apiClient) and `orgId` as the
 * first two arguments, keeping the module stateless.
 *
 * Usage in a page:
 *   import * as gc from "../../services/genesysApi.js";
 *   const users = await gc.fetchAllPages(api, orgId, "/api/v2/users");
 *   const convs = await gc.searchConversations(api, orgId, { ... });
 */
import { sleep } from "../utils.js";
import { inlineActionTemplates, templateTextOf } from "../lib/dataActions.js";

// ─────────────────────────────────────────────────────────────────────
// Generic pagination helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all pages of a paginated Genesys endpoint (pageNumber style).
 *
 * Most Genesys list endpoints return:
 *   { entities: [...], pageCount, pageNumber, pageSize, total }
 *
 * @param {Object}   api          apiClient instance.
 * @param {string}   orgId        Customer org id.
 * @param {string}   path         API path, e.g. "/api/v2/users".
 * @param {Object}   [opts]
 * @param {Object}   [opts.query]        Extra query params (merged with pageNumber/pageSize).
 * @param {number}   [opts.pageSize=100] Items per page.
 * @param {string}   [opts.entitiesKey="entities"] Key containing the array in each response.
 * @param {Function} [opts.onProgress]   Called with (fetchedSoFar, totalEstimate).
 * @returns {Promise<Object[]>}  All entities concatenated.
 */
export async function fetchAllPages(api, orgId, path, opts = {}) {
  const {
    query: extraQuery = {},
    pageSize = 100,
    entitiesKey = "entities",
    onProgress,
    shouldStop,
  } = opts;

  let page = 1;
  let all = [];
  let total = null;

  while (true) {
    const query = { ...extraQuery, pageSize: String(pageSize), pageNumber: String(page) };
    const resp = await api.proxyGenesys(orgId, "GET", path, { query });

    const items = resp[entitiesKey] || [];
    all = all.concat(items);

    if (total === null) total = resp.total ?? null;
    if (onProgress) onProgress(all.length, total);

    // No more pages?
    if (items.length < pageSize || page >= (resp.pageCount ?? page)) break;

    // Cancelled between pages. Callers that hand in `shouldStop` get a real
    // stop rather than a cosmetic one: previously Cancel only set a flag that
    // was read after the whole walk had finished, so a big org kept paging
    // long after the user had given up on it. Returns what arrived so far.
    if (shouldStop && shouldStop()) break;

    page++;
  }

  return all;
}

/**
 * Fetch all results from a cursor-paginated Genesys endpoint.
 *
 * @param {Object}   api           apiClient instance.
 * @param {string}   orgId         Customer org id.
 * @param {string}   path          API path.
 * @param {Object}   [opts]
 * @param {Object}   [opts.query]        Extra query params.
 * @param {string}   [opts.itemsKey]     Key containing the array (auto-detected if omitted).
 * @param {Function} [opts.onProgress]   Called with (fetchedSoFar).
 * @returns {Promise<Object[]>}  All items concatenated.
 */
export async function fetchAllCursor(api, orgId, path, opts = {}) {
  const { query: extraQuery = {}, itemsKey, onProgress } = opts;

  let all = [];
  let cursor = null;

  while (true) {
    const query = { ...extraQuery };
    if (cursor) query.cursor = cursor;

    const resp = await api.proxyGenesys(orgId, "GET", path, { query });

    // Auto-detect the array key (e.g. "conversations", "entities", "results")
    const key = itemsKey || Object.keys(resp).find((k) => Array.isArray(resp[k])) || "entities";
    const items = resp[key] || [];
    all = all.concat(items);

    if (onProgress) onProgress(all.length);

    cursor = resp.cursor || null;
    if (!cursor) break;
  }

  return all;
}

// ─────────────────────────────────────────────────────────────────────
// Analytics — Conversation search (async jobs API)
// ─────────────────────────────────────────────────────────────────────

/**
 * Submit an async analytics conversation details job.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {string} interval  ISO 8601 interval, e.g. "2026-02-20T00:00:00Z/2026-02-27T23:59:59Z".
 * @param {Object} [body]    Additional job body fields (filters, etc.).
 * @returns {Promise<string>} jobId
 */
export async function submitAnalyticsJob(api, orgId, interval, body = {}) {
  const resp = await api.proxyGenesys(orgId, "POST",
    "/api/v2/analytics/conversations/details/jobs",
    { body: { interval, ...body } }
  );
  if (!resp.jobId) {
    const detail = resp.error || resp.message || JSON.stringify(resp);
    throw new Error(`Analytics job submission failed: ${detail}`);
  }
  return resp.jobId;
}

/**
 * Poll an analytics job until it reaches FULFILLED (or FAILED/timeout).
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {string}   jobId
 * @param {Object}   [opts]
 * @param {number}   [opts.pollIntervalMs=2000]
 * @param {number}   [opts.maxWaitSeconds=300]
 * @param {Function} [opts.onPoll]  Called each poll with (elapsedSeconds).
 * @returns {Promise<void>}  Resolves when FULFILLED.
 */
export async function pollAnalyticsJob(api, orgId, jobId, opts = {}) {
  const {
    pollIntervalMs = 2000,
    maxWaitSeconds = 300,
    onPoll,
  } = opts;

  const start = Date.now();

  while (true) {
    await sleep(pollIntervalMs);
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed > maxWaitSeconds) {
      throw new Error(`Analytics job timed out after ${maxWaitSeconds}s`);
    }

    const resp = await api.proxyGenesys(orgId, "GET",
      `/api/v2/analytics/conversations/details/jobs/${jobId}`);

    if (onPoll) onPoll(elapsed);

    if (resp.state === "FULFILLED") return;
    if (resp.state === "FAILED") {
      throw new Error(`Analytics job failed: ${resp.errorMessage || "Unknown error"}`);
    }
  }
}

/**
 * Fetch all results from a completed analytics job (cursor pagination).
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {string}   jobId
 * @param {Object}   [opts]
 * @param {Function} [opts.onProgress]  Called with (fetchedSoFar).
 * @returns {Promise<Object[]>}  All conversation objects.
 */
export async function fetchAnalyticsJobResults(api, orgId, jobId, opts = {}) {
  return fetchAllCursor(api, orgId,
    `/api/v2/analytics/conversations/details/jobs/${jobId}/results`,
    { query: { pageSize: "2000" }, itemsKey: "conversations", ...opts }
  );
}

/**
 * High-level: search conversations by date interval.
 *
 * Submits an async job, polls until complete, fetches all results.
 * Uses the async jobs API because it's the only path that returns
 * participant attributes (the sync query returns WithoutAttributes).
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {Object}   opts
 * @param {string}   opts.interval       ISO 8601 interval.
 * @param {Object}   [opts.jobBody]      Extra job body fields.
 * @param {Function} [opts.onStatus]     Called with (statusMessage).
 * @param {Function} [opts.onProgress]   Called with (progressPercent 0–100).
 * @returns {Promise<Object[]>}  All conversations.
 */
export async function searchConversations(api, orgId, opts = {}) {
  const { interval, jobBody, onStatus, onProgress } = opts;

  if (onStatus) onStatus("Submitting analytics job…");
  if (onProgress) onProgress(5);

  const jobId = await submitAnalyticsJob(api, orgId, interval, jobBody);

  if (onStatus) onStatus("Waiting for job to complete…");
  await pollAnalyticsJob(api, orgId, jobId, {
    onPoll: (elapsed) => {
      if (onProgress) onProgress(10 + Math.min(elapsed / 300 * 40, 40));
    },
  });

  if (onStatus) onStatus("Fetching results…");
  const conversations = await fetchAnalyticsJobResults(api, orgId, jobId, {
    onProgress: (n) => {
      if (onStatus) onStatus(`Fetching results… (${n} so far)`);
      if (onProgress) onProgress(50 + Math.min(n % 500 / 10, 45));
    },
  });

  if (onProgress) onProgress(100);
  return conversations;
}



// ─────────────────────────────────────────────────────────────────────
// Conversations — Actions
// ─────────────────────────────────────────────────────────────────────

/**
 * Force-disconnect a single conversation.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {string} conversationId
 * @returns {Promise<Object|null>}
 */
export async function disconnectConversation(api, orgId, conversationId) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/conversations/${conversationId}/disconnect`);
}

/**
 * Run the synchronous analytics conversation details query.
 *
 * This is different from the async jobs API — it returns results
 * immediately but with a 31-day limit and no participant attributes.
 * Good for finding currently-active conversations in a queue.
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {Object}   body           Full query body.
 * @param {Object}   [opts]
 * @param {number}   [opts.maxPages=10]  Max pages to fetch. `Infinity` pages the
 *   whole result set; pair it with `shouldStop` so there is a way out.
 * @param {Function} [opts.onProgress]   Called with (fetchedSoFar).
 * @param {Function} [opts.shouldStop]   Checked between pages; truthy stops the
 *   paging early. Returns what was fetched so far, so a caller that stops has
 *   a partial result and must treat it as one.
 * @returns {Promise<Object[]>}  All conversation objects.
 */
export async function queryConversationDetails(api, orgId, body, opts = {}) {
  const { maxPages = 10, onProgress, shouldStop } = opts;
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    const pageBody = {
      ...body,
      paging: { ...(body.paging || {}), pageSize: 100, pageNumber: page },
    };

    const resp = await api.proxyGenesys(orgId, "POST",
      "/api/v2/analytics/conversations/details/query",
      { body: pageBody });

    const convs = resp.conversations || [];
    all.push(...convs);
    if (onProgress) onProgress(all.length);

    if (convs.length < 100) break;

    // A caller paging without a page limit needs a way out that does not
    // involve waiting for the end. Checked after the short-page break so a
    // finished query is never reported as stopped.
    if (shouldStop?.()) break;
  }

  return all;
}

/**
 * A queue's live state: how deep it is, whether anything is being handled, and
 * how long the oldest has waited.
 *
 * Stats only — no `detailMetrics`. The detail list is capped at 100 and cannot
 * be paged or sliced (the query takes only `queueId` and `mediaType`), so it
 * can never enumerate a large queue. Enumeration is analytics' job; this call
 * supplies the numbers analytics cannot give: what the queue holds *right now*.
 *
 * `interacting` is the signal that decides whether the live-agent guard applies
 * at all. When it is 0, nothing in the queue is live, so an unclosed `interact`
 * segment on a candidate is stale rather than active — which is the case that
 * made a blanket guard skip orphans (`549dbc3`).
 *
 * `oldestMs` is derived from `oLongestWaiting`, which Genesys reports as an
 * epoch timestamp rather than an elapsed time — read as a duration the live
 * value came to 56 years, which is what gave it away. The threshold at 1e12
 * distinguishes the two rather than trusting one reading for ever: that is
 * either a timestamp in 2001 or a wait of 31 years, and only one is plausible.
 *
 * Each field is `null` when it cannot be read — a missing
 * `analytics:queueObservation:view` being the likely reason — so a caller can
 * tell "none" from "could not tell". A count silently reading 0 beside a
 * non-zero result reads as a fault.
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {string}   queueId
 * @param {string[]} mediaTypes  Lowercase analytics media types (voice, email…).
 * @returns {Promise<{waiting: number|null, interacting: number|null, oldestMs: number|null}>}
 */
export async function getQueueStats(api, orgId, queueId, mediaTypes = []) {
  const clauses = [{ type: "or", predicates: [{ dimension: "queueId", value: queueId }] }];
  if (mediaTypes.length) {
    clauses.push({
      type: "or",
      predicates: mediaTypes.map(t => ({ dimension: "mediaType", value: t })),
    });
  }

  const resp = await api.proxyGenesys(orgId, "POST",
    "/api/v2/analytics/queues/observations/query",
    { body: { filter: { type: "and", clauses },
              metrics: ["oWaiting", "oInteracting", "oLongestWaiting"] } });

  const results = resp?.results;
  if (!Array.isArray(results)) return { waiting: null, interacting: null, oldestMs: null };

  let waiting = 0;
  let interacting = 0;
  let oldestMs = null;

  // One group per media type, so counts sum and the oldest is the oldest of them.
  for (const r of results) {
    for (const d of (r.data || [])) {
      const count = typeof d.stats?.count === "number" ? d.stats.count : 0;
      if (d.metric === "oWaiting")          waiting += count;
      else if (d.metric === "oInteracting") interacting += count;
      else if (d.metric === "oLongestWaiting") {
        const v = d.stats?.calculatedMetricValue;
        if (typeof v === "number" && v > 0) {
          const ms = v > 1e12 ? Date.now() - v : v;
          if (ms >= 0) oldestMs = oldestMs === null ? ms : Math.max(oldestMs, ms);
        }
      }
    }
  }

  return { waiting, interacting, oldestMs };
}

/**
 * How many conversations a query would return, without returning them.
 *
 * The details/query response carries `totalHits`, so one request with a page
 * size of 1 answers "is there anything here" for the price of a single row.
 * Used to decide whether an interval is worth the submit-poll-fetch cycle of an
 * async job: an empty month then costs one small request instead of a job.
 *
 * Returns `null` when the response carries no usable `totalHits`, so a caller
 * can tell "none" from "could not tell" and scan rather than skip.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {Object} body   Query body; `paging` is supplied here.
 * @returns {Promise<number|null>}
 */
export async function countConversationDetails(api, orgId, body) {
  const resp = await api.proxyGenesys(orgId, "POST",
    "/api/v2/analytics/conversations/details/query",
    { body: { ...body, paging: { pageSize: 1, pageNumber: 1 } } });
  return typeof resp?.totalHits === "number" ? resp.totalHits : null;
}

/**
 * Get a single conversation's full details (participants, media, state).
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {string} conversationId
 * @returns {Promise<Object>}  Full conversation object.
 */
export async function getConversation(api, orgId, conversationId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/conversations/${conversationId}`);
}

/**
 * Get one conversation in the *analytics* shape — participants with sessions
 * and segments.
 *
 * Use this when a page needs a field the live conversation object does not
 * carry. The email sender and recipient are the case that brought it in:
 * `AnalyticsSession.addressFrom` / `addressTo` exist only here, while
 * `GET /conversations/{id}` offers `Participant.address`, which is documented
 * as the ANI for a phone call and carries no from/to pair for email.
 *
 * Requires `analytics:conversationDetail:view` (or the agent-scoped variant),
 * which is a wider permission than `conversation:communication:view`. Recently
 * created conversations may 404 until analytics has ingested them.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {string} conversationId
 * @returns {Promise<Object>}  AnalyticsConversationWithoutAttributes.
 */
export async function getConversationAnalytics(api, orgId, conversationId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/analytics/conversations/${conversationId}/details`);
}

/**
 * Blind-transfer (replace) a participant to a different queue.
 *
 * Uses POST /api/v2/conversations/{id}/participants/{pid}/replace
 * with TransferToQueueRequest body.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {string} conversationId
 * @param {string} participantId
 * @param {string} destQueueId
 * @returns {Promise<Object|null>}
 */
export async function replaceParticipantQueue(api, orgId, conversationId, participantId, destQueueId) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/conversations/${conversationId}/participants/${participantId}/replace`,
    { body: { queueId: destQueueId } });
}

// ─────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all users (with optional expand fields).
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {Object}   [opts]
 * @param {string[]} [opts.expand]  e.g. ["authorization","dateLastLogin"]
 * @param {string}   [opts.state]   e.g. "any" (default: active only)
 * @param {Function} [opts.onProgress]
 * @returns {Promise<Object[]>}
 */
export async function fetchAllUsers(api, orgId, opts = {}) {
  const { expand = [], state, onProgress, shouldStop, pageSize } = opts;
  const query = {};
  if (expand.length) query.expand = expand.join(",");
  if (state) query.state = state;
  // `pageSize` matters once `expand` is heavy. `authorization` carries a user's
  // whole effective permission set, so 100 admins per page is megabytes and can
  // outrun the Function's request budget — pass a smaller page for those calls.
  return fetchAllPages(api, orgId, "/api/v2/users", { query, onProgress, shouldStop, pageSize });
}

/** Create a new user. Minimum body: { name, email }. */
export async function createUser(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/users", { body });
}

/** Partial-update a user (name, addresses, etc.). version is required. */
export async function patchUser(api, orgId, userId, body) {
  return api.proxyGenesys(orgId, "PATCH", `/api/v2/users/${userId}`, { body });
}

/** Update a user's division. Requires fresh version from GET. divisionObj = { id, name, selfUri }. */
export async function updateUserDivision(api, orgId, userId, divisionObj, version) {
  return api.proxyGenesys(orgId, "PATCH", `/api/v2/users/${userId}`, {
    body: { version, division: divisionObj },
  });
}

/**
 * Grant roles to a user (additive — does not remove existing roles).
 * roles = [{ roleId, divisionId }]
 */
/**
 * Grant roles to a user (additive). roles = [{ roleId, divisionId }]
 * Calls POST /api/v2/authorization/roles/{roleId} once per role.
 */
export async function grantUserRoles(api, orgId, userId, roles) {
  for (const { roleId, divisionId } of roles) {
    const body = {
      subjectIds: [userId],
    };
    // Avoid sending an invalid synthetic scope id when no division is supplied.
    if (divisionId) {
      body.divisionIds = [divisionId];
    }

    await api.proxyGenesys(orgId, "POST", `/api/v2/authorization/roles/${roleId}`, {
      query: { subjectType: "PC_USER" },
      body,
    });
  }
}

/**
 * Add or update routing skills for a user (additive bulk patch).
 * skills = [{ id, proficiency }]
 */
export async function addUserRoutingSkillsBulk(api, orgId, userId, skills) {
  return api.proxyGenesys(orgId, "PATCH", `/api/v2/users/${userId}/routingskills/bulk`, { body: skills });
}

/**
 * Add or update routing languages for a user (additive bulk patch).
 * languages = [{ id, proficiency }]
 */
export async function addUserRoutingLanguagesBulk(api, orgId, userId, languages) {
  return api.proxyGenesys(orgId, "PATCH", `/api/v2/users/${userId}/routinglanguages/bulk`, { body: languages });
}

/**
 * Remove a role grant from a user (all divisions for that role).
 * Fetches user's grants, then removes each matching role+division.
 */
export async function deleteUserRole(api, orgId, userId, roleId) {
  const grants = await getUserGrants(api, orgId, userId);
  const matching = grants.filter((g) => g.roleId === roleId);
  if (!matching.length) return;

  for (const g of matching) {
    await deleteUserRoleGrant(api, orgId, userId, g.roleId, g.divisionId);
  }
}

/**
 * Remove a single role+division grant from a user.
 * Calls DELETE /api/v2/authorization/subjects/{subjectId}/divisions/{divisionId}/roles/{roleId}
 */
export async function deleteUserRoleGrant(api, orgId, userId, roleId, divisionId) {
  return api.proxyGenesys(orgId, "DELETE",
    `/api/v2/authorization/subjects/${userId}/divisions/${divisionId}/roles/${roleId}`);
}

/**
 * Remove a routing skill from a user.
 * Calls DELETE /api/v2/users/{userId}/routingskills/{skillId}
 */
export async function deleteUserSkill(api, orgId, userId, skillId) {
  return api.proxyGenesys(orgId, "DELETE",
    `/api/v2/users/${userId}/routingskills/${skillId}`);
}

/**
 * Remove a routing language from a user.
 * Calls DELETE /api/v2/users/{userId}/routinglanguages/{languageId}
 */
export async function deleteUserLanguage(api, orgId, userId, languageId) {
  return api.proxyGenesys(orgId, "DELETE",
    `/api/v2/users/${userId}/routinglanguages/${languageId}`);
}

/**
 * Remove a user from a queue.
 * Calls DELETE /api/v2/routing/queues/{queueId}/members with body [{ id }].
 */
export async function removeQueueMember(api, orgId, queueId, userId) {
  return api.proxyGenesys(orgId, "DELETE",
    `/api/v2/routing/queues/${queueId}/members/${userId}`);
}

/**
 * Fetch role grants for a user (all roles and divisions).
 * Returns { roles: [{ roleId, roleName, divisionId, divisionName }] }
 */
export async function getUserGrants(api, orgId, userId) {
  const resp = await api.proxyGenesys(orgId, "GET",
    `/api/v2/authorization/subjects/${userId}`);
  const grants = [];
  for (const g of (resp.grants || [])) {
    const roleId = g.role?.id;
    const roleName = g.role?.name || "";
    const divisionId = g.division?.id || "";
    const divisionName = g.division?.name || "";
    if (roleId) grants.push({ roleId, roleName, divisionId, divisionName });
  }
  return grants;
}

/**
 * Fetch queue memberships for a user.
 * Returns array of { queueId, queueName }.
 */
export async function getUserQueues(api, orgId, userId) {
  const queues = await fetchAllPages(api, orgId,
    `/api/v2/users/${userId}/queues`, { query: { pageSize: "100" } });
  return queues.map((q) => ({ queueId: q.id, queueName: q.name }));
}

// ─────────────────────────────────────────────────────────────────────
// Direct Routing — Backup settings
// ─────────────────────────────────────────────────────────────────────

/**
 * Get agent-level direct routing backup settings.
 *
 * Returns a tagged result rather than a bare value, because "there is no
 * backup" and "you are not allowed to look" are different answers and the
 * caller has to render them differently. The previous version swallowed every
 * failure into `null`, so an admin missing `routing:directRoutingBackup:view`
 * was shown an empty form that would then overwrite whatever was really set.
 *
 *   { state: "ok",     settings }  — a backup is configured
 *   { state: "none",   settings: null }  — confirmed: none configured
 *   { state: "denied", settings: null }  — Genesys refused the read
 *
 * Anything else throws. A swallowed 500 is how the original defect started.
 *
 * @returns {Promise<{ state: "ok"|"none"|"denied", settings: Object|null }>}
 */
export async function getDirectRoutingBackup(api, orgId, userId) {
  try {
    const settings = await api.proxyGenesys(orgId, "GET",
      `/api/v2/routing/users/${userId}/directroutingbackup/settings`);
    return { state: "ok", settings };
  } catch (err) {
    // Verified against a live org: a missing backup is 404 + resource.not.found.
    if (err.status === 404 && err.body?.code === "resource.not.found") {
      return { state: "none", settings: null };
    }
    // `code` is the discriminator, not the status. The proxy raises 403s of its
    // own for app-level gates (org_locked, entitlement guards) and those carry
    // `error`, not `code` — they are real failures and must not be reported to
    // the user as "you lack a Genesys permission".
    if (err.status === 403 && err.body?.code) {
      return { state: "denied", settings: null };
    }
    throw err;
  }
}

/**
 * Set agent-level direct routing backup settings.
 *
 * The body is built here from the four writable fields, never spread from the
 * object that was read: `backedUpUsers` comes back on the GET and is readOnly.
 * `userId` and `queueId` are omitted when empty rather than sent as null —
 * the API has no null sentinel, and a PUT *replaces*, so omitting is how a
 * side is cleared. Setting both is legal: user is the primary backup, queue
 * the secondary.
 *
 * @param {Object} settings
 * @param {string} [settings.userId]            Backup user (primary).
 * @param {string} [settings.queueId]           Backup queue (secondary).
 * @param {boolean} settings.waitForAgent
 * @param {number} settings.agentWaitSeconds    Genesys accepts [60, 864000].
 */
export async function putDirectRoutingBackup(api, orgId, userId, settings = {}) {
  const body = {
    waitForAgent: !!settings.waitForAgent,
    agentWaitSeconds: settings.agentWaitSeconds,
  };
  if (settings.userId)  body.userId  = settings.userId;
  if (settings.queueId) body.queueId = settings.queueId;

  return api.proxyGenesys(orgId, "PUT",
    `/api/v2/routing/users/${userId}/directroutingbackup/settings`, { body });
}

/** Remove agent-level direct routing backup settings. */
export async function deleteDirectRoutingBackup(api, orgId, userId) {
  return api.proxyGenesys(orgId, "DELETE",
    `/api/v2/routing/users/${userId}/directroutingbackup/settings`);
}

/**
 * Fetch all inbound email domains.
 *
 * Paged, deliberately: the endpoint defaults to pageSize 25, and the caller
 * that used to hit it directly took only that first page — so an org with more
 * domains than that reported the rest as "not configured".
 *
 * Requires `routing:email:manage`, which is not implied by the permissions the
 * pages using this hold. Callers must treat a failure as "could not check",
 * never as "the domain is absent".
 */
export async function fetchAllEmailDomains(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/email/domains", opts);
}

// ─────────────────────────────────────────────────────────────────────
// Routing — Queues, Skills, Wrapup codes
// ─────────────────────────────────────────────────────────────────────

/** Fetch all routing queues. */
export async function fetchAllQueues(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/queues", opts);
}

/** Update a queue's division. version is required by Genesys to prevent silent no-ops. */
export async function updateQueueDivision(api, orgId, queueId, divisionId, version) {
  return api.proxyGenesys(orgId, "PATCH", `/api/v2/routing/queues/${queueId}`, {
    body: { version, division: { id: divisionId } },
  });
}

/** Fetch a single queue by ID (full object). */
export async function getQueue(api, orgId, queueId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/routing/queues/${queueId}`);
}

/**
 * Add members to a queue in batches of 100.
 * members: [{ id, ringNumber? }]
 */
export async function addQueueMembers(api, orgId, queueId, members) {
  const BATCH = 100;
  for (let i = 0; i < members.length; i += BATCH) {
    await api.proxyGenesys(orgId, "POST", `/api/v2/routing/queues/${queueId}/members`, {
      body: members.slice(i, i + BATCH),
    });
  }
}

/** Full PUT update of a queue (required to change division). */
export async function putQueue(api, orgId, queueId, body) {
  return api.proxyGenesys(orgId, "PUT", `/api/v2/routing/queues/${queueId}`, { body });
}

/**
 * Move one or more objects to a division using the batch authorization endpoint.
 * objects: [{ id, type }] where type is e.g. "QUEUE", "DATATABLES", "USER".
 * Batches into groups of 100 automatically.
 */
/**
 * Move objects to a division.
 * objectType: "USER", "QUEUE", "DATATABLES", "FLOW", etc. — goes in the URL path.
 * ids: array of object ID strings.
 */
/**
 * Move objects into a division in bulk.
 *
 * `objectType` must be one of the values this endpoint accepts. The list below
 * is the API's own, returned verbatim in the 400 body when an unknown value is
 * sent — it is not published in the API docs or the SDKs, and it is not
 * derivable from the endpoint paths (note EMERGENCYGROUPS and ROUTINGSCHEDULES
 * plural against QUEUE and FLOW singular):
 *
 *   QUEUE, CAMPAIGN, CONTACTLIST, DNCLIST, EMAILCAMPAIGN, MESSAGINGCAMPAIGN,
 *   MANAGEMENTUNIT, BUSINESSUNIT, FLOW, FLOWMILESTONE, FLOWOUTCOME, USER,
 *   CALLROUTE, EMERGENCYGROUPS, ROUTINGSCHEDULES, ROUTINGSCHEDULEGROUPS,
 *   DATATABLES, TEAM, WORKBIN, WORKTYPE, EXTENSIONPOOL, SKILLGROUP, SCRIPT,
 *   LIBRARY
 *
 * Being division-aware in Genesys does NOT put an object type on that list.
 * Skills and wrap-up codes both carry a division and neither is accepted here;
 * they are moved one at a time by writing the division onto the object itself.
 * Re-check the 400 body before assuming a new type is unsupported.
 */
export async function moveToDivision(api, orgId, divisionId, objectType, ids) {
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    await api.proxyGenesys(orgId, "POST",
      `/api/v2/authorization/divisions/${divisionId}/objects/${objectType}`,
      { body: ids.slice(i, i + BATCH) });
  }
}

/** Fetch all routing skills. */
export async function fetchAllSkills(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/skills", opts);
}

/** Create a routing skill. Body: { name }. */
export async function createSkill(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/routing/skills", { body });
}

/**
 * Reassign a skill's division (patchRoutingSkill, `routing:skill:update`).
 * Skills are not accepted by the bulk division endpoint — see moveToDivision.
 *
 * The body is UpdateSkillDivisionRequest: a flat `{ divisionId }` string, NOT
 * the `{ division: { id } }` shape every other object in this file uses. The
 * endpoint answers 200 and silently ignores properties outside that schema, so
 * the wrong shape here looks exactly like a successful move. Returns the
 * updated RoutingSkill, which carries `division` — check it.
 */
export async function updateSkillDivision(api, orgId, skillId, divisionId) {
  return api.proxyGenesys(orgId, "PATCH", `/api/v2/routing/skills/${skillId}`, {
    body: { divisionId },
  });
}

/** Fetch a single routing skill. */
export async function fetchSkill(api, orgId, skillId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/routing/skills/${skillId}`);
}

/** Fetch all routing languages. */
export async function fetchAllLanguages(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/languages", opts);
}

/** Create a routing language. Body: { name }. */
export async function createLanguage(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/routing/languages", { body });
}

/** Create a routing queue. */
export async function createQueue(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/routing/queues", { body });
}

/** Fetch all wrapup codes. */
export async function fetchAllWrapupCodes(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/wrapupcodes", opts);
}

/** Create a wrap-up code. */
export async function createWrapupCode(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/routing/wrapupcodes", { body });
}

/** Update a wrap-up code. */
export async function putWrapupCode(api, orgId, codeId, body) {
  return api.proxyGenesys(orgId, "PUT", `/api/v2/routing/wrapupcodes/${codeId}`, { body });
}

/** Assign wrap-up codes to a queue (body = array of {id}). */
export async function addWrapupCodesToQueue(api, orgId, queueId, codes) {
  return api.proxyGenesys(orgId, "POST", `/api/v2/routing/queues/${queueId}/wrapupcodes`, { body: codes });
}

// ─────────────────────────────────────────────────────────────────────
// Architect — Flows, Schedules, DataTables
// ─────────────────────────────────────────────────────────────────────

/** Fetch all flows. */
export async function fetchAllFlows(api, orgId, opts = {}) {
  const query = { deleted: "false", ...(opts.query || {}) };
  return fetchAllPages(api, orgId, "/api/v2/flows", { ...opts, query });
}

// ─────────────────────────────────────────────────────────────────────
// Architect — Dependency Tracking
//
// The index behind "what does this flow use" and "what uses this object".
// Consumed by Flows › Delete Flow (see docs/flow-deletion-design.md).
//
// The index is built ASYNCHRONOUSLY by Genesys. A stale or in-progress build
// returns answers that look authoritative and are not, so callers must check
// the build status before trusting anything here.
//
// Response shapes are normalised defensively: this repo has not previously
// called these endpoints, and every caller acts on the result irreversibly.
// Reading a field that turns out to be named differently must degrade to
// "unknown", never to a confident empty list — see normalizeDependency().
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalise one dependency-tracking entry to a stable shape.
 *
 * Returns null for an entry with no usable identity, so a response shaped
 * differently than expected yields fewer entries rather than a list of blanks
 * that would read as "nothing depends on this".
 */
function normalizeDependency(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id || raw.objectId || "";
  const name = raw.name || raw.objectName || "";
  if (!id && !name) return null;
  return {
    id,
    name: name || id,
    // Genesys spells this `type` on some resources and `objectType` on others.
    type: String(raw.type || raw.objectType || "").toUpperCase(),
    // Present on flow-ish resources; used to spot deleted/unpublished state.
    deleted: raw.deleted === true,
    version: raw.version || null,
    raw,
  };
}

/**
 * Collapse a dependency list to distinct objects.
 *
 * The API returns one entry per reference — in practice one per VERSION of the
 * consuming resource — so a single flow that has been published four times
 * appears four times. Left raw this reads as four separate consumers and inflates
 * every "and N more" tally. Identity here is type + id; the version is dropped
 * deliberately, since "which versions reference this" is not a question this
 * feature asks.
 */
function distinctByObject(list) {
  const seen = new Map();
  for (const d of list) {
    const key = `${d.type}::${d.id}`;
    if (!seen.has(key)) seen.set(key, d);
  }
  return [...seen.values()];
}

/**
 * Dependency-tracking index build status.
 *
 * Returns the raw status object. Callers decide what is acceptable — this
 * deliberately does not collapse the answer to a boolean, because "no build has
 * ever run" and "a build is running now" call for different messages.
 */
export async function getDependencyTrackingBuildStatus(api, orgId) {
  return api.proxyGenesys(orgId, "GET", "/api/v2/architect/dependencytracking/build");
}

/**
 * Resources that the given object USES (its direct dependencies).
 *
 * @param {string} objectType  Dependency-tracking object type, e.g. "FLOW".
 * @param {Object} [opts.query] Extra params, e.g. { version: "…" }.
 */
export async function fetchConsumedResources(api, orgId, id, objectType, opts = {}) {
  const entities = await fetchAllPages(api, orgId,
    "/api/v2/architect/dependencytracking/consumedresources",
    { ...opts, query: { id, objectType, ...(opts.query || {}) } });
  return distinctByObject(entities.map(normalizeDependency).filter(Boolean));
}

/**
 * Resources that USE the given object (its consumers).
 *
 * This is the call the delete review's orphan test rests on: an empty result
 * means "safe to delete". Treat a failure as unknown, never as empty.
 */
export async function fetchConsumingResources(api, orgId, id, objectType, opts = {}) {
  const entities = await fetchAllPages(api, orgId,
    "/api/v2/architect/dependencytracking/consumingresources",
    { ...opts, query: { id, objectType, ...(opts.query || {}) } });
  return distinctByObject(entities.map(normalizeDependency).filter(Boolean));
}

/** Fetch all schedules. */
export async function fetchAllSchedules(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/architect/schedules", opts);
}

/** Create an Architect schedule. */
export async function createSchedule(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/architect/schedules", { body });
}

/** Full PUT update of an Architect schedule. */
export async function putSchedule(api, orgId, scheduleId, body) {
  return api.proxyGenesys(orgId, "PUT", `/api/v2/architect/schedules/${scheduleId}`, { body });
}

/** Fetch all schedule groups. */
export async function fetchAllScheduleGroups(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/architect/schedulegroups", opts);
}

/** Create an Architect schedule group. */
export async function createScheduleGroup(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/architect/schedulegroups", { body });
}

/** Full PUT update of an Architect schedule group. */
export async function putScheduleGroup(api, orgId, groupId, body) {
  return api.proxyGenesys(orgId, "PUT", `/api/v2/architect/schedulegroups/${groupId}`, { body });
}

/** Fetch all valid timezone IDs supported by Genesys Cloud. */
export async function fetchTimezones(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/timezones", opts);
}

/** Fetch all data tables. Pass opts.query.expand = "schema" for full schema. */
export async function fetchAllDataTables(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/flows/datatables", opts);
}

/** Full PUT update of a data table (required to change division). Pass the
 *  complete table object (name + schema + updated division). */
export async function putDataTable(api, orgId, tableId, body) {
  return api.proxyGenesys(orgId, "PUT",
    `/api/v2/flows/datatables/${tableId}`, { body });
}

/** Fetch a single data table by ID (includes schema when expand=schema). */
export async function getDataTable(api, orgId, tableId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/flows/datatables/${tableId}`, { query: { expand: "schema" } });
}

/** Create a new data table. Body: { name, schema, division? }. */
export async function createDataTable(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/flows/datatables", { body });
}

/** Create a DID pool. */
export async function createDIDPool(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/telephony/providers/edges/didpools", { body });
}

/** Insert a single row into a data table. */
export async function createDataTableRow(api, orgId, tableId, row) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/flows/datatables/${tableId}/rows`, { body: row });
}

/** Replace a single row in a data table by row key. */
export async function putDataTableRow(api, orgId, tableId, rowKey, row) {
  const key = encodeURIComponent(String(rowKey ?? ""));
  return api.proxyGenesys(orgId, "PUT",
    `/api/v2/flows/datatables/${tableId}/rows/${key}`, { body: row });
}

/** Delete a single row from a data table by row key. */
export async function deleteDataTableRow(api, orgId, tableId, rowKey) {
  const key = encodeURIComponent(String(rowKey ?? ""));
  return api.proxyGenesys(orgId, "DELETE",
    `/api/v2/flows/datatables/${tableId}/rows/${key}`);
}

/** Fetch rows from a data table. Add query.showbrief = "false" for full rows. */
export async function fetchDataTableRows(api, orgId, tableId, opts = {}) {
  return fetchAllPages(api, orgId,
    `/api/v2/flows/datatables/${tableId}/rows`, opts);
}

// ─────────────────────────────────────────────────────────────────────
// Telephony — Sites, DIDs, Phones
// ─────────────────────────────────────────────────────────────────────

/** Fetch all sites. */
export async function fetchAllSites(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId,
    "/api/v2/telephony/providers/edges/sites", opts);
}

/** Fetch all locations. */
export async function fetchAllLocations(api, orgId) {
  return fetchAllPages(api, orgId, "/api/v2/locations");
}

/** Get all number plans for a site. */
export async function getSiteNumberPlans(api, orgId, siteId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/telephony/providers/edges/sites/${siteId}/numberplans`);
}

/** Replace all number plans for a site (max 200). */
export async function updateSiteNumberPlans(api, orgId, siteId, plans) {
  return api.proxyGenesys(orgId, "PUT",
    `/api/v2/telephony/providers/edges/sites/${siteId}/numberplans`, { body: plans });
}

/** Create a site. Body: { name, mediaModel, mediaRegions?, location, description? }. */
export async function createSite(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST",
    "/api/v2/telephony/providers/edges/sites", { body });
}

/** Fetch all trunk base settings (paginated). */
export async function fetchAllTrunkBaseSettings(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId,
    "/api/v2/telephony/providers/edges/trunkbasesettings", opts);
}

/** Get all outbound routes for a site. */
export async function getSiteOutboundRoutes(api, orgId, siteId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/telephony/providers/edges/sites/${siteId}/outboundroutes`);
}

/** Create an outbound route on a site. */
export async function createSiteOutboundRoute(api, orgId, siteId, body) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/telephony/providers/edges/sites/${siteId}/outboundroutes`, { body });
}

/** Update an outbound route on a site (full PUT). */
export async function updateSiteOutboundRoute(api, orgId, siteId, routeId, body) {
  return api.proxyGenesys(orgId, "PUT",
    `/api/v2/telephony/providers/edges/sites/${siteId}/outboundroutes/${routeId}`, { body });
}

/**
 * Fetch all DID pools.
 *
 * Each pool is a *range* — `startPhoneNumber` to `endPhoneNumber`, both E.164 —
 * so membership is a numeric comparison against a handful of pools rather than
 * a lookup per number. Requires `telephony:plugin:all`; callers must treat a
 * failure as "could not check", never as "the number is absent".
 */
export async function fetchAllDidPools(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId,
    "/api/v2/telephony/providers/edges/didpools", opts);
}

/** Fetch all phone base settings. */
export async function fetchAllPhoneBaseSettings(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId,
    "/api/v2/telephony/providers/edges/phonebasesettings", opts);
}

/** Get a single phone base setting by ID (includes lines). */
export async function getPhoneBaseSetting(api, orgId, id) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/telephony/providers/edges/phonebasesettings/${id}`);
}

/** Fetch all phones (paginated). */
export async function fetchAllPhones(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId,
    "/api/v2/telephony/providers/edges/phones", opts);
}

/**
 * Run an API call, retrying it when Genesys rate-limits.
 *
 * For bulk write loops. The proxy returns a JSON body only, so the server's
 * own `Retry-After` header is not visible to the browser and the delay is a
 * fixed exponential instead. Without this a burst of 429s is indistinguishable
 * from real failures in a run log, and the affected objects are silently left
 * untouched.
 *
 * Only 429 is retried. A 4xx does not become correct by being repeated.
 */
export async function withRateLimitRetry(fn, { attempts = 4, initialDelayMs = 1000 } = {}) {
  let wait = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.status !== 429 || attempt >= attempts) throw err;
      await sleep(wait);
      wait *= 2;
    }
  }
}

/** Create a phone. */
export async function createPhone(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST",
    "/api/v2/telephony/providers/edges/phones", { body });
}

/** Get a single phone by ID (full object including webRtcUser). */
export async function getPhone(api, orgId, phoneId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/telephony/providers/edges/phones/${phoneId}`);
}

/** Delete a phone. Irreversible — the phone and its lines are removed. */
export async function deletePhone(api, orgId, phoneId) {
  return api.proxyGenesys(orgId, "DELETE",
    `/api/v2/telephony/providers/edges/phones/${phoneId}`);
}

/** Update a phone (full PUT — requires the complete phone object). */
export async function updatePhone(api, orgId, phoneId, body) {
  return api.proxyGenesys(orgId, "PUT",
    `/api/v2/telephony/providers/edges/phones/${phoneId}`, { body });
}

/** Fetch all licensed users (paginated). */
export async function fetchAllLicenseUsers(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/license/users", opts);
}

/** Fetch all license definitions (non-paginated flat list of {id} objects). */
export async function fetchLicenseDefinitions(api, orgId) {
  const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/license/definitions");
  // API returns a flat array directly (not wrapped in .entities)
  return Array.isArray(resp) ? resp : (resp.entities || []);
}

/**
 * Fetch a single license definition.
 *
 * The list endpoint above may return definitions without their `permissions`
 * populated; this one always carries them. Callers that need `permissions.ids`
 * should fall back to this whenever the listed entry came back skinny.
 */
export async function fetchLicenseDefinition(api, orgId, licenseId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/license/definitions/${encodeURIComponent(licenseId)}`);
}

/**
 * Ask Genesys which licenses a set of roles requires.
 *
 * POST /api/v2/license/infer  body: [roleId]  →  [licenseId]
 *
 * This is the same inference the Genesys admin UI runs when it warns that a
 * role needs a license, so its answer is the billing answer. Prefer it over
 * comparing permissions against a license definition by hand.
 */
export async function inferLicensesForRoles(api, orgId, roleIds) {
  const resp = await api.proxyGenesys(orgId, "POST", "/api/v2/license/infer", {
    body: roleIds,
  });
  return Array.isArray(resp) ? resp : [];
}

// ─────────────────────────────────────────────────────────────────────
// Integrations / Data Actions
// ─────────────────────────────────────────────────────────────────────

/** Fetch all data actions. */
export async function fetchAllDataActions(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/integrations/actions", opts);
}

/**
 * Resolve a Velocity template URI to its text through the proxy.
 * Non-JSON responses arrive wrapped as `{ raw }` — see `templateTextOf`.
 */
function templateFetcher(api, orgId) {
  return async (uri) =>
    templateTextOf(await api.proxyGenesys(orgId, "GET", uri, { raw: true }));
}

/**
 * Fetch a single data action with full contract and config.
 *
 * Velocity templates stored as `.vm` files come back as `requestTemplateUri` /
 * `successTemplateUri` with no inline string. They are resolved here so no
 * caller can read an empty template and write that emptiness back — the bug
 * this centralisation exists to make impossible. Pass
 * `{ inlineTemplates: false }` when only the envelope (id, version) is wanted.
 */
export async function getDataAction(api, orgId, actionId, { inlineTemplates = true } = {}) {
  const action = await api.proxyGenesys(orgId, "GET",
    `/api/v2/integrations/actions/${actionId}`,
    { query: { expand: "contract", includeConfig: "true" } });
  return inlineTemplates
    ? inlineActionTemplates(templateFetcher(api, orgId), action)
    : action;
}

/** Create a published data action. Body: { name, category, integrationId, contract, config }. */
export async function createDataAction(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST",
    "/api/v2/integrations/actions", { body });
}

/** Create a data action as draft. Body: { name, category, integrationId, contract, config }. */
export async function createDataActionDraft(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST",
    "/api/v2/integrations/actions/drafts", { body });
}

/** Fetch all action drafts (actions that exist only as drafts). */
export async function fetchAllDataActionDrafts(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/integrations/actions/drafts", opts);
}

/** Get the draft of an existing action. Inlines templates like `getDataAction`. */
export async function getDataActionDraft(api, orgId, actionId, { inlineTemplates = true } = {}) {
  const draft = await api.proxyGenesys(orgId, "GET",
    `/api/v2/integrations/actions/${actionId}/draft`,
    { query: { expand: "contract", includeConfig: "true" } });
  return inlineTemplates
    ? inlineActionTemplates(templateFetcher(api, orgId), draft)
    : draft;
}

/** Create a new draft from an existing published action. */
export async function createDraftFromAction(api, orgId, actionId) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/integrations/actions/${actionId}/draft`);
}

/** Update (patch) an existing draft. */
export async function patchDataActionDraft(api, orgId, actionId, body) {
  return api.proxyGenesys(orgId, "PATCH",
    `/api/v2/integrations/actions/${actionId}/draft`, { body });
}

/** Validate draft configuration. */
export async function validateDataActionDraft(api, orgId, actionId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/integrations/actions/${actionId}/draft/validation`);
}

/** Publish a draft (makes it the active action). */
export async function publishDataActionDraft(api, orgId, actionId, body = {}) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/integrations/actions/${actionId}/draft/publish`, { body });
}

/** Test a published action with input parameters. */
export async function testDataAction(api, orgId, actionId, body) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/integrations/actions/${actionId}/test`, { body });
}

/** Test a draft action with input parameters. */
export async function testDataActionDraft(api, orgId, actionId, body) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/integrations/actions/${actionId}/draft/test`, { body });
}

/** Fetch all integrations. Filter by type via opts.query.integrationType. */
export async function fetchAllIntegrations(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/integrations", opts);
}

// ─────────────────────────────────────────────────────────────────────
// External Contacts
// ─────────────────────────────────────────────────────────────────────

/** Fetch all external contacts (cursor-paginated in newer API versions). */
export async function fetchAllExternalContacts(api, orgId, opts = {}) {
  return fetchAllCursor(api, orgId, "/api/v2/externalcontacts/contacts", opts);
}

// ─────────────────────────────────────────────────────────────────────
// GDPR
// ─────────────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────────────
// Quality / Evaluations
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the published evaluation forms.
 *
 * Published rather than all: an unpublished form has never scored anything, so
 * offering one as a filter can only ever return nothing.
 *
 * Each entry carries both `id` (this VERSION of the form) and `contextId`
 * (shared across every version). Filters key on `contextId` — see the note in
 * js/lib/evaluationQuery.js on why filtering by version is the wrong default.
 */
export async function fetchAllEvaluationForms(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/quality/publishedforms/evaluations", opts);
}

/**
 * The latest published version of each evaluation form, by CONTEXT id.
 *
 * The aggregate and search domains group by `questionGroupId`, which is an id
 * and not a name. This is the only route from a form context — which is what the
 * filter bar carries — to the question groups inside it.
 */
export async function fetchEvaluationFormsByContext(api, orgId, contextIds) {
  if (!contextIds?.length) return [];
  const resp = await api.proxyGenesys(orgId, "GET",
    "/api/v2/quality/forms/evaluations/bulk/contexts",
    { query: { contextId: contextIds.join(",") } });
  return Array.isArray(resp) ? resp : (resp?.entities || []);
}

/**
 * Every revision of an evaluation form.
 *
 * A question group has a different `id` in every version of its form but keeps
 * one `contextId`, so covering all versions means collecting the ids from each
 * revision and merging the results back together on the context.
 */
export async function fetchEvaluationFormVersions(api, orgId, formId, opts = {}) {
  return fetchAllPages(api, orgId,
    `/api/v2/quality/forms/evaluations/${formId}/versions`, opts);
}

/**
 * One evaluation form, in full.
 *
 * The list and versions endpoints deliberately omit `questionGroups` ("the
 * detailed information about evaluation form, is not returned"), so a caller
 * that needs the groups of a specific version has to ask for that version by
 * id. This is that call.
 */
export async function fetchEvaluationForm(api, orgId, formId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/quality/forms/evaluations/${formId}`);
}

/** Query the evaluation aggregate domain. */
export async function queryEvaluationAggregates(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/analytics/evaluations/aggregates/query", { body });
}

/** Search evaluations — rows, aggregations, or both. Max 3-month range. */
export async function searchEvaluations(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/quality/evaluations/search", { body });
}

/** Per-agent evaluation activity: counts, average and extreme scores. */
export async function fetchAgentActivity(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/quality/agents/activity", opts);
}

/**
 * Roles that carry a given permission string.
 *
 * `GET /api/v2/authorization/roles?permission=…` filters server-side, which is
 * how Roles › Permissions vs. Users already answers this question.
 */
export async function fetchRolesWithPermission(api, orgId, permission, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/authorization/roles", {
    ...opts,
    query: { ...(opts.query || {}), permission },
  });
}

/** Per-evaluator activity: assigned/started/completed, evaluations and calibrations. */
export async function fetchEvaluatorActivity(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/quality/evaluators/activity", opts);
}

// ─────────────────────────────────────────────────────────────────────
// Quality automation — programs, scoring rules, transcription
// ─────────────────────────────────────────────────────────────────────
//
// An auto-evaluation exists only if a Speech & Text Analytics PROGRAM covers
// the conversation and an Agent Scoring Rule on that program fires. A media
// retention policy cannot do it: its conditions carry queues and no flows, and
// `submissionType: Automated` lives on the scoring rule. See design §13.2.

/** Every Speech & Text Analytics program. */
export async function fetchPrograms(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/speechandtextanalytics/programs", opts);
}

/**
 * Programs that exist but have never been published.
 *
 * An unpublished program does nothing at all, silently — which is exactly the
 * kind of thing this page exists to surface.
 */
export async function fetchUnpublishedPrograms(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/speechandtextanalytics/programs/unpublished", opts);
}

/**
 * Every program's queue and flow mappings.
 *
 * Returns `TopicsDefinitionsProgramMappings[]`, each
 * `{ program: {id, name}, queues: [{id}], flows: [{id}] }`.
 *
 * NOTE THE SHAPE. The PUT body for this resource is `{queueIds, flowIds}` and
 * the GET response is `{queues, flows}` — entity refs, not id strings. Reading
 * the request definition and assuming the response matched is what made this
 * page report "0 queues" for a program with nine of them.
 *
 * Paged by `nextPage`/`nextUri` rather than `pageNumber` or `cursor`, so
 * neither shared pager fits and it walks the pages itself.
 */
export async function fetchProgramMappings(api, orgId, opts = {}) {
  const { pageSize = 100 } = opts;
  const path = "/api/v2/speechandtextanalytics/programs/mappings";
  const all = [];
  const seen = new Set();
  let nextPage = null;

  while (true) {
    const query = { pageSize: String(pageSize) };
    if (nextPage) query.nextPage = nextPage;
    const resp = await api.proxyGenesys(orgId, "GET", path, { query });
    all.push(...(resp?.entities || []));

    // The token is lifted out of `nextUri` rather than derived, because its
    // format is not documented and is not ours to reconstruct.
    const m = /[?&]nextPage=([^&]+)/.exec(resp?.nextUri || "");
    if (!m) break;
    const token = decodeURIComponent(m[1]);
    // A server that keeps handing back the same token would otherwise spin
    // forever against a customer org.
    if (seen.has(token)) break;
    seen.add(token);
    nextPage = token;
  }

  return all;
}

/**
 * The Agent Scoring Rules for one program.
 *
 * There is no cross-program listing, so callers fan out over the program list.
 * Programs are few, so that is cheap.
 */
export async function fetchAgentScoringRules(api, orgId, programId, opts = {}) {
  return fetchAllPages(api, orgId,
    `/api/v2/quality/programs/${programId}/agentscoringrules`, opts);
}

/**
 * Transcript aggregates.
 *
 * Grouped by `conversationId` this returns the set of conversations that were
 * actually analysed, which is how Evaluation Gaps decides "not transcribed"
 * without a per-conversation call. Needs
 * `analytics:speechAndTextAnalyticsAggregates:view`.
 */
export async function queryTranscriptAggregates(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST",
    "/api/v2/analytics/transcripts/aggregates/query", { body });
}

/** One program by id. Used to name a default program the list did not carry. */
export async function fetchProgram(api, orgId, programId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/speechandtextanalytics/programs/${programId}`);
}

/**
 * Whether AI Summary, Insights & Outline is on, for every program at once.
 *
 * `ProgramInsightsSettingsEntityListing`: entities of `{program, enabled}`.
 * The per-program endpoint exists too; this one avoids the fan-out.
 *
 * Needs `speechAndTextAnalytics:insightsSettings:view` ON TOP of the program
 * view permission, so it fails separately from the program list.
 */
export async function fetchProgramInsightsSettings(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId,
    "/api/v2/speechandtextanalytics/programs/settings/insights", opts);
}

/**
 * The transcription engines configured for one program.
 *
 * `ProgramTranscriptionEngines.transcriptionEngines[]` is
 * `{engine, dialects, engineIntegration}`. Per-program only — there is no
 * listing across programs — so callers fan out over the program list.
 */
export async function fetchProgramTranscriptionEngines(api, orgId, programId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/speechandtextanalytics/programs/${programId}/transcriptionengines`);
}

/**
 * Org-wide Speech & Text Analytics settings.
 *
 * `{ defaultProgram, expectedDialects, textAnalyticsEnabled, agentEmpathyEnabled }`.
 *
 * NOTE: Agent Empathy and Customer Sentiment are ONLY available here. The
 * Genesys program editor shows them as per-program checkboxes, but no
 * per-program equivalent exists anywhere in the API — consistent with that
 * screen's own note that organisation-level settings override program-level
 * configuration. Report them as org-wide facts; do not attribute them to a
 * program.
 *
 * Needs `speechAndTextAnalytics:settings:view`.
 */
export async function fetchSpeechTextAnalyticsSettings(api, orgId) {
  return api.proxyGenesys(orgId, "GET", "/api/v2/speechandtextanalytics/settings");
}

/**
 * Org-wide transcription setting.
 *
 * `transcription` is Disabled | EnabledGlobally | EnabledQueueFlow. Disabled
 * means nothing anywhere is transcribed, so no AI scoring can happen at all;
 * EnabledQueueFlow means it depends on each queue's `enableTranscription`.
 */
export async function fetchTranscriptionSettings(api, orgId) {
  return api.proxyGenesys(orgId, "GET", "/api/v2/routing/settings/transcription");
}

// ─────────────────────────────────────────────────────────────────────
// Groups / Divisions
// ─────────────────────────────────────────────────────────────────────

/** Fetch all groups. */
export async function fetchAllGroups(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/groups", opts);
}

/** Fetch all divisions. */
export async function fetchAllDivisions(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/authorization/divisions", opts);
}

/** Create a division. Body: { name, description? }. */
export async function createDivision(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/authorization/divisions", { body });
}

/** Fetch all authorization roles (for role picker and filtered export). */
export async function fetchAllAuthorizationRoles(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/authorization/roles", opts);
}

/** Get a single role by ID — returns full object including permissionPolicies. */
export async function getAuthorizationRole(api, orgId, roleId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/authorization/roles/${roleId}`);
}

/**
 * Create a new authorization role.
 * body: { name, description?, permissionPolicies: [{ domain, entityName, actionSet, allowConditions?, resourceConditionNode? }] }
 */
export async function createAuthorizationRole(api, orgId, body) {
  return api.proxyGenesys(orgId, "POST", "/api/v2/authorization/roles", { body });
}

/**
 * Update (full replace) an existing authorization role.
 * body must include all fields including permissionPolicies.
 */
export async function updateAuthorizationRole(api, orgId, roleId, body) {
  return api.proxyGenesys(orgId, "PUT", `/api/v2/authorization/roles/${roleId}`, { body });
}

/**
 * Fetch all users assigned to a specific role (includes inactive/deleted/external).
 * Used for accurate member count: intersect result with active org users.
 */
export async function fetchRoleUsers(api, orgId, roleId, opts = {}) {
  return fetchAllPages(api, orgId, `/api/v2/authorization/roles/${roleId}/users`, opts);
}

// ─────────────────────────────────────────────────────────────────────
// Org Authorization — Trustees
// ─────────────────────────────────────────────────────────────────────

/** Fetch trustees for a customer org (orgs that have been granted access). */
export async function fetchTrustees(api, orgId) {
  const resp = await api.proxyGenesys(orgId, "GET",
    "/api/v2/orgauthorization/trustees");
  return resp.entities || [];
}

/** Fetch groups granted to a specific trustee in a customer org. */
export async function fetchTrusteeGroups(api, orgId, trusteeOrgId) {
  const resp = await api.proxyGenesys(orgId, "GET",
    `/api/v2/orgauthorization/trustees/${trusteeOrgId}/groups`);
  return resp.entities || [];
}

/** Fetch members of a group (in the trustee org). */
export async function fetchGroupMembers(api, orgId, groupId, opts = {}) {
  return fetchAllPages(api, orgId, `/api/v2/groups/${groupId}/members`, opts);
}

/** Fetch a single user by ID (for fallback name/email lookup). */
export async function getUser(api, orgId, userId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/users/${userId}`);
}

/** Fetch a single OAuth client by client ID. */
export async function getOAuthClient(api, orgId, clientId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/oauth/clients/${clientId}`);
}

/**
 * Generic entity fetch by path — used by the audit entity name resolver.
 * Returns the full response object; caller extracts `.name`.
 */
export async function fetchEntityByPath(api, orgId, path) {
  return api.proxyGenesys(orgId, "GET", path);
}

/** Fetch a single external contact by ID. */
export async function getExternalContact(api, orgId, contactId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/externalcontacts/contacts/${contactId}`);
}

// ─────────────────────────────────────────────────────────────────────
// Architect — Flow milestones & outcomes
// ─────────────────────────────────────────────────────────────────────

/** Fetch all flow milestones. */
export async function fetchAllFlowMilestones(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/flows/milestones", opts);
}

/** Fetch all flow outcomes. */
export async function fetchAllFlowOutcomes(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/flows/outcomes", opts);
}

/** Fetch all scripts. */
export async function fetchAllScripts(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/scripts", opts);
}

// ─────────────────────────────────────────────────────────────────────
// Routing — Extended (call routes, emergency groups, extension pools,
//           skill groups, routing schedules already in Architect section)
// ─────────────────────────────────────────────────────────────────────

/** Fetch all call routes. */
export async function fetchAllCallRoutes(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/architect/ivrs", opts);
}

/**
 * Find the call route a number is currently assigned to, asking Genesys
 * rather than matching locally.
 *
 * The list endpoint filters on `dnis`, and Genesys compares numbers the way it
 * stores them — which a client-side match cannot reliably reproduce, since a
 * DNIS and a user's address are not guaranteed to be written in the same
 * format. A number may be on at most one route, so the first hit is the answer.
 *
 * Returns null when the number is on no route, and also when the owning route
 * is not visible to the caller — the caller must treat those the same way.
 */
export async function findCallRouteByDnis(api, orgId, number) {
  const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/architect/ivrs", {
    query: { dnis: number, pageSize: "1", pageNumber: "1" },
  });
  return (resp.entities || [])[0] || null;
}

/** Fetch a single call route (Architect IVR). Needed fresh before a PUT. */
export async function getCallRoute(api, orgId, ivrId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/architect/ivrs/${ivrId}`);
}

/**
 * Replace a call route's DNIS list.
 *
 * The endpoint is a whole-object PUT, so the caller hands in the route exactly
 * as it was read and only `dnis` is swapped — anything omitted is dropped.
 * `version` must be the one from that read, so read immediately before writing.
 *
 * Genesys enforces that a number appears on at most one call route, which is
 * why moving a number is a removal and an addition rather than one write.
 */
export async function putCallRouteDnis(api, orgId, route, dnis) {
  const body = { ...route, dnis };
  delete body.selfUri;
  delete body.dateCreated;
  delete body.dateModified;
  delete body.modifiedBy;
  delete body.createdBy;
  delete body.state;
  delete body.modifiedByApp;
  delete body.createdByApp;
  return api.proxyGenesys(orgId, "PUT", `/api/v2/architect/ivrs/${route.id}`, { body });
}

/** Fetch all emergency groups. */
export async function fetchAllEmergencyGroups(api, orgId, opts = {}) {
  return fetchAllPages(
    api, orgId,
    "/api/v2/architect/emergencygroups",
    opts
  );
}

/** Fetch all extension pools. */
export async function fetchAllExtensionPools(api, orgId, opts = {}) {
  return fetchAllPages(
    api, orgId,
    "/api/v2/telephony/providers/edges/extensionpools",
    opts
  );
}

/** Fetch all routing skill groups. */
export async function fetchAllSkillGroups(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/skillgroups", opts);
}

// ─────────────────────────────────────────────────────────────────────
// People / Teams
// ─────────────────────────────────────────────────────────────────────

/** Fetch all teams. */
export async function fetchAllTeams(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/teams", opts);
}

/** Fetch members of a team. */
export async function fetchTeamMembers(api, orgId, teamId, opts = {}) {
  return fetchAllPages(api, orgId, `/api/v2/teams/${teamId}/members`, opts);
}

// ─────────────────────────────────────────────────────────────────────
// Outbound
// ─────────────────────────────────────────────────────────────────────

/** Fetch all outbound campaigns (voice). */
export async function fetchAllCampaigns(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/outbound/campaigns", opts);
}

/** Fetch all outbound contact lists. */
export async function fetchAllContactLists(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/outbound/contactlists", opts);
}

/** Fetch all DNC (Do Not Call) lists. */
export async function fetchAllDncLists(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/outbound/dnclists", opts);
}

/** Fetch all outbound email campaigns. */
export async function fetchAllEmailCampaigns(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/outbound/campaigns/all", {
    ...opts,
    query: { ...(opts.query ?? {}), mediaType: "EMAIL" },
  });
}

/** Fetch all outbound messaging campaigns. */
export async function fetchAllMessagingCampaigns(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/outbound/messagingcampaigns", opts);
}

/** Get outbound dialer wrap-up code mappings document. */
export async function getOutboundWrapupCodeMappings(api, orgId) {
  return api.proxyGenesys(orgId, "GET", "/api/v2/outbound/wrapupcodemappings");
}

/** Update outbound dialer wrap-up code mappings document. */
export async function putOutboundWrapupCodeMappings(api, orgId, body) {
  return api.proxyGenesys(orgId, "PUT", "/api/v2/outbound/wrapupcodemappings", { body });
}

// ─────────────────────────────────────────────────────────────────────
// Workforce Management
// ─────────────────────────────────────────────────────────────────────

/** Fetch all WFM business units. */
export async function fetchAllBusinessUnits(api, orgId, opts = {}) {
  return fetchAllPages(
    api, orgId,
    "/api/v2/workforcemanagement/businessunits",
    opts
  );
}

/** Fetch all WFM management units. */
export async function fetchAllManagementUnits(api, orgId, opts = {}) {
  return fetchAllPages(
    api, orgId,
    "/api/v2/workforcemanagement/managementunits",
    opts
  );
}

// ─────────────────────────────────────────────────────────────────────
// Task Management
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all task management workbins (POST-based query endpoint).
 * Supports cursor pagination via response.nextUri / response.entities.
 */
export async function fetchAllWorkbins(api, orgId, opts = {}) {
  const all = [];
  let after = null;
  while (true) {
    const body = { pageSize: 100 };
    if (after) body.cursor = after;
    const resp = await api.proxyGenesys(
      orgId, "POST",
      "/api/v2/taskmanagement/workbins/query",
      { body }
    );
    const items = resp.entities || [];
    all.push(...items);
    after = resp.cursor || null;
    if (!after || items.length < 100) break;
  }
  return all;
}

/**
 * Fetch all task management work types (POST-based query endpoint).
 * Supports cursor pagination via response.cursor.
 */
export async function fetchAllWorktypes(api, orgId, opts = {}) {
  const all = [];
  let after = null;
  while (true) {
    const body = { pageSize: 100 };
    if (after) body.cursor = after;
    const resp = await api.proxyGenesys(
      orgId, "POST",
      "/api/v2/taskmanagement/worktypes/query",
      { body }
    );
    const items = resp.entities || [];
    all.push(...items);
    after = resp.cursor || null;
    if (!after || items.length < 100) break;
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────
// Response Management — Libraries
// ─────────────────────────────────────────────────────────────────────

/** Fetch all response management libraries. */
export async function fetchAllLibraries(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/responsemanagement/libraries", opts);
}

// ─────────────────────────────────────────────────────────────────────
// GDPR
// ─────────────────────────────────────────────────────────────────────

/** Search for GDPR subjects by a single identifier. */
export async function gdprSearchSubjects(api, orgId, searchType, searchValue) {
  const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/gdpr/subjects", {
    query: { searchType, searchValue },
  });
  return resp.entities || [];
}

/** Submit a GDPR request. Pass deleteConfirmed=true for GDPR_DELETE. */
export async function gdprSubmitRequest(api, orgId, body, deleteConfirmed = false) {
  const qs = deleteConfirmed ? "?deleteConfirmed=true" : "";
  return api.proxyGenesys(orgId, "POST", `/api/v2/gdpr/requests${qs}`, { body });
}

/** Fetch existing GDPR requests for an org. */
export async function gdprGetRequests(api, orgId) {
  const resp = await api.proxyGenesys(orgId, "GET", "/api/v2/gdpr/requests?pageSize=50");
  return resp.entities || [];
}

/** Fetch a single GDPR request by ID (includes resultsUrl for exports). */
export async function gdprGetRequest(api, orgId, requestId) {
  return api.proxyGenesys(orgId, "GET", `/api/v2/gdpr/requests/${requestId}`);
}

// ─────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the service/entity/action mapping for audit queries.
 * Returned once per page session and cached by the caller.
 *
 * @param {Object} api
 * @param {string} orgId
 * @returns {Promise<Object>}  { services: [{ name, entities: [{ name, actions }] }] }
 */
export async function fetchAuditServiceMapping(api, orgId) {
  return api.proxyGenesys(orgId, "GET", "/api/v2/audits/query/servicemapping");
}

/**
 * Fetch the service mapping for the realtime audit endpoint.
 * Returns only services supported by /audits/query/realtime.
 */
export async function fetchRealtimeAuditServiceMapping(api, orgId) {
  return api.proxyGenesys(orgId, "GET", "/api/v2/audits/query/realtime/servicemapping");
}

/**
 * Submit a synchronous (realtime) audit query.
 * Covers up to 14 days back. Returns entities directly — no polling needed.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {Object} body  { interval, serviceName }
 * @returns {Promise<Object[]>}  Audit entries array.
 */
export async function submitRealtimeAuditQuery(api, orgId, body) {
  const all = [];
  let cursor = null;

  while (true) {
    let path = "/api/v2/audits/query/realtime?pageSize=500";
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;

    const resp = await api.proxyGenesys(orgId, "POST", path, { body });
    const items = resp.entities || resp.audits || [];
    all.push(...items);

    const nextUri = resp.nextUri || null;
    if (!nextUri) break;
    const match = nextUri.match(/[?&]cursor=([^&]+)/);
    cursor = match ? decodeURIComponent(match[1]) : null;
    if (!cursor) break;
  }

  return all;
}

/**
 * Submit an async audit query.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {Object} body  Full query body — interval + serviceName + optional filters.
 * @returns {Promise<string>}  transactionId
 */
export async function submitAuditQuery(api, orgId, body) {
  const resp = await api.proxyGenesys(orgId, "POST", "/api/v2/audits/query", { body });
  const txId = resp.id || resp.transactionId;
  if (!txId) {
    throw new Error(`Audit query submission failed: ${resp.message || JSON.stringify(resp)}`);
  }
  return txId;
}

/**
 * Poll an audit query until it reaches Succeeded (or Failed / timeout).
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {string}   transactionId
 * @param {Object}   [opts]
 * @param {number}   [opts.pollIntervalMs=2000]
 * @param {number}   [opts.maxWaitSeconds=120]
 * @param {Function} [opts.onPoll]  Called each tick with (elapsedSeconds).
 * @returns {Promise<void>}
 */
export async function pollAuditQuery(api, orgId, transactionId, opts = {}) {
  const {
    pollIntervalMs = 2000,
    maxWaitSeconds = 120,
    onPoll,
  } = opts;

  const start = Date.now();
  while (true) {
    await sleep(pollIntervalMs);
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed > maxWaitSeconds) {
      throw new Error(`Audit query timed out after ${maxWaitSeconds}s`);
    }

    const resp = await api.proxyGenesys(orgId, "GET",
      `/api/v2/audits/query/${transactionId}`);

    if (onPoll) onPoll(elapsed);

    const state = (resp.state || "").toLowerCase();
    if (state === "succeeded" || state === "fulfilled") return;
    if (state === "failed") {
      throw new Error(`Audit query failed: ${resp.errorMessage || "Unknown error"}`);
    }
  }
}

/**
 * Fetch all results from a completed audit query (cursor / nextUri pagination).
 *
 * The Genesys audit results endpoint uses `nextUri` to point to the
 * next page. Results are in `entities[]`.
 *
 * @param {Object}   api
 * @param {string}   orgId
 * @param {string}   transactionId
 * @param {Object}   [opts]
 * @param {Function} [opts.onProgress]  Called with (fetchedSoFar).
 * @returns {Promise<Object[]>}  All audit entries.
 */
export async function fetchAuditQueryResults(api, orgId, transactionId, opts = {}) {
  const { onProgress } = opts;
  const all = [];
  let cursor = null;

  while (true) {
    // Build query params directly into the path so the proxy forwards them
    // correctly regardless of how it handles the `query` option for GET requests.
    let path = `/api/v2/audits/query/${transactionId}/results?pageSize=500`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;

    const resp = await api.proxyGenesys(orgId, "GET", path);

    const items = resp.entities || resp.audits || [];
    all.push(...items);
    if (onProgress) onProgress(all.length);

    // Extract cursor from nextUri (e.g. "...results?cursor=xxx" — may be absolute URL)
    const nextUri = resp.nextUri || null;
    if (!nextUri) break;
    const match = nextUri.match(/[?&]cursor=([^&]+)/);
    cursor = match ? decodeURIComponent(match[1]) : null;
    if (!cursor) break;
  }

  return all;
}
