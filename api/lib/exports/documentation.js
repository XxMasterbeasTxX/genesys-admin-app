"use strict";
/**
 * Documentation Export — full Genesys Cloud configuration workbook.
 *
 * Produces up to two Excel workbooks that mirror the Python Export_All.py output:
 *   1. Documentation_<Org>_<ts>.xlsx  — all 42 configuration sheets + Index cover
 *   2. Documentation_DataTables_<Org>_<ts>.xlsx — one sheet per data-table with its rows
 *
 * When both workbooks contain data they are bundled into a single ZIP archive.
 * If the DataTables workbook is empty only the main XLSX is returned.
 *
 * Each fetch function returns:
 *   { headers, rows }  on success  (rows may be empty)
 *   { error }          when the API returns 403 / 404 → sheet shows error status
 */
const XLSX  = require("xlsx-js-style");
const JSZip = require("jszip");
const customers          = require("../customers.json");
const { getGenesysToken } = require("../genesysAuth");
const { addStyledSheet }  = require("../excelStyles");

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const MAIN_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ZIP_MIME  = "application/zip";

const SHEET_DESCRIPTIONS = {
  "Queues":                   "Contact center queues with routing configuration",
  "Users":                    "Active users with roles and authorization details",
  "Routing - Calls":          "Call routing configuration and IVR flows",
  "Wrapup Codes":             "After-call work codes and categories",
  "Triggers":                 "Event-based automation triggers",
  "Trunks":                   "Voice trunk configurations and settings",
  "Data Actions":             "External integration actions and endpoints",
  "Integrations":             "Third-party system integrations",
  "DID Pools":                "Phone number pool allocations",
  "DID Numbers":              "Direct inward dial number assignments",
  "Policies":                 "Security and routing policies",
  "DB Schemas":               "Data table schemas and definitions",
  "Flow Outcomes":            "Flow execution outcome tracking",
  "Milestones":               "Flow milestone definitions",
  "Flows":                    "Architect flows with creator attribution",
  "Routing - Messaging":      "Message routing configuration",
  "Messenger Configurations": "Web messenger deployment settings",
  "Messenger Deployments":    "Web messenger deployment details",
  "Schedules":                "Operating schedules and time definitions",
  "Schedule Groups":          "Schedule group configurations",
  "User Prompts":             "Audio prompts and announcements",
  "Email Domains":            "Email domain configurations",
  "Email Addresses":          "Email address routing settings",
  "Sites":                    "Physical location and site definitions",
  "Sites - Outbound Routes":  "Outbound call routing by site",
  "Sites - Number Plans":     "Number plan configurations by site",
  "Agent Copilots":           "AI assistant configurations by queue",
  "Agent Copilots - Rules":   "Copilot automation rules and conditions",
  "OB - Campaigns":           "Outbound campaign configurations and settings",
  "OB - Attempt Controls":    "Outbound attempt limits and recall entry settings",
  "OB - Contactable Time Sets":"Outbound callable time sets with time zones and daily contactable windows",
  "OB - Call Analysis":       "Outbound call analysis response sets with disposition reactions and detection settings",
  "OB - Campaign Rules":      "Outbound campaign rule automation with conditions and actions",
  "OB - Contact List Filters":"Outbound contact list filter predicates with clause details",
  "OB - Contact Lists":       "Outbound contact list configurations with phone/email/WhatsApp column details",
  "OB - Contact List Templates":"Outbound contact list template definitions with phone/email/WhatsApp columns, attempt controls, and preview mode",
  "OB - Settings":            "Organization-level Outbound settings with automatic time zone mapping",
  "OAuth - CODE":             "OAuth clients using Code Authorization Grant (per-scope rows)",
  "OAuth - TOKEN":            "OAuth clients using Implicit Grant (per-scope rows)",
  "OAuth - SAML2-BEARER":     "OAuth clients using SAML2 Bearer Extension (per-scope rows)",
  "OAuth - PASSWORD":         "OAuth clients using Resource Owner Password Grant (per-scope rows)",
  "OAuth - CLIENT-CREDENTIALS":"OAuth clients using Client Credentials Grant (per-role-division rows)",
};

// ─────────────────────────────────────────────────────────
// Cover sheet styling
// ─────────────────────────────────────────────────────────

const CS_THIN = {
  top:    { style: "thin", color: { rgb: "D3D3D3" } },
  bottom: { style: "thin", color: { rgb: "D3D3D3" } },
  left:   { style: "thin", color: { rgb: "D3D3D3" } },
  right:  { style: "thin", color: { rgb: "D3D3D3" } },
};

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Return "DD-MM-YYYY HH:MM:SS" matching Python strftime("%d-%m-%Y %H:%M:%S").
 */
function formatTs(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Return "YYYYMMDD_HHMMSS" for use in filename.
 */
function tsForFilename(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Truncate / sanitise sheet name so it is safe for Excel (max 31 chars).
 */
function safeSheet(name) {
  return name.replace(/[:\\/?*[\]]/g, "").slice(0, 31);
}

/**
 * Build hyperlink target for an internal sheet reference.
 * Names containing a space or hyphen must be wrapped in single quotes.
 */
function sheetHref(name) {
  const safe = safeSheet(name);
  const needsQuotes = /[\s-]/.test(safe);
  return needsQuotes ? `#'${safe}'!A1` : `#${safe}!A1`;
}

/**
 * Perform a single Genesys Cloud API GET using an already-obtained token.
 */
async function genesysGet(region, token, path) {
  const url  = `https://api.${region}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err  = new Error(`Genesys API ${resp.status} for ${path}`);
    err.status = resp.status;
    err.detail = body.slice(0, 200);
    throw err;
  }
  return resp.json();
}

/**
 * Fetch all pages of a paged Genesys endpoint.
 * The response must have an `entities` array and `pageCount` field.
 */
async function genesysGetAllPages(region, token, path, pageSize = 100) {
  let page = 1;
  let all  = [];
  while (true) {
    const sep      = path.includes("?") ? "&" : "?";
    const fullPath = `${path}${sep}pageSize=${pageSize}&pageNumber=${page}`;
    const resp     = await genesysGet(region, token, fullPath);
    const items    = resp.entities || [];
    all            = all.concat(items);
    if (items.length < pageSize || page >= (resp.pageCount ?? page)) break;
    page++;
  }
  return all;
}

/** Safely get a nested value by dot-path, returning fallback on any miss. */
function get(obj, path, fallback = "") {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur ?? fallback;
}

/** Join array items as comma-separated string; return "" for non-arrays. */
function joinArr(arr, key) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr.map((i) => (key ? (i[key] ?? i) : i)).join(", ");
}

/** Ms → "Xs". Returns "" for falsy. */
function msToSecs(ms) {
  if (!ms && ms !== 0) return "";
  return `${Math.round(ms / 1000)}s`;
}

/** Percentage as "X%". */
function pct(v) {
  if (v == null) return "";
  return `${Math.round(v * 100)}%`;
}

/** Safe wrap to handle 403/404 — returns { error } if caught. */
async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: err.message, status: err.status };
  }
}

// ─────────────────────────────────────────────────────────
// Cover sheet builder
// ─────────────────────────────────────────────────────────

/**
 * Build the "Index" cover sheet and insert it at position 0 in the workbook.
 *
 * @param {object}   wb        xlsx workbook
 * @param {string}   orgName   Organisation friendly name
 * @param {string}   tsStr     Formatted timestamp string (DD-MM-YYYY HH:MM:SS)
 * @param {object[]} inventory [{name, status}] for each sheet added to the workbook
 */
function buildCoverSheet(wb, orgName, tsStr, inventory) {
  const ws = {};

  const setCell = (addr, value, style, link) => {
    ws[addr] = { v: value, t: typeof value === "number" ? "n" : "s" };
    if (style) ws[addr].s = style;
    if (link)  ws[addr].l = { Target: link };
  };

  // Row 1: Title
  setCell("A1", "GENESYS CLOUD CONFIGURATION DOCUMENTATION", {
    font:      { sz: 18, bold: true, color: { rgb: "366092" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  });

  // Row 3: Organisation
  setCell("A3", "Organization:", {
    font:      { sz: 12, bold: true, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  });
  setCell("B3", orgName, {
    font:      { sz: 12, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  });

  // Row 4: Generated timestamp
  setCell("A4", "Generated:", {
    font:      { sz: 12, bold: true, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  });
  setCell("B4", tsStr, {
    font:      { sz: 12, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  });

  // Row 6: Separator
  setCell("A6", "-".repeat(80), {
    font:      { sz: 11, color: { rgb: "366092" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  });

  // Row 8: Section heading
  setCell("A8", "TABLE OF CONTENTS", {
    font:      { sz: 14, bold: true, color: { rgb: "366092" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
  });

  // Row 10: Column headers
  const hdrs = ["Sheet Name", "Status", "Description"];
  ["A10", "B10", "C10"].forEach((addr, i) => {
    setCell(addr, hdrs[i], {
      fill:      { fgColor: { rgb: "366092" } },
      font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
      alignment: { horizontal: "center", vertical: "center" },
      border:    CS_THIN,
    });
  });

  // Rows 11+: inventory
  inventory.forEach((item, idx) => {
    const row   = 11 + idx;
    const desc  = SHEET_DESCRIPTIONS[item.name] || "";

    // Column A – hyperlink
    const linkStyle = {
      font:      { sz: 11, color: { rgb: "0563C1" }, underline: true, name: "Calibri" },
      alignment: { horizontal: "left", vertical: "center" },
      border:    CS_THIN,
    };
    setCell(`A${row}`, item.name, linkStyle, sheetHref(item.name));

    // Column B – status
    let statusStyle;
    let statusText;
    if (item.status === "data") {
      statusText  = "OK";
      statusStyle = { font: { sz: 11, bold: true, color: { rgb: "008000" }, name: "Calibri" }, alignment: { horizontal: "center", vertical: "center" }, border: CS_THIN };
    } else if (item.status === "error") {
      statusText  = "ERROR";
      statusStyle = { font: { sz: 11, bold: true, color: { rgb: "FF0000" }, name: "Calibri" }, alignment: { horizontal: "center", vertical: "center" }, border: CS_THIN };
    } else {
      statusText  = "SKIP";
      statusStyle = { font: { sz: 11, color: { rgb: "999999" }, name: "Calibri" }, alignment: { horizontal: "center", vertical: "center" }, border: CS_THIN };
    }
    setCell(`B${row}`, statusText, statusStyle);

    // Column C – description
    setCell(`C${row}`, desc, {
      font:      { sz: 10, name: "Calibri" },
      alignment: { horizontal: "left", vertical: "center" },
      border:    CS_THIN,
    });
  });

  // Sheet range
  const lastRow = 10 + inventory.length;
  ws["!ref"] = `A1:C${lastRow}`;

  // Column widths
  ws["!cols"] = [{ wch: 35 }, { wch: 10 }, { wch: 80 }];

  // Row heights – row 1 (index 0) taller
  ws["!rows"] = [{ hpt: 25 }];

  // Hide grid lines
  ws["!views"] = [{ showGridLines: false }];

  // Insert at position 0
  wb.SheetNames.unshift("Index");
  wb.Sheets["Index"] = ws;
}

// ─────────────────────────────────────────────────────────
// Fetch functions — one per sheet group
// ─────────────────────────────────────────────────────────

async function fetchQueues(region, token) {
  const headers = [
    "Queue ID","Name","Description","Division","Member Count","User Members","Joined Members",
    "Skill Evaluation","Scoring Method","Auto Answer Only","Suppress Recording",
    "ACW Timeout","ACW Wrapup Prompt",
    "Call - Alerting Timeout","Call - Service Level Duration","Call - Service Level %",
    "Chat - Alerting Timeout","Chat - Service Level Duration","Chat - Service Level %",
    "Email - Alerting Timeout","Email - Service Level Duration","Email - Service Level %",
    "Message - Alerting Timeout","Message - Service Level Duration","Message - Service Level %",
    "Callback - Alerting Timeout","Callback - Service Level Duration","Callback - Service Level %",
    "Callback Mode","Callback Auto Dial/End","Outbound Email","SMS Address","WhatsApp Recipient",
    "Open Messaging","In Queue Flow","Email In Queue Flow","Message In Queue Flow",
    "Default Scripts","Routing Rules Count","Whisper Prompt","On Hold Prompt",
    "Calling Party Name","Calling Party Number",
  ];

  const queueList = await genesysGetAllPages(region, token, "/api/v2/routing/queues", 100);

  // Build script id → name map
  let scriptMap = {};
  try {
    const scripts = await genesysGetAllPages(region, token, "/api/v2/scripts", 100);
    for (const s of scripts) scriptMap[s.id] = s.name;
  } catch (_) { /* skip */ }

  const rows = queueList.map((q) => {
    const ms = (type, field) => {
      const node = q.mediaSettings?.[type];
      if (!node) return "";
      if (field === "alerting") return node.alertingTimeoutSeconds ?? "";
      if (field === "slDur")    return node.serviceLevel?.durationMs ? msToSecs(node.serviceLevel.durationMs) : "";
      if (field === "slPct")    return node.serviceLevel?.percentage != null ? pct(q.mediaSettings[type].serviceLevel.percentage) : "";
      return "";
    };

    // Default scripts: "mediaType: scriptName; ..."
    const scriptStr = Object.entries(q.defaultScripts || {})
      .filter(([, s]) => s && s.id && scriptMap[s.id])
      .map(([type, s]) => `${type}: ${scriptMap[s.id]}`)
      .join("; ");

    // Outbound email: combine route.pattern @ domain.id
    let outboundEmail = "";
    const obe = q.outboundEmailAddress;
    if (obe) {
      const routePattern = obe.route?.pattern || "";
      const domainId = obe.domain?.id || "";
      if (routePattern && domainId) outboundEmail = `${routePattern}@${domainId}`;
      else if (domainId) outboundEmail = domainId;
      else if (routePattern) outboundEmail = routePattern;
    }

    // Outbound messaging addresses
    const obm = q.outboundMessagingAddresses;

    return [
      q.id, q.name, q.description || "", q.division?.name || "",
      q.memberCount ?? "", q.userMemberCount ?? "", q.joinedMemberCount ?? "",
      q.skillEvaluationMethod || "", q.scoringMethod || "",
      q.autoAnswerOnly ?? "", q.suppressInQueueCallRecording ?? "",
      q.acwSettings?.timeoutMs ? msToSecs(q.acwSettings.timeoutMs) : "",
      q.acwSettings?.wrapupPrompt || "",
      ms("call","alerting"), ms("call","slDur"), ms("call","slPct"),
      ms("chat","alerting"), ms("chat","slDur"), ms("chat","slPct"),
      ms("email","alerting"), ms("email","slDur"), ms("email","slPct"),
      ms("message","alerting"), ms("message","slDur"), ms("message","slPct"),
      ms("callback","alerting"), ms("callback","slDur"), ms("callback","slPct"),
      q.mediaSettings?.callback?.mode || "",
      q.mediaSettings?.callback?.enableAutoDialAndEnd ?? "",
      outboundEmail,
      obm?.smsAddress?.name || "",
      obm?.whatsAppRecipient?.name || "",
      obm?.openMessagingRecipient?.name || "",
      q.queueFlow?.name || "",
      q.emailInQueueFlow?.name || "",
      q.messageInQueueFlow?.name || "",
      scriptStr,
      q.routingRules?.length ?? 0,
      q.whisperPrompt?.name || "",
      q.onHoldPrompt?.name || "",
      q.callingPartyName || "",
      q.callingPartyNumber || "",
    ];
  });

  return { headers, rows };
}

async function fetchUsers(region, token) {
  const headers = ["Id","Name","Email","Division","Work Phone","Extension","Title","Department","Station","Skills","Languages"];

  let stationMap = {};
  try {
    const stations = await genesysGetAllPages(region, token, "/api/v2/stations", 100);
    for (const s of stations) stationMap[s.id] = s.name;
  } catch (_) { /* skip */ }

  const users = await genesysGetAllPages(
    region, token,
    "/api/v2/users?state=active&expand=skills,languages,station,division",
    100
  );

  const rows = users.map((u) => {
    const skills    = (u.skills  || []).map((s) => s.name).join(", ");
    const languages = (u.languages || []).map((l) => l.name).join(", ");
    const stationId = u.station?.effectiveStation?.id;
    const station   = stationId ? (stationMap[stationId] || stationId) : "";

    return [
      u.id, u.name, u.email,
      u.division?.name || "",
      u.addresses?.find((a) => a.type === "PHONE")?.display || "",
      u.username || "",
      u.title || "", u.department || "",
      station, skills, languages,
    ];
  });

  return { headers, rows };
}

async function fetchCallRouting(region, token) {
  const headers = ["Name","Division","DNIS","Open Hours Flow","Closed Hours Flow","Holiday Hours Flow","Schedule Group"];
  const ivrs = await genesysGetAllPages(region, token, "/api/v2/architect/ivrs", 100);

  const rows = ivrs.map((ivr) => [
    ivr.name,
    ivr.division?.name || "",
    joinArr(ivr.dnis),
    ivr.openHoursFlow?.name || "",
    ivr.closedHoursFlow?.name || "",
    ivr.holidayHoursFlow?.name || "",
    ivr.scheduleGroup?.name || "",
  ]);

  return { headers, rows };
}

async function fetchWrapupCodes(region, token) {
  const headers = ["Name","Division","Description"];
  const codes = await genesysGetAllPages(region, token, "/api/v2/routing/wrapupcodes", 100);
  const rows = codes.map((c) => [c.name, c.division?.name || "", c.description || ""]);
  return { headers, rows };
}

async function fetchTriggers(region, token) {
  const headers = ["Name","Topic Name","Target Type","Flow Name","Enabled"];

  // Build flow id → name map (include deleted flows for trigger lookups)
  let flowMap = {};
  try {
    const flows = await genesysGetAllPages(region, token, "/api/v2/flows", 100);
    for (const f of flows) flowMap[f.id] = f.name;
  } catch (_) { /* skip */ }

  const resp = await genesysGet(region, token, "/api/v2/processautomation/triggers?pageSize=200");
  const triggers = resp.entities || [];

  const rows = triggers.map((t) => {
    const flowId = t.target?.id;
    const flowName = flowId ? (flowMap[flowId] || "") : "";
    return [t.name, t.topicName || "", t.target?.type || "", flowName, t.enabled != null ? String(t.enabled) : ""];
  });

  return { headers, rows };
}

async function fetchTrunks(region, token) {
  const headers = ["Name","Type","State","Protocol","Recording","Metabase","Site","Description"];
  const trunks = await genesysGetAllPages(
    region, token,
    "/api/v2/telephony/providers/edges/trunkbasesettings", 100
  );

  const rows = trunks.map((t) => {
    const props    = t.properties || {};
    const protocol = (props["trunk.connection.transport"]?.value?.instance || "").toUpperCase();
    const recording = props["trunk.media.mediaRecording.enabled"]?.value?.instance
      ? "Enabled" : "Disabled";

    return [
      t.name,
      t.trunkType || "",
      t.state || "",
      protocol,
      recording,
      t.trunkMetabase?.name || "",
      t.site?.name || "",
      t.description || "",
    ];
  });

  return { headers, rows };
}

async function fetchDataActions(region, token) {
  const headers = ["ID","Name","Category"];
  const actions = await genesysGetAllPages(region, token, "/api/v2/integrations/actions", 100);
  const rows = actions.map((a) => [a.id, a.name, a.category || ""]);
  return { headers, rows };
}

async function fetchIntegrations(region, token) {
  const headers = ["ID","Name","Integration Type","Notes","Intended State","Reported State"];
  const integrations = await genesysGetAllPages(region, token, "/api/v2/integrations", 100);
  const rows = integrations.map((i) => [
    i.id, i.name,
    i.integrationType?.id || "",
    i.notes || "",
    i.intendedState || "",
    i.reportedState?.code || "",
  ]);
  return { headers, rows };
}

async function fetchDIDPools(region, token) {
  const headers = ["ID","Description","State","Start Phone Number","End Phone Number","Phone Number Count","Comments"];
  const pools = await genesysGetAllPages(region, token, "/api/v2/telephony/providers/edges/didpools", 100);
  const rows = pools.map((p) => [
    p.id, p.description || "", p.state || "",
    p.startPhoneNumber || "", p.endPhoneNumber || "",
    p.phoneNumberCount ?? "", p.comments || "",
  ]);
  return { headers, rows };
}

async function fetchDIDNumbers(region, token) {
  const headers = ["Number","Assigned","Assignee","Assignee Type"];
  const dids = await genesysGetAllPages(region, token, "/api/v2/telephony/providers/edges/dids", 100);
  const rows = dids.map((d) => [
    d.phoneNumber || "", d.assigned ?? "",
    d.owner?.name || "", d.ownerType || "",
  ]);
  return { headers, rows };
}

async function fetchPolicies(region, token) {
  const headers = [
    "ID","Name","Description","Enabled","Active Media Types",
    "Call Policy","Email Policy","Chat Policy","Message Policy",
    "Retention Action","Retention Days","Archive Days",
    "Has Retention Duration","Retention Notes",
    "Has Evaluations","Has Surveys","Survey Count","Evaluator Count",
    "Target Queues","Target Users","Target Wrapup Codes","Directions Filter",
  ];
  const policies = await genesysGetAllPages(region, token, "/api/v2/recording/mediaretentionpolicies", 100);

  // Build queue and wrapup-code lookups (like Python)
  let queueLookup = {};
  try {
    const queues = await genesysGetAllPages(region, token, "/api/v2/routing/queues", 100);
    for (const q of queues) queueLookup[q.id] = q.name;
  } catch (_) { /* skip */ }

  let wrapupLookup = {};
  try {
    const codes = await genesysGetAllPages(region, token, "/api/v2/routing/wrapupcodes", 100);
    for (const c of codes) wrapupLookup[c.id] = c.name;
  } catch (_) { /* skip */ }

  const rows = policies.map((p) => {
    const mp = p.mediaPolicies || {};
    const activeMedia = [];
    let hasCall = false, hasEmail = false, hasChat = false, hasMessage = false;

    const retentionActions = new Set();
    const retentionDaysList = [];
    const archiveDaysList = [];
    let hasRetentionDuration = false;
    const retentionNotesParts = [];

    let hasEvaluations = false;
    let hasSurveys = false;
    let surveyCount = 0;
    let evaluatorCount = 0;

    const targetQueues = new Set();
    let targetUsersCount = 0;
    const targetWrapupCodes = new Set();
    const directionsSet = new Set();

    // Process a single media sub-policy (call, email, chat, message)
    const processMediaPolicy = (subPolicy, mediaName) => {
      if (!subPolicy) return false;

      const actions = subPolicy.actions;
      if (actions) {
        if (actions.retainRecording) retentionActions.add("Retain");
        if (actions.deleteRecording) retentionActions.add("Delete");
        if (actions.alwaysDelete)    retentionActions.add("Always Delete");

        if (actions.retentionDuration) {
          hasRetentionDuration = true;
          const rd = actions.retentionDuration;
          if (rd.deleteRetention?.days)  retentionDaysList.push([mediaName, rd.deleteRetention.days]);
          if (rd.archiveRetention?.days) archiveDaysList.push([mediaName, rd.archiveRetention.days]);
        }

        if (actions.assignEvaluations || actions.assignMeteredEvaluations || actions.assignMeteredAssignmentByAgent) {
          hasEvaluations = true;
          if (actions.assignMeteredEvaluations) {
            for (const evalObj of actions.assignMeteredEvaluations) {
              if (evalObj.evaluators) evaluatorCount += evalObj.evaluators.length;
            }
          }
        }

        if (actions.assignSurveys?.length) {
          hasSurveys = true;
          surveyCount += actions.assignSurveys.length;
        }
      }

      const conditions = subPolicy.conditions;
      if (conditions) {
        if (conditions.forQueues) {
          for (const q of conditions.forQueues) {
            if (q.id) targetQueues.add(queueLookup[q.id] || q.id);
          }
        }
        if (conditions.forUsers) targetUsersCount += conditions.forUsers.length;
        if (conditions.wrapupCodes) {
          for (const w of conditions.wrapupCodes) {
            if (w.id) targetWrapupCodes.add(wrapupLookup[w.id] || w.id);
          }
        }
        if (conditions.directions) {
          for (const d of conditions.directions) directionsSet.add(d);
        }
      }

      return true;
    };

    if (processMediaPolicy(mp.callPolicy,    "Call"))    { hasCall    = true; activeMedia.push("Call"); }
    if (processMediaPolicy(mp.emailPolicy,   "Email"))   { hasEmail   = true; activeMedia.push("Email"); }
    if (processMediaPolicy(mp.chatPolicy,    "Chat"))    { hasChat    = true; activeMedia.push("Chat"); }
    if (processMediaPolicy(mp.messagePolicy, "Message")) { hasMessage = true; activeMedia.push("Message"); }

    // Aggregate retention days — if all same show number, else put details in notes
    let retentionDays = "";
    if (retentionDaysList.length) {
      const uniqueDays = new Set(retentionDaysList.map(([, d]) => d));
      if (uniqueDays.size === 1) {
        retentionDays = [...uniqueDays][0];
      } else {
        for (const [media, days] of retentionDaysList) retentionNotesParts.push(`${media}: ${days} days delete`);
      }
    }

    let archiveDays = "";
    if (archiveDaysList.length) {
      const uniqueDays = new Set(archiveDaysList.map(([, d]) => d));
      if (uniqueDays.size === 1) {
        archiveDays = [...uniqueDays][0];
      } else {
        for (const [media, days] of archiveDaysList) retentionNotesParts.push(`${media}: ${days} days archive`);
      }
    }

    const retentionNotes   = retentionNotesParts.join("; ");
    const targetQueuesStr  = targetQueues.size       ? [...targetQueues].sort().join(", ") : "All";
    const targetUsersStr   = targetUsersCount > 0    ? `${targetUsersCount} users` : "";
    const targetWrapupStr  = targetWrapupCodes.size  ? [...targetWrapupCodes].sort().join(", ") : "";
    const directionsStr    = directionsSet.size      ? [...directionsSet].sort().join(", ") : "";

    return [
      p.id, p.name, p.description || "",
      p.enabled ?? false,
      activeMedia.join(", "),
      hasCall, hasEmail, hasChat, hasMessage,
      [...retentionActions].sort().join(", "),
      retentionDays,
      archiveDays,
      hasRetentionDuration,
      retentionNotes,
      hasEvaluations,
      hasSurveys,
      surveyCount,
      evaluatorCount,
      targetQueuesStr,
      targetUsersStr,
      targetWrapupStr,
      directionsStr,
    ];
  });

  return { headers, rows };
}

async function fetchDBSchemas(region, token) {
  const headers = ["Table Name","Table Division","Property Name","Property Title","Property Type","Display Order"];
  const tables = await genesysGetAllPages(
    region, token,
    "/api/v2/flows/datatables?expand=schema",
    100
  );

  const rows = [];
  for (const table of tables) {
    const props = table.schema?.properties || {};
    for (const [pName, pDef] of Object.entries(props)) {
      rows.push([
        table.name,
        table.division?.name || "",
        pName,
        pDef.title || "",
        pDef.type  || "",
        pDef.displayOrder ?? "",
      ]);
    }
  }

  return { headers, rows };
}

async function fetchFlowOutcomes(region, token) {
  const headers = ["Name","Description","Division"];
  const items = await genesysGetAllPages(region, token, "/api/v2/flows/outcomes", 100);
  const rows = items.map((i) => [i.name, i.description || "", i.division?.name || ""]);
  return { headers, rows };
}

async function fetchFlowMilestones(region, token) {
  const headers = ["Name","Description","Division"];
  const items = await genesysGetAllPages(region, token, "/api/v2/flows/milestones", 100);
  const rows = items.map((i) => [i.name, i.description || "", i.division?.name || ""]);
  return { headers, rows };
}

async function fetchFlows(region, token) {
  const headers = ["Name","Division","Description","Type","Active","Created By","Date Created","Version","Secure","Virtual Agent","Agentic Virtual Agent"];
  const flows = await genesysGetAllPages(region, token, "/api/v2/flows?deleted=false", 100);

  const rows = flows.map((f) => {
    const pv = f.publishedVersion;
    const dc = pv?.dateCreated;
    return [
      f.name,
      f.division?.name || "",
      f.description || "",
      f.type || "",
      f.active != null ? (f.active ? "True" : "False") : "",
      pv?.createdBy?.name || "",
      dc ? formatTs(new Date(dc)) : "",
      pv?.name || "",
      pv?.secure != null ? (pv.secure ? "True" : "False") : "",
      f.virtualAgentEnabled != null ? (f.virtualAgentEnabled ? "True" : "False") : "",
      f.agenticVirtualAgentEnabled != null ? (f.agenticVirtualAgentEnabled ? "True" : "False") : "",
    ];
  });

  return { headers, rows };
}

async function fetchMessageRouting(region, token) {
  const headers = ["Name","Type","Flow","Active"];
  const items = await genesysGetAllPages(region, token, "/api/v2/routing/message/recipients", 100);
  const rows = items.map((r) => [
    r.name,
    r.messengerType || "",
    r.flow?.name || "",
    r.flow?.active != null ? (r.flow.active ? "True" : "False") : "",
  ]);
  return { headers, rows };
}

async function fetchMessengerConfigurations(region, token) {
  const headers = [
    "Name","Description","Version","Status","Languages","Default Language",
    "Messenger Enabled","Cobrowse Enabled","Journey Events Enabled",
    "Authentication Enabled","Headless Mode Enabled","Support Center Enabled","Position Alignment",
  ];
  const resp = await genesysGet(region, token, "/api/v2/webdeployments/configurations?showOnlyPublished=true");
  const items = resp.entities || [];

  const rows = items.map((c) => [
    c.name, c.description || "",
    c.version || "", c.status || "",
    joinArr(c.languages || []),
    c.defaultLanguage || "",
    c.messenger?.enabled != null ? (c.messenger.enabled ? "True" : "False") : "",
    c.cobrowse?.enabled != null ? (c.cobrowse.enabled ? "True" : "False") : "",
    c.journeyEvents?.enabled != null ? (c.journeyEvents.enabled ? "True" : "False") : "",
    c.authenticationSettings?.enabled != null ? (c.authenticationSettings.enabled ? "True" : "False") : "",
    c.headlessMode?.enabled != null ? (c.headlessMode.enabled ? "True" : "False") : "",
    c.supportCenter ? "True" : "False",
    c.position?.alignment || "",
  ]);

  return { headers, rows };
}

async function fetchMessengerDeployments(region, token) {
  const headers = ["Name","Description","Status","Configuration Name","Configuration Version","Flow Name","Allow All Domains","Supported Content ID"];
  const resp = await genesysGet(region, token, "/api/v2/webdeployments/deployments");
  const items = resp.entities || [];

  const rows = items.map((d) => [
    d.name, d.description || "", d.status || "",
    d.configuration?.name || "",
    d.configuration?.version != null ? String(d.configuration.version) : "",
    d.flow?.name || "",
    d.allowAllDomains != null ? (d.allowAllDomains ? "True" : "False") : "",
    d.supportedContent?.id || "",
  ]);

  return { headers, rows };
}

async function fetchSchedules(region, token) {
  const headers = ["ID","Name","Description","Division","State","Start","End","Recurrence Rule"];
  const items = await genesysGetAllPages(region, token, "/api/v2/architect/schedules", 100);

  const fmtDt = (v) => { if (!v) return ""; try { const d = new Date(v); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`; } catch(_) { return String(v); } };

  const rows = items.map((s) => [
    s.id, s.name, s.description || "",
    s.division?.name || "", s.state || "",
    fmtDt(s.start), fmtDt(s.end), s.rrule || "",
  ]);

  return { headers, rows };
}

async function fetchScheduleGroups(region, token) {
  const headers = ["ID","Name","Description","Division","State","Time Zone","Open Schedules","Closed Schedules","Holiday Schedules"];
  const items = await genesysGetAllPages(region, token, "/api/v2/architect/schedulegroups", 100);

  const rows = items.map((g) => [
    g.id, g.name, g.description || "",
    g.division?.name || "", g.state || "", g.timeZone || "",
    joinArr(g.openSchedules,    "name"),
    joinArr(g.closedSchedules,  "name"),
    joinArr(g.holidaySchedules, "name"),
  ]);

  return { headers, rows };
}

async function fetchUserPrompts(region, token) {
  const headers = ["Prompt Name","Language","Duration in Seconds","TTS","TTS Text"];
  const prompts = await genesysGetAllPages(region, token, "/api/v2/architect/prompts", 100);

  const rows = [];
  for (const p of prompts) {
    const resources = p.resources || [];
    if (resources.length > 0) {
      for (const r of resources) {
        rows.push([
          p.name,
          r.language || "",
          r.durationSeconds ?? "",
          r.ttsString ? true : false,
          r.ttsString || "",
        ]);
      }
    }
  }

  return { headers, rows };
}

async function fetchEmail(region, token) {
  const domainHeaders = ["Domain","MX Record Status","Type"];
  const addrHeaders   = [
    "Email Address","Domain","From Name","Queue","Flow","Spam Flow",
    "Multiple Actions","Priority","Language","Auto BCC","Reply-To","Skills","Signature",
  ];

  // Fetch inbound and outbound domains
  const [inboundResp, outboundResp] = await Promise.allSettled([
    genesysGet(region, token, "/api/v2/routing/email/domains"),
    genesysGet(region, token, "/api/v2/routing/email/outbound/domains"),
  ]);

  const inbound  = inboundResp.status  === "fulfilled" ? (inboundResp.value.entities  || inboundResp.value  || []) : [];
  const outbound = outboundResp.status === "fulfilled" ? (outboundResp.value.entities || outboundResp.value || []) : [];

  // Build domain rows — differentiate Genesys Cloud vs Custom vs Campaigns
  const domainRows = [
    ...inbound.map((d)  => [d.id || d.name, d.mxRecordStatus || "", d.subDomain ? "Genesys Cloud Domain" : "Custom Domain"]),
    ...outbound.map((d) => [d.id || d.name, "",                      "Campaigns/Agentless"]),
  ];

  // Signature cache: canned response id → name
  const sigCache = {};
  const resolveSignature = async (sig) => {
    if (!sig) return "";
    const cid = sig.cannedResponseId;
    if (!cid) return "";
    if (sigCache[cid] !== undefined) return sigCache[cid];
    try {
      const resp = await genesysGet(region, token, `/api/v2/responsemanagement/responses/${cid}`);
      sigCache[cid] = resp.name || cid;
    } catch (_) {
      sigCache[cid] = cid;
    }
    return sigCache[cid];
  };

  // Fetch routes per inbound domain
  const addrRows = [];
  for (const domain of inbound) {
    try {
      const routes = await genesysGetAllPages(
        region, token,
        `/api/v2/routing/email/domains/${domain.id}/routes`,
        100
      );
      for (const r of routes) {
        const sigName = await resolveSignature(r.signature);

        // Reply-to: construct pattern@domain like Python
        let replyTo = "";
        const rea = r.replyEmailAddress;
        if (rea) {
          const rp = rea.route?.pattern || "";
          const rd = rea.domain?.id || "";
          if (rp && rd) replyTo = `${rp}@${rd}`;
          else if (rd) replyTo = rd;
          else if (rp) replyTo = rp;
        }

        // Auto BCC: array of email addresses
        let autoBccStr = "";
        if (Array.isArray(r.autoBcc) && r.autoBcc.length) {
          autoBccStr = r.autoBcc.map((b) => (typeof b === "string" ? b : b.email || String(b))).join(", ");
        }

        addrRows.push([
          `${r.pattern || "unknown"}@${domain.id}`,
          domain.id,
          r.fromName || "",
          r.queue?.name || "",
          r.flow?.name  || "",
          r.spamFlow?.name || "",
          r.allowMultipleActions ?? false,
          r.priority ?? "",
          r.language?.name || "",
          autoBccStr,
          replyTo,
          joinArr(r.skills, "name"),
          sigName,
        ]);
      }
    } catch (_) { /* skip domain */ }
  }

  return {
    domains: { headers: domainHeaders, rows: domainRows },
    addresses: { headers: addrHeaders, rows: addrRows },
  };
}

async function fetchSites(region, token) {
  const siteHeaders  = ["Site Name","Site ID","Location","Media Model","Media Regions","Core Site","Managed","State","Edge Count","Outbound Route Count"];
  const routeHeaders = ["Site Name","Route Name","Route ID","Description","Enabled","State","Distribution","Classification Types","Trunk Count","Trunk Names","Trunk IDs"];
  const planHeaders  = ["Site Name","Plan Name","Classification","Match Type","Priority","State","Numbers","Digit Length","Match Pattern","Normalized Format"];

  const sites = await genesysGetAllPages(region, token, "/api/v2/telephony/providers/edges/sites", 100);

  const siteRows  = [];
  const routeRows = [];
  const planRows  = [];

  // Sequential per-site calls (Python does this sequentially)
  for (const site of sites) {
    const mediaRegions = joinArr(site.mediaRegions || []);

    siteRows.push([
      site.name, site.id,
      site.location?.name || "",
      site.mediaModel || "",
      mediaRegions,
      site.coreSite ? "True" : "False",
      site.managed != null ? (site.managed ? "True" : "False") : "",
      site.state || "",
      (site.edges || []).length,
      0, // placeholder, filled below
    ]);
    const siteRowIdx = siteRows.length - 1;

    // Outbound routes
    try {
      const routes = await genesysGet(region, token, `/api/v2/telephony/providers/edges/sites/${site.id}/outboundroutes`);
      const routeList = routes.entities || routes || [];
      siteRows[siteRowIdx][9] = routeList.length; // update route count

      for (const r of routeList) {
        const trunks = r.externalTrunkBases || [];
        routeRows.push([
          site.name,
          r.name, r.id,
          r.description || "",
          r.enabled != null ? (r.enabled ? "True" : "False") : "",
          r.state || "",
          r.distribution || "",
          joinArr(r.classificationTypes || []),
          trunks.length,
          trunks.map((t) => t.name).join(", "),
          trunks.map((t) => t.id).join(", "),
        ]);
      }
    } catch (_) { /* skip routes for this site */ }

    // Number plans
    try {
      const plans = await genesysGet(region, token, `/api/v2/telephony/providers/edges/sites/${site.id}/numberplans`);
      const planList = Array.isArray(plans) ? plans : (plans.entities || []);

      for (const np of planList) {
        const numbersStr = (np.numbers || []).map((n) => n.start || "").join(", ");
        let digitLen = "";
        if (np.digitLength) {
          digitLen = np.digitLength.start && np.digitLength.end
            ? `${np.digitLength.start}-${np.digitLength.end}`
            : String(np.digitLength.start || "");
        }
        planRows.push([
          site.name,
          np.name, np.classification || "",
          np.matchType || "",
          np.priority ?? "",
          np.state || "",
          numbersStr, digitLen,
          np.match || "",
          np.normalizedFormat || "",
        ]);
      }
    } catch (_) { /* skip plans for this site */ }
  }

  return {
    sites:          { headers: siteHeaders,  rows: siteRows  },
    outboundRoutes: { headers: routeHeaders, rows: routeRows },
    numberPlans:    { headers: planHeaders,  rows: planRows  },
  };
}

async function fetchAgentCopilots(region, token) {
  const copilotsHeaders = [
    "Assistant Name","Assistant ID","State","Queue Name","Media Types",
    "Copilot Enabled","Language","NLU Engine Type","Live On Queue",
    "NLU Domain ID","Intent Confidence Threshold","Transcription Vendor",
    "Knowledge Vendor","Knowledge Base IDs","Rules Count","Fallback Enabled",
  ];
  const rulesHeaders = [
    "Assistant Name","Assistant ID","Rule ID","Enabled",
    "Condition Type","Condition Values","Action Type","Action Attributes","Participant Role",
  ];

  // Raw API call for assistants with copilot expanded.
  // Must be raw (not SDK) so participantRoles and other fields are not stripped.
  const assistantsResp = await genesysGet(region, token, "/api/v2/assistants?pageSize=100&expand=copilot");
  const assistants = assistantsResp.entities || [];

  // Queue assignments from /api/v2/assistants/queues.
  // Each entity returned is: { id: <queueId>, name: <queueName>,
  //   assistant: { id: <assistantId> }, mediaTypes: [...] }
  let assignmentMap = {}; // assistantId → [{ queueName, mediaTypes }]
  try {
    const assignResp = await genesysGet(region, token, "/api/v2/assistants/queues?pageSize=500");
    for (const entry of (assignResp.entities || [])) {
      const aid = entry.assistant?.id;
      if (!aid) continue;
      if (!assignmentMap[aid]) assignmentMap[aid] = [];
      assignmentMap[aid].push({
        queueName:  entry.name || entry.id || "No Queue Assignment",
        mediaTypes: joinArr(entry.mediaTypes || []),
      });
    }
  } catch (_) { /* skip — unassigned assistants still appear, just with no queue */ }

  const copilotsRows = [];
  const rulesRows    = [];

  for (const a of assistants) {
    const copilot        = a.copilot                  || {};
    const nluConfig      = copilot.nluConfig           || {};
    const ruleConfig     = copilot.ruleEngineConfig    || {};
    const transConfig    = a.transcriptionConfig       || {}; // lives on assistant, not copilot
    const knowledgeCfg   = a.knowledgeSuggestionConfig || {}; // lives on assistant, not copilot

    // NLU Domain ID is a nested object: nluConfig.domain.id
    const nluDomainId = (typeof nluConfig.domain === "object")
      ? (nluConfig.domain?.id || "")
      : (nluConfig.domain    || "");

    // Knowledge base IDs from assistant.knowledgeSuggestionConfig.knowledgeBases[]
    const kbIds = (knowledgeCfg.knowledgeBases || [])
      .map((kb) => (typeof kb === "object" ? kb.id : kb) || "")
      .filter(Boolean)
      .join(", ");

    const rules    = ruleConfig.rules   || [];
    const fallback = ruleConfig.fallback || {};

    // Queue assignments — default to one "no assignment" row for unassigned assistants
    const assignments = assignmentMap[a.id] || [{ queueName: "No Queue Assignment", mediaTypes: "" }];

    // Language expansion: use copilot.languages[] when present, else [defaultLanguage] or [""]
    const languages = Array.isArray(copilot.languages) && copilot.languages.length > 0
      ? copilot.languages
      : [copilot.defaultLanguage || ""];

    // 1 row per queue × language combination
    for (const assign of assignments) {
      for (const lang of languages) {
        copilotsRows.push([
          a.name  || "", a.id || "",
          a.state || "",
          assign.queueName,
          assign.mediaTypes,
          copilot.enabled ?? "",
          lang,
          copilot.nluEngineType || "", // nluEngineType is directly on copilot, not inside nluConfig
          copilot.liveOnQueue   ?? "",
          nluDomainId,
          nluConfig.intentConfidenceThreshold ?? "",
          transConfig.vendorName   || "",
          knowledgeCfg.vendorName  || "",
          kbIds,
          rules.length,
          fallback.enabled ?? "",
        ]);
      }
    }

    // Rules sheet — doubly-nested: ruleOuter.rule contains conditions/actions;
    // participantRoles is at ruleOuter level (preserved by raw API call).
    for (const ruleOuter of rules) {
      const ruleInner  = ruleOuter.rule  || {};
      const conditions = ruleInner.conditions || [];
      const actions    = ruleInner.actions    || [];

      const condTypes = conditions.map((c) => c.conditionType || "").join(", ");
      const condVals  = conditions.flatMap((c) => c.conditionValues || []).join(", ");

      const actTypes = actions.map((a) => a.actionType || "").join(", ");
      const actAttrs = actions.flatMap((a) => {
        const attrs = a.attributes || {};
        return Object.entries(attrs).map(([k, v]) => `${k}:${v}`);
      }).join(", ");

      const participantRoles = joinArr(ruleOuter.participantRoles || []);

      rulesRows.push([
        a.name || "", a.id || "",
        ruleOuter.id || "", ruleOuter.enabled ?? "",
        condTypes, condVals,
        actTypes, actAttrs,
        participantRoles,
      ]);
    }
  }

  return {
    copilots: { headers: copilotsHeaders, rows: copilotsRows },
    rules:    { headers: rulesHeaders,    rows: rulesRows    },
  };
}

async function fetchOAuthClients(region, token) {
  const scopeHeaders = ["ID","Name","Description","State","Token Duration (sec)","Grant Type","Created By","Modified By","Scope","Redirect URIs"];
  const ccHeaders    = ["ID","Name","Description","State","Token Duration (sec)","Grant Type","Created By","Modified By","Role","Division"];

  // All three lookups in parallel
  const [clientsResp, rolesResp, divisionsResp, usersResp] = await Promise.allSettled([
    genesysGet(region, token, "/api/v2/oauth/clients"),
    genesysGetAllPages(region, token, "/api/v2/authorization/roles", 100),
    genesysGetAllPages(region, token, "/api/v2/authorization/divisions", 100),
    genesysGetAllPages(region, token, "/api/v2/users?state=any", 100),
  ]);

  const clients  = clientsResp.status  === "fulfilled" ? (clientsResp.value.entities  || []) : [];
  const roleMap  = {};
  const divMap   = {};
  const userMap  = {};

  if (rolesResp.status     === "fulfilled") for (const r of rolesResp.value)     roleMap[r.id]  = r.name;
  if (divisionsResp.status === "fulfilled") for (const d of divisionsResp.value) divMap[d.id]   = d.name;
  if (usersResp.status     === "fulfilled") for (const u of usersResp.value)     userMap[u.id]  = u.name;

  const byGrant = {
    "CODE": [], "TOKEN": [], "SAML2-BEARER": [], "PASSWORD": [], "CLIENT-CREDENTIALS": [],
  };

  for (const c of clients) {
    const grantType = (c.authorizedGrantType || "").toUpperCase();
    const base = [
      c.id, c.name, c.description || "",
      c.state || "",
      c.accessTokenValiditySeconds ?? "",
      grantType,
      c.createdBy?.id ? (userMap[c.createdBy.id] || "Unknown") : "",
      c.modifiedBy?.id ? (userMap[c.modifiedBy.id] || "Unknown") : "",
    ];

    if (grantType === "CLIENT-CREDENTIALS") {
      const roles = c.roleDivisions || [];
      if (roles.length === 0) {
        byGrant["CLIENT-CREDENTIALS"].push([...base, "", ""]);
      } else {
        for (const rd of roles) {
          byGrant["CLIENT-CREDENTIALS"].push([
            ...base,
            roleMap[rd.roleId] || "Unknown Role",
            divMap[rd.divisionId] || "Unknown Division",
          ]);
        }
      }
    } else {
      const validGrants = ["CODE","TOKEN","SAML2-BEARER","PASSWORD"];
      if (!validGrants.includes(grantType)) continue; // skip unknown grant types
      const scopes      = c.scope || [];
      const redirects   = joinArr(c.registeredRedirectUri || []);

      if (scopes.length === 0) {
        byGrant[grantType].push([...base, "", redirects]);
      } else {
        for (const scope of scopes) {
          byGrant[grantType].push([...base, scope, redirects]);
        }
      }
    }
  }

  return {
    code:              { headers: scopeHeaders, rows: byGrant["CODE"]                },
    token:             { headers: scopeHeaders, rows: byGrant["TOKEN"]               },
    saml2:             { headers: scopeHeaders, rows: byGrant["SAML2-BEARER"]        },
    password:          { headers: scopeHeaders, rows: byGrant["PASSWORD"]            },
    clientCredentials: { headers: ccHeaders,    rows: byGrant["CLIENT-CREDENTIALS"]  },
  };
}

async function fetchOBCampaigns(region, token) {
  const headers = [
    "Name","Contact List","Queue","Dialing Mode","Script","Site","Abandon Rate",
    "DNC Lists","Call Analysis Response Set","Caller Name","Caller Address",
    "Outbound Line Count","Rule Sets","Skip Preview Disabled","Preview Timeout Seconds",
    "Single Number Preview","Always Running",
    "Contact Sort - Field Name","Contact Sort - Direction","Contact Sort - Numeric",
    "Contact Sorts","No Answer Timeout","Priority","Contact List Filters","Division",
    "Dynamic Queue Sort","Dynamic Queue Filter","Callback Auto Answer",
    "Dynamic Line Balancing Enabled","Diagnostics Alert","Precise Dialing Enabled",
  ];
  const campaigns = await genesysGetAllPages(region, token, "/api/v2/outbound/campaigns", 100);

  const rows = campaigns.map((c) => {
    const cs = c.contactSort || {};
    const contactSorts = c.contactSorts || [];
    const contactSortsStr = contactSorts.length
      ? contactSorts.map((s) => `${s.fieldName || ""} ${s.direction || ""} (numeric: ${s.numeric ?? ""})`).join(" | ")
      : "";
    const dynQueue = c.dynamicContactQueueingSettings || {};
    const dynLine  = c.dynamicLineBalancingSettings || {};
    const diag     = c.diagnosticsSettings || {};
    return [
      c.name,
      c.contactList?.name || "",
      c.queue?.name || "",
      c.dialingMode || "",
      c.script?.name || "",
      c.site?.name   || "",
      c.abandonRate ?? "",
      joinArr(c.dncLists, "name"),
      c.callAnalysisResponseSet?.name || "",
      c.callerName   || "",
      c.callerAddress || "",
      c.outboundLineCount ?? "",
      joinArr(c.ruleSets,  "name"),
      c.skipPreviewDisabled            ?? "",
      c.previewTimeOutSeconds          ?? "",
      c.singleNumberPreview            ?? "",
      c.alwaysRunning                  ?? "",
      cs.fieldName || "",
      cs.direction || "",
      cs.numeric   ?? "",
      contactSortsStr,
      c.noAnswerTimeout      ?? "",
      c.priority             ?? "",
      joinArr(c.contactListFilters, "name"),
      c.division?.name || "",
      dynQueue.sort   ?? "",
      dynQueue.filter ?? "",
      c.callbackAutoAnswer ?? "",
      dynLine.enabled ?? "",
      diag.reportLowMaxCallsPerAgentAlert ?? "",
      c.preciseDialingEnabled  ?? "",
    ];
  });

  return { headers, rows };
}

async function fetchOBAttemptLimits(region, token) {
  const headers = [
    "Name","ID","Time Zone","Reset Period",
    "Max Attempts Per Contact","Max Attempts Per Number",
    "Answering Machine - Attempts","Answering Machine - Minutes",
    "Busy - Attempts","Busy - Minutes",
    "Fax - Attempts","Fax - Minutes",
    "No Answer - Attempts","No Answer - Minutes",
  ];
  const items = await genesysGetAllPages(region, token, "/api/v2/outbound/attemptlimits", 100);

  const rows = items.map((a) => {
    const recalls = a.recallEntries || {};
    const re = (type, field) => (recalls[type] || {})[field] ?? "";

    return [
      a.name, a.id,
      a.timeZoneId || "",
      a.resetPeriod || "",
      a.maxAttemptsPerContact ?? "",
      a.maxAttemptsPerNumber  ?? "",
      re("answeringMachine","nbrAttempts"), re("answeringMachine","minutesBetweenAttempts"),
      re("busy",            "nbrAttempts"), re("busy",            "minutesBetweenAttempts"),
      re("fax",             "nbrAttempts"), re("fax",             "minutesBetweenAttempts"),
      re("noAnswer",        "nbrAttempts"), re("noAnswer",        "minutesBetweenAttempts"),
    ];
  });

  return { headers, rows };
}

async function fetchOBCallableTimeSets(region, token) {
  const headers = ["Name","ID","Time Zone","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  // day number (1=Mon…7=Sun) → column index in headers (0-based: Mon=3,Tue=4,…Sun=9)
  const DAY_TO_COL = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8, 7: 9 };
  const DAY_NAMES  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

  const items = await genesysGetAllPages(region, token, "/api/v2/outbound/callabletimesets", 100);

  const rows = [];
  for (const cts of items) {
    const times = cts.callableTimes || [];
    if (times.length === 0) {
      rows.push([cts.name, cts.id, "", "", "", "", "", "", "", ""]);
      continue;
    }
    for (const ct of times) {
      const cols = ["", "", "", "", "", "", "", "", "", ""];
      cols[0] = cts.name;
      cols[1] = cts.id;
      cols[2] = ct.timeZoneId || "";

      for (const slot of (ct.timeSlots || [])) {
        const ci = DAY_TO_COL[slot.day];
        if (ci == null) continue;
        const startStr = (slot.startTime || "").replace(/\.\d+$/, "");
        const stopStr  = (slot.stopTime  || "").replace(/\.\d+$/, "");
        const slotStr  = `${startStr}-${stopStr}`;
        cols[ci] = cols[ci] ? `${cols[ci]}; ${slotStr}` : slotStr;
      }

      rows.push(cols);
    }
  }

  return { headers, rows };
}

async function fetchOBCallAnalysis(region, token) {
  const headers = [
    "Name","ID","Beep Detection Enabled","AMD Speech Distinguish Enabled",
    "Live Speaker Detection Mode","Person","Machine","Busy","No Answer",
    "Fax","Disconnect","SIT Callable","SIT Uncallable","Not Found",
  ];
  const items = await genesysGetAllPages(region, token, "/api/v2/outbound/callanalysisresponsesets", 100);

  const rows = items.map((c) => {
    const r  = c.responses || {};
    const rv = (key) => {
      const reaction = r[key];
      if (!reaction) return "";
      if (typeof reaction !== "object") return String(reaction);
      const rt = reaction.reactionType || "";
      if (rt === "transfer_flow" && reaction.name) return `${rt}: ${reaction.name}`;
      return rt;
    };
    return [
      c.name, c.id,
      c.beepDetectionEnabled         ?? "",
      c.amdSpeechDistinguishEnabled  ?? "",
      c.liveSpeakerDetectionMode     || "",
      rv("callable_person"),
      rv("callable_machine"),
      rv("callable_busy"),
      rv("callable_noanswer"),
      rv("callable_fax"),
      rv("callable_disconnect"),
      rv("sit_callable"),
      rv("sit_uncallable"),
      rv("not_found"),
    ];
  });

  return { headers, rows };
}

async function fetchOBCampaignRules(region, token) {
  const headers = [
    "Name","ID","Enabled","Time Zone","Match Any Conditions",
    "Monitored Campaign Count","Monitored Campaigns","Monitored Sequence Count","Monitored Sequences",
    "Condition Count (Old Format)","Condition Group Count (New Format)","Total Condition Count",
    "Condition Types","Condition Details",
    "Action Count","Action Target Count","Action Types","Action Details",
    "Use Triggering Entity","Execution Frequency","Execution Mode","Rule Notes",
  ];
  const items = await genesysGetAllPages(region, token, "/api/v2/outbound/campaignrules", 100);

  const rows = items.map((r) => {
    const sep = ", ";
    const entities    = r.campaignRuleEntities || {};
    const campaigns   = entities.campaigns   || [];
    const sequences   = entities.sequences   || [];

    // Conditions - Old Format
    const oldConds    = r.campaignRuleConditions || [];
    const oldCondCount = oldConds.length;

    // Conditions - New Format (conditionGroups)
    const condGroups  = r.conditionGroups || [];
    const newCondCount = condGroups.length;

    // Total conditions
    let totalCondCount = oldCondCount;
    for (const g of condGroups) totalCondCount += (g.conditions || []).length;

    // Extract condition types & details
    const condTypes = new Set();
    const condDetails = [];

    // From old format
    for (const cond of oldConds) {
      const ct = cond.conditionType || "";
      if (ct) condTypes.add(ct);
      const params = cond.parameters || {};
      const op = params.operator || "";
      const val = params.value || "";
      if (ct && op && val) condDetails.push(`${ct}: ${op} ${val}`);
    }

    // From new format (conditionGroups)
    condGroups.forEach((group, gi) => {
      const groupMatchAny = group.matchAnyConditions ?? false;
      const groupLogic = groupMatchAny ? "OR" : "AND";
      const groupConds = group.conditions || [];
      const groupDetails = [];
      for (const cond of groupConds) {
        const ct = cond.conditionType || "";
        if (ct) condTypes.add(ct);
        const params = cond.parameters || {};
        const op = params.operator || "";
        const val = params.value || "";
        if (ct && op && val) groupDetails.push(`${ct}: ${op} ${val}`);
      }
      if (groupDetails.length) {
        condDetails.push(`Group ${gi + 1} (${groupLogic}): ${sep}${groupDetails.join(sep)}`);
      }
    });

    const condTypesStr = [...condTypes].sort().join(sep);
    const condDetailsStr = condDetails.join(sep);

    // Actions
    const actions = r.campaignRuleActions || [];
    const actionTypes = new Set();
    const actionDetails = [];
    let totalTargets = 0;
    let useTriggeringEntity = false;

    for (const action of actions) {
      const at = action.actionType || "";
      if (at) actionTypes.add(at);

      const ae = action.campaignRuleActionEntities || {};
      const aCamps = ae.campaigns || [];
      const aSeqs  = ae.sequences || [];
      const useTrig = ae.useTriggeringEntity ?? false;
      if (useTrig) useTriggeringEntity = true;

      totalTargets += aCamps.length + aSeqs.length;

      const targets = [
        ...aCamps.map((c) => c.name || ""),
        ...aSeqs.map((s)  => s.name || ""),
      ];
      if (targets.length) {
        actionDetails.push(`${at}: ${targets.join(sep)}`);
      } else if (useTrig) {
        actionDetails.push(`${at}: triggering entity`);
      } else {
        actionDetails.push(at);
      }
    }

    const actionTypesStr = [...actionTypes].sort().join(sep);
    const actionDetailsStr = actionDetails.join(sep);

    // Execution Settings
    const execSettings = r.executionSettings || {};
    const execFrequency = execSettings.frequency || "";
    const execMode = "";

    // Rule Notes from campaignRuleProcessing
    const processing = r.campaignRuleProcessing || "";
    const ruleNotes = processing ? `Processing: ${processing}` : "";

    return [
      r.name, r.id,
      r.enabled     ?? "",
      r.timeZoneId  || "",
      r.matchAnyConditions ?? "",
      campaigns.length,
      campaigns.map((c) => c.name).join(sep),
      sequences.length,
      sequences.map((s) => s.name).join(sep),
      oldCondCount,
      newCondCount,
      totalCondCount,
      condTypesStr,
      condDetailsStr,
      actions.length,
      totalTargets,
      actionTypesStr,
      actionDetailsStr,
      useTriggeringEntity,
      execFrequency,
      execMode,
      ruleNotes,
    ];
  });

  return { headers, rows };
}

async function fetchOBContactListFilters(region, token) {
  const headers = [
    "Name","ID","Contact List","Source Type","Filter Type",
    "Clause Number","Clause Filter Type",
    "Predicate: Column","Predicate: Column Type","Predicate: Operator","Predicate: Value","Predicate: Inverted",
  ];
  const items = await genesysGetAllPages(region, token, "/api/v2/outbound/contactlistfilters", 100);

  const rows = [];
  for (const f of items) {
    const base = [f.name, f.id, f.contactList?.name || "", f.contactListFilterType || "", f.filterType || ""];
    const clauses = f.clauses || [];

    if (clauses.length === 0) {
      rows.push([...base, "", "", "", "", "", "", ""]);
      continue;
    }

    clauses.forEach((clause, ci) => {
      const predicates = clause.predicates || [];
      if (predicates.length === 0) {
        rows.push([...base, ci + 1, clause.filterType || "", "", "", "", "", ""]);
        return;
      }
      for (const pred of predicates) {
        rows.push([
          ...base,
          ci + 1,
          clause.filterType || "",
          pred.columnName    || "",
          pred.columnType    || "",
          pred.operator      || "",
          pred.value         ?? "",
          pred.inverted      ?? "",
        ]);
      }
    });
  }

  return { headers, rows };
}

async function fetchOBContactLists(region, token) {
  const headers = [
    "Name","ID","Division","Column Names","Phone Columns","Email Columns",
    "WhatsApp Columns","Attempt Control","Automatic Time Zone Mapping",
    "Data Type Specification","Trim White Space",
  ];
  const items = await genesysGetAllPages(region, token, "/api/v2/outbound/contactlists", 100);

  const fmtCols = (cols, timeKey) => {
    if (!cols || !cols.length) return "";
    return cols.map((c) => {
      const n = c.columnName || "";
      const t = c.type || "";
      const tc = c[timeKey] || "";
      return tc ? `${n} (${t}, ${tc})` : `${n} (${t})`;
    }).join("; ");
  };

  const fmtSpecs = (specs) => {
    if (!specs || !specs.length) return "";
    return specs.map((s) => {
      const cn = s.columnName || "";
      const dt = s.columnDataType || "";
      const details = [];
      if (s.maxLength) details.push(`maxLength=${s.maxLength}`);
      if (s.min != null || s.max != null) details.push(`range=${s.min ?? ""}-${s.max ?? ""}`);
      return details.length ? `${cn}: ${dt} (${details.join(", ")})` : `${cn}: ${dt}`;
    }).join("; ");
  };

  const rows = items.map((l) => [
    l.name, l.id,
    l.division?.name || "",
    joinArr(l.columnNames || []),
    fmtCols(l.phoneColumns, "callableTimeColumn"),
    fmtCols(l.emailColumns, "contactableTimeColumn"),
    fmtCols(l.whatsAppColumns, "contactableTimeColumn"),
    l.attemptLimits?.name || "",
    l.automaticTimeZoneMapping ?? "",
    fmtSpecs(l.columnDataTypeSpecifications || []),
    l.trimWhitespace ?? "",
  ]);

  return { headers, rows };
}

async function fetchOBContactListTemplates(region, token) {
  const headers = [
    "Name","ID","Column Names","Phone Columns","Email Columns","WhatsApp Columns",
    "Attempt Control","Automatic Time Zone Mapping","Data Type Specification",
    "Trim White Space","Preview Mode Column Name","Preview Mode Accepted Values",
  ];
  const items = await genesysGetAllPages(region, token, "/api/v2/outbound/contactlisttemplates", 100);

  const fmtCols = (cols) => {
    if (!cols || !cols.length) return "";
    return cols.map((c) => {
      const n = c.columnName || "";
      const t = c.type || "";
      const tc = c.callableTimeColumn || c.contactableTimeColumn || "";
      return tc ? `${n} (${t}, ${tc})` : `${n} (${t})`;
    }).join("; ");
  };

  const fmtSpecs = (specs) => {
    if (!specs || !specs.length) return "";
    return specs.map((s) => {
      const cn = s.columnName || "";
      const dt = s.columnDataType || "";
      const details = [];
      if (dt === "TEXT" && s.maxLength) details.push(`maxLength=${s.maxLength}`);
      if (dt === "NUMERIC") {
        if (s.min != null) details.push(`min=${s.min}`);
        if (s.max != null) details.push(`max=${s.max}`);
      }
      return details.length ? `${cn}: ${dt} (${details.join(", ")})` : `${cn}: ${dt}`;
    }).join("; ");
  };

  const rows = items.map((t) => [
    t.name, t.id,
    joinArr(t.columnNames || []),
    fmtCols(t.phoneColumns      || []),
    fmtCols(t.emailColumns      || []),
    fmtCols(t.whatsAppColumns   || []),
    t.attemptLimits?.name || "",
    t.automaticTimeZoneMapping ?? "",
    fmtSpecs(t.columnDataTypeSpecifications || []),
    t.trimWhitespace ?? "",
    t.previewModeColumnName || "",
    joinArr(t.previewModeAcceptedValues || []),
  ]);

  return { headers, rows };
}

async function fetchOBSettings(region, token) {
  const headers = [
    "Max Calls Per Agent","Max Calls Per Agent Decimal","Max Configurable Calls Per Agent",
    "Max Line Utilization","Abandon Seconds","Compliance Abandon Rate Denominator",
    "Auto TZ Mapping - Callable Windows","Auto TZ Mapping - Supported Countries",
    "Reschedule Time Zone Skipped Contacts","Settings Name",
  ];
  const s = await genesysGet(region, token, "/api/v2/outbound/settings");

  const fmtWindows = (atzm) => {
    if (!atzm || !atzm.callableWindows) return "";
    return (atzm.callableWindows || []).map((w) => {
      const parts = [];
      if (w.mapped) {
        const e = w.mapped.earliestCallableTime || "";
        const l = w.mapped.latestCallableTime || "";
        if (e && l) parts.push(`Mapped: ${e}-${l}`);
      }
      if (w.unmapped) {
        const e = w.unmapped.earliestCallableTime || "";
        const l = w.unmapped.latestCallableTime || "";
        const tz = w.unmapped.timeZoneId || "";
        if (e && l) parts.push(tz ? `Unmapped: ${e}-${l} (${tz})` : `Unmapped: ${e}-${l}`);
      }
      return parts.join(", ");
    }).filter(Boolean).join("; ");
  };

  const atzm = s.automaticTimeZoneMapping || {};
  const windows = fmtWindows(atzm);
  const countries = joinArr(atzm.supportedCountries || []);

  const rows = [[
    s.maxCallsPerAgent             ?? "",
    s.maxCallsPerAgentDecimal      ?? "",
    s.maxConfigurableCallsPerAgent ?? "",
    s.maxLineUtilization           ?? "",
    s.abandonSeconds               ?? "",
    s.complianceAbandonRateDenominator || "",
    windows,
    countries,
    s.rescheduleTimeZoneSkippedContacts ?? "",
    s.name || "",
  ]];

  return { headers, rows };
}

// ─────────────────────────────────────────────────────────
// Data Tables Contents workbook
// ─────────────────────────────────────────────────────────

async function buildDataTablesWorkbook(region, token, orgName, tsStr) {
  const dtWb = XLSX.utils.book_new();

  const tables = await genesysGetAllPages(
    region, token,
    "/api/v2/flows/datatables?expand=schema",
    100
  );

  for (const table of tables) {
    const sheetName = safeSheet(table.name || table.id);
    const props     = table.schema?.properties || {};

    // Column headers from schema: key first, then other fields in order
    const colHeaders = ["key", ...Object.keys(props).filter((k) => k !== "key")];

    let allRows = [];
    try {
      allRows = await genesysGetAllPages(
        region, token,
        `/api/v2/flows/datatables/${table.id}/rows?showbrief=false`,
        100
      );
    } catch (_) { /* skip this table's rows */ }

    const wsData = [
      colHeaders,
      ...allRows.map((row) => colHeaders.map((col) => {
        const v = row[col];
        if (v == null) return "";
        if (typeof v === "object") return JSON.stringify(v);
        return v;
      })),
    ];

    addStyledSheet(dtWb, wsData, sheetName);
  }

  return dtWb;
}

// ─────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────

async function execute(context, schedule) {
  const config = schedule?.exportConfig || {};
  const orgId  = config.orgId;

  if (!orgId) return { success: false, error: "No orgId specified in exportConfig" };

  const customer = customers.find((c) => c.id === orgId);
  if (!customer)  return { success: false, error: `Unknown org: ${orgId}` };

  const envKey  = `GENESYS_${orgId.replace(/-/g, "_").toUpperCase()}`;
  const clientId     = process.env[`${envKey}_CLIENT_ID`];
  const clientSecret = process.env[`${envKey}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    return { success: false, error: `Credentials not configured for ${orgId}` };
  }

  context.log(`Documentation export started for ${customer.name} (${orgId})`);

  let token;
  try {
    token = await getGenesysToken(orgId, customer.region, clientId, clientSecret);
  } catch (err) {
    return { success: false, error: `Token acquisition failed: ${err.message}` };
  }

  const region = customer.region;
  const now    = new Date();
  const tsStr  = formatTs(now);
  const tsFile = tsForFilename(now);
  const safeOrg = customer.name.replace(/[^a-zA-Z0-9_-]/g, "_");

  // ── Fire all top-level fetches in parallel ──

  context.log("Fetching all Genesys data in parallel…");

  const [
    queuesR, usersR, callRoutingR, wrapupR, triggersR, trunksR,
    dataActionsR, integrationsR, didPoolsR, didNumsR, policiesR,
    dbSchemasR, flowOutcomesR, milestonesR, flowsR, msgRoutingR,
    messengerConfigsR, messengerDeployR, schedulesR, schedGroupsR,
    promptsR, emailR, sitesR, agentCopilotsR, oauthR,
    obCampaignsR, obAttemptR, obCallableTimeR, obCallAnalysisR,
    obCampaignRulesR, obContactListFiltersR, obContactListsR,
    obContactListTemplatesR, obSettingsR,
  ] = await Promise.allSettled([
    safe(() => fetchQueues(region, token)),
    safe(() => fetchUsers(region, token)),
    safe(() => fetchCallRouting(region, token)),
    safe(() => fetchWrapupCodes(region, token)),
    safe(() => fetchTriggers(region, token)),
    safe(() => fetchTrunks(region, token)),
    safe(() => fetchDataActions(region, token)),
    safe(() => fetchIntegrations(region, token)),
    safe(() => fetchDIDPools(region, token)),
    safe(() => fetchDIDNumbers(region, token)),
    safe(() => fetchPolicies(region, token)),
    safe(() => fetchDBSchemas(region, token)),
    safe(() => fetchFlowOutcomes(region, token)),
    safe(() => fetchFlowMilestones(region, token)),
    safe(() => fetchFlows(region, token)),
    safe(() => fetchMessageRouting(region, token)),
    safe(() => fetchMessengerConfigurations(region, token)),
    safe(() => fetchMessengerDeployments(region, token)),
    safe(() => fetchSchedules(region, token)),
    safe(() => fetchScheduleGroups(region, token)),
    safe(() => fetchUserPrompts(region, token)),
    safe(() => fetchEmail(region, token)),
    safe(() => fetchSites(region, token)),
    safe(() => fetchAgentCopilots(region, token)),
    safe(() => fetchOAuthClients(region, token)),
    safe(() => fetchOBCampaigns(region, token)),
    safe(() => fetchOBAttemptLimits(region, token)),
    safe(() => fetchOBCallableTimeSets(region, token)),
    safe(() => fetchOBCallAnalysis(region, token)),
    safe(() => fetchOBCampaignRules(region, token)),
    safe(() => fetchOBContactListFilters(region, token)),
    safe(() => fetchOBContactLists(region, token)),
    safe(() => fetchOBContactListTemplates(region, token)),
    safe(() => fetchOBSettings(region, token)),
  ]);

  context.log("All fetches complete — building workbook…");

  // Helper: unwrap a PromiseSettledResult → value or error object
  const val = (r) => r.status === "fulfilled" ? r.value : { error: r.reason?.message || String(r.reason) };

  // ── Build main workbook ──

  const wb        = XLSX.utils.book_new();
  const inventory = []; // [{name, status}] for cover sheet

  const addSheet = (name, result) => {
    const data = val(result);
    if (data.error) {
      // Error: include a placeholder sheet and show ERROR in the index
      addStyledSheet(wb, [["Error"], [data.error]], safeSheet(name));
      inventory.push({ name, status: "error" });
    } else {
      const { headers, rows } = data;
      if (rows.length === 0) {
        // No data: omit the sheet entirely and exclude from the index
        return;
      }
      addStyledSheet(wb, [headers, ...rows], safeSheet(name));
      inventory.push({ name, status: "data" });
    }
  };

  // Sheets in alphabetical order (Python sorts before inserting Index)

  // Agent Copilots — two sub-sheets from one fetch
  const acData = val(agentCopilotsR);
  if (acData.error) {
    addSheet("Agent Copilots",         { status: "rejected", reason: { message: acData.error } });
    addSheet("Agent Copilots - Rules", { status: "rejected", reason: { message: acData.error } });
  } else {
    addSheet("Agent Copilots",         { status: "fulfilled", value: acData.copilots });
    addSheet("Agent Copilots - Rules", { status: "fulfilled", value: acData.rules    });
  }

  addSheet("DB Schemas",              dbSchemasR);
  addSheet("DID Numbers",             didNumsR);
  addSheet("DID Pools",               didPoolsR);
  addSheet("Data Actions",            dataActionsR);

  // Email — two sub-sheets
  const emailData = val(emailR);
  if (emailData.error) {
    addSheet("Email Addresses", { status: "rejected", reason: { message: emailData.error } });
    addSheet("Email Domains",   { status: "rejected", reason: { message: emailData.error } });
  } else {
    addSheet("Email Addresses", { status: "fulfilled", value: emailData.addresses });
    addSheet("Email Domains",   { status: "fulfilled", value: emailData.domains   });
  }

  addSheet("Flow Outcomes",            flowOutcomesR);
  addSheet("Flows",                    flowsR);
  addSheet("Integrations",             integrationsR);
  addSheet("Messenger Configurations", messengerConfigsR);
  addSheet("Messenger Deployments",    messengerDeployR);
  addSheet("Milestones",               milestonesR);
  addSheet("OB - Attempt Controls",    obAttemptR);
  addSheet("OB - Call Analysis",       obCallAnalysisR);
  addSheet("OB - Campaign Rules",      obCampaignRulesR);
  addSheet("OB - Campaigns",           obCampaignsR);
  addSheet("OB - Contact List Filters",obContactListFiltersR);
  addSheet("OB - Contact List Templates", obContactListTemplatesR);
  addSheet("OB - Contact Lists",       obContactListsR);
  addSheet("OB - Contactable Time Sets",obCallableTimeR);
  addSheet("OB - Settings",            obSettingsR);

  // OAuth — five sub-sheets
  const oauthData = val(oauthR);
  if (oauthData.error) {
    for (const sub of ["OAuth - CLIENT-CREDENTIALS","OAuth - CODE","OAuth - PASSWORD","OAuth - SAML2-BEARER","OAuth - TOKEN"]) {
      addSheet(sub, { status: "rejected", reason: { message: oauthData.error } });
    }
  } else {
    addSheet("OAuth - CLIENT-CREDENTIALS", { status: "fulfilled", value: oauthData.clientCredentials });
    addSheet("OAuth - CODE",               { status: "fulfilled", value: oauthData.code     });
    addSheet("OAuth - PASSWORD",           { status: "fulfilled", value: oauthData.password });
    addSheet("OAuth - SAML2-BEARER",       { status: "fulfilled", value: oauthData.saml2    });
    addSheet("OAuth - TOKEN",              { status: "fulfilled", value: oauthData.token     });
  }

  addSheet("Policies",         policiesR);
  addSheet("Queues",           queuesR);
  addSheet("Routing - Calls",  callRoutingR);
  addSheet("Routing - Messaging", msgRoutingR);
  addSheet("Schedule Groups",  schedGroupsR);
  addSheet("Schedules",        schedulesR);

  // Sites — three sub-sheets
  const sitesData = val(sitesR);
  if (sitesData.error) {
    addSheet("Sites",                   { status: "rejected", reason: { message: sitesData.error } });
    addSheet("Sites - Number Plans",    { status: "rejected", reason: { message: sitesData.error } });
    addSheet("Sites - Outbound Routes", { status: "rejected", reason: { message: sitesData.error } });
  } else {
    addSheet("Sites",                   { status: "fulfilled", value: sitesData.sites          });
    addSheet("Sites - Number Plans",    { status: "fulfilled", value: sitesData.numberPlans    });
    addSheet("Sites - Outbound Routes", { status: "fulfilled", value: sitesData.outboundRoutes });
  }

  addSheet("Triggers",      triggersR);
  addSheet("Trunks",        trunksR);
  addSheet("User Prompts",  promptsR);
  addSheet("Users",         usersR);
  addSheet("Wrapup Codes",  wrapupR);

  // Sort sheets alphabetically — controls tab order in the Excel file.
  // Index is inserted at position 0 after sorting, so it is not included here.
  wb.SheetNames.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  // Sort inventory to match the sorted sheet order for the cover-sheet table of contents.
  inventory.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  // Insert cover sheet at position 0
  buildCoverSheet(wb, customer.name, tsStr, inventory);

  // ── Build DataTables workbook ──

  let dtWorkbook = XLSX.utils.book_new();
  try {
    dtWorkbook = await buildDataTablesWorkbook(region, token, customer.name, tsStr);
  } catch (err) {
    context.log.warn(`DataTables workbook build failed: ${err.message}`);
  }

  const okeCount  = inventory.filter((i) => i.status === "data").length;
  const errCount  = inventory.filter((i) => i.status === "error").length;
  const skipCount = inventory.filter((i) => i.status === "skip").length;
  const summary   = `${customer.name}: ${okeCount} sheets OK, ${skipCount} empty, ${errCount} errors`;

  context.log(`Documentation export complete — ${summary}`);

  // ── ZIP vs single XLSX ──

  const mainBuf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

  if (dtWorkbook.SheetNames.length > 0) {
    const dtBuf  = XLSX.write(dtWorkbook, { bookType: "xlsx", type: "buffer" });
    const zip    = new JSZip();
    zip.file(`Documentation_${safeOrg}_${tsFile}.xlsx`, mainBuf);
    zip.file(`Documentation_DataTables_${safeOrg}_${tsFile}.xlsx`, dtBuf);
    const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    return {
      success:  true,
      filename: `Documentation_${safeOrg}_${tsFile}.zip`,
      base64:   Buffer.from(zipBuf).toString("base64"),
      mimeType: ZIP_MIME,
      summary,
    };
  }

  return {
    success:  true,
    filename: `Documentation_${safeOrg}_${tsFile}.xlsx`,
    base64:   Buffer.from(mainBuf).toString("base64"),
    mimeType: MAIN_MIME,
    summary,
  };
}

module.exports = { execute };
