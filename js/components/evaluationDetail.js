/**
 * Evaluation detail drawer — the transcript and the scored form, side by side.
 *
 * Opened from the Show details button on the Evaluations table
 * (docs/dashboards-quality-design.md §7.5). A drawer rather than a modal or an
 * inline row expansion: the two panes want width, and the table stays visible
 * behind so a reviewer can work down the rows without losing their place.
 *
 *   GET /api/v2/quality/conversations/{cid}/evaluations/{eid}?expand=…
 *   GET /api/v2/conversations/{cid}
 *   GET /api/v2/speechandtextanalytics/conversations/{cid}/communications/{id}/transcripturl
 *
 * THE TWO HALVES FAIL SEPARATELY, deliberately. The form needs
 * `quality:evaluation:view`; the transcript needs `recording:recording:view`
 * AND `speechAndTextAnalytics:data:view`. Neither is the Scores page's own
 * gate, so a reviewer entitled to one and not the other must still get the one
 * — each pane reports its own missing permission rather than the drawer
 * failing whole.
 */

import { escapeHtml } from "../utils.js";

/** Speaker purpose → the word a reader expects. */
const SPEAKER = { customer: "Customer", agent: "Agent", external: "External", ivr: "IVR" };

/**
 * The direction of a conversation, from its own participants.
 *
 * The evaluation domain has no direction of any kind — not as a dimension, not
 * as a field, not on the record (design §7.6). It is only knowable here because
 * this drawer already fetches the conversation for the transcript, which is why
 * this is the one place in the feature that can show it at all.
 */
function conversationDirection(conv) {
  for (const p of conv?.participants || []) {
    for (const key of ["calls", "messages", "emails", "callbacks"]) {
      for (const c of p[key] || []) {
        if (c.direction) return c.direction;
      }
    }
  }
  return null;
}

/** The customer's communication id, preferring the customer participant. */
function customerCommunicationId(conv) {
  const keys = ["calls", "messages", "emails", "callbacks", "chats"];
  for (const purpose of ["customer", "external", null]) {
    for (const p of conv?.participants || []) {
      if (purpose && p.purpose !== purpose) continue;
      for (const key of keys) {
        for (const c of p[key] || []) if (c.id) return c.id;
      }
    }
  }
  return null;
}

export function createEvaluationDetail({ api }) {
  const el = document.createElement("div");
  el.className = "dq-drawer";
  el.hidden = true;
  el.innerHTML = `
    <div class="dq-drawer-scrim" data-d="scrim"></div>
    <aside class="dq-drawer-panel" role="dialog" aria-modal="true" aria-label="Evaluation detail">
      <header class="dq-drawer-head">
        <div>
          <h2 class="dq-drawer-title" data-d="title">Evaluation</h2>
          <p class="dq-drawer-sub" data-d="sub"></p>
        </div>
        <button class="btn" data-d="close">Close</button>
      </header>
      <div class="dq-drawer-body">
        <section class="dq-drawer-pane">
          <h3 class="dq-panel-title">Transcript</h3>
          <div data-d="transcript"></div>
        </section>
        <section class="dq-drawer-pane">
          <h3 class="dq-panel-title">Scored form</h3>
          <div data-d="form"></div>
        </section>
      </div>
    </aside>`;

  const $ = (n) => el.querySelector(`[data-d="${n}"]`);
  let lastFocus = null;

  function close() {
    el.hidden = true;
    document.removeEventListener("keydown", onKey);
    lastFocus?.focus?.();
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  $("close").addEventListener("click", close);
  $("scrim").addEventListener("click", close);

  /** Render the scored form: every question, its answer, and what it scored. */
  function renderForm(evaluation) {
    const form = evaluation?.evaluationForm;
    const answers = evaluation?.answers;
    if (!form?.questionGroups?.length) {
      return `<p class="dq-bar-empty">This evaluation carries no form definition.</p>`;
    }

    const groupScores = new Map(
      (answers?.questionGroupScores || []).map((g) => [g.questionGroupId, g]));

    const parts = [];
    for (const group of form.questionGroups) {
      const gs = groupScores.get(group.id);
      const qScores = new Map((gs?.questionScores || []).map((q) => [q.questionId, q]));
      const naGroup = gs?.markedNA || gs?.systemMarkedNA;

      parts.push(`<div class="dq-q-group">
        <div class="dq-q-group-head">
          <span class="dq-q-group-name">${escapeHtml(group.name || "Question group")}</span>
          <span class="dq-q-group-score">${naGroup ? "N/A"
            : gs ? `${gs.totalScore ?? 0} / ${gs.maxTotalScore ?? 0}` : "—"}</span>
        </div>`);

      for (const q of group.questions || []) {
        const qs = qScores.get(q.id);
        const na = qs?.markedNA || qs?.systemMarkedNA;
        const chosen = (q.answerOptions || []).find((a) => a.id === qs?.answerId);
        // The AI's answer is shown when it differs from the recorded one: a
        // reviewer looking at an AI-scored evaluation wants to see where the
        // model landed, and where a person moved it.
        const aiOpt = qs?.aiAnswer?.answerId && qs.aiAnswer.answerId !== qs.answerId
          ? (q.answerOptions || []).find((a) => a.id === qs.aiAnswer.answerId)
          : null;

        parts.push(`<div class="dq-q${qs?.failedKillQuestion ? " is-kill" : ""}">
          <div class="dq-q-text">
            ${escapeHtml(q.text || "Question")}
            ${q.isCritical ? '<span class="dq-q-tag">critical</span>' : ""}
            ${q.isKill ? '<span class="dq-q-tag">kill</span>' : ""}
          </div>
          <div class="dq-q-answer">
            ${na ? '<span class="dq-q-na">Marked N/A</span>'
                 : chosen ? escapeHtml(chosen.text || "")
                 : qs ? "<em>answered</em>" : "<em>not answered</em>"}
            ${qs && !na ? `<span class="dq-q-score">${qs.score ?? 0}</span>` : ""}
          </div>
          ${qs?.failedKillQuestion ? '<div class="dq-q-flag">Failed kill question</div>' : ""}
          ${aiOpt ? `<div class="dq-q-ai">AI answered: ${escapeHtml(aiOpt.text || "")}${
              qs.aiAnswer.explanation ? ` — ${escapeHtml(qs.aiAnswer.explanation)}` : ""}</div>` : ""}
          ${qs?.comments ? `<div class="dq-q-comment">${escapeHtml(qs.comments)}</div>` : ""}
        </div>`);
      }
      parts.push(`</div>`);
    }

    for (const [label, text] of [
      ["Evaluator comments", answers?.comments],
      ["Agent comments", answers?.agentComments],
    ]) {
      if (text) {
        parts.push(`<div class="dq-q-group"><div class="dq-q-group-head">
          <span class="dq-q-group-name">${escapeHtml(label)}</span></div>
          <div class="dq-q-comment">${escapeHtml(text)}</div></div>`);
      }
    }
    return parts.join("");
  }

  /** Render the transcript as speaker-labelled lines. */
  function renderTranscript(data) {
    const lines = [];
    for (const t of data?.transcripts || []) {
      for (const p of t.phrases || []) {
        if (p.text) lines.push({ who: p.participantPurpose, text: p.text });
      }
    }
    if (!lines.length) {
      return `<p class="dq-bar-empty">The transcript is empty.</p>`;
    }
    return `<div class="dq-transcript">${lines.map((l) => `
      <div class="dq-phrase dq-phrase--${escapeHtml((l.who || "other").toLowerCase())}">
        <span class="dq-phrase-who">${escapeHtml(SPEAKER[l.who] || l.who || "—")}</span>
        <span class="dq-phrase-text">${escapeHtml(l.text)}</span>
      </div>`).join("")}</div>`;
  }

  /** Turn an error into the sentence a reader can act on. */
  function reason(err, permissions) {
    if (err?.status === 403) return `You do not have permission for this (needs ${permissions}).`;
    if (err?.status === 404) return "Genesys has no record of this.";
    return err?.message || "Could not load.";
  }

  async function open({ orgId, conversationId, evaluationId, summary }) {
    lastFocus = document.activeElement;
    el.hidden = false;
    document.addEventListener("keydown", onKey);
    $("close").focus();

    $("title").textContent = summary?.agent ? `${summary.agent}` : "Evaluation";
    $("sub").textContent = [summary?.form, summary?.conversation, summary?.score]
      .filter(Boolean).join(" · ");
    $("transcript").innerHTML = `<p class="dq-bar-empty">Loading…</p>`;
    $("form").innerHTML = `<p class="dq-bar-empty">Loading…</p>`;

    // The scored form. Its own permission, its own failure.
    api.proxyGenesys(orgId, "GET",
      `/api/v2/quality/conversations/${conversationId}/evaluations/${evaluationId}`,
      { query: { expand: "evaluationForm,agent,evaluator" } })
      .then((evaluation) => { $("form").innerHTML = renderForm(evaluation); })
      .catch((err) => {
        $("form").innerHTML =
          `<p class="dq-bar-empty">${escapeHtml(reason(err, "quality:evaluation:view"))}</p>`;
      });

    // The conversation, for the direction and the communication id.
    let conv = null;
    try {
      conv = await api.proxyGenesys(orgId, "GET", `/api/v2/conversations/${conversationId}`);
      const dir = conversationDirection(conv);
      if (dir) {
        $("sub").textContent =
          `${$("sub").textContent} · ${dir.charAt(0).toUpperCase()}${dir.slice(1)}`;
      }
    } catch { /* direction is a nicety; the transcript attempt reports its own */ }

    // The transcript, which not every evaluation has.
    try {
      const commId = customerCommunicationId(conv);
      if (!commId) {
        $("transcript").innerHTML =
          `<p class="dq-bar-empty">No transcript: this interaction has no communication to transcribe.</p>`;
        return;
      }
      const urlResp = await api.proxyGenesys(orgId, "GET",
        `/api/v2/speechandtextanalytics/conversations/${conversationId}/communications/${commId}/transcripturl`);
      if (!urlResp?.url) {
        $("transcript").innerHTML =
          `<p class="dq-bar-empty">No transcript was recorded for this interaction.</p>`;
        return;
      }
      // A pre-signed URL — fetched directly, without the proxy or a token.
      const resp = await fetch(urlResp.url);
      if (!resp.ok) throw new Error(`Transcript fetch failed (${resp.status})`);
      $("transcript").innerHTML = renderTranscript(await resp.json());
    } catch (err) {
      $("transcript").innerHTML = `<p class="dq-bar-empty">${escapeHtml(
        reason(err, "recording:recording:view and speechAndTextAnalytics:data:view"))}</p>`;
    }
  }

  return { el, open, close };
}
