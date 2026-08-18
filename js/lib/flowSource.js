/**
 * Flow source — the shared "get me a parsed flow" layer.
 *
 * Every page that reads Architect flows needs the same four things: the org's
 * flow list, a lookup by id and by name, one flow fetched as structured YAML and
 * parsed, and the ids of the flows it depends on. Flows › Flow Overview and
 * Deployment › Test › Test Cases both do exactly that before they diverge into
 * drawing a diagram or enumerating test paths.
 *
 *   listFlows(api, orgId)                        → [{ id, name, type }]
 *   indexFlows(list)                             → { byId, byName }
 *   loadFlow(api, orgId, meta)                   → { data, varIndex, depIndex, actionIndex }
 *   discoverDepFlowIds(data, flowByName, selfId) → [flowId]
 *
 * Deliberately UI-free: no DOM, no tab state, no spinners, no caching. Callers
 * own their work list and their own cache, because "which flows am I working
 * through, and what do I show while I wait" differs per page — Flow Overview
 * keeps a user-clickable tab strip, Test Cases keeps a generation queue. Only
 * the part that is identical in both lives here.
 *
 * WHY YAML: the structured Archy/SDK export makes the implicit "Default output
 * continues to the next action" links explicit in its ordering. The flat REST
 * `latestconfiguration` omits them (Architect rebuilds them at render time), so
 * neither a diagram nor a test path can be traced reliably from it. See the note
 * at the top of flowYaml.js.
 *
 * INTERNAL ONLY: `POST /api/flow-yaml` forwards to the onboarding runner's SDK
 * export using client credentials and answers 403 for a customer session (see
 * api/flow-yaml/index.js). Any page built on this module is internal-only in
 * practice, whatever its access key says.
 */

import * as gc from "../services/genesysApi.js";
import {
  parseFlowYaml,
  buildVariableIndex,
  buildDependencyIndex,
  buildActionIndex,
} from "./flowYaml.js";

/**
 * Architect flow types → display labels, covering every type the flow list can
 * return (including outboundcall, which Deployment › Onboarding deliberately
 * excludes as a deploy root but which still shows up as a transfer target).
 */
export const FLOW_TYPE_LABELS = {
  inboundcall: "Inbound Call", inboundchat: "Inbound Chat", inboundemail: "Inbound Email",
  inboundshortmessage: "Inbound Message", bot: "Bot", digitalbot: "Digital Bot",
  commonmodule: "Common Module", inqueuecall: "In-Queue Call", inqueueemail: "In-Queue Email",
  inqueueshortmessage: "In-Queue Message", securecall: "Secure Call", voicemail: "Voicemail",
  workflow: "Workflow", workitem: "Workitem", voicesurvey: "Voice Survey",
  surveyinvite: "Survey Invite", outboundcall: "Outbound Call",
};

/** Display label for a flow type, falling back to the raw type. */
export function flowTypeLabel(type) {
  return FLOW_TYPE_LABELS[type] || type || "";
}

/**
 * Sort weight for grouping dependency flows: supporting flows (common modules,
 * in-queue) first, then bots and post-interaction flows. Entry-point flow types
 * are not listed and sort last — a dependency list is read from the inside out.
 */
export function flowTypeOrder(type) {
  const order = ["commonmodule", "inqueuecall", "inqueueemail", "inqueueshortmessage", "workflow",
    "bot", "digitalbot", "voicesurvey", "surveyinvite", "securecall", "voicemail", "workitem"];
  const i = order.indexOf(type);
  return i === -1 ? 99 : i;
}

/**
 * Every non-deleted flow in an org, normalized to { id, name, type } and sorted
 * by name. `type` is lower-cased so it can be compared against the keys above.
 *
 * @param {object} api    app API client (createApiClient)
 * @param {string} orgId  customer org id
 * @returns {Promise<Array<{ id: string, name: string, type: string }>>}
 */
export async function listFlows(api, orgId) {
  const flows = await gc.fetchAllFlows(api, orgId, { query: { pageSize: "100" } });
  return (flows || [])
    .filter((f) => f.id && f.name)
    .map((f) => ({ id: f.id, name: f.name, type: (f.type || "").toLowerCase() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lookups over a flow list. `byName` is what dependency resolution needs: a
 * flow's YAML names the flows it calls, it does not carry their ids.
 *
 * @param {Array<{ id: string, name: string, type: string }>} list
 * @returns {{ byId: Map, byName: Map }}
 */
export function indexFlows(list) {
  const flows = list || [];
  return {
    byId: new Map(flows.map((f) => [f.id, f])),
    byName: new Map(flows.map((f) => [f.name, f])),
  };
}

/**
 * Fetch one flow's YAML and parse it into the node/edge model plus its three
 * cross-reference indexes. Not cached — the caller decides what to keep.
 *
 * @param {object} api    app API client
 * @param {string} orgId  customer org id
 * @param {{ name: string, type: string }} meta  from listFlows
 * @returns {Promise<{ data: object, varIndex: Map, depIndex: Map, actionIndex: Map }>}
 */
export async function loadFlow(api, orgId, meta) {
  const resp = await api.appRequest("/api/flow-yaml", {
    method: "POST",
    body: { orgId, flowName: meta && meta.name, flowType: meta && meta.type },
  });
  if (!resp || !resp.yaml) throw new Error((resp && resp.error) || "no YAML returned");
  if (!window.jsyaml) throw new Error("YAML parser not loaded (js/lib/js-yaml.min.js).");
  const data = parseFlowYaml(window.jsyaml.load(resp.yaml));
  return {
    data,
    varIndex: buildVariableIndex(data),
    depIndex: buildDependencyIndex(data),
    actionIndex: buildActionIndex(data),
  };
}

/**
 * The ids of the flows a parsed flow depends on — common modules, in-queue
 * flows, bot flows and transfer targets.
 *
 * A flow's dependencies are recorded by NAME, so they are resolved against the
 * org's flow list; a dependency whose name matches nothing (a data table, a
 * queue, a flow in another org) simply isn't a flow and drops out. Self
 * references are excluded so a flow that transfers to itself can't recurse.
 *
 * @param {object} data              parsed flow (parseFlowYaml)
 * @param {Map}    flowByName        from indexFlows
 * @param {string} selfId            the flow being inspected
 * @returns {string[]} unique flow ids
 */
export function discoverDepFlowIds(data, flowByName, selfId) {
  const ids = new Set();
  if (!flowByName) return [];
  for (const dep of (data && data.dependencies) || []) {
    const f = flowByName.get(dep.name);
    if (f && f.id !== selfId) ids.add(f.id);
  }
  return [...ids];
}
