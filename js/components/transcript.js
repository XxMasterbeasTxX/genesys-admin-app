/**
 * Transcript — fetching one and rendering it as speaker-labelled lines.
 *
 * Shared by the Evaluation Scores drawer and the Agent Copilot drill-down, so
 * the two cannot drift in how they name a speaker or read a phrase.
 *
 *   GET /api/v2/conversations/{cid}                      → the customer's communication
 *   GET /api/v2/speechandtextanalytics/conversations/{cid}/communications/{id}/transcripturl
 *   fetch(url)                                          → the transcript JSON, from S3
 *
 * The transcript URL is pre-signed, so the last step goes straight to S3
 * without the proxy or a token. Needs `recording:recording:view` and
 * `speechAndTextAnalytics:data:view`.
 *
 * SPEAKERS ARE NAMED FOR THE READER. The transcript's own vocabulary is
 * `internal` and `external` — the org's side of the call and the other side —
 * which on screen read as jargon and once left "internal" unmapped entirely.
 * A reader wants Agent and Customer, and that is what the labels say.
 */

import { escapeHtml } from "../utils.js";

/**
 * The transcript's speaker vocabulary → the role a reader recognises.
 *
 * One mapping drives BOTH the label and the CSS class, because the stylesheet
 * colours `--agent` and `--customer` — and a phrase classed `--internal` got
 * neither the word nor the colour.
 */
const ROLE = {
  internal: "agent",
  agent: "agent",
  external: "customer",
  customer: "customer",
  ivr: "ivr",
};
const LABEL = { agent: "Agent", customer: "Customer", ivr: "IVR" };

/**
 * The customer's communication id, preferring the customer participant.
 *
 * The transcript hangs off a COMMUNICATION, not the conversation, and the one
 * on the customer's leg is the one that carries both sides of the exchange.
 */
export function customerCommunicationId(conv) {
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

/**
 * Fetch a communication's transcript.
 *
 * Returns the transcript JSON, or `null` when Genesys has none for this
 * communication — which is ordinary, not an error. Throws on a failure that
 * is not "there is no transcript", so the caller can name the permission.
 */
export async function fetchTranscriptJson(api, orgId, conversationId, commId) {
  const url = await fetchTranscriptUrl(api, orgId, conversationId, commId);
  return url ? fetchTranscriptFromUrl(url) : null;
}

/**
 * The pre-signed URL of a communication's transcript, or `null` when Genesys
 * has none.
 *
 * Split out so a caller can learn WHETHER a transcript exists - one proxy
 * call - without pulling its body until somebody reads it.
 */
export async function fetchTranscriptUrl(api, orgId, conversationId, commId) {
  const urlResp = await api.proxyGenesys(orgId, "GET",
    `/api/v2/speechandtextanalytics/conversations/${conversationId}`
    + `/communications/${commId}/transcripturl`);
  return urlResp?.url || null;
}

/** The transcript JSON behind a pre-signed URL - fetched directly, without the proxy or a token. */
export async function fetchTranscriptFromUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Transcript fetch failed (${resp.status})`);
  return resp.json();
}

/** Render the transcript as speaker-labelled lines. */
export function renderTranscript(data) {
  const lines = [];
  for (const t of data?.transcripts || []) {
    for (const p of t.phrases || []) {
      if (p.text) lines.push({ who: p.participantPurpose, text: p.text });
    }
  }
  if (!lines.length) {
    return `<p class="dq-bar-empty">The transcript is empty.</p>`;
  }
  return `<div class="dq-transcript">${lines.map((l) => {
    const raw = (l.who || "").toLowerCase();
    const role = ROLE[raw] || raw || "other";
    return `
      <div class="dq-phrase dq-phrase--${escapeHtml(role)}">
        <span class="dq-phrase-who">${escapeHtml(LABEL[role] || l.who || "—")}</span>
        <span class="dq-phrase-text">${escapeHtml(l.text)}</span>
      </div>`;
  }).join("")}</div>`;
}

/**
 * Turn a transcript failure into the sentence a reader can act on.
 *
 * 403 names the permissions; 404 says Genesys has nothing; anything else
 * passes its own message through.
 */
export function transcriptFailureReason(err) {
  if (err?.status === 403) {
    return "You do not have permission for this (needs recording:recording:view "
      + "and speechAndTextAnalytics:data:view).";
  }
  if (err?.status === 404) return "Genesys has no record of this.";
  return err?.message || "Could not load the transcript.";
}
