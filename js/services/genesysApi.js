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
    { itemsKey: "conversations", ...opts }
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
 * @param {number}   [opts.maxPages=10]  Max pages to fetch.
 * @param {Function} [opts.onProgress]   Called with (fetchedSoFar).
 * @returns {Promise<Object[]>}  All conversation objects.
 */
export async function queryConversationDetails(api, orgId, body, opts = {}) {
  const { maxPages = 10, onProgress } = opts;
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
  }

  return all;
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
  const { expand = [], state, onProgress } = opts;
  const query = {};
  if (expand.length) query.expand = expand.join(",");
  if (state) query.state = state;
  return fetchAllPages(api, orgId, "/api/v2/users", { query, onProgress });
}

// ─────────────────────────────────────────────────────────────────────
// Routing — Queues, Skills, Wrapup codes
// ─────────────────────────────────────────────────────────────────────

/** Fetch all routing queues. */
export async function fetchAllQueues(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/queues", opts);
}

/** Fetch all routing skills. */
export async function fetchAllSkills(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/skills", opts);
}

/** Fetch all wrapup codes. */
export async function fetchAllWrapupCodes(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/routing/wrapupcodes", opts);
}

// ─────────────────────────────────────────────────────────────────────
// Architect — Flows, Schedules, DataTables
// ─────────────────────────────────────────────────────────────────────

/** Fetch all flows. */
export async function fetchAllFlows(api, orgId, opts = {}) {
  const query = { deleted: "false", ...(opts.query || {}) };
  return fetchAllPages(api, orgId, "/api/v2/flows", { ...opts, query });
}

/** Fetch all schedules. */
export async function fetchAllSchedules(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/architect/schedules", opts);
}

/** Fetch all schedule groups. */
export async function fetchAllScheduleGroups(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/architect/schedulegroups", opts);
}

/** Fetch all data tables. Pass opts.query.expand = "schema" for full schema. */
export async function fetchAllDataTables(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/flows/datatables", opts);
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

/** Insert a single row into a data table. */
export async function createDataTableRow(api, orgId, tableId, row) {
  return api.proxyGenesys(orgId, "POST",
    `/api/v2/flows/datatables/${tableId}/rows`, { body: row });
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

/** Fetch all DID pools. */
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

/** Update a phone (full PUT — requires the complete phone object). */
export async function updatePhone(api, orgId, phoneId, body) {
  return api.proxyGenesys(orgId, "PUT",
    `/api/v2/telephony/providers/edges/phones/${phoneId}`, { body });
}

/** Fetch all licensed users (paginated). */
export async function fetchAllLicenseUsers(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/license/users", opts);
}

// ─────────────────────────────────────────────────────────────────────
// Integrations / Data Actions
// ─────────────────────────────────────────────────────────────────────

/** Fetch all data actions. */
export async function fetchAllDataActions(api, orgId, opts = {}) {
  return fetchAllPages(api, orgId, "/api/v2/integrations/actions", opts);
}

/** Fetch a single data action with full contract and config. */
export async function getDataAction(api, orgId, actionId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/integrations/actions/${actionId}`,
    { query: { expand: "contract", includeConfig: "true" } });
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

/** Get the draft of an existing action. */
export async function getDataActionDraft(api, orgId, actionId) {
  return api.proxyGenesys(orgId, "GET",
    `/api/v2/integrations/actions/${actionId}/draft`,
    { query: { expand: "contract", includeConfig: "true" } });
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

/**
 * Search GDPR subjects.
 *
 * @param {Object} api
 * @param {string} orgId
 * @param {string} searchType  NAME | ADDRESS | PHONE | EMAIL
 * @param {string} searchValue
 * @returns {Promise<Object>}
 */
export async function searchGdprSubjects(api, orgId, searchType, searchValue) {
  return api.proxyGenesys(orgId, "GET", "/api/v2/gdpr/subjects", {
    query: { searchType, searchValue },
  });
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
