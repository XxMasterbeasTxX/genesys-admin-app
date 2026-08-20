/**
 * Requests — the feature request board.
 *
 * Reached from the header button beside Activity Log, not from the nav tree, and
 * available to every signed-in session regardless of access keys or
 * entitlements: the channel for telling us the product is missing something
 * cannot itself be something you have to be granted.
 *
 * Two boards:
 *   My company board — your own org's requests, in full. Everyone in an org sees
 *                     that org's requests, the same contract schedules and the
 *                     activity log already have.
 *   Shared          — requests a superuser has promoted, visible to every org as
 *                     a redacted card built server-side.
 * Superusers get a third, Triage, spanning every organisation.
 *
 * Nothing here decides permissions. The page draws what the endpoint returns and
 * shows the triage controls when the response says `isSuperuser`; the server
 * re-checks every write regardless.
 *
 * See docs/feature-requests-design.md.
 */
import { escapeHtml, formatDateTime } from "../utils.js";
import { APP_VERSION, RELEASE_NOTES } from "../releaseNotes.js";
import {
  fetchRequests,
  createRequest,
  updateOwnRequest,
  triageRequest,
  toggleVote,
  deleteRequest,
  fetchThread,
  postThreadMessage,
  deleteThreadMessage,
} from "../services/featureRequestService.js";

/** Where the header button stashes the page you were on (§4). */
export const CONTEXT_KEY = "gc_request_context";

const TYPE_LABELS = {
  feature:  "New feature",
  change:   "Change",
  bug:      "Not working",
  question: "Question",
};

const STATUS_LABELS = {
  "new":                "New",
  "triaged":            "Looked at",
  "awaiting-submitter": "Waiting for you",
  "planned":            "Planned",
  "in-progress":        "Being built",
  "shipped":            "Shipped",
  "not-planned":        "Not planned",
  "duplicate":          "Duplicate",
};

/** Status → modifier class, so the badge colour carries the same meaning. */
const STATUS_TONE = {
  "new":                "new",
  "triaged":            "open",
  "awaiting-submitter": "waiting",
  "planned":            "open",
  "in-progress":        "open",
  "shipped":            "done",
  "not-planned":        "closed",
  "duplicate":          "closed",
};

/**
 * Is a release note for this version visible to this viewer?
 *
 * A shipped request links to its release note, but internal-only entries are
 * filtered out of customer sessions — so linking one would send a customer to
 * an entry they cannot see (§6.4). When the entry is hidden, the version is
 * shown as plain text instead.
 */
function releaseNoteVisible(version, isInternal) {
  const entry = RELEASE_NOTES.find((e) => e.version === version);
  if (!entry) return false;
  return isInternal || !entry.internalOnly;
}

export default function renderRequests({ me, orgContext, isInternal = true }) {
  const el = document.createElement("section");
  el.className = "card";

  let board = "mine";
  let isSuperuser = false;
  let requests = [];
  let editingId = null;   // request being edited by its submitter
  let triagingId = null;  // request whose triage panel is open
  const openThreads = new Map(); // request id → messages, for threads on screen

  // The page you were on when you pressed the button (§4). Read once and
  // cleared: it describes the trip that brought you here, not every request you
  // file afterwards.
  let captured = null;
  try {
    const raw = sessionStorage.getItem(CONTEXT_KEY);
    if (raw) captured = JSON.parse(raw);
  } catch (_) { captured = null; }
  sessionStorage.removeItem(CONTEXT_KEY);

  el.innerHTML = `
    <div class="fr-header">
      <div>
        <h2 class="h2">Requests</h2>
        <p class="page-desc">
          Ask for something new, a change to something that exists, or tell us when
          something is not working. Everyone in your organisation sees this board.
        </p>
      </div>
      <button type="button" class="btn" id="frRefresh">Refresh</button>
    </div>

    <div class="fr-tabs" id="frTabs">
      <button type="button" class="fr-tab fr-tab--active" data-board="mine">My company board</button>
      <button type="button" class="fr-tab" data-board="shared">Shared board</button>
      <button type="button" class="fr-tab" data-board="all" id="frTabAll" hidden>Triage board</button>
    </div>

    <div id="frComposeWrap">
      <button type="button" class="btn fr-new" id="frNewBtn">+ New request</button>
      <form class="fr-form" id="frForm" hidden>
        <div class="fr-form-row">
          <label class="di-label" for="frType">What is this?</label>
          <select class="input" id="frType">
            ${Object.entries(TYPE_LABELS).map(([k, v]) =>
              `<option value="${escapeHtml(k)}">${escapeHtml(v)}</option>`).join("")}
          </select>
        </div>
        <div class="fr-form-row">
          <label class="di-label" for="frTitle">One line summary</label>
          <input type="text" class="input" id="frTitle" maxlength="120"
                 placeholder="e.g. Trustee export is missing the division column">
        </div>
        <div class="fr-form-row">
          <label class="di-label" for="frDescription">What do you need, and why?</label>
          <textarea class="input fr-textarea" id="frDescription" rows="5" maxlength="4000"
                    placeholder="What you are trying to do, and what stops you today."></textarea>
          <p class="fr-hint">
            Please do not paste conversation content, recordings or personal data here.
          </p>
        </div>
        <div class="fr-form-row" id="frContextRow" hidden>
          <label class="di-label">Page this is about</label>
          <div class="fr-context">
            <span id="frContextLabel"></span>
            <button type="button" class="fr-context-clear" id="frContextClear" title="Not about this page">clear</button>
          </div>
        </div>
        <label class="fr-check">
          <input type="checkbox" id="frAnon">
          <span>Do not show my name if this is published</span>
        </label>
        <p class="fr-consent">
          Your request stays within your own organisation unless we publish it to the
          shared board that all organisations can see. If we do, it appears with the
          wording we write, shown as your first name and last initial — or as
          “A customer” if you tick the box above. Your organisation is never named.
        </p>
        <div class="fr-form-actions">
          <button type="submit" class="btn" id="frSubmit">Submit request</button>
          <button type="button" class="btn" id="frCancel">Cancel</button>
        </div>
      </form>
    </div>

    <p class="fr-status" id="frStatus">Loading…</p>
    <div class="fr-list" id="frList"></div>
  `;

  const $tabs        = el.querySelector("#frTabs");
  const $tabAll      = el.querySelector("#frTabAll");
  const $composeWrap = el.querySelector("#frComposeWrap");
  const $newBtn      = el.querySelector("#frNewBtn");
  const $form        = el.querySelector("#frForm");
  const $type        = el.querySelector("#frType");
  const $title       = el.querySelector("#frTitle");
  const $description = el.querySelector("#frDescription");
  const $contextRow  = el.querySelector("#frContextRow");
  const $contextLbl  = el.querySelector("#frContextLabel");
  const $anon        = el.querySelector("#frAnon");
  const $submit      = el.querySelector("#frSubmit");
  const $status      = el.querySelector("#frStatus");
  const $list        = el.querySelector("#frList");
  const $refresh     = el.querySelector("#frRefresh");

  function setStatus(msg, tone) {
    $status.textContent = msg || "";
    $status.className = "fr-status" + (tone ? ` fr-status--${tone}` : "");
    $status.style.display = msg ? "" : "none";
  }

  if (captured?.pageLabel) {
    $contextLbl.textContent = captured.pageLabel;
    $contextRow.hidden = false;
  }
  el.querySelector("#frContextClear").addEventListener("click", () => {
    captured = null;
    $contextRow.hidden = true;
  });

  // ── Cards ─────────────────────────────────────────────

  /**
   * Is the newest message on this request from the other side of the
   * conversation?
   *
   * Compared against the role the viewer would post as, rather than against an
   * author id, so a superuser's own request — where every message is theirs —
   * never marks itself as waiting. Only the two people who can actually reply
   * see it: a colleague reading along has nothing to answer.
   */
  function waitingOnMe(r) {
    const participant = isSuperuser || r.userId === me?.id;
    if (!participant || !r.threadCount) return false;
    const myRole = isSuperuser ? "superuser" : "submitter";
    return r.threadLastRole && r.threadLastRole !== myRole;
  }

  function badge(kind, tone, text) {
    return `<span class="fr-badge fr-badge--${kind}-${tone}">${escapeHtml(text)}</span>`;
  }

  function shippedMarkup(r) {
    if (r.status !== "shipped" || !r.shippedVersion) return "";
    const v = escapeHtml(r.shippedVersion);
    return releaseNoteVisible(r.shippedVersion, isInternal)
      ? `<a class="fr-shipped" href="#/release-notes">Shipped in v${v}</a>`
      : `<span class="fr-shipped">Shipped in v${v}</span>`;
  }

  function cardMarkup(r) {
    const own = board !== "shared";
    const status = r.status || "new";
    const editable = own && r.userId === me?.id && status === "new";

    // On the shared board the submitter is already an abbreviation the server
    // produced; on your own board it is the full name of a colleague.
    const who = own
      ? (r.publishAnonymously ? `${escapeHtml(r.userName || "—")} (anonymous if published)` : escapeHtml(r.userName || "—"))
      : escapeHtml(r.submitter || "—");

    const context = own && r.pageLabel
      ? `<span class="fr-meta-item">${escapeHtml(r.pageLabel)}</span>` : "";
    const orgTag = board === "all" && r.orgName
      ? `<span class="fr-meta-item">${escapeHtml(r.orgName)}</span>` : "";

    return `
      <article class="fr-card" data-id="${escapeHtml(r.id)}">
        <div class="fr-card-top">
          <h3 class="fr-card-title">${escapeHtml(r.title || "(no title)")}</h3>
          <button type="button" class="fr-vote${r.hasVoted ? " fr-vote--on" : ""}" data-vote="${escapeHtml(r.id)}"
                  title="${r.hasVoted ? "Remove your vote" : "I want this too"}">
            ${r.hasVoted ? "Voted" : "Vote"}${r.voteCount ? ` <span class="fr-vote-count">(${r.voteCount})</span>` : ""}
          </button>
        </div>
        <div class="fr-card-meta">
          ${badge("type", "plain", TYPE_LABELS[r.type] || r.type || "")}
          ${badge("status", STATUS_TONE[status] || "open", STATUS_LABELS[status] || status)}
          <span class="fr-meta-item">${who}</span>
          <span class="fr-meta-item">${escapeHtml(formatDateTime(r.createdAt))}</span>
          ${orgTag}
          ${context}
          ${shippedMarkup(r)}
        </div>
        <p class="fr-card-body">${escapeHtml(r.description || "")}</p>
        ${r.adminNote ? `
          <div class="fr-response">
            <span class="fr-response-label">Response</span>
            <p class="fr-response-body">${escapeHtml(r.adminNote)}</p>
          </div>` : ""}
        ${board === "all" && r.visibility === "shared"
          ? `<p class="fr-published">Published to the shared board as “${escapeHtml(r.sharedTitle || "")}”</p>` : ""}
        <div class="fr-card-actions">
          ${own ? `<button type="button" class="fr-link" data-thread="${escapeHtml(r.id)}">${
            openThreads.has(r.id)
              ? "Hide discussion"
              : `Discussion${r.threadCount ? ` (${r.threadCount})` : ""}`
          }</button>${waitingOnMe(r) ? `<span class="fr-waiting" title="The last message was not yours">reply waiting</span>` : ""}` : ""}
          ${editable ? `<button type="button" class="fr-link" data-edit="${escapeHtml(r.id)}">Edit</button>` : ""}
          ${isSuperuser && own ? `<button type="button" class="fr-link" data-triage="${escapeHtml(r.id)}">Triage</button>` : ""}
          ${isSuperuser && own ? `<button type="button" class="fr-link fr-link--danger" data-delete="${escapeHtml(r.id)}">Delete</button>` : ""}
        </div>
        ${own ? threadMarkup(r) : ""}
        ${editingId === r.id ? editMarkup(r) : ""}
        ${triagingId === r.id ? triageMarkup(r) : ""}
      </article>`;
  }

  function editMarkup(r) {
    return `
      <form class="fr-inline" data-edit-form="${escapeHtml(r.id)}">
        <input type="text" class="input" name="title" maxlength="120" value="${escapeHtml(r.title || "")}">
        <textarea class="input fr-textarea" name="description" rows="4" maxlength="4000">${escapeHtml(r.description || "")}</textarea>
        <div class="fr-form-actions">
          <button type="submit" class="btn">Save</button>
          <button type="button" class="btn" data-edit-cancel="1">Cancel</button>
        </div>
      </form>`;
  }

  function triageMarkup(r) {
    return `
      <form class="fr-inline" data-triage-form="${escapeHtml(r.id)}">
        <label class="di-label">Status</label>
        <select class="input" name="status">
          ${Object.entries(STATUS_LABELS).map(([k, v]) =>
            `<option value="${escapeHtml(k)}"${r.status === k ? " selected" : ""}>${escapeHtml(v)}</option>`).join("")}
        </select>

        <label class="di-label">Response — the submitter reads this</label>
        <textarea class="input fr-textarea" name="adminNote" rows="3">${escapeHtml(r.adminNote || "")}</textarea>

        <label class="di-label">Shipped in version</label>
        <input type="text" class="input" name="shippedVersion" value="${escapeHtml(r.shippedVersion || "")}" placeholder="e.g. 3.8">

        <hr class="hr">
        <p class="fr-hint">
          Publishing shows this on the shared board that every organisation sees.
          The wording below is what they read — the submitter's own words are never
          published.
        </p>
        <label class="di-label">Published title</label>
        <input type="text" class="input" name="sharedTitle" maxlength="120" value="${escapeHtml(r.sharedTitle || "")}">
        <label class="di-label">Published description</label>
        <textarea class="input fr-textarea" name="sharedDescription" rows="3" maxlength="4000">${escapeHtml(r.sharedDescription || "")}</textarea>
        <label class="fr-check">
          <input type="checkbox" name="shared"${r.visibility === "shared" ? " checked" : ""}>
          <span>Show on the shared board</span>
        </label>

        <div class="fr-form-actions">
          <button type="submit" class="btn">Save</button>
          <button type="button" class="btn" data-triage-cancel="1">Cancel</button>
        </div>
      </form>`;
  }

  /**
   * The discussion thread on a request.
   *
   * Everyone in the org reads it; only the submitter and a superuser write.
   * That is deliberate — §1's complaint was that people never learn what became
   * of what they asked for, and a conversation only its two participants can
   * see recreates exactly that for the colleagues standing behind them.
   */
  function threadMarkup(r) {
    const messages = openThreads.get(r.id);
    if (!messages) return "";

    const canPost = isSuperuser || r.userId === me?.id;
    const body = messages.length
      ? messages.map((m) => `
          <div class="fr-msg">
            <div class="fr-msg-head">
              <span class="fr-msg-who">${escapeHtml(m.authorName || "—")}</span>
              ${m.authorRole === "superuser" ? `<span class="fr-msg-role">us</span>` : ""}
              <span class="fr-meta-item">${escapeHtml(formatDateTime(m.createdAt))}</span>
              ${(m.authorId === me?.id || isSuperuser)
                ? `<button type="button" class="fr-link" data-msg-delete="${escapeHtml(m.id)}" data-msg-request="${escapeHtml(r.id)}">Delete</button>`
                : ""}
            </div>
            <p class="fr-msg-body">${escapeHtml(m.body || "")}</p>
          </div>`).join("")
      : `<p class="fr-hint">No messages yet.</p>`;

    return `
      <div class="fr-thread">
        ${body}
        ${canPost ? `
          <form class="fr-inline" data-thread-form="${escapeHtml(r.id)}">
            <textarea class="input fr-textarea" name="body" rows="3" maxlength="4000"
                      placeholder="Reply…"></textarea>
            <div class="fr-form-actions">
              <button type="submit" class="btn">Send</button>
            </div>
          </form>`
          : `<p class="fr-hint">Only ${escapeHtml(r.userName || "the person who filed this")} and we can reply here.</p>`}
      </div>`;
  }

  function renderList() {
    if (!requests.length) {
      $list.innerHTML = "";
      setStatus(board === "shared"
        ? "Nothing has been published to the shared board yet."
        : "No requests yet. Use “+ New request” to add the first one.");
      return;
    }
    setStatus("");
    $list.innerHTML = requests.map(cardMarkup).join("");
  }

  // ── Load ──────────────────────────────────────────────

  async function load() {
    setStatus("Loading…");
    $refresh.disabled = true;
    try {
      const data = await fetchRequests(board);
      requests = data.requests || [];
      isSuperuser = data.isSuperuser === true;
      $tabAll.hidden = !isSuperuser;
      renderList();
    } catch (err) {
      setStatus(`Could not load requests: ${err.message}`, "error");
      $list.innerHTML = "";
    } finally {
      $refresh.disabled = false;
    }
  }

  // ── Events ────────────────────────────────────────────

  $tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-board]");
    if (!btn) return;
    board = btn.dataset.board;
    editingId = null;
    triagingId = null;
    // Open threads are cleared along with the panels. Without this they
    // survived the switch and redrew under the shared board's redacted cards —
    // which is not a leak (the messages were already fetched by someone
    // entitled to them) but makes the shared board look like it carries
    // discussions, which is the one thing it must never do.
    openThreads.clear();
    $tabs.querySelectorAll(".fr-tab").forEach((t) =>
      t.classList.toggle("fr-tab--active", t.dataset.board === board));
    // The compose form belongs to your own board; you cannot file a request
    // "into" the shared board or the triage queue.
    $composeWrap.hidden = board !== "mine";
    load();
  });

  $newBtn.addEventListener("click", () => {
    $form.hidden = false;
    $newBtn.hidden = true;
    $title.focus();
  });

  el.querySelector("#frCancel").addEventListener("click", () => {
    $form.hidden = true;
    $newBtn.hidden = false;
  });

  $form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $title.value.trim();
    const description = $description.value.trim();
    if (!title || !description) {
      setStatus("A summary and a description are both needed.", "error");
      return;
    }

    $submit.disabled = true;
    setStatus("Submitting…");
    try {
      const org = orgContext?.getDetails?.() || null;
      await createRequest({
        title,
        description,
        type: $type.value,
        route: captured?.route || "",
        pageLabel: captured?.pageLabel || "",
        orgId: org?.id || "",
        orgName: org?.name || "",
        appVersion: APP_VERSION,
        publishAnonymously: $anon.checked,
      });
      $title.value = "";
      $description.value = "";
      $anon.checked = false;
      $form.hidden = true;
      $newBtn.hidden = false;
      await load();
      setStatus("Thank you — your request has been filed.", "success");
    } catch (err) {
      setStatus(`Could not submit: ${err.message}`, "error");
    } finally {
      $submit.disabled = false;
    }
  });

  $refresh.addEventListener("click", load);

  $list.addEventListener("click", async (e) => {
    const voteBtn = e.target.closest("[data-vote]");
    if (voteBtn) {
      voteBtn.disabled = true;
      try {
        const updated = await toggleVote(voteBtn.dataset.vote);
        const i = requests.findIndex((r) => r.id === updated.id);
        if (i >= 0) requests[i] = { ...requests[i], ...updated };
        renderList();
      } catch (err) {
        setStatus(`Could not register your vote: ${err.message}`, "error");
        voteBtn.disabled = false;
      }
      return;
    }

    const threadBtn = e.target.closest("[data-thread]");
    if (threadBtn) {
      const rid = threadBtn.dataset.thread;
      if (openThreads.has(rid)) {
        openThreads.delete(rid);
        renderList();
        return;
      }
      try {
        const data = await fetchThread(rid);
        openThreads.set(rid, data.messages || []);
        renderList();
      } catch (err) {
        setStatus(`Could not open the discussion: ${err.message}`, "error");
      }
      return;
    }

    const msgDel = e.target.closest("[data-msg-delete]");
    if (msgDel) {
      if (!confirm("Delete this message?")) return;
      const rid = msgDel.dataset.msgRequest;
      try {
        await deleteThreadMessage(rid, msgDel.dataset.msgDelete);
        const data = await fetchThread(rid);
        openThreads.set(rid, data.messages || []);
        renderList();
      } catch (err) {
        setStatus(`Could not delete the message: ${err.message}`, "error");
      }
      return;
    }

    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) { editingId = editBtn.dataset.edit; triagingId = null; renderList(); return; }

    const triageBtn = e.target.closest("[data-triage]");
    if (triageBtn) { triagingId = triageBtn.dataset.triage; editingId = null; renderList(); return; }

    if (e.target.closest("[data-edit-cancel]")) { editingId = null; renderList(); return; }
    if (e.target.closest("[data-triage-cancel]")) { triagingId = null; renderList(); return; }

    const delBtn = e.target.closest("[data-delete]");
    if (delBtn) {
      if (!confirm("Delete this request? This cannot be undone.")) return;
      try {
        await deleteRequest(delBtn.dataset.delete);
        await load();
        setStatus("Request deleted.", "success");
      } catch (err) {
        setStatus(`Could not delete: ${err.message}`, "error");
      }
    }
  });

  $list.addEventListener("submit", async (e) => {
    const editForm = e.target.closest("[data-edit-form]");
    if (editForm) {
      e.preventDefault();
      const id = editForm.dataset.editForm;
      try {
        await updateOwnRequest(id, {
          title: editForm.title.value.trim(),
          description: editForm.description.value.trim(),
        });
        editingId = null;
        await load();
        setStatus("Saved.", "success");
      } catch (err) {
        setStatus(`Could not save: ${err.message}`, "error");
      }
      return;
    }

    const threadForm = e.target.closest("[data-thread-form]");
    if (threadForm) {
      e.preventDefault();
      const rid = threadForm.dataset.threadForm;
      const body = threadForm.body.value.trim();
      if (!body) return;
      try {
        await postThreadMessage(rid, body);
        const data = await fetchThread(rid);
        openThreads.set(rid, data.messages || []);
        renderList();
      } catch (err) {
        setStatus(`Could not send: ${err.message}`, "error");
      }
      return;
    }

    const triageForm = e.target.closest("[data-triage-form]");
    if (triageForm) {
      e.preventDefault();
      const id = triageForm.dataset.triageForm;
      try {
        await triageRequest(id, {
          status: triageForm.status.value,
          adminNote: triageForm.adminNote.value,
          shippedVersion: triageForm.shippedVersion.value.trim(),
          sharedTitle: triageForm.sharedTitle.value.trim(),
          sharedDescription: triageForm.sharedDescription.value.trim(),
          visibility: triageForm.shared.checked ? "shared" : "private",
        });
        triagingId = null;
        await load();
        setStatus("Saved.", "success");
      } catch (err) {
        setStatus(`Could not save: ${err.message}`, "error");
      }
    }
  });

  load();
  return el;
}
