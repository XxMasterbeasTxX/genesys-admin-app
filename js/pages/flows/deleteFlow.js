/**
 * Flows › Delete Flow — PHASE 1 (discovery only)
 *
 * Reports exactly what removing a callflow would touch: the flow's dependency
 * closure, who else uses each object, what is blocked, and what could be
 * deleted. See docs/flow-deletion-design.md.
 *
 * *** THIS PAGE DELETES NOTHING. *** There is no delete path in Phase 1 — not a
 * disabled button, not a guarded code path. Execution lands in Phase 2, once the
 * §13 validation items have been answered against a live org. Until then this is
 * a read-only report, and it is also the instrument that answers them: the
 * Findings panel records the raw Dependency Tracking shapes encountered.
 *
 * Pipeline:
 *   1. Check the dependency-tracking build. Refuse to run on a stale index.
 *   2. Walk `consumedresources` from the root flow, recursing ONLY into flows.
 *   3. Fetch `consumingresources` for every object found — the consumer graph.
 *   4. Render the review; recompute orphan state locally on every toggle.
 *
 * The orphan rule (design §5):
 *   deletable(o) ⟺ consumers(o) \ (selection ∪ {root}) = ∅
 * "outside" is the operative word — orphan status is relative to the current
 * selection, so unticking a common module re-locks the data table only it used.
 */
import { escapeHtml } from "../../utils.js";
import * as gc from "../../services/genesysApi.js";
import {
  keyOf, hardBlockers, softBlockers, isDeletable, settleSelection, defaultSelection,
} from "../../lib/flowDeleteGraph.js";

// ── Object types ────────────────────────────────────────
//
// The objectType enum is CONFIRMED — the API returned the full allowable list on
// 2026-08-13 (design §13 item 1). Notable corrections to the original guesses:
// there is no generic "FLOW", scripts are "COMPOSERSCRIPT" not "SCRIPT", prompts
// are "USERPROMPT"/"SYSTEMPROMPT" not "PROMPT", and workitem flows are
// "WORKITEMFLOW" not "WORKITEM".
//
// Unrecognised values are still handled defensively — the enum can grow — and
// land in tier B (unticked) with the raw value shown.

/**
 * Object types that belong to a callflow — ticked by default when orphaned.
 *
 * This is a statement about the TYPE, not about who made a particular object. A
 * data table exists to serve flows whether it was deployed by a tool or built by
 * hand; a queue does not. The set happens to match what Deployment › Onboarding
 * creates, which is where the rule came from, but the label must not claim
 * provenance it cannot know.
 */
const TIER_A = new Set([
  "DATATABLE", "DATAACTION", "COMPOSERSCRIPT", "SURVEYFORM", "USERPROMPT",
]);

/**
 * Platform vocabulary — EXCLUDED from the tree entirely.
 *
 * Dependency Tracking reports everything a flow consumes, which includes the
 * building blocks the flow is written in: the action types it uses
 * (PlayAudioAction, DecisionAction…), its data types (str, int, que…), its
 * supported languages, system prompts, and TTS engines/voices. A single flow
 * pulls in 50+ of these.
 *
 * They are not dependencies in any sense this tool cares about: they exist in
 * every org, are never created or deleted, and nothing is gained by listing
 * them. Reporting them buried the twenty real findings under sixty rows of
 * noise. Onboarding draws the same line from the other side — resolveDeps
 * excludes `SystemPrompt.` references because they exist in every org.
 *
 * Counted in the Findings panel, so the exclusion is visible rather than silent.
 */
const PLATFORM_VOCABULARY = new Set([
  "FLOWACTION", "FLOWDATATYPE", "LANGUAGE", "SYSTEMPROMPT",
  "TTSENGINE", "TTSVOICE", "STTENGINE",
]);

/**
 * Real objects that are nonetheless never this tool's to delete: org identity
 * and knowledge platform. Discovered and REPORTED, but no checkbox — removing a
 * division or a user because a callflow referenced it is well outside what
 * "delete a callflow and its dependencies" can mean.
 */
const NEVER_OFFER = new Set([
  "USER", "DIVISION", "OAUTHCLIENT",
  "KNOWLEDGEBASE", "KNOWLEDGEBASEDOCUMENT", "KNOWLEDGESETTING",
]);

/** Anything whose type name looks like a flow — recursed into, and tier A. */
function isFlowType(type) {
  const t = String(type || "").toUpperCase();
  return t === "FLOW" || t.endsWith("FLOW") || t === "WORKFLOW" || t === "WORKITEM";
}

function tierOf(type) {
  return (isFlowType(type) || TIER_A.has(String(type || "").toUpperCase())) ? "A" : "B";
}

/** Readable labels. Unknown types fall back to the raw enum value, never blank. */
const TYPE_LABELS = {
  FLOW: "Flow", WORKFLOW: "Workflow", WORKITEM: "Workitem Flow",
  INBOUNDCALLFLOW: "Inbound Call Flow", INBOUNDEMAILFLOW: "Inbound Email Flow",
  INBOUNDCHATFLOW: "Inbound Chat Flow", INBOUNDSHORTMESSAGEFLOW: "Inbound Message Flow",
  INQUEUECALLFLOW: "In-Queue Call Flow", INQUEUEEMAILFLOW: "In-Queue Email Flow",
  INQUEUESHORTMESSAGEFLOW: "In-Queue Message Flow",
  COMMONMODULEFLOW: "Common Module", SECURECALLFLOW: "Secure Call Flow",
  VOICEMAILFLOW: "Voicemail Flow", BOTFLOW: "Bot Flow", DIGITALBOTFLOW: "Digital Bot Flow",
  VOICESURVEYFLOW: "Voice Survey Flow", SURVEYINVITEFLOW: "Survey Invite Flow",
  OUTBOUNDCALLFLOW: "Outbound Call Flow",
  DATATABLE: "Data Table", DATAACTION: "Data Action",
  SCRIPT: "Script", COMPOSERSCRIPT: "Script",
  SURVEYFORM: "Survey Form", USERPROMPT: "User Prompt", PROMPT: "Prompt",
  QUEUE: "Queue", ACDSKILL: "Skill", ACDLANGUAGE: "Language",
  ACDWRAPUPCODE: "Wrap-up Code", GROUP: "Group", USER: "User",
  SCHEDULE: "Schedule", SCHEDULEGROUP: "Schedule Group",
  EMERGENCYGROUP: "Emergency Group", IVRCONFIGURATION: "IVR Configuration",
  FLOWMILESTONE: "Flow Milestone", FLOWOUTCOME: "Flow Outcome",
  CONTACTLIST: "Contact List", RESPONSE: "Response", SYSTEMPROMPT: "System Prompt",
  TTSENGINE: "TTS Engine", TTSVOICE: "TTS Voice", RECORDINGPOLICY: "Recording Policy",
  NLUDOMAIN: "NLU Domain", KNOWLEDGEBASE: "Knowledge Base", DECISIONTABLE: "Decision Table",
  // Synthetic types from the attachment probes — not Dependency Tracking values.
  WEBDEPLOYMENT: "Web/Messaging Deployment", QUEUEASSIGNMENT: "Queue assignment",
  CALLROUTE: "Call route",
};

const typeLabel = (t) => TYPE_LABELS[String(t || "").toUpperCase()] || String(t || "unknown");

/**
 * Types believed to have no DELETE endpoint (design §8.1) — reported and locked
 * rather than offered, so the tree never shows an action that would fail.
 * UNVERIFIED; confirm before Phase 2.
 */
const NO_DELETE_API = new Set(["FLOWOUTCOME"]);

/**
 * Architect flow type → Dependency Tracking objectType.
 *
 * Confirmed against the enum the API returned. There is NO generic "FLOW" value,
 * so an unmapped type is an error rather than something to fall back on — a
 * silent fallback here would produce a report about the wrong object.
 */
const DT_FLOW_TYPE = {
  inboundcall: "INBOUNDCALLFLOW", inboundemail: "INBOUNDEMAILFLOW",
  inboundchat: "INBOUNDCHATFLOW", inboundshortmessage: "INBOUNDSHORTMESSAGEFLOW",
  inqueuecall: "INQUEUECALLFLOW", inqueueemail: "INQUEUEEMAILFLOW",
  inqueueshortmessage: "INQUEUESHORTMESSAGEFLOW", commonmodule: "COMMONMODULEFLOW",
  securecall: "SECURECALLFLOW", voicemail: "VOICEMAILFLOW", bot: "BOTFLOW",
  digitalbot: "DIGITALBOTFLOW", voicesurvey: "VOICESURVEYFLOW",
  surveyinvite: "SURVEYINVITEFLOW", workflow: "WORKFLOW", workitem: "WORKITEMFLOW",
  outboundcall: "OUTBOUNDCALLFLOW", voice: "VOICEFLOW", emailsend: "EMAILSENDFLOW",
};

// ── Dependency-tracking build status ────────────────────
//
// Confirmed against a live org (2026-08-13). The endpoint returns:
//   { user, buildId, dateStarted, dateCompleted, status: "OPERATIONAL",
//     failedObjects: [], selfUri }
//
// "OPERATIONAL" means the index is live and maintained. `dateCompleted` is the
// last FULL rebuild and is routinely weeks old — ordinary publishes update the
// index incrementally — so an old date is NOT a staleness signal on its own and
// must not be treated as one. It is surfaced for the operator to judge.

/** Status values that mean the index can be trusted. */
const BUILD_READY = new Set(["OPERATIONAL"]);

/** Status values known to mean "not usable", with the reason to show. */
const BUILD_NOT_READY = {
  BUILDING: "a rebuild is in progress",
  NOTBUILT: "the index has never been built",
  FAILED: "the last build failed",
  UNKNOWN: "the index state could not be determined",
};

// ── Provenance ──────────────────────────────────────────
//
// "Who made this" is decision-relevant: a data table a person built last month
// is a different deletion risk from one a deploy tool produced. Genesys exposes
// this unevenly, so it is read defensively and reported in three honest states —
// a person, an API client, or "not recorded". Never guessed.

/** Where to fetch an object's detail, per Dependency Tracking type. */
const DETAIL_PATH = {
  DATATABLE: (id) => `/api/v2/flows/datatables/${id}`,
  DATAACTION: (id) => `/api/v2/integrations/actions/${id}`,
  COMPOSERSCRIPT: (id) => `/api/v2/scripts/${id}`,
  USERPROMPT: (id) => `/api/v2/architect/prompts/${id}`,
  QUEUE: (id) => `/api/v2/routing/queues/${id}`,
  SURVEYFORM: (id) => `/api/v2/quality/forms/surveys/${id}`,
  SCHEDULE: (id) => `/api/v2/architect/schedules/${id}`,
  SCHEDULEGROUP: (id) => `/api/v2/architect/schedulegroups/${id}`,
  EMERGENCYGROUP: (id) => `/api/v2/architect/emergencygroups/${id}`,
  RESPONSE: (id) => `/api/v2/responsemanagement/responses/${id}`,
  NLUDOMAIN: (id) => `/api/v2/languageunderstanding/domains/${id}`,
};

// Fields that mean "who made this", most authoritative first, then the
// fallbacks that only mean "who touched it last". The two are reported
// differently rather than blurred: on a flow, `createdBy` often reflects whoever
// last saved a version, not the original author, and claiming otherwise would be
// worse than saying nothing.
const CREATED_FIELDS = ["createdBy", "createdByUser", "createdByClient", "createdByApp", "owner"];
const MODIFIED_FIELDS = ["modifiedBy", "lastModifiedBy", "updatedBy", "publishedBy"];

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function renderDeleteFlow({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <style>
      @keyframes df-spin { to { transform: rotate(360deg); } }
      .df-spin { display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.25);
                 border-top-color:#fff;border-radius:50%;animation:df-spin .8s linear infinite; }
      .df-combo { position:relative; width:320px; }
      .df-menu { position:absolute;z-index:40;top:100%;left:0;right:0;margin-top:2px;max-height:300px;
                 overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:8px;display:none; }
      .df-menu.open { display:block; }
      .df-item { padding:6px 10px;font-size:13px;cursor:pointer;white-space:nowrap; }
      .df-item:hover, .df-item.is-active { background:rgba(96,165,250,.15); }
      .df-item .df-meta { color:var(--muted);font-size:11px; }
      .df-sect { border:1px solid var(--border);border-radius:8px;margin:14px 0;overflow:hidden; }
      .df-sect-head { padding:9px 12px;background:var(--panel);border-bottom:1px solid var(--border); }
      .df-sect-head h3 { margin:0;font-size:.95rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
      .df-sect--b .df-sect-head { background:rgba(251,191,36,.07); }
      .df-row { display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border); }
      .df-row:last-child { border-bottom:none; }
      .df-row--locked { opacity:.72; }
      .df-row-main { flex:1;min-width:0; }
      .df-name { font-size:.9rem; }
      .df-sub { color:var(--muted);font-size:.79rem;margin-top:2px;line-height:1.45; }
      .df-badge { display:inline-block;font-size:.72rem;padding:1px 7px;border-radius:999px;
                  border:1px solid var(--border);color:var(--muted); }
      .df-lock { color:#fbbf24; }
      .df-block { color:#f87171; }
      .df-note { background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.35);
                 border-radius:8px;padding:11px 13px;margin:12px 0; }
      .df-caveat { background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);
                   border-radius:6px;padding:8px 11px;margin:0;font-size:.82rem; }
    </style>

    <h2>Flows — Delete Flow</h2>
    <p class="page-desc">
      Report everything that removing a callflow would touch. Pick a flow and this
      resolves its full dependency tree, then checks — for every object in it —
      whether anything <em>else</em> still uses it. Objects nothing else uses can be
      selected for removal; objects still in use are listed with what holds them, so
      you can act on them. The org comes from the selector at the top of the page.
    </p>
    <p class="df-caveat">
      <strong>Phase 1 — report only.</strong> This page does not delete anything yet.
      Dependencies are read from flow authoring; references built at runtime from
      variables or data-table values are not visible and are not checked.
    </p>

    <div class="dt-controls" style="margin-top:14px">
      <div class="dt-control-group">
        <label class="dt-label">Callflow</label>
        <div class="df-combo">
          <input class="dt-input" id="dfFlowInput" type="text" placeholder="Search a flow…" autocomplete="off" disabled style="width:100%" />
          <div class="df-menu" id="dfFlowMenu"></div>
        </div>
      </div>
      <div class="dt-actions" style="margin-bottom:12px;display:flex;align-items:flex-end;gap:10px">
        <button class="btn" id="dfAnalyse" disabled>Analyse</button>
      </div>
    </div>

    <div class="dt-status" id="dfStatus">Select an organisation and a callflow to begin.</div>

    <div id="dfReport"></div>
  `;

  const $ = (sel) => el.querySelector(sel);
  const $flowInput = $("#dfFlowInput");
  const $flowMenu = $("#dfFlowMenu");
  const $analyse = $("#dfAnalyse");
  const $status = $("#dfStatus");
  const $report = $("#dfReport");

  // ── State ─────────────────────────────────────────────
  const state = {
    orgId: null,
    flows: [],            // { id, name, type } from the org
    flowById: new Map(),
    rootId: "",           // the flow's GUID (from the picker)
    rootKey: "",          // its closure key — TYPE::id; kept separate so a
                          // re-analysis still has the raw id to start from
    rootMeta: null,
    rootHardBlocked: false,
    buildDate: null,           // last full rebuild of the dependency index
    failedObjectIds: new Set(),// objects the index could not process
    rootVersions: [],          // real version ids read off the root flow
    incomplete: [],            // flows whose dependencies could not be read
    closure: new Map(),   // key → node
    consumers: new Map(), // key → normalised consumer list
    selection: new Set(), // keys ticked for (eventual) deletion
    rootBlockers: [],     // consumers of the root that sit outside the closure
    lockNote: null,       // Architect checkout, if any
    findings: null,       // diagnostics for design §13
    busy: false,
  };

  function setStatus(msg, type = "", spinner = false) {
    $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
    $status.innerHTML = (spinner ? `<span class="df-spin"></span> ` : "") + escapeHtml(msg);
  }

  // ── Graph rules ───────────────────────────────────────
  // The rules themselves live in js/lib/flowDeleteGraph.js so they can be read
  // and tested without a DOM. `state` is the graph those functions expect.

  const blockedHard = (key) => hardBlockers(state, key);
  const blockedSoft = (key) => softBlockers(state, key);
  const deletable   = (key) => isDeletable(state, key);

  // ── Discovery ─────────────────────────────────────────

  /**
   * consumedresources, trying each candidate `version` in turn.
   *
   * Dependency Tracking requires a version alongside the id and objectType, and
   * which value it wants is not obvious — a flow has published, checked-in and
   * saved versions, and "LATEST" may or may not be accepted. Each attempt is
   * recorded with its own error text: the first live run failed on a VALID
   * objectType and the reason was lost because only the last error survived,
   * which is precisely the mistake this records against.
   */
  async function consumedWithFallback(id, objectType, versions, findings) {
    let lastErr = null;
    for (const version of versions) {
      try {
        const out = await gc.fetchConsumedResources(api, state.orgId, id, objectType,
          version ? { query: { version } } : {});
        findings.objectTypeCalls.push({ objectType, version: version || "(none)", ok: true, count: out.length });
        return { entries: out, objectType, version };
      } catch (err) {
        lastErr = err;
        findings.objectTypeCalls.push({
          objectType, version: version || "(none)", ok: false,
          error: (err.message || String(err)).slice(0, 300),
        });
      }
    }
    throw lastErr || new Error("no usable objectType/version combination");
  }

  /**
   * A flow's own version, read from the flow itself and cached.
   *
   * Dependency Tracking wants the version OF THE OBJECT being asked about, and
   * every flow has its own — the root was 8.0 while its common modules were 3.0.
   * Guessing from a shared pool therefore failed repeatedly and dropped three
   * common modules out of the tree altogether, leaving it quietly incomplete.
   * One lookup per flow removes the guesswork entirely.
   */
  const flowDetailCache = new Map();
  async function getFlowDetail(id) {
    if (flowDetailCache.has(id)) return flowDetailCache.get(id);
    let detail = null;
    try {
      detail = await api.proxyGenesys(state.orgId, "GET", `/api/v2/flows/${id}`);
    } catch (_) { /* caller degrades */ }
    flowDetailCache.set(id, detail);
    return detail;
  }

  async function resolveFlowVersion(id) {
    const f = await getFlowDetail(id);
    const v = f?.publishedVersion?.id || f?.checkedInVersion?.id || f?.savedVersion?.id;
    return v ? String(v) : null;
  }

  /**
   * Turn an id into a named actor: a person, or an API client.
   *
   * Tried as a user first, then as an OAuth client. An id that resolves to
   * neither is left as an id rather than labelled — it may be a deleted user, and
   * calling that "an API client" would be a guess presented as a fact.
   * Cached: a handful of distinct actors typically cover a whole analysis.
   */
  const actorCache = new Map();
  async function actorById(id) {
    if (actorCache.has(id)) return actorCache.get(id);
    let out = null;
    try {
      const u = await api.proxyGenesys(state.orgId, "GET", `/api/v2/users/${id}`);
      if (u?.name) out = { kind: "user", name: u.name };
    } catch (_) { /* not a user, or deleted */ }
    if (!out) {
      try {
        const c = await api.proxyGenesys(state.orgId, "GET", `/api/v2/oauth/clients/${id}`);
        if (c?.name) out = { kind: "oauth", name: c.name };
      } catch (_) { /* not a client, or no permission to read clients */ }
    }
    if (!out) out = { kind: "unresolved", name: id };
    actorCache.set(id, out);
    return out;
  }

  /** Resolve whatever shape a creator field holds into a named actor. */
  async function resolveActor(ref) {
    if (!ref) return { kind: "none", name: null };
    if (typeof ref === "object") {
      const uri = String(ref.selfUri || "");
      if (ref.name) {
        return { kind: /\/oauth\/clients\//.test(uri) ? "oauth" : "user", name: ref.name };
      }
      return ref.id ? actorById(String(ref.id)) : { kind: "none", name: null };
    }
    const s = String(ref).trim();
    if (!s) return { kind: "none", name: null };
    return GUID_RE.test(s) ? actorById(s) : { kind: "label", name: s };
  }

  /**
   * Who made this object, from whatever the detail payload exposes.
   * Records the field used per type so the Findings panel shows which types
   * actually carry provenance and which simply do not.
   */
  async function describeCreator(detail, type, findings) {
    if (!detail) return { kind: "none", basis: null };
    let field = CREATED_FIELDS.find((f) => detail[f] != null);
    let basis = "created";
    if (!field) {
      field = MODIFIED_FIELDS.find((f) => detail[f] != null);
      basis = "modified";
    }
    if (!findings.creatorFields.has(type)) findings.creatorFields.set(type, field || "(none)");
    if (!field) return { kind: "none", basis: null };
    const actor = await resolveActor(detail[field]);
    return { ...actor, basis, field };
  }

  /**
   * Version candidates, evidence-first.
   *
   * The first live run proved two candidates are always wasted: "LATEST" is
   * never accepted ("Could not find the dependency object with specified ID and
   * version") and omitting the parameter is rejected outright ("Query parameter
   * 'version' is missing or empty"). Both are gone — the object's own version is
   * the only thing that has ever worked.
   */
  function versionCandidates(own, fromEntry) {
    return [...new Set([own, fromEntry].filter(Boolean).map(String))];
  }

  /** Walk the closure from the root, recursing only into flow-typed objects. */
  async function buildClosure(findings) {
    const closure = new Map();
    const rootType = DT_FLOW_TYPE[state.rootMeta.type];
    if (!rootType) {
      // No generic "FLOW" exists in the enum, so there is nothing safe to guess.
      throw new Error(
        `Flow type '${state.rootMeta.type}' has no known dependency-tracking ` +
        `object type, so its dependencies cannot be resolved.`
      );
    }
    const rootKey = keyOf(rootType, state.rootId);

    closure.set(rootKey, {
      key: rootKey, id: state.rootId, name: state.rootMeta.name,
      type: rootType, isRoot: true, isFlow: true, tier: "A", noDeleteApi: false,
      version: null,
    });

    const queue = [{ key: rootKey, id: state.rootId, type: rootType, isFlow: true, version: null }];
    const visited = new Set([rootKey]);

    while (queue.length) {
      const cur = queue.shift();
      // Only flows are recursed into: a data table's contents are out of scope by
      // design (§2), so non-flow objects are leaves.
      if (!cur.isFlow) continue;

      let entries;
      try {
        const own = await resolveFlowVersion(cur.id);
        const versions = versionCandidates(own, cur.version);
        if (!versions.length) throw new Error("no version could be determined for this flow");
        // Remember it so the consumer lookup asks about the same version.
        const node = closure.get(cur.key);
        if (node) node.version = versions[0];
        ({ entries } = await consumedWithFallback(cur.id, cur.type, versions, findings));
      } catch (err) {
        // A failure on the ROOT is fatal. Continuing would produce a closure of
        // one and a report reading "no dependencies found" — which is not a
        // finding, it is the absence of one, and reads as a green light.
        if (cur.key === rootKey) {
          throw new Error(
            `Could not read the flow's dependencies: ${err.message || err}. ` +
            `This may be a missing dependency-tracking permission on your account. ` +
            `No conclusions can be drawn about this flow.`
          );
        }
        // Not fatal — but the tree is now missing whatever this flow used, so it
        // must be said out loud rather than left in the diagnostics.
        const label = closure.get(cur.key)?.name || cur.id;
        findings.errors.push(`consumedresources for '${label}' (${cur.type}): ${err.message || err}`);
        state.incomplete.push(label);
        continue;
      }

      for (const dep of entries) {
        findings.typesSeen.set(dep.type, (findings.typesSeen.get(dep.type) || 0) + 1);
        if (dep.deleted) continue;                // already gone
        // Platform vocabulary never enters the tree — see PLATFORM_VOCABULARY.
        if (PLATFORM_VOCABULARY.has(String(dep.type).toUpperCase())) {
          findings.excluded.set(dep.type, (findings.excluded.get(dep.type) || 0) + 1);
          continue;
        }
        const k = keyOf(dep.type, dep.id);
        if (k === cur.key || visited.has(k)) continue;
        visited.add(k);
        const flowish = isFlowType(dep.type);
        const upper = String(dep.type).toUpperCase();
        closure.set(k, {
          key: k, id: dep.id, name: dep.name, type: dep.type,
          isRoot: false, isFlow: flowish,
          tier: tierOf(dep.type),
          version: dep.version || null,
          noDeleteApi: NO_DELETE_API.has(upper),
          neverOffer: NEVER_OFFER.has(upper),
        });
        queue.push({ key: k, id: dep.id, type: dep.type, isFlow: flowish, version: dep.version || null });
      }
    }
    return closure;
  }

  /**
   * Attachment probes — things that point AT a flow from outside Architect.
   *
   * Dependency Tracking indexes what a flow references, and what references it
   * *within Architect*. It does not know about the places a flow is attached to
   * the platform: a web messaging deployment, a queue's in-queue flow, a call
   * route. Those hold the flow just as firmly, and Genesys will refuse to delete
   * it, but `consumingresources` returns nothing for them.
   *
   * Proven, not theorised: a messaging flow attached to a deployment reported
   * zero consumers and read as fully deletable.
   *
   * Each hit becomes a synthetic consumer whose key is deliberately outside the
   * closure, so the existing §5 rule treats it as a hard blocker with no changes
   * to the graph module.
   *
   * @returns {{ byFlowId: Map<string, object[]>, unchecked: string[] }}
   */
  async function probeAttachments(flowIds, findings) {
    const byFlowId = new Map();
    const unchecked = [];
    /**
     * `holderId` is the REAL id of the attaching object, not a synthetic one, so
     * that a probe hit which Dependency Tracking already reported can be
     * recognised as the same fact and dropped. Queue assignments turn out to be
     * indexed by DT; web deployments are not. Reporting both sources blindly
     * listed one queue twice under two different labels.
     */
    const add = (flowId, holderId, name, type) => {
      if (!flowId || !flowIds.has(String(flowId))) return;
      const list = byFlowId.get(String(flowId)) || [];
      list.push({ id: String(holderId || `attach:${type}:${name}`), name, type });
      byFlowId.set(String(flowId), list);
    };

    // Web / messaging deployments → an inbound message flow.
    try {
      const resp = await api.proxyGenesys(state.orgId, "GET", "/api/v2/webdeployments/deployments");
      const list = Array.isArray(resp) ? resp : (resp?.entities || []);
      for (const d of list) add(d?.flow?.id, d?.id, d?.name || "(unnamed deployment)", "WEBDEPLOYMENT");
      findings.probes.push({ probe: "web deployments", ok: true, count: list.length });
    } catch (err) {
      unchecked.push("web/messaging deployments");
      findings.probes.push({ probe: "web deployments", ok: false, error: (err.message || String(err)).slice(0, 200) });
    }

    // Queues → in-queue call / message / email flows.
    try {
      const queues = await gc.fetchAllPages(api, state.orgId, "/api/v2/routing/queues");
      for (const q of queues) {
        for (const field of ["queueFlow", "messageInQueueFlow", "emailInQueueFlow"]) {
          add(q?.[field]?.id, q?.id, `${q.name} (${field})`, "QUEUEASSIGNMENT");
        }
      }
      findings.probes.push({ probe: "queues", ok: true, count: queues.length });
    } catch (err) {
      unchecked.push("queue in-queue flow assignments");
      findings.probes.push({ probe: "queues", ok: false, error: (err.message || String(err)).slice(0, 200) });
    }

    // Call routes (IVR configurations) → open/closed/holiday hours flows.
    try {
      const ivrs = await gc.fetchAllPages(api, state.orgId, "/api/v2/architect/ivrs");
      for (const ivr of ivrs) {
        for (const field of ["openHoursFlow", "closedHoursFlow", "holidayHoursFlow"]) {
          add(ivr?.[field]?.id, ivr?.id, `${ivr.name} (${field})`, "CALLROUTE");
        }
      }
      findings.probes.push({ probe: "call routes", ok: true, count: ivrs.length });
    } catch (err) {
      unchecked.push("call routes");
      findings.probes.push({ probe: "call routes", ok: false, error: (err.message || String(err)).slice(0, 200) });
    }

    return { byFlowId, unchecked };
  }

  /** Fetch the consumer list for every object in the closure. */
  async function buildConsumerGraph(closure, findings) {
    const consumers = new Map();
    let done = 0;
    for (const node of closure.values()) {
      // The index reported it could not process this object, so whatever it says
      // about the object's consumers is incomplete by its own admission.
      if (state.failedObjectIds?.has(String(node.id).toLowerCase())) {
        consumers.set(node.key, null);
        findings.errors.push(`'${node.name}' is listed in the index's failedObjects — dependency data for it is incomplete`);
        done++;
        continue;
      }
      try {
        // Ask about the same version the object was discovered at; flows get
        // their own resolved version, everything else what the entry carried.
        const version = node.version
          || (node.isFlow ? await resolveFlowVersion(node.id) : null);
        const list = await gc.fetchConsumingResources(api, state.orgId, node.id, node.type,
          version ? { query: { version } } : {});
        const kept = list.filter((c) => !c.deleted && c.id !== node.id);
        // Which version each answer came from. Two runs returned DISJOINT
        // consumer sets for the same data action, and version scoping is the
        // leading explanation — this records the evidence to confirm it.
        findings.consumerCalls.push({
          name: node.name, type: node.type, version: version || "(none)",
          count: kept.length, names: kept.map((c) => c.name).slice(0, 8),
        });
        consumers.set(node.key, kept);
      } catch (err) {
        // Unknown, never empty: an object we cannot check must not read as safe.
        consumers.set(node.key, null);
        findings.errors.push(`consumingresources for '${node.name}' (${node.type}): ${err.message || err}`);
      }
      done++;
      setStatus(`Checking dependencies… ${done}/${closure.size}`, "", true);
    }
    return consumers;
  }

  /**
   * Add the numbers that make the cost of a tick visible before it is made
   * (design §3): rows on a data table, members on a queue. Best-effort — a
   * missing count is cosmetic, so a failure here never interrupts the analysis.
   */
  async function enrichNodes(closure, findings) {
    for (const node of closure.values()) {
      const type = String(node.type).toUpperCase();

      // Counts that make the cost of a tick visible.
      try {
        if (type === "DATATABLE") {
          const r = await api.proxyGenesys(state.orgId, "GET",
            `/api/v2/flows/datatables/${node.id}/rows`, { query: { pageSize: "1", showbrief: "true" } });
          if (typeof r?.total === "number") node.rowCount = r.total;
        } else if (type === "QUEUE") {
          const r = await api.proxyGenesys(state.orgId, "GET",
            `/api/v2/routing/queues/${node.id}/members`, { query: { pageSize: "1" } });
          if (typeof r?.total === "number") node.memberCount = r.total;
        }
      } catch (_) { /* cosmetic only */ }

      // Provenance. Flows reuse the detail already fetched for their version.
      try {
        let detail = null;
        if (node.isFlow) detail = await getFlowDetail(node.id);
        else if (DETAIL_PATH[type]) {
          detail = await api.proxyGenesys(state.orgId, "GET", DETAIL_PATH[type](node.id));
        }
        node.creator = await describeCreator(detail, type, findings);
        if (detail?.dateCreated) node.dateCreated = detail.dateCreated;
      } catch (_) {
        node.creator = { kind: "none", basis: null };
      }
    }
  }

  // ── Analyse ───────────────────────────────────────────
  async function analyse() {
    if (state.busy || !state.rootId) return;
    state.busy = true;
    $analyse.disabled = true;
    $report.innerHTML = "";

    const findings = {
      typesSeen: new Map(),
      excluded: new Map(),      // platform vocabulary kept out of the tree
      objectTypeCalls: [],
      probes: [],               // attachment probes and their outcomes
      consumerCalls: [],        // which version each consumer answer came from
      creatorFields: new Map(), // which provenance field each type actually has
      errors: [],
      buildStatus: null,
    };
    state.incomplete = [];
    state.uncheckedAttachments = [];

    try {
      // 1. The index must be current, or every answer below is fiction (§4.1).
      setStatus("Checking the dependency-tracking index…", "", true);
      let build;
      try {
        build = await gc.getDependencyTrackingBuildStatus(api, state.orgId);
        findings.buildStatus = build;
      } catch (err) {
        throw new Error(
          `Could not read the dependency-tracking build status: ${err.message || err}. ` +
          `Without it there is no way to know whether the dependency data is current, ` +
          `so the analysis is stopped here.`
        );
      }
      const buildState = String(build?.status || build?.state || "").toUpperCase();
      if (!BUILD_READY.has(buildState)) {
        const why = BUILD_NOT_READY[buildState];
        throw new Error(why
          ? `The dependency-tracking index is not usable — ${why} (status "${buildState}"). ` +
            `Wait for it to become OPERATIONAL and re-run.`
          : `Unrecognised dependency-tracking build status "${buildState}". Refusing to ` +
            `continue rather than guess whether the dependency data can be trusted.`);
      }
      state.buildDate = build?.dateCompleted || null;

      // Objects the index itself failed to process have incomplete dependency
      // data — precisely the case that produces a false orphan. They are not
      // fatal to the run, but any that turn up in this closure are forced to
      // UNKNOWN rather than trusted.
      state.failedObjectIds = new Set(
        (Array.isArray(build?.failedObjects) ? build.failedObjects : [])
          .map((o) => String(o?.id || o || "").toLowerCase())
          .filter(Boolean)
      );

      // 2. Root flow metadata — including any Architect checkout.
      setStatus("Reading the flow…", "", true);
      state.lockNote = null;
      state.rootVersions = [];
      flowDetailCache.clear();
      actorCache.clear();
      try {
        const flow = await api.proxyGenesys(state.orgId, "GET", `/api/v2/flows/${state.rootId}`);
        const locker = flow?.lockedUser?.name || flow?.lockedUser?.email || flow?.lockedUser?.id;
        if (locker) state.lockNote = `Checked out in Architect by ${locker}`;
        // Dependency Tracking wants a version alongside the id. Collect the real
        // ones so the lookup has something concrete to try beyond "LATEST".
        state.rootVersions = [
          flow?.publishedVersion?.id, flow?.checkedInVersion?.id, flow?.savedVersion?.id,
        ].filter(Boolean).map(String);
        findings.flowVersions = state.rootVersions;
      } catch (_) { /* metadata is a nicety; discovery does not depend on it */ }

      // 3. Closure, then consumer graph.
      setStatus("Resolving dependencies…", "", true);
      state.closure = await buildClosure(findings);
      state.consumers = await buildConsumerGraph(state.closure, findings);

      // Attachments the index cannot see — merged in as synthetic consumers so
      // the ordinary blocker rules apply to them.
      setStatus("Checking where these flows are attached…", "", true);
      const flowIds = new Set(
        [...state.closure.values()].filter((n) => n.isFlow).map((n) => String(n.id))
      );
      const { byFlowId, unchecked } = await probeAttachments(flowIds, findings);
      state.uncheckedAttachments = unchecked;
      for (const node of state.closure.values()) {
        const found = byFlowId.get(String(node.id));
        if (!found?.length) continue;
        const existing = state.consumers.get(node.key);
        // A null (unknown) list stays unknown — it is already the stricter state.
        if (existing === null) continue;
        // Drop probe hits the index already reported. Queue assignments ARE
        // indexed by Dependency Tracking; web deployments are not. Without this
        // one queue was listed twice under two different labels, which reads as
        // two separate things holding the flow.
        const known = new Set((existing || []).map((c) => String(c.id).toLowerCase()));
        const novel = found.filter((f) => !known.has(String(f.id).toLowerCase()));
        if (novel.length) state.consumers.set(node.key, [...(existing || []), ...novel]);
      }

      await enrichNodes(state.closure, findings);
      state.findings = findings;

      // 4. Root blockers: consumers outside the closure hold the flow itself, and
      //    by §7 that locks everything below it.
      const rootNode = [...state.closure.values()].find((n) => n.isRoot);
      state.rootKey = rootNode.key;
      state.rootHardBlocked = false;               // computed from blockers below
      state.rootBlockers = blockedHard(rootNode.key);
      state.rootHardBlocked = state.rootBlockers.length > 0 || !!state.lockNote;

      // 5. Default selection: every orphaned tier A object, settled to a fixpoint.
      defaultSelection(state);

      renderReport();
      setStatus(
        state.rootHardBlocked
          ? "This flow cannot be deleted yet — see the blockers below."
          : `Analysis complete — ${state.closure.size - 1} dependencies found.`,
        state.rootHardBlocked ? "error" : "success"
      );
    } catch (err) {
      setStatus(err.message || String(err), "error");
      // Surface the findings even on failure — a run that stopped early is still
      // evidence about the API's real behaviour, which is half of Phase 1's job.
      state.findings = findings;
      renderFindings();
    } finally {
      state.busy = false;
      $analyse.disabled = !state.rootId;
    }
  }

  // ── Render ────────────────────────────────────────────

  function consumerNames(list, limit = 6) {
    const names = list.map((c) => `${c.name} (${typeLabel(c.type)})`);
    return names.length > limit
      ? names.slice(0, limit).join(", ") + ` and ${names.length - limit} more`
      : names.join(", ");
  }

  /**
   * Provenance line. Three honest states and no fourth: a person, an API client,
   * or not recorded. "created" and "last modified" are kept distinct because on
   * several object types only the latter is available, and presenting it as
   * authorship would be a guess dressed as a fact.
   */
  function creatorHtml(node) {
    const c = node.creator;
    if (!c || c.kind === "none") {
      return `<span style="color:var(--muted)">Creator not recorded for this object type.</span>`;
    }
    const verb = c.basis === "created" ? "Created" : "Last modified";
    const when = node.dateCreated && c.basis === "created"
      ? ` on ${new Date(node.dateCreated).toLocaleDateString()}` : "";
    if (c.kind === "user")  return `${verb} by <strong>${escapeHtml(c.name)}</strong>${when}.`;
    if (c.kind === "oauth") return `${verb} via API — OAuth client <strong>${escapeHtml(c.name)}</strong>${when}.`;
    if (c.kind === "label") return `${verb} by ${escapeHtml(c.name)}${when}.`;
    // Resolved to neither a user nor a client: could be a deleted user or a
    // client we cannot read. Say that, rather than pick one.
    return `<span style="color:var(--muted)">${verb} by an account that no longer resolves `
      + `(${escapeHtml(String(c.name).slice(0, 8))}…) — a deleted user or an API client.</span>`;
  }

  /** One dependency row: checkbox when deletable, reason when not. */
  function rowHtml(node) {
    const consumers = state.consumers.get(node.key);
    const unknown = consumers === null;
    const hard = unknown ? [] : blockedHard(node.key);
    const soft = unknown ? [] : blockedSoft(node.key);
    const canDelete = !unknown && deletable(node.key);
    const checked = state.selection.has(node.key);

    let reason;
    if (unknown) {
      reason = `<span class="df-block">Could not be checked — treated as in use.</span>`;
    } else if (node.neverOffer) {
      reason = `<span class="df-lock">Org-level object — reported, but never removed by this tool.</span>`;
    } else if (node.noDeleteApi) {
      reason = `<span class="df-lock">No delete API for this type — reported only.</span>`;
    } else if (state.rootHardBlocked) {
      // The tree is locked, but the findings still have to be reported — a
      // blocked flow is when knowing what you are dealing with matters most.
      // Reported selection-independently, since nothing can be selected: who
      // uses this today, full stop.
      const all = consumers || [];
      reason = (all.length
        ? `Used by ${escapeHtml(consumerNames(all))}.`
        : `Nothing else uses this.`)
        + ` <span class="df-lock">Locked while the callflow is blocked.</span>`;
    } else if (hard.length) {
      // Show the in-tree consumers too. A row listing only the outside ones
      // reads as the complete picture and is not — that asymmetry once made a
      // deliberate org change look like an API defect.
      const inTree = (consumers || [])
        .filter((c) => state.closure.has(keyOf(c.type, c.id)))
        .map((c) => state.closure.get(keyOf(c.type, c.id)));
      reason = `<span class="df-lock">Kept — still used by ${escapeHtml(consumerNames(hard))}, `
        + `outside this callflow.</span>`
        + (inTree.length ? ` <span style="color:var(--muted)">Also used inside it by ${escapeHtml(consumerNames(inTree))}.</span>` : "");
    } else if (soft.length) {
      reason = `<span class="df-lock">Kept — used by ${escapeHtml(consumerNames(soft))}, which ${soft.length === 1 ? "is" : "are"} not selected.</span>`;
    } else {
      reason = `Nothing else uses this.`;
    }

    // The cost of a tick, made visible before it is made: rows are customer data,
    // and a queue with members is live infrastructure, not a callflow artifact.
    const extra = [];
    if (node.tier === "B") extra.push("org-level");
    if (typeof node.rowCount === "number") extra.push(`${node.rowCount} row${node.rowCount === 1 ? "" : "s"}`);
    if (typeof node.memberCount === "number") extra.push(`${node.memberCount} member${node.memberCount === 1 ? "" : "s"}`);

    return `
      <div class="df-row ${canDelete ? "" : "df-row--locked"}">
        <input type="checkbox" data-key="${escapeHtml(node.key)}"
               ${canDelete ? "" : "disabled"} ${checked ? "checked" : ""}
               style="margin-top:3px" />
        <div class="df-row-main">
          <div class="df-name">${escapeHtml(node.name)}
            <span class="df-badge">${escapeHtml(typeLabel(node.type))}</span>
            ${extra.length ? `<span class="df-badge">${escapeHtml(extra.join(" · "))}</span>` : ""}
          </div>
          <div class="df-sub">${reason}</div>
          <div class="df-sub" style="margin-top:1px">${creatorHtml(node)}</div>
        </div>
      </div>`;
  }

  function sectionHtml(title, nodes, tier, blurb) {
    if (!nodes.length) return "";
    const selectable = nodes.filter((n) => deletable(n.key)).length;
    return `
      <div class="df-sect ${tier === "B" ? "df-sect--b" : ""}">
        <div class="df-sect-head">
          <h3>${escapeHtml(title)}
            <span class="df-badge">${nodes.length} found</span>
            <span class="df-badge">${selectable} selectable</span>
          </h3>
          ${blurb ? `<div class="df-sub" style="margin-top:4px">${blurb}</div>` : ""}
        </div>
        ${nodes.map(rowHtml).join("")}
      </div>`;
  }

  function renderReport() {
    const nodes = [...state.closure.values()].filter((n) => !n.isRoot);
    const byName = (a, b) => (a.type + a.name).localeCompare(b.type + b.name);
    const tierA = nodes.filter((n) => n.tier === "A").sort(byName);
    const tierB = nodes.filter((n) => n.tier === "B").sort(byName);
    const root = state.closure.get(state.rootKey);

    const blockersHtml = state.rootHardBlocked ? `
      <div class="df-note">
        <strong class="df-block">This callflow cannot be deleted yet.</strong>
        <ul style="margin:7px 0 0;padding-left:18px;font-size:.86rem;line-height:1.6">
          ${state.lockNote ? `<li>${escapeHtml(state.lockNote)}</li>` : ""}
          ${state.rootBlockers.map((b) =>
            `<li>${escapeHtml(b.name)} <span style="color:var(--muted)">— ${escapeHtml(typeLabel(b.type))}</span></li>`
          ).join("")}
        </ul>
        <p style="margin:8px 0 0;font-size:.83rem;color:var(--muted)">
          Detach these in Genesys, then run the analysis again. While the flow itself
          survives it still uses everything below, so nothing here is removable.
        </p>
      </div>` : "";

    $report.innerHTML = `
      <div class="df-sect">
        <div class="df-sect-head">
          <h3>${escapeHtml(root.name)}
            <span class="df-badge">${escapeHtml(typeLabel(root.type))}</span>
            <span class="df-badge">${state.rootHardBlocked ? "blocked" : "deletable"}</span>
          </h3>
          <div class="df-sub" style="margin-top:4px">
            The callflow being removed.${state.buildDate ? `
            Dependency index last fully rebuilt ${escapeHtml(new Date(state.buildDate).toLocaleString())}
            — normal for this to be old, as publishing updates it incrementally.` : ""}
          </div>
        </div>
      </div>
      ${blockersHtml}
      ${state.uncheckedAttachments?.length ? `
        <div class="df-note">
          <strong class="df-block">Some attachments could not be checked.</strong>
          <p style="margin:6px 0 0;font-size:.85rem">
            ${escapeHtml(state.uncheckedAttachments.join(", "))} could not be read, so a
            flow shown as deletable here may still be attached to one. Dependency
            Tracking does not report these — they are checked separately, and that
            check did not complete.
          </p>
        </div>` : ""}
      ${state.incomplete.length ? `
        <div class="df-note">
          <strong class="df-block">This report is incomplete.</strong>
          <p style="margin:6px 0 0;font-size:.85rem">
            The dependencies of ${state.incomplete.length} flow${state.incomplete.length === 1 ? "" : "s"}
            could not be read — ${escapeHtml(state.incomplete.slice(0, 5).join(", "))}${
              state.incomplete.length > 5 ? `, and ${state.incomplete.length - 5} more` : ""}.
            Anything used only by ${state.incomplete.length === 1 ? "it" : "them"} is missing from
            the list below. Treat this as a partial picture, not a clean one.
          </p>
        </div>` : ""}
      ${sectionHtml("Callflow objects", tierA, "A",
        "Object types that belong to a callflow — other flows, data tables, data actions, " +
        "scripts, survey forms and prompts. Selected by default where nothing else uses them.")}
      ${sectionHtml("Org-level objects", tierB, "B",
        "Queues, skills, schedules and the like. They exist independently of any callflow, " +
        "and may be used in ways that are not visible here — queues and skills are often " +
        "looked up by name at runtime. Never selected by default.")}
      <div id="dfSummary"></div>
      <div id="dfFindings"></div>`;

    renderSummary();
    renderFindings();
  }

  function renderSummary() {
    const sum = $("#dfSummary");
    if (!sum) return;
    const total = state.closure.size - 1;
    const kept = total - state.selection.size;
    sum.innerHTML = `
      <div class="df-sect">
        <div class="df-sect-head">
          <h3>Summary</h3>
          <div class="df-sub" style="margin-top:4px">
            ${state.rootHardBlocked
              ? "Nothing can be removed while the callflow is blocked."
              : `The callflow plus <strong>${state.selection.size}</strong> of ${total} dependencies would be removed; <strong>${kept}</strong> kept.`}
          </div>
        </div>
        <div class="df-row">
          <div class="df-row-main df-sub">
            Phase 1 reports only — no deletion is performed. Execution, with the
            re-verification step, lands in Phase 2.
          </div>
        </div>
      </div>`;
  }

  /**
   * Diagnostics for design §13. Phase 1's second job is telling us what the
   * Dependency Tracking API actually returns, so the raw shapes are surfaced
   * rather than swallowed.
   */
  function renderFindings() {
    const host = $("#dfFindings") || $report;
    const f = state.findings;
    if (!f || !host) return;
    const types = [...f.typesSeen.entries()].sort((a, b) => b[1] - a[1]);
    const block = document.createElement("details");
    block.className = "df-sect";
    block.style.cssText = "padding:10px 12px";
    block.innerHTML = `
      <summary style="cursor:pointer;user-select:none;font-size:.88rem">
        Findings — what the dependency-tracking API returned
      </summary>
      <div style="margin-top:9px;font-size:.82rem;line-height:1.6">
        <div><strong>Object types seen:</strong> ${
          types.length ? types.map(([t, n]) => `${escapeHtml(t || "(blank)")} ×${n}`).join(" · ") : "none"
        }</div>
        <div style="margin-top:5px"><strong>Excluded as platform vocabulary:</strong> ${
          f.excluded?.size
            ? [...f.excluded.entries()].sort((a, b) => b[1] - a[1])
                .map(([t, n]) => `${escapeHtml(t)} ×${n}`).join(" · ")
            : "none"
        }</div>
        <div style="margin-top:5px"><strong>Provenance field per type:</strong> ${
          f.creatorFields?.size
            ? [...f.creatorFields.entries()].map(([t, fld]) =>
                `${escapeHtml(t)}=${escapeHtml(fld)}`).join(" · ")
            : "none"
        }</div>
        <div style="margin-top:5px"><strong>Attachment probes:</strong> ${
          f.probes?.length
            ? f.probes.map((p) => `${escapeHtml(p.probe)} ${p.ok
                ? `ok (${p.count} scanned)` : `FAILED: ${escapeHtml(p.error || "")}`}`).join(" · ")
            : "none"
        }</div>
        <div style="margin-top:5px"><strong>Flow versions available:</strong> ${
          escapeHtml((f.flowVersions || []).join(", ") || "none read")
        }</div>
        <div style="margin-top:5px"><strong>objectType / version calls:</strong>
          <ul style="margin:3px 0 0;padding-left:18px">
            ${f.objectTypeCalls.length
              ? f.objectTypeCalls.slice(0, 14).map((c) =>
                  `<li>${escapeHtml(c.objectType)} @ ${escapeHtml(String(c.version ?? "—"))} — ${
                    c.ok ? `<strong>ok (${c.count})</strong>`
                         : `failed: ${escapeHtml(c.error || "")}`}</li>`).join("")
              : "<li>none</li>"}
          </ul>
        </div>
        <div style="margin-top:5px"><strong>Build status:</strong> <code>${
          escapeHtml(JSON.stringify(f.buildStatus || null).slice(0, 400))
        }</code></div>
        <div style="margin-top:7px"><strong>Consumer lookups (version → who came back):</strong>
          <ul style="margin:3px 0 0;padding-left:18px">
            ${(f.consumerCalls || []).slice(0, 30).map((c) =>
              `<li>${escapeHtml(c.name)} <span style="color:var(--muted)">[${escapeHtml(c.type)}]</span>
               @ ${escapeHtml(String(c.version))} → ${c.count}${
                 c.names?.length ? `: ${escapeHtml(c.names.join(", "))}` : ""}</li>`).join("") || "<li>none</li>"}
          </ul>
        </div>
        ${f.errors.length ? `
          <div style="margin-top:7px"><strong class="df-block">Errors (${f.errors.length}):</strong>
            <ul style="margin:4px 0 0;padding-left:18px">
              ${f.errors.slice(0, 12).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}
            </ul>
          </div>` : ""}
      </div>`;
    const existing = host.querySelector("details");
    if (existing) existing.replaceWith(block); else host.appendChild(block);
  }

  /**
   * A toggle changes what counts as orphaned, so the whole tree is re-derived —
   * unticking a common module must re-lock the data table only it used.
   *
   * Bound ONCE, on the container that renderReport() writes into rather than the
   * rows it replaces, so repeated renders cannot stack listeners.
   */
  $report.addEventListener("change", (ev) => {
    const cb = ev.target.closest("input[type=checkbox][data-key]");
    if (!cb) return;
    const key = cb.dataset.key;
    if (cb.checked) state.selection.add(key); else state.selection.delete(key);
    settleSelection(state);
    renderReport();
  });

  // ── Flow picker ───────────────────────────────────────
  function renderMenu(term) {
    const q = term.trim().toLowerCase();
    const list = state.flows
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .slice(0, 60);
    $flowMenu.innerHTML = list.length
      ? list.map((f) => `
          <div class="df-item" data-id="${escapeHtml(f.id)}">
            ${escapeHtml(f.name)}
            <span class="df-meta">· ${escapeHtml(f.type)}</span>
          </div>`).join("")
      : `<div class="df-item df-meta">No flows match.</div>`;
    $flowMenu.classList.add("open");
  }

  $flowInput.addEventListener("input", () => {
    state.rootId = "";
    state.rootMeta = null;
    $analyse.disabled = true;
    renderMenu($flowInput.value);
  });
  $flowInput.addEventListener("focus", () => renderMenu($flowInput.value));
  $flowMenu.addEventListener("click", (ev) => {
    const item = ev.target.closest(".df-item[data-id]");
    if (!item) return;
    const flow = state.flowById.get(item.dataset.id);
    if (!flow) return;
    state.rootId = flow.id;
    state.rootMeta = flow;
    $flowInput.value = flow.name;
    $flowMenu.classList.remove("open");
    $analyse.disabled = false;
    setStatus(`Ready to analyse “${flow.name}”.`);
  });
  document.addEventListener("click", (ev) => {
    if (!el.isConnected) return;          // navigated away — go inert
    if (!el.contains(ev.target)) $flowMenu.classList.remove("open");
  });
  $analyse.addEventListener("click", analyse);

  // ── Init ──────────────────────────────────────────────
  (async function init() {
    state.orgId = orgContext.get();
    if (!state.orgId) {
      setStatus("Select an organisation in the selector at the top of the page.");
      return;
    }
    setStatus("Loading flows…", "", true);
    try {
      const flows = await gc.fetchAllFlows(api, state.orgId, { query: { pageSize: "100" } });
      state.flows = (flows || [])
        .filter((f) => f.id && f.name)
        .map((f) => ({ id: f.id, name: f.name, type: (f.type || "").toLowerCase() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      state.flowById = new Map(state.flows.map((f) => [f.id, f]));
      $flowInput.disabled = false;
      $flowInput.placeholder = `Search ${state.flows.length} flows…`;
      setStatus("Pick a callflow to analyse.");
    } catch (err) {
      setStatus(`Could not load flows: ${err.message || err}`, "error");
    }
  })();

  return el;
}
