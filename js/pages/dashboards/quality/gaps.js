/**
 * Dashboards › Quality › Evaluation Gaps
 *
 * See docs/dashboards-quality-design.md §13.
 *
 * The question: which agents should have been evaluated and were not, and why?
 *
 * STEP ONE OF TWO. This is the configuration half — the part that is exact.
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
  fetchAllEvaluationForms,
} from "../../../services/genesysApi.js";
import { makeStatus, escapeHtml } from "../../../utils.js";

/** A finding's severity. `blocker` stops evaluations outright. */
const SEVERITY = Object.freeze({
  blocker: { label: "Blocking", cls: "eg-sev-blocker" },
  warn: { label: "Worth checking", cls: "eg-sev-warn" },
  ok: { label: "Fine", cls: "eg-sev-ok" },
});

function pill(sev) {
  const s = SEVERITY[sev] || SEVERITY.ok;
  return `<span class="eg-pill ${s.cls}">${escapeHtml(s.label)}</span>`;
}

/** `n thing` / `n things`, because "1 queues" is the kind of thing people notice. */
function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export default function renderEvaluationGaps({ me, api, orgContext, access }) {
  const el = document.createElement("section");
  el.className = "card";

  el.innerHTML = `
    <h1 class="h1">Dashboards — Quality — Evaluation Gaps</h1>
    <hr class="hr">

    <p class="page-desc">
      Why agents who should be evaluated are not. An automatic evaluation only
      happens if a chain of settings all hold — transcription is on, the queue
      or flow is covered by a published program, and that program has an
      enabled scoring rule. This page reads that chain and shows every link
      that is broken.
    </p>

    <div class="cs-actions">
      <button class="btn" data-c="load">Check configuration</button>
    </div>

    <div class="cs-status" data-c="status" style="display:none"></div>

    <div data-c="results" hidden>
      <div class="dq-tiles" data-c="tiles"></div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">What is stopping evaluations</h3>
        <p class="dq-panel-sub">
          Every broken link in the chain, worst first. A blocking finding means
          no evaluation can be created for the interactions it covers.
        </p>
        <div data-c="findings"></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Programs and their scoring rules</h3>
        <p class="dq-panel-sub" data-c="programSub"></p>
        <div class="dq-table-wrap">
          <table class="dq-table" data-c="programs"></table>
        </div>
        <div class="dq-panel-note" data-c="programNote" hidden></div>
      </div>

      <div class="dq-panel">
        <h3 class="dq-panel-title">Transcription</h3>
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

  /**
   * The findings list.
   *
   * Ordered blockers first, then warnings, because the reader's question is
   * "what do I fix" and a blocker is always the answer over a warning. A clean
   * result says so explicitly rather than rendering an empty box — "nothing
   * found" and "nothing checked" must not look the same.
   */
  function renderFindings(container, findings) {
    const rank = { blocker: 0, warn: 1, ok: 2 };
    const rows = [...findings].sort((a, b) => rank[a.sev] - rank[b.sev]);
    if (!rows.length) {
      container.innerHTML =
        '<div class="eg-clean">Nothing in the configuration is stopping evaluations. ' +
        'Every program is published, has an enabled scoring rule, and its queues have ' +
        'transcription switched on.</div>';
      return;
    }
    container.innerHTML = rows.map((f) => `
      <div class="eg-finding">
        <div class="eg-finding-head">
          ${pill(f.sev)}
          <span class="eg-finding-title">${escapeHtml(f.title)}</span>
        </div>
        <div class="eg-finding-body">${escapeHtml(f.detail)}</div>
        ${f.fix ? `<div class="eg-finding-fix">${escapeHtml(f.fix)}</div>` : ""}
      </div>`).join("");
  }

  function renderProgramTable($table, rows) {
    if (!rows.length) {
      $table.innerHTML = "";
      return;
    }
    const head = ["Program", "Published", "Queues", "Flows", "Scoring rules", "Sampling", "Scores"];
    $table.innerHTML =
      `<thead><tr>${head.map((h, i) =>
        `<th${i >= 2 && i <= 4 ? ' class="is-num"' : ""}>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map((r) => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${r.published ? "Yes" : '<span class="dq-flag">No</span>'}</td>
          <td class="is-num">${r.queues.toLocaleString()}</td>
          <td class="is-num">${r.flows.toLocaleString()}</td>
          <td class="is-num">${escapeHtml(r.rules)}</td>
          <td>${escapeHtml(r.sampling)}</td>
          <td>${escapeHtml(r.scores)}</td>
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
          <td>${r.on
            ? "On"
            : '<span class="dq-flag">Off — nothing here can be scored</span>'}</td>
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
      const [settingsRes, programsRes, unpublishedRes, mappingsRes, queuesRes, formsRes] =
        await Promise.allSettled([
          fetchTranscriptionSettings(api, org.id),
          fetchPrograms(api, org.id),
          fetchUnpublishedPrograms(api, org.id),
          fetchProgramMappings(api, org.id),
          fetchAllQueues(api, org.id),
          fetchAllEvaluationForms(api, org.id),
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

      const findings = [];
      const failures = [];
      for (const [name, r] of [
        ["transcription settings", settingsRes], ["programs", programsRes],
        ["unpublished programs", unpublishedRes], ["program mappings", mappingsRes],
        ["queues", queuesRes], ["evaluation forms", formsRes],
      ]) {
        if (r.status === "rejected") failures.push(`${name} (${why(r)})`);
      }

      // ── 1. Org transcription mode ────────────────
      const mode = settings?.transcription || null;
      if (mode === "Disabled") {
        findings.push({
          sev: "blocker",
          title: "Transcription is switched off for the whole org",
          detail: "Nothing is transcribed anywhere, so AI scoring cannot run on any "
            + "interaction. Every other setting below is moot until this changes.",
          fix: "Admin → Quality → Speech and Text Analytics → Transcription.",
        });
      }

      // ── 2. Program mappings ──────────────────────
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
      setStatus("Reading scoring rules…");
      const ruleResults = await Promise.allSettled(
        programs.map((p) => fetchAgentScoringRules(api, org.id, p.id)));
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

      // ── Per-program findings and rows ────────────
      const programRows = [];
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

        if (!isPublished && scopeCount > 0) {
          findings.push({
            sev: "blocker",
            title: `Program “${p.name || p.id}” is not published`,
            detail: `It covers ${plural(map.queueIds.length, "queue")} and `
              + `${plural(map.flowIds.length, "flow")}, but an unpublished program does `
              + "nothing at all — no interaction it would cover is scored.",
            fix: "Publish the program, or remove its mappings if it is not meant to run.",
          });
        }

        if (isPublished && scopeCount === 0) {
          findings.push({
            sev: "warn",
            title: `Program “${p.name || p.id}” covers no queues or flows`,
            detail: "It is published but mapped to nothing, so it can never match an "
              + "interaction.",
            fix: "Map it to the queues or flows it is meant to cover.",
          });
        }

        if (rulesKnown && isPublished && scopeCount > 0 && rules.length === 0) {
          findings.push({
            sev: "blocker",
            title: `Program “${p.name || p.id}” has no scoring rule`,
            detail: "It covers interactions but has no Agent Scoring Rule, so nothing "
              + "creates an evaluation from them.",
            fix: "Add a scoring rule naming the evaluation form to use.",
          });
        }

        for (const r of rules) {
          if (!r.enabled || !r.published) {
            findings.push({
              sev: "blocker",
              title: `A scoring rule on “${p.name || p.id}” is ${
                !r.enabled ? "disabled" : "unpublished"}`,
              detail: `It would score ${r.samplingType === "Percentage"
                ? `${r.samplingPercentage}% of interactions` : "every interaction"}`
                + ` using ${formName.get(r.evaluationFormContextId) || "a form"}, but it `
                + "is not running.",
              fix: !r.enabled ? "Enable the rule." : "Publish the rule.",
            });
          }
        }

        const samplings = [...new Set(live.map((r) => r.samplingType === "Percentage"
          ? `${r.samplingPercentage}%` : "All"))];
        const scores = [...new Set(live.map((r) => r.agentToScore).filter(Boolean))];

        programRows.push({
          name: p.name || p.id,
          published: isPublished,
          queues: map.queueIds.length,
          flows: map.flowIds.length,
          rules: !rulesKnown ? "—"
            : rules.length ? `${live.length} of ${rules.length} live` : "none",
          sampling: samplings.join(", ") || "—",
          scores: scores.join(", ") || "—",
        });
      }

      if (programs.length === 0 && programsRes.status === "fulfilled") {
        findings.push({
          sev: "blocker",
          title: "There are no Speech and Text Analytics programs",
          detail: "Auto-evaluation is driven entirely by programs, so with none defined "
            + "no interaction can be automatically evaluated.",
          fix: "Create a program, map it to queues or flows, and give it a scoring rule.",
        });
      }

      // ── 4. Per-queue transcription ───────────────
      // Only meaningful when the org is on EnabledQueueFlow — under
      // EnabledGlobally the per-queue flag does not gate anything.
      const queueRows = [];
      if (mode === "EnabledQueueFlow") {
        const offQueues = [];
        for (const qid of coveredQueueIds) {
          const q = queueById.get(qid);
          if (!q) continue;
          const on = q.enableTranscription !== false;
          const program = programs.find((p) => (mapOf.get(p.id)?.queueIds || []).includes(qid));
          queueRows.push({ name: q.name || qid, program: program?.name || "—", on });
          if (!on) offQueues.push(q.name || qid);
        }
        queueRows.sort((a, b) => (a.on === b.on ? a.name.localeCompare(b.name) : a.on ? 1 : -1));
        if (offQueues.length) {
          findings.push({
            sev: "blocker",
            title: `${plural(offQueues.length, "program queue")} ${
              offQueues.length === 1 ? "has" : "have"} transcription switched off`,
            detail: `${offQueues.slice(0, 6).join(", ")}${
              offQueues.length > 6 ? `, and ${offQueues.length - 6} more` : ""}. `
              + "A program covers these queues, but without a transcript AI cannot score "
              + "the interaction, so their agents go unevaluated.",
            fix: "Admin → Contact Center → Queues → the queue → Voice Transcription.",
          });
        }
      }

      // ── Tiles ────────────────────────────────────
      const blockers = findings.filter((f) => f.sev === "blocker").length;
      const warns = findings.filter((f) => f.sev === "warn").length;
      $("tiles").innerHTML = [
        tile("Blocking findings", blockers.toLocaleString(),
          blockers ? "no evaluations can be created" : "nothing is switched off"),
        tile("Worth checking", warns.toLocaleString(), "not blocking, but probably wrong"),
        tile("Programs", programsRes.status === "fulfilled"
          ? programs.length.toLocaleString() : null,
          programsRes.status === "fulfilled" ? "speech and text analytics" : why(programsRes)),
        tile("Live scoring rules", ruleFailures ? null : liveRuleCount.toLocaleString(),
          ruleFailures ? "some could not be read" : "enabled and published"),
        tile("Transcription", mode ? mode.replace(/([a-z])([A-Z])/g, "$1 $2") : null,
          mode ? "org-wide setting" : why(settingsRes)),
      ].join("");

      renderFindings($("findings"), findings);

      renderProgramTable($("programs"), programRows);
      $("programSub").textContent = programRows.length
        ? "Every program, what it covers, and whether a rule is actually running. "
          + "Sampling and Scores are the rule's own settings — they decide how much of "
          + "the covered work is meant to be evaluated at all."
        : "No programs to show.";
      $("programNote").hidden = !ruleFailures;
      if (ruleFailures) {
        $("programNote").textContent =
          `Scoring rules could not be read for ${plural(ruleFailures, "program")}. `
          + "That usually means the quality:scoringRule:view permission is missing.";
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
