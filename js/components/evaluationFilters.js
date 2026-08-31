/**
 * Evaluation filter bar — shared by every Dashboards › Quality page.
 *
 * See docs/dashboards-quality-design.md §5.2.
 *
 * Usage:
 *   const bar = createEvaluationFilters({ api, orgContext, onChange });
 *   container.append(bar.el);
 *   await bar.loadOptions(orgId);   // populates the dropdowns
 *   bar.getFilters();               // → EvaluationFilters (js/lib/evaluationQuery.js)
 *
 * WHAT IS NOT HERE, deliberately: a Groups filter. No evaluation endpoint that
 * can back a dashboard carries a group dimension — only quality/agents/activity
 * does — so a group filter would have to be expanded client-side into member
 * user ids, and would then filter some bands of a page but not others. Every
 * control below is a native dimension on BOTH backing endpoints, which is what
 * lets one filter object serialise to both with nothing lost.
 */

import { createMultiSelect } from "./multiSelect.js";
import {
  fetchAllUsers, fetchAllQueues, fetchAllTeams,
  fetchAllDivisions, fetchAllEvaluationForms,
} from "../services/genesysApi.js";
import { MEDIA_TYPES, TIME_BASIS_OPTIONS, emptyFilters } from "../lib/evaluationQuery.js";
import {
  RANGE_PRESETS, resolvePreset, latestSelectableDay, dayCount,
} from "../utils/dateRanges.js";

/**
 * One sessionStorage key for the whole bar.
 *
 * The router destroys a page on navigation, so without this every move between
 * the three Quality pages would drop the scope the user had just set. Session
 * rather than local: a filter set is about the question being asked right now,
 * not a preference worth surviving a browser restart.
 */
const STORE_KEY = "dq-filters";

function loadStored() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveStored(filters) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(filters)); } catch { /* not fatal */ }
}

/**
 * @param {Object}   opts
 * @param {Object}   opts.api
 * @param {Function} [opts.onChange]      Called with the filter object on every edit.
 * @param {boolean}  [opts.showTimeBasis] Show the conversation/created/released
 *                                        control. Coverage shows it; the other
 *                                        pages inherit whatever it was set to.
 */
export function createEvaluationFilters({ api, onChange, showTimeBasis = false } = {}) {
  const el = document.createElement("div");
  el.className = "dq-filters";

  // Yesterday by default: the last complete day is what someone opening a QM
  // dashboard is usually asking about, and it is the only short range that is
  // not still filling.
  const defaults = resolvePreset("yesterday");
  const stored = loadStored();

  el.innerHTML = `
    <div class="dq-filter-band">
      <span class="dq-filter-caption">When</span>
      <div class="dq-filter-fields">
        <div class="cs-control-group">
          <label class="cs-label">From</label>
          <input type="date" class="input is-date" data-f="from">
        </div>
        <div class="cs-control-group">
          <label class="cs-label">To</label>
          <input type="date" class="input is-date" data-f="to">
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Quick ranges</label>
          <div class="dq-presets" data-f="presets"></div>
        </div>
        <div class="cs-control-group" data-f="basisGroup" ${showTimeBasis ? "" : "hidden"}>
          <label class="cs-label">Dates refer to</label>
          <select class="input" data-f="basis"></select>
        </div>
      </div>
    </div>

    <div class="dq-filter-band">
      <span class="dq-filter-caption">Who</span>
      <div class="dq-filter-fields">
        <div class="cs-control-group">
          <label class="cs-label">Agents</label>
          <div data-f="agents"></div>
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Work Teams</label>
          <div data-f="teams"></div>
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Divisions</label>
          <div data-f="divisions"></div>
        </div>
      </div>
    </div>

    <div class="dq-filter-band">
      <span class="dq-filter-caption">What</span>
      <div class="dq-filter-fields">
        <div class="cs-control-group">
          <label class="cs-label">Queues</label>
          <div data-f="queues"></div>
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Forms</label>
          <div data-f="forms"></div>
        </div>
        <div class="cs-control-group">
          <label class="cs-label">Media types</label>
          <div data-f="media"></div>
        </div>
        <div class="cs-control-group dq-filter-reset">
          <label class="cs-label">&nbsp;</label>
          <button class="btn btn-sm" data-f="reset">Clear filters</button>
        </div>
      </div>
    </div>

    <div class="dq-filter-note" data-f="note" hidden></div>
  `;

  const $ = (name) => el.querySelector(`[data-f="${name}"]`);
  const $from = $("from");
  const $to = $("to");
  const $basis = $("basis");
  const $note = $("note");

  // ── Dates ───────────────────────────────────────────
  // Max is TODAY. A range ending today is partial by definition and the pages
  // mark its trailing bucket as in progress rather than refusing the range —
  // AI scoring lands against a conversation almost immediately, so today's
  // evaluations are real data, not an artefact.
  const maxDay = latestSelectableDay();
  $from.max = maxDay;
  $to.max = maxDay;
  $from.value = stored?.from || defaults.from;
  $to.value = stored?.to || defaults.to;

  for (const { key, label } of TIME_BASIS_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    $basis.append(opt);
  }
  $basis.value = stored?.timeBasis || "conversation";

  // ── Presets ─────────────────────────────────────────
  // The preset the user last clicked, so an ambiguous range (Monday, where
  // "This week" and "Today" are the same dates) highlights what they chose.
  let chosenPreset = null;
  const $presets = $("presets");
  for (const preset of RANGE_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm dq-preset";
    btn.textContent = preset.label;
    btn.dataset.preset = preset.key;
    btn.addEventListener("click", () => {
      const r = resolvePreset(preset.key);
      $from.value = r.from;
      $to.value = r.to;
      chosenPreset = preset.key;
      markActivePreset();
      emit();
    });
    $presets.append(btn);
  }

  /**
   * Light up exactly ONE preset.
   *
   * Presets can resolve to the same range — on a Monday "This week" IS "Today",
   * and at the start of a month "Last Month" can coincide with others. Matching
   * purely on dates then lights two buttons at once, which reads as a bug even
   * though both are true. The preset the user actually clicked wins while its
   * dates still hold; only after the dates are edited by hand does it fall back
   * to the first match in display order.
   */
  function markActivePreset() {
    let active = null;
    if (chosenPreset) {
      const r = resolvePreset(chosenPreset);
      if (r && r.from === $from.value && r.to === $to.value) active = chosenPreset;
      else chosenPreset = null;
    }
    if (!active) {
      for (const p of RANGE_PRESETS) {
        const r = resolvePreset(p.key);
        if (r && r.from === $from.value && r.to === $to.value) { active = p.key; break; }
      }
    }
    for (const btn of $presets.querySelectorAll(".dq-preset")) {
      btn.classList.toggle("is-active", btn.dataset.preset === active);
    }
  }

  // ── Multi-selects ───────────────────────────────────
  const agents = createMultiSelect({ placeholder: "All agents", searchable: true, onChange: emit });
  const teams = createMultiSelect({ placeholder: "All teams", searchable: true, onChange: emit });
  const divisions = createMultiSelect({ placeholder: "All divisions", searchable: true, onChange: emit });
  const queues = createMultiSelect({ placeholder: "All queues", searchable: true, onChange: emit });
  const forms = createMultiSelect({ placeholder: "All forms", searchable: true, onChange: emit });
  const media = createMultiSelect({ placeholder: "All media types", onChange: emit });

  $("agents").append(agents.el);
  $("teams").append(teams.el);
  $("divisions").append(divisions.el);
  $("queues").append(queues.el);
  $("forms").append(forms.el);
  $("media").append(media.el);

  media.setItems(MEDIA_TYPES.map((m) => ({ id: m.id, label: m.label })));

  // Until loadOptions runs, the scope dropdowns hold nothing — and an empty
  // multiSelect swallows clicks silently (its trigger returns early when it has
  // no items). A control that looks live and does nothing is worse than a
  // disabled one, so they start explicitly disabled and say why.
  for (const [ms, label] of [[agents, "agents"], [teams, "teams"], [divisions, "divisions"],
                             [queues, "queues"], [forms, "forms"]]) {
    ms.setPlaceholder(`Loading ${label}…`);
    ms.setEnabled(false);
  }

  // Id → name, per list, filled by loadOptions and read back by the pages.
  const lookups = {
    agents: new Map(), teams: new Map(), divisions: new Map(),
    queues: new Map(), forms: new Map(),
    media: new Map(MEDIA_TYPES.map((m) => [m.id, m.label])),
  };

  // ── Change plumbing ─────────────────────────────────
  $from.addEventListener("change", () => { chosenPreset = null; markActivePreset(); emit(); });
  $to.addEventListener("change", () => { chosenPreset = null; markActivePreset(); emit(); });
  $basis.addEventListener("change", emit);

  $("reset").addEventListener("click", () => {
    for (const ms of [agents, teams, divisions, queues, forms, media]) ms.setSelected([]);
    emit();
  });

  function getFilters() {
    return {
      from: $from.value,
      to: $to.value,
      timeBasis: $basis.value || "conversation",
      agentIds: [...agents.getSelected()],
      teamIds: [...teams.getSelected()],
      divisionIds: [...divisions.getSelected()],
      queueIds: [...queues.getSelected()],
      formContextIds: [...forms.getSelected()],
      mediaTypes: [...media.getSelected()],
    };
  }

  function emit() {
    const filters = getFilters();
    saveStored(filters);
    validate(filters);
    onChange?.(filters);
  }

  /** Inline validation — states a problem, never blocks typing. */
  function validate(filters) {
    const problems = [];
    if (!filters.from || !filters.to) {
      problems.push("Pick both a start and an end date.");
    } else if (Date.parse(filters.from) > Date.parse(filters.to)) {
      problems.push("The start date is after the end date.");
    } else if (dayCount(filters.from, filters.to) > 800) {
      // Not a hard limit anywhere, but past this a dashboard is answering a
      // question nobody asked and the aggregate calls get slow enough to feel
      // broken. Said out loud rather than silently clamped.
      problems.push("That is a very long range — over two years. Expect a slow load.");
    }
    if (problems.length) {
      $note.textContent = problems.join(" ");
      $note.hidden = false;
    } else {
      $note.hidden = true;
    }
    return !problems.some((p) => p.startsWith("Pick") || p.startsWith("The start"));
  }

  markActivePreset();

  return {
    el,
    getFilters,

    /** True when the current dates are usable. */
    isValid() { return validate(getFilters()); },

    /**
     * Populate every dropdown for an org. Each list is independent: one that
     * fails leaves its dropdown empty and disabled rather than failing the
     * page, because a missing Forms list is not a reason to refuse to show
     * evaluation counts.
     *
     * @returns {Promise<string[]>} human-readable warnings, one per failed list.
     */
    async loadOptions(orgId) {
      const warnings = [];
      const restore = loadStored();

      const jobs = [
        {
          label: "agents", placeholder: "All agents", lookupKey: "agents", ms: agents,
          run: () => fetchAllUsers(api, orgId, { query: { state: "active" } }),
          map: (u) => ({ id: u.id, label: u.name || u.email || u.id }),
          restoreKey: "agentIds",
        },
        {
          label: "work teams", placeholder: "All teams", lookupKey: "teams", ms: teams,
          run: () => fetchAllTeams(api, orgId),
          map: (t) => ({ id: t.id, label: t.name || t.id }),
          restoreKey: "teamIds",
        },
        {
          label: "divisions", placeholder: "All divisions", lookupKey: "divisions", ms: divisions,
          run: () => fetchAllDivisions(api, orgId),
          map: (d) => ({ id: d.id, label: d.name || d.id }),
          restoreKey: "divisionIds",
        },
        {
          label: "queues", placeholder: "All queues", lookupKey: "queues", ms: queues,
          run: () => fetchAllQueues(api, orgId),
          map: (q) => ({ id: q.id, label: q.name || q.id }),
          restoreKey: "queueIds",
        },
        {
          label: "evaluation forms", placeholder: "All forms", lookupKey: "forms", ms: forms,
          run: () => fetchAllEvaluationForms(api, orgId),
          // Keyed on contextId, not id: a form has one id per version, and
          // filtering by version would silently drop evaluations scored on
          // other versions of the same form.
          map: (f) => ({ id: f.contextId || f.id, label: f.name || f.id }),
          restoreKey: "formContextIds",
          dedupe: true,
        },
      ];

      await Promise.all(jobs.map(async (job) => {
        try {
          const rows = await job.run();
          let items = rows.map(job.map);
          if (job.dedupe) {
            const seen = new Set();
            items = items.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
          }
          job.ms.setItems(items);
          job.ms.setEnabled(items.length > 0);
          const store = lookups[job.lookupKey];
          if (store) for (const i of items) store.set(i.id, i.label);
          job.ms.setPlaceholder(items.length ? job.placeholder : `No ${job.label}`);
          const keep = restore?.[job.restoreKey];
          if (keep?.length) job.ms.setSelected(keep.filter((id) => items.some((i) => i.id === id)));
        } catch (err) {
          job.ms.setEnabled(false);
          job.ms.setPlaceholder(`${job.label} unavailable`);
          warnings.push(`Could not load ${job.label}: ${err.message}`);
        }
      }));

      if (restore?.mediaTypes?.length) media.setSelected(restore.mediaTypes);

      return warnings;
    },

    /**
     * Id → name maps for the lists this bar already loaded.
     *
     * Aggregate responses group by id and carry no names, so every page needs
     * these. Handing back what the bar fetched anyway is what stops each page
     * re-fetching the whole user directory to label a bar chart.
     */
    getLookups() { return lookups; },

    setEnabled(on) {
      // Re-enabling must not resurrect a dropdown that has nothing in it — that
      // is how a control goes back to looking live while still ignoring clicks.
      for (const ms of [agents, teams, divisions, queues, forms, media]) {
        ms.setEnabled(on && ms.count() > 0);
      }
      $from.disabled = !on;
      $to.disabled = !on;
      $basis.disabled = !on;
      for (const btn of $presets.querySelectorAll("button")) btn.disabled = !on;
      $("reset").disabled = !on;
    },

    /** Number of forms currently selected — the question-level bands need exactly one. */
    selectedFormCount() { return forms.getSelected().size; },
  };
}

/** A fresh, empty filter object matching this bar's defaults. */
export function defaultFilters() {
  const r = resolvePreset("yesterday");
  return emptyFilters(r.from, r.to);
}
