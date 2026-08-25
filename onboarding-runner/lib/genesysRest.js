/**
 * Genesys REST helper (runner) — client-credentials calls for the data table /
 * data action phases (the flow phases go through the SDK child workers instead).
 * `org` is a resolved object from regions.resolveOrg().
 */
"use strict";

const { getGenesysToken } = require("./genesysAuth");

async function gcFetch(org, method, path, { query, body, raw } = {}) {
  const token = await getGenesysToken(org.id, org.region, org.clientId, org.clientSecret);
  let url = `https://api.${org.region}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body && method.toUpperCase() !== "GET") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 204) return null;
  const text = await resp.text();

  // `raw` callers want the bytes. A Velocity template whose placeholders sit
  // inside quotes — {"Status": "${Status}"} — is itself valid JSON, and parsing
  // it destroys the original text the caller is about to write elsewhere.
  let json;
  if (raw) {
    json = { raw: text };
  } else {
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  if (!resp.ok) {
    let extra = "";
    if (json.code) extra = json.code;
    if (Array.isArray(json.details) && json.details.length) {
      const d = json.details[0];
      extra = [extra, d.errorCode, d.fieldName].filter(Boolean).join(" ");
    }
    const base = json.message || json.error || `${method} ${path} → ${resp.status}`;
    const err = new Error(extra ? `${base} (${extra})` : base);
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchAllPages(org, path, { query = {}, entitiesKey = "entities", pageSize = 100 } = {}) {
  let page = 1;
  let all = [];
  while (true) {
    const resp = await gcFetch(org, "GET", path, {
      query: { ...query, pageSize: String(pageSize), pageNumber: String(page) },
    });
    const items = resp[entitiesKey] || [];
    all = all.concat(items);
    if (items.length < pageSize || page >= (resp.pageCount ?? page)) break;
    page++;
  }
  return all;
}

// ── Divisions ───────────────────────────────────────────
const listDivisions = (org) =>
  fetchAllPages(org, "/api/v2/authorization/divisions");

// ── Data tables ─────────────────────────────────────────
const listDataTables = (org) =>
  fetchAllPages(org, "/api/v2/flows/datatables", { query: { expand: "schema" } });

const getDataTable = (org, id) =>
  gcFetch(org, "GET", `/api/v2/flows/datatables/${id}`, { query: { expand: "schema" } });

const createDataTable = (org, body) =>
  gcFetch(org, "POST", "/api/v2/flows/datatables", { body });

const fetchDataTableRows = (org, tableId) =>
  fetchAllPages(org, `/api/v2/flows/datatables/${tableId}/rows`, { query: { showbrief: "false" } });

const createDataTableRow = (org, tableId, row) =>
  gcFetch(org, "POST", `/api/v2/flows/datatables/${tableId}/rows`, { body: row });

// ── Data actions ────────────────────────────────────────
const listDataActions = (org) =>
  fetchAllPages(org, "/api/v2/integrations/actions", { query: { includeAuthActions: "false" } });

/**
 * Keys naming a file that belongs to one action in one org.
 *
 * They are useless in another org, and because they embed the action's own id
 * they also make two identical actions compare as different — which is why the
 * conflict resolver must ignore them (see VOLATILE_KEYS in processor.js).
 */
const ACTION_URI_KEYS = [
  "requestTemplateUri", "successTemplateUri",
  "inputSchemaUri", "successSchemaUri", "errorSchemaUri",
  "inputSchemaFlattened", "successSchemaFlattened", "errorSchemaFlattened",
];

/**
 * Resolve a data action's Velocity templates into inline strings.
 *
 * An action whose template was stored as a `.vm` file comes back with only a
 * `requestTemplateUri` / `successTemplateUri` and no inline template. Copying
 * such an action verbatim gives the target Genesys's default
 * `${input.rawRequest}` instead of the real template, silently — so the
 * templates are fetched and inlined here, and a fetch that fails is reported
 * on the action as `templateFetchFailures` rather than swallowed.
 *
 * Mirrors `js/lib/dataActions.js` on the browser side; keep the two in step.
 */
async function inlineActionTemplates(org, action) {
  const fields = [
    ["request", "requestTemplateUri", "requestTemplate", "request template"],
    ["response", "successTemplateUri", "successTemplate", "success template"],
  ];
  const failures = [];

  for (const [section, uriKey, tplKey, label] of fields) {
    const cfg = action && action.config && action.config[section];
    if (!cfg || !cfg[uriKey] || cfg[tplKey]) continue;
    let text = null;
    try {
      const resp = await gcFetch(org, "GET", cfg[uriKey], { raw: true });
      // `raw: true` guarantees { raw: <bytes> } — never a parsed object, which
      // is what a JSON-valid template would otherwise become.
      if (typeof resp === "string") text = resp;
      else if (resp && typeof resp.raw === "string") text = resp.raw;
    } catch (_) { text = null; }

    if (typeof text === "string") {
      cfg[tplKey] = text;
      delete cfg[uriKey];
    } else {
      // Keep the URI: an action with neither a template nor a pointer to one
      // is exactly the silent default this guards against.
      failures.push(label);
    }
  }

  if (failures.length) action.templateFetchFailures = failures;
  return action;
}

/** Deep copy with every org-specific file reference stripped. */
function stripOrgSpecificUris(value) {
  if (Array.isArray(value)) return value.map(stripOrgSpecificUris);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (ACTION_URI_KEYS.includes(k)) continue;
      out[k] = stripOrgSpecificUris(v);
    }
    return out;
  }
  return value;
}

const getDataAction = async (org, id) =>
  inlineActionTemplates(org, await gcFetch(org, "GET",
    `/api/v2/integrations/actions/${id}`,
    { query: { expand: "contract", includeConfig: "true" } }));

const createDataAction = (org, body) =>
  gcFetch(org, "POST", "/api/v2/integrations/actions", { body });

const listIntegrations = (org) =>
  fetchAllPages(org, "/api/v2/integrations");

// ── Flows ───────────────────────────────────────────────
/** All flows (every type) in an org — used to discover flow references by GUID. */
const listFlows = (org) => fetchAllPages(org, "/api/v2/flows");

// ── Scripts ─────────────────────────────────────────────
const listScripts = (org) => fetchAllPages(org, "/api/v2/scripts");

/** Request a script export; returns a (pre-signed) URL to download the file. */
const getScriptExportUrl = async (org, scriptId) => {
  const res = await gcFetch(org, "POST", `/api/v2/scripts/${scriptId}/export`, { body: {} });
  return res && res.url ? res.url : null;
};

/** Poll status of a script upload (import). */
const getScriptUploadStatus = (org, uploadId) =>
  gcFetch(org, "GET", `/api/v2/scripts/uploads/${uploadId}/status`);

/** Download the text body of a URL (e.g. an exported script file). */
async function downloadText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download failed → ${resp.status}`);
  return resp.text();
}

/**
 * Import a script into an org via the Scripter upload endpoint (multipart).
 * Returns the upload correlation id to poll with getScriptUploadStatus.
 */
async function importScript(org, scriptName, fileText) {
  const token = await getGenesysToken(org.id, org.region, org.clientId, org.clientSecret);
  const form = new FormData();
  form.append("file", new Blob([fileText], { type: "application/json" }), "script.json");
  form.append("scriptName", scriptName);
  // NB: uses the apps.<region> host, not api.<region>.
  const resp = await fetch(`https://apps.${org.region}/uploads/v2/scripter`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) throw new Error(json.message || json.error || `script upload → ${resp.status}`);
  return json.correlationId || json.uploadId || json.id;
}

/**
 * Publish a script so it becomes referenceable by flows (screen pops, etc.).
 * Imported scripts start as unpublished drafts; the flow validator only sees
 * published scripts. POST /api/v2/scripts/published?scriptDataVersion=0 {scriptId}.
 */
const publishScript = (org, scriptId) =>
  gcFetch(org, "POST", "/api/v2/scripts/published", {
    query: { scriptDataVersion: "0" },
    body: { scriptId },
  });

// ── Survey forms (voice-survey flow dependency) ─────────
/** All survey forms (latest editable versions) in an org. */
const listSurveyForms = (org) => fetchAllPages(org, "/api/v2/quality/forms/surveys");

/** Full survey form (with question groups) by id. */
const getSurveyForm = (org, formId) =>
  gcFetch(org, "GET", `/api/v2/quality/forms/surveys/${formId}`);

/** Create a survey form. Returns the created form (with a new id/contextId). */
const createSurveyForm = (org, body) =>
  gcFetch(org, "POST", "/api/v2/quality/forms/surveys", { body });

/** Publish a survey form version so flows can reference it. */
const publishSurveyForm = (org, formId) =>
  gcFetch(org, "POST", "/api/v2/quality/publishedforms/surveys", {
    body: { id: formId, published: true },
  });

// ── User prompts (referenced directly by flow actions) ──
// System prompts are deliberately not handled: they exist in every org, so
// there is nothing to copy.

/** All user prompts in an org. */
const listPrompts = (org) => fetchAllPages(org, "/api/v2/architect/prompts");

/** One user prompt's per-language resources (TTS text, audio, tags). */
const listPromptResources = (org, promptId) =>
  fetchAllPages(org, `/api/v2/architect/prompts/${promptId}/resources`);

/** Create a user prompt. Body: { name, description? }. */
const createPrompt = (org, body) =>
  gcFetch(org, "POST", "/api/v2/architect/prompts", { body });

/**
 * Add one language resource to a prompt. Body carries everything except the
 * audio itself: { language, ttsString?, text?, tags? }. Recorded audio is
 * intentionally never copied — the customer records their own.
 */
const createPromptResource = (org, promptId, body) =>
  gcFetch(org, "POST", `/api/v2/architect/prompts/${promptId}/resources`, { body });

/** Find a flow's id by exact name + type in an org (or null). */
async function findFlowIdByName(org, type, name) {
  const flows = await fetchAllPages(org, "/api/v2/flows", {
    query: { type, nameOrDescription: name },
  });
  const exact = flows.find((f) => f.name === name);
  return exact ? exact.id : null;
}

// ── Divisions (assign objects) ────────────────────────
/**
 * Assign objects (by id) to a division. `objectType` goes in the URL path
 * (e.g. "FLOW", "SCRIPT"); body is a raw JSON array of ids, batched by 100.
 * Genesys: POST /api/v2/authorization/divisions/{divisionId}/objects/{objectType}.
 */
async function moveObjectsToDivision(org, divisionId, objectType, ids) {
  const list = (ids || []).filter(Boolean);
  const BATCH = 100;
  for (let i = 0; i < list.length; i += BATCH) {
    await gcFetch(org, "POST", `/api/v2/authorization/divisions/${divisionId}/objects/${objectType}`, {
      body: list.slice(i, i + BATCH),
    });
  }
}

module.exports = {
  gcFetch,
  fetchAllPages,
  listDivisions,
  listDataTables,
  getDataTable,
  createDataTable,
  fetchDataTableRows,
  createDataTableRow,
  listDataActions,
  getDataAction,
  createDataAction,
  stripOrgSpecificUris,
  ACTION_URI_KEYS,
  listIntegrations,
  listFlows,
  listScripts,
  getScriptExportUrl,
  getScriptUploadStatus,
  downloadText,
  importScript,
  publishScript,
  listSurveyForms,
  getSurveyForm,
  createSurveyForm,
  publishSurveyForm,
  listPrompts,
  listPromptResources,
  createPrompt,
  createPromptResource,
  findFlowIdByName,
  moveObjectsToDivision,
};
