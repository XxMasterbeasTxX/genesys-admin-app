/**
 * Dashboards › Quality › STA Configuration
 *
 * See docs/dashboards-quality-design.md §13.
 *
 * Every Speech & Text Analytics setting that decides what happens to an
 * interaction: whether it is transcribed, which program covers it, what that
 * program analyses, and whether a scoring rule turns it into an evaluation.
 *
 * Named for what it holds rather than for one of its consequences. It shipped
 * as Evaluation Gaps, was renamed to Evaluation Setup when it turned out to be
 * settings rather than gaps, and renamed again because transcription, insights,
 * empathy and engines are not about evaluations at all (§13.7). The list of
 * interactions that should have been evaluated and were not is its own page
 * (§14).
 * It reads the chain an interaction must pass for its agent to be evaluated
 * (§13.2) and reports every link that is switched off:
 *
 *   1. org transcription mode          routing/settings/transcription
 *   2. per-queue transcription         Queue.enableTranscription
 *   3. queue/flow covered by a program speechandtextanalytics/programs/mappings
 *   4. program published               speechandtextanalytics/programs/unpublished
 *   5. a scoring rule enabled+published quality/programs/{id}/agentscoringrules
 *
 * None of that needs conversation data, so it costs a handful of requests
 * whatever the org's volume, and every answer is a fact rather than an
 * estimate. The per-agent half (§13.0a) comes second, once three facet
 * questions are settled against a live org (§13.5).
 *
 * WHY AN AGENT SCORING RULE AND NOT A POLICY. Auto-evaluation comes only from
 * a Speech & Text Analytics program. A media retention policy's
 * assignEvaluations cannot do it — its conditions carry queues and no flows,
 * and `submissionType: Automated` lives on the scoring rule.
 *
 * Read-only, so no Activity Log entry.
 */

import {
  fetchPrograms, fetchUnpublishedPrograms, fetchProgramMappings,
  fetchAgentScoringRules, fetchTranscriptionSettings, fetchAllQueues,
  fetchAllEvaluationForms, fetchProgramInsightsSettings,
  fetchProgramTranscriptionEngines, fetchSpeechTextAnalyticsSettings,
  fetchProgram,
} from "../../../services/genesysApi.js";
import { makeStatus, escapeHtml } from "../../../utils.js";

/** `n thing` / `n things`, because "1 queues" is the kind of thing people notice. */
function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export default function renderEvaluationGaps({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Quality — STA Configuration</h1>
    <hr class="hr">

    <p class="page-desc">
      Your Speech and Text Analytics configuration, and what it is doing to
      your interactions. Transcription, the programs that cover each queue and
      flow, what those programs analyse, and the scoring rules that turn an
      interaction into an evaluation. Where a setting is stopping something from
      happening, it is called out.
    </p>

    <div class="cs-actions">
      <button class="btn" data-c="load">Check configuration</button>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-tiles" data-c="tiles"></div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Speech and Text Analytics</h3>
        <p class="dq-panel-sub">
          Organisation-level settings, which override program-level
          configuration — Genesys says so on the program editor itself. Agent
          Empathy Analysis and Customer Sentiment Analysis appear there as
          per-program checkboxes, but no per-program value is readable through
          the API.
        </p>
        <div class="eg-facts" data-c="orgFacts"></div>
        <div class="dq-panel-note" data-c="orgNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Programs</h3>
        <p class="dq-panel-sub" data-c="programSub"></p>
        <div class="dq-table-wrap">
          <table class="dq-table" data-c="programs"></table>
        </div>
        <div class="dq-panel-note" data-c="programNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Agent scoring rules</h3>
        <p class="dq-panel-sub" data-c="ruleSub"></p>
        <div class="dq-table-wrap">
          <table class="dq-table" data-c="rules"></table>
        </div>
        <div class="dq-panel-note" data-c="ruleNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Queue transcription</h3>
        <p class="dq-panel-sub" data-c="transcriptionSub"></p>
        <div class="dq-table-wrap">
          <table class="dq-table" data-c="queues"></table>
        </div>
        <div class="dq-panel-note" data-c="queueNote" hidden></div>
      </div>
    </div>
  `;

  const $ = (n) => el.querySelector(`[data-c="${n}"]`);
  const $status = $("status");
  const $results = $("results");
  const $loadBtn = $("load");

  const applyStatus = makeStatus($status, "cs-status");
  function setStatus(msg, type = "") {
    applyStatus(msg, type);
    $status.style.display = "";
  }
  function hideStatus() { $status.style.display = "none"; }

  const currentOrg = () => orgContext?.getDetails?.() || null;

  function reflectOrg() {
    const org = currentOrg();
    $loadBtn.disabled = !org;
    if (!org) {
      $results.hidden = true;
      setStatus("Please select a customer org from the dropdown above to get started.");
    } else {
      hideStatus();
    }
  }

  const unsubscribe = orgContext?.onChange?.(() => {
    $results.hidden = true;
    reflectOrg();
  });
  if (unsubscribe) el.__destroy = unsubscribe;

  reflectOrg();

  // ── Rendering ───────────────────────────────────────

  function tile(label, value, sub) {
    const empty = value == null;
    return `
      <div class="dq-tile">
        <div class="dq-tile-label">${escapeHtml(label)}</div>
        <div class="dq-tile-value${empty ? " is-empty" : ""}">${empty ? "—" : escapeHtml(value)}</div>
        ${sub ? `<div class="dq-tile-sub">${escapeHtml(sub)}</div>` : ""}
      </div>`;
  }

  /** A yes/no cell where "no" is worth noticing but is not necessarily a fault. */
  function yesNo(v, { flagNo = false } = {}) {
    if (v == null) return '<span class="dq-muted">—</span>';
    if (v) return "Yes";
    return flagNo ? '<span class="dq-flag">No</span>' : "No";
  }

  function renderOrgFacts(container, facts) {
    container.innerHTML = facts.map((f) => `
      <div class="eg-fact">
        <div class="eg-fact-label">${escapeHtml(f.label)}</div>
        <div class="eg-fact-value">${f.html}</div>
        ${f.sub ? `<div class="eg-fact-sub">${escapeHtml(f.sub)}</div>` : ""}
      </div>`).join("");
  }

  function renderProgramTable($table, rows) {
    if (!rows.length) {
      $table.innerHTML = "";
      return;
    }
    const head = ["Program", "Published", "Queues", "Flows",
                  "Transcription engines", "AI summary & insights", "Scoring rules"];
    $table.innerHTML =
      `<thead><tr>${head.map((h, i) =>
        `<th${(i >= 2 && i <= 3) || i === 6 ? ' class="is-num"' : ""}>${escapeHtml(h)}</th>`)
        .join("")}</tr></thead>` +
      `<tbody>${rows.map((r) => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${yesNo(r.published, { flagNo: true })}</td>
          <td class="is-num">${r.queues.toLocaleString()}</td>
          <td class="is-num">${r.flows.toLocaleString()}</td>
          <td>${escapeHtml(r.engines)}</td>
          <td>${r.insights == null
            ? '<span class="dq-muted">—</span>' : yesNo(r.insights)}</td>
          <td class="is-num">${escapeHtml(r.rules)}</td>
        </tr>`).join("")}</tbody>`;
  }

  /**
   * One row per RULE, not per program.
   *
   * A program can carry several rules with different forms, sampling and
   * targets, and folding them into one cell of the program table loses exactly
   * the detail someone came here for.
   */
  function renderRuleTable($table, rows) {
    if (!rows.length) {
      $table.innerHTML = "";
      return;
    }
    const head = ["Program", "State", "Selects", "Agents scored", "Submission",
                  "Form", "Evaluator"];
    $table.innerHTML =
      `<thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map((r) => `
        <tr>
          <td>${escapeHtml(r.program)}</td>
          <td>${r.live ? "Live" : `<span class="dq-flag">${escapeHtml(r.state)}</span>`}</td>
          <td>${escapeHtml(r.selects)}</td>
          <td>${escapeHtml(r.agents)}</td>
          <td>${escapeHtml(r.submission)}</td>
          <td>${escapeHtml(r.form)}</td>
          <td>${escapeHtml(r.evaluator)}</td>
        </tr>`).join("")}</tbody>`;
  }

  function renderQueueTable($table, rows) {
    if (!rows.length) {
      $table.innerHTML = "";
      return;
    }
    $table.innerHTML =
      '<thead><tr><th>Queue</th><th>Covered by</th><th>Transcription</th></tr></thead>' +
      `<tbody>${rows.map((r) => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.program)}</td>
          <td>${r.on ? "On" : '<span class="dq-flag">Off</span>'}</td>
        </tr>`).join("")}</tbody>`;
  }

  // ── Load ────────────────────────────────────────────
  $loadBtn.addEventListener("click", async () => {
    const org = currentOrg();
    if (!org) {
      setStatus("Please select a customer org from the dropdown above.", "error");
      return;
    }

    $loadBtn.disabled = true;
    $results.hidden = true;
    // Plain text, not spinHtml: makeStatus owns the throbber and inserts it
    // itself whenever the message ends in an ellipsis. Handing it markup as
    // well printed the span tags on screen, since it escapes what it is given.
    setStatus("Reading the quality automation configuration…");

    try {
      // Every call is independent and each one degrades on its own: a customer
      // may hold the quality permissions and not the routing ones, or the
      // reverse, and a page that fails whole because one of five was refused
      // would be useless to both.
      const [settingsRes, programsRes, unpublishedRes, mappingsRes, queuesRes, formsRes,
             staRes, insightsRes] =
        await Promise.allSettled([
          fetchTranscriptionSettings(api, org.id),
          fetchPrograms(api, org.id),
          fetchUnpublishedPrograms(api, org.id),
          fetchProgramMappings(api, org.id),
          fetchAllQueues(api, org.id),
          fetchAllEvaluationForms(api, org.id),
          fetchSpeechTextAnalyticsSettings(api, org.id),
          fetchProgramInsightsSettings(api, org.id),
        ]);

      const val = (r) => (r.status === "fulfilled" ? r.value : null);
      const why = (r) => (r.status === "rejected"
        ? (r.reason?.status === 403 ? "permission refused" : r.reason?.message || "failed")
        : null);

      const settings = val(settingsRes);
      const programs = val(programsRes) || [];
      const unpublished = val(unpublishedRes) || [];
      const mappings = val(mappingsRes) || [];
      const queues = val(queuesRes) || [];
      const forms = val(formsRes) || [];
      const sta = val(staRes);
      const insights = val(insightsRes) || [];

      const failures = [];
      for (const [name, r] of [
        ["transcription settings", settingsRes], ["programs", programsRes],
        ["unpublished programs", unpublishedRes], ["program mappings", mappingsRes],
        ["queues", queuesRes], ["evaluation forms", formsRes],
        ["analytics settings", staRes], ["AI insights settings", insightsRes],
      ]) {
        if (r.status === "rejected") failures.push(`${name} (${why(r)})`);
      }

      const mode = settings?.transcription || null;

      // ── Program mappings ─────────────────────────
      // `TopicsDefinitionsProgramMappings`: { program: {id}, queues: [{id}],
      // flows: [{id}] }. Entity refs, not id strings — the id-string shape is
      // the PUT body, and assuming the response matched it is what made this
      // page report a program with nine queues as covering none.
      const mapOf = new Map();
      for (const m of mappings || []) {
        const id = m.program?.id;
        if (!id) continue;
        mapOf.set(id, {
          queueIds: (m.queues || []).map((q) => q.id).filter(Boolean),
          flowIds: (m.flows || []).map((f) => f.id).filter(Boolean),
        });
      }

      const unpublishedIds = new Set(unpublished.map((p) => p.id).filter(Boolean));

      // ── 3. Scoring rules, one call per program ───
      setStatus("Reading scoring rules and transcription engines…");
      const [ruleResults, engineResults] = await Promise.all([
        Promise.allSettled(programs.map((p) => fetchAgentScoringRules(api, org.id, p.id))),
        Promise.allSettled(programs.map((p) => fetchProgramTranscriptionEngines(api, org.id, p.id))),
      ]);
      // A program whose rules could NOT be read is not a program with no rules.
      // `rulesOf` holds only what was actually returned, so "has no scoring
      // rule" can never be asserted from a refused request.
      const rulesOf = new Map();
      let ruleFailures = 0;
      programs.forEach((p, i) => {
        const r = ruleResults[i];
        if (r.status === "fulfilled") rulesOf.set(p.id, r.value || []);
        else ruleFailures++;
      });

      const formName = new Map(forms.map((f) => [f.contextId || f.id, f.name]));
      const queueById = new Map(queues.map((q) => [q.id, q]));

      // `{program, enabled}` per ProgramInsightsSettingsEntityListing.
      const insightsOf = new Map();
      for (const i of insights) {
        if (i?.program?.id) insightsOf.set(i.program.id, !!i.enabled);
      }

      // ProgramTranscriptionEngines.transcriptionEngines[] is
      // `{engine, dialects, engineIntegration}`; the dialects are what a reader
      // actually recognises, so both are shown.
      const enginesOf = new Map();
      programs.forEach((p, i) => {
        const r = engineResults[i];
        if (r.status !== "fulfilled") return;
        const list = r.value?.transcriptionEngines || [];
        enginesOf.set(p.id, list.map((e) => {
          const dialects = Array.isArray(e.dialects) ? e.dialects.join(", ") : e.dialects;
          return dialects ? `${e.engine || "engine"} (${dialects})` : (e.engine || "engine");
        }));
      });
      const engineFailures = engineResults.filter((r) => r.status === "rejected").length;

      // ── Per-program rows ─────────────────────────
      const programRows = [];
      const ruleRows = [];
      const coveredQueueIds = new Set();
      let liveRuleCount = 0;

      for (const p of programs) {
        const map = mapOf.get(p.id) || { queueIds: [], flowIds: [] };
        for (const q of map.queueIds) coveredQueueIds.add(q);
        const rulesKnown = rulesOf.has(p.id);
        const rules = rulesOf.get(p.id) || [];
        const live = rules.filter((r) => r.enabled && r.published);
        liveRuleCount += live.length;

        const isPublished = p.published !== false && !unpublishedIds.has(p.id);
        const scopeCount = map.queueIds.length + map.flowIds.length;

        const engines = enginesOf.get(p.id);
        programRows.push({
          name: p.name || p.id,
          published: isPublished,
          queues: map.queueIds.length,
          flows: map.flowIds.length,
          engines: engines == null ? "—" : (engines.length ? engines.join(" · ") : "none"),
          insights: insightsRes.status === "fulfilled"
            ? (insightsOf.has(p.id) ? insightsOf.get(p.id) : false)
            : null,
          rules: !rulesKnown ? "—"
            : rules.length ? `${live.length} of ${rules.length} live` : "none",
        });

        for (const r of rules) {
          ruleRows.push({
            program: p.name || p.id,
            live: !!(r.enabled && r.published),
            state: !r.enabled ? "Disabled" : !r.published ? "Unpublished" : "Live",
            // "Selection criteria" on the rule is sampling and nothing else —
            // the API exposes no media, direction or wrap-up condition here.
            selects: r.samplingType === "Percentage"
              ? `${r.samplingPercentage}% of interactions`
              : r.samplingType === "All" ? "Every interaction" : (r.samplingType || "—"),
            agents: r.agentToScore || "—",
            submission: r.submissionType || "—",
            form: formName.get(r.evaluationFormContextId)
              || (r.evaluationFormContextId ? "(unknown form)" : "—"),
            evaluator: r.evaluator?.name || (r.evaluator?.id ? "(set)" : "—"),
          });
        }
      }

      // ── Per-queue transcription ───────────────
      // Only meaningful when the org is on EnabledQueueFlow — under
      // EnabledGlobally the per-queue flag does not gate anything.
      let transcriptionOffCount = 0;
      const queueRows = [];
      if (mode === "EnabledQueueFlow") {
        for (const qid of coveredQueueIds) {
          const q = queueById.get(qid);
          if (!q) continue;
          const on = q.enableTranscription !== false;
          if (!on) transcriptionOffCount++;
          const program = programs.find((pr) => (mapOf.get(pr.id)?.queueIds || []).includes(qid));
          queueRows.push({ name: q.name || qid, program: program?.name || "—", on });
        }
        queueRows.sort((a, b) => (a.on === b.on ? a.name.localeCompare(b.name) : a.on ? 1 : -1));
      }

      // ── Tiles ────────────────────────────────────────
      // Counts of what IS configured, not a verdict on it. Whether a setting is
      // costing evaluations belongs on Evaluation Gaps (§14), which can say which
      // interactions it actually cost; this page describes the setup and leaves
      // the reader to draw the conclusion.
      const coveredFlowIds = new Set();
      for (const prog of programs) {
        for (const f of (mapOf.get(prog.id)?.flowIds || [])) coveredFlowIds.add(f);
      }
      const publishedCount = programs.filter(
        (x) => x.published !== false && !unpublishedIds.has(x.id)).length;
      $("tiles").innerHTML = [
        tile("Programs", programsRes.status === "fulfilled"
          ? programs.length.toLocaleString() : null,
          programsRes.status === "fulfilled"
            ? `${publishedCount.toLocaleString()} published` : why(programsRes)),
        tile("Queues covered", mappingsRes.status === "fulfilled"
          ? coveredQueueIds.size.toLocaleString() : null,
          mappingsRes.status === "fulfilled" ? "mapped to a program" : why(mappingsRes)),
        tile("Flows covered", mappingsRes.status === "fulfilled"
          ? coveredFlowIds.size.toLocaleString() : null,
          mappingsRes.status === "fulfilled" ? "mapped to a program" : why(mappingsRes)),
        tile("Scoring rules", ruleFailures ? null : liveRuleCount.toLocaleString(),
          ruleFailures ? "some could not be read" : "enabled and published"),
        tile("Transcription off", mode === "EnabledQueueFlow"
          ? transcriptionOffCount.toLocaleString() : null,
          mode === "EnabledQueueFlow" ? "of the covered queues"
            : mode ? "set globally, not per queue" : why(settingsRes)),
      ].join("");

      // The default program comes back as an AddressableEntityRef, which
      // carries an id and a selfUri and NO name. Resolving it against the
      // program list covers the normal case; when the list does not hold it —
      // which happens on a live org — it is fetched by id rather than shown as
      // an opaque "(set)".
      let defaultProgramName = null;
      if (sta?.defaultProgram?.id) {
        defaultProgramName = programs.find((x) => x.id === sta.defaultProgram.id)?.name || null;
        if (!defaultProgramName) {
          try {
            defaultProgramName = (await fetchProgram(api, org.id, sta.defaultProgram.id))?.name
              || null;
          } catch { /* leave it unresolved; the id is not worth showing */ }
        }
      }

      const modeWords = mode ? mode.replace(/([a-z])([A-Z])/g, "$1 $2") : null;
      renderOrgFacts($("orgFacts"), [
        {
          label: "Transcription",
          html: modeWords ? escapeHtml(modeWords) : '<span class="dq-muted">—</span>',
          sub: mode === "Disabled" ? "nothing is transcribed anywhere"
            : mode === "EnabledQueueFlow" ? "set per queue and flow"
            : mode === "EnabledGlobally" ? "on everywhere" : why(settingsRes) || "",
        },
        {
          label: "Text Analytics on Digital Interactions",
          html: sta ? yesNo(!!sta.textAnalyticsEnabled) : '<span class="dq-muted">—</span>',
          sub: sta ? "" : why(staRes) || "",
        },
        {
          label: "Agent Empathy Analysis",
          html: sta ? yesNo(!!sta.agentEmpathyEnabled) : '<span class="dq-muted">—</span>',
          sub: sta ? "" : why(staRes) || "",
        },
        {
          // Shown rather than quietly omitted. Genesys has this setting; its
          // API does not expose it anywhere — not on the settings resource in
          // GET, PUT or PATCH, and not on any other endpoint. Leaving the card
          // out would look like an oversight; printing a value would be a lie.
          label: "Customer Sentiment Analysis",
          html: '<span class="dq-muted">—</span>',
          sub: "Genesys has this setting, but it is not exposed by the API",
        },
        {
          // "None" is a fact and must not be printed when the settings call was
          // refused — not knowing whether a default program is set is a
          // different thing from knowing there is none.
          label: "Default program",
          html: !sta ? '<span class="dq-muted">—</span>'
            : defaultProgramName ? escapeHtml(defaultProgramName)
            : '<span class="dq-muted">None</span>',
          sub: !sta ? (why(staRes) || "")
            : defaultProgramName ? "used for topic detection where nothing else matches"
            : "nothing catches interactions no program covers",
        },
      ]);
      $("orgNote").hidden = staRes.status !== "rejected";
      if (staRes.status === "rejected") {
        $("orgNote").textContent =
          `Org-wide analytics settings could not be read (${why(staRes)}). `
          + "Needs speechAndTextAnalytics:settings:view.";
      }

      renderProgramTable($("programs"), programRows);
      $("programSub").textContent = programRows.length
        ? "What each program covers, which transcription engines it uses, and whether "
          + "a scoring rule is actually running on it."
        : "No programs to show.";

      renderRuleTable($("rules"), ruleRows);
      $("ruleSub").textContent = ruleRows.length
        ? "One row per rule. Selects and Agents scored decide how much of the covered "
          + "work is meant to be evaluated at all — a rule sampling 20% is supposed to "
          + "leave most interactions unevaluated, and one scoring First or Last is "
          + "supposed to skip the other agents on a conversation."
        : (rulesOf.size ? "No scoring rules are configured on any program."
                        : "Scoring rules could not be read.");
      const programNotes = [];
      if (ruleFailures) {
        programNotes.push(
          `Scoring rules could not be read for ${plural(ruleFailures, "program")} `
          + "(usually a missing quality:scoringRule:view).");
      }
      if (engineFailures) {
        programNotes.push(
          `Transcription engines could not be read for ${plural(engineFailures, "program")}.`);
      }
      if (insightsRes.status === "rejected") {
        programNotes.push(
          "AI summary and insights settings could not be read "
          + "(needs speechAndTextAnalytics:insightsSettings:view), so that column is blank.");
      }
      $("programNote").hidden = !programNotes.length;
      $("programNote").textContent = programNotes.join(" ");
      $("ruleNote").hidden = !ruleFailures;
      if (ruleFailures) {
        $("ruleNote").textContent =
          `${plural(ruleFailures, "program")} could not be read, so rules on `
          + "them are missing from this table.";
      }

      renderQueueTable($("queues"), queueRows);
      $("transcriptionSub").textContent = mode === "EnabledQueueFlow"
        ? "Transcription is set per queue and flow, so each queue a program covers has to "
          + "have it switched on. Queues with it off are listed first."
        : mode === "EnabledGlobally"
          ? "Transcription is enabled globally, so no individual queue can switch it off. "
            + "Nothing to check here."
          : mode === "Disabled"
            ? "Transcription is switched off for the whole org. Nothing is transcribed, so "
              + "nothing can be AI scored."
            : "The org transcription setting could not be read.";
      $("queueNote").hidden = queuesRes.status !== "rejected";
      if (queuesRes.status === "rejected") {
        $("queueNote").textContent =
          `Queues could not be read (${why(queuesRes)}), so per-queue transcription was `
          + "not checked. Needs routing:queue:view.";
      }

      $results.hidden = false;
      if (failures.length) {
        setStatus(`Some configuration could not be read: ${failures.join("; ")}. `
          + "Everything else on this page is still accurate.", "error");
      } else {
        hideStatus();
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $loadBtn.disabled = false;
    }
  });

  return el;
}
