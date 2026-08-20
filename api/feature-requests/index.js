/**
 * Feature Requests API
 *
 * GET    /api/feature-requests?board=mine    → the caller's own org's requests
 * GET    /api/feature-requests?board=shared  → promoted requests, redacted (§6.7)
 * GET    /api/feature-requests?board=all     → every org's, unredacted (superuser)
 * GET    /api/feature-requests/{id}          → one request, if visible to the caller
 * POST   /api/feature-requests               → create
 * PUT    /api/feature-requests/{id}          → edit own (while new), or triage
 * POST   /api/feature-requests/{id}/vote     → toggle the caller's vote
 * GET    /api/feature-requests/{id}/thread   → the discussion thread (§3a)
 * POST   /api/feature-requests/{id}/thread   → post a message (submitter or superuser)
 * DELETE /api/feature-requests/{id}/thread/{messageId} → author, or superuser
 * DELETE /api/feature-requests/{id}          → superuser only
 *
 * Two rules run through all of it, and everything else is detail.
 *
 * WHO YOU ARE comes from your token, never from the body. `caller.userId` is
 * resolved server-side (see lib/callerContext.js); a `userEmail` in a payload is
 * display text and is never read for a decision.
 *
 * WHAT YOU SEE is scoped by `ownerOrgId`, exactly as schedules and the activity
 * log are. The one path that crosses an org boundary is the superuser triage
 * read, which is deliberate and argued in docs/feature-requests-design.md §6.2:
 * a queue that cannot see the requests it triages is not a queue.
 */
const store = require("../lib/featureRequestStore");
const threadStore = require("../lib/featureRequestThreadStore");
const { getCallerContext } = require("../lib/callerContext");
const { isSuperuser } = require("../lib/superusers");
const notify = require("../lib/featureRequestNotify");

module.exports = async function (context, req) {
  const method = req.method.toUpperCase();
  const id = context.bindingData.id || null;
  const action = (context.bindingData.action || "").toLowerCase();
  const messageId = context.bindingData.messageId || null;

  const json = (status, body) => ({
    status,
    headers: { "Content-Type": "application/json" },
    body,
  });

  try {
    const caller = await getCallerContext(context, req);
    if (!caller.authorized) {
      context.res = json(caller.status || 401, { error: caller.error || "unauthorized" });
      return;
    }

    const superuser = isSuperuser(caller);

    // Every write needs to know who is acting. Identity comes from the token, so
    // a null userId means Genesys could not be reached or the token resolved to
    // nobody — not a reason to guess. Reads stay open: not knowing who someone
    // is should not stop them seeing their own org's board.
    const requireIdentity = () => {
      if (caller.userId) return null;
      return json(503, {
        error: "identity_unavailable",
        message: "Could not confirm who you are with Genesys. Please try again.",
      });
    };

    /** Is this request one the caller is allowed to see in full? */
    const ownVisible = (request) =>
      superuser || request.ownerOrgId === caller.ownerOrgId;

    // ── GET ─────────────────────────────────────────────
    if (method === "GET") {
      if (id && action === "thread") {
        const request = await store.getById(id);
        // The thread never crosses an org boundary, promoted or not: it holds
        // submitter text nobody curated. Being able to see the shared CARD does
        // not entitle you to the conversation behind it.
        if (!request || !ownVisible(request)) {
          context.res = json(404, { error: "Request not found" });
          return;
        }
        // Who answered is hidden from a customer's own org, and only there:
        // internal threads keep real names, and a superuser reading a
        // customer's thread still sees them (§3a.2).
        const anonymiseSuperuser = request.ownerOrgId !== "internal" && !superuser;
        const messages = await threadStore.listByRequest(id);
        context.res = json(200, {
          messages: threadStore.projectMessages(messages, { anonymiseSuperuser }),
        });
        return;
      }

      if (id) {
        const request = await store.getById(id);
        if (!request) { context.res = json(404, { error: "Request not found" }); return; }

        if (ownVisible(request)) {
          context.res = json(200, store.toOwnCard(request, caller.userId, { includeEmail: superuser }));
          return;
        }
        // Visible to another org only once promoted, and only as the card.
        if (request.visibility === "shared") {
          context.res = json(200, store.toSharedCard(request, caller.userId));
          return;
        }
        // Not shared and not yours: say "not found" rather than "forbidden".
        // Confirming that an id exists tells a caller something about another
        // tenant's board, which is the thing this endpoint is built to avoid.
        context.res = json(404, { error: "Request not found" });
        return;
      }

      const board = String(req.query.board || "mine").toLowerCase();
      const all = await store.listAll();

      if (board === "all") {
        if (!superuser) { context.res = json(403, { error: "forbidden" }); return; }
        // The purge rides along with the triage read — the one read guaranteed
        // to be infrequent and performed by someone who is not waiting on a page.
        store.purgeOld()
          .then((ids) => Promise.all(ids.map((rid) => threadStore.removeThread(rid))))
          .catch((err) =>
            context.log.warn("[feature-requests] purge error (non-critical):", err?.message)
          );
        context.res = json(200, {
          requests: all.map((r) => store.toOwnCard(r, caller.userId, { includeEmail: true })),
          isSuperuser: true,
        });
        return;
      }

      if (board === "shared") {
        context.res = json(200, {
          requests: all
            .filter((r) => r.visibility === "shared")
            .map((r) => store.toSharedCard(r, caller.userId)),
          isSuperuser: superuser,
        });
        return;
      }

      // "mine" — the caller's own organisation, in full. Everyone in an org sees
      // that org's requests, the same contract schedules and the activity log
      // already have.
      context.res = json(200, {
        requests: all
          .filter((r) => r.ownerOrgId === caller.ownerOrgId)
          .map((r) => store.toOwnCard(r, caller.userId, { includeEmail: superuser })),
        isSuperuser: superuser,
      });
      return;
    }

    // ── POST — create, or vote ──────────────────────────
    if (method === "POST") {
      const blocked = requireIdentity();
      if (blocked) { context.res = blocked; return; }

      if (id && action === "vote") {
        const request = await store.getById(id);
        if (!request) { context.res = json(404, { error: "Request not found" }); return; }

        // You may vote on anything you can see: your own org's board, or the
        // shared board. Votes on a promoted request aggregate across every org,
        // which is the signal the shared board exists to produce.
        const votable = ownVisible(request) || request.visibility === "shared";
        if (!votable) { context.res = json(404, { error: "Request not found" }); return; }

        const updated = await store.toggleVote(id, caller.userId);
        context.res = json(200, ownVisible(updated)
          ? store.toOwnCard(updated, caller.userId, { includeEmail: superuser })
          : store.toSharedCard(updated, caller.userId));
        return;
      }

      if (id && action === "thread") {
        const request = await store.getById(id);
        if (!request || !ownVisible(request)) {
          context.res = json(404, { error: "Request not found" });
          return;
        }

        // Two parties, and no others. A colleague who wants the same thing
        // votes; a colleague who wants something adjacent files their own (§3a).
        const isAuthor = request.userId === caller.userId;
        if (!isAuthor && !superuser) {
          context.res = json(403, {
            error: "not_a_participant",
            message: "Only the person who filed this request can reply on it.",
          });
          return;
        }

        const body = String((req.body || {}).body || "").trim();
        if (!body) { context.res = json(400, { error: "A message is required." }); return; }
        if (body.length > threadStore.BODY_MAX) {
          context.res = json(400, { error: `Messages must be ${threadStore.BODY_MAX} characters or fewer.` });
          return;
        }

        const message = await threadStore.create({
          requestId: id,
          authorId: caller.userId,
          authorName: caller.userName,
          // The role is derived, never claimed: a superuser replying on their
          // own request is still answering it as the superuser.
          authorRole: superuser ? "superuser" : "submitter",
          body,
        });

        // Keep the board's summary current, recomputed from the messages that
        // actually exist rather than incremented. A count that is derived is a
        // count that cannot drift; if this write fails, the next message
        // corrects it.
        await store.update(id, threadStore.summarize(await threadStore.listByRequest(id)))
          .catch((err) => context.log.warn("[feature-requests] thread summary:", err?.message));

        // The one notification the design calls load-bearing: an async
        // conversation between two people who are not looking at the same
        // screen only works if each turn announces itself (§3a.3).
        notify.notifyThreadMessage(context, request, message).catch(() => {});

        context.res = json(201, message);
        return;
      }

      if (id) { context.res = json(404, { error: "Unknown action" }); return; }

      const b = req.body || {};
      const title = String(b.title || "").trim();
      const description = String(b.description || "").trim();
      if (!title || !description) {
        context.res = json(400, { error: "Missing required fields: title, description" });
        return;
      }
      if (title.length > store.TITLE_MAX || description.length > store.DESCRIPTION_MAX) {
        context.res = json(400, {
          error: `Title must be ${store.TITLE_MAX} characters or fewer and description ${store.DESCRIPTION_MAX} or fewer.`,
        });
        return;
      }

      const recent = await store.countRecentByUser(caller.userId);
      if (recent >= store.CREATES_PER_DAY) {
        context.res = json(429, {
          error: "rate_limited",
          message: `You have submitted ${store.CREATES_PER_DAY} requests in the last 24 hours. Please try again later.`,
        });
        return;
      }

      const created = await store.create({
        // Ownership and identity are the server's to state, not the body's.
        ownerOrgId: caller.ownerOrgId,
        userId: caller.userId,
        userEmail: caller.userEmail,
        userName: caller.userName,
        type: b.type,
        title,
        description,
        route: b.route,
        pageLabel: b.pageLabel,
        orgId: b.orgId,
        orgName: b.orgName,
        appVersion: b.appVersion,
        publishAnonymously: b.publishAnonymously === true,
        // A new request is always private and always `new`. Neither is a field
        // a submitter may set: promotion and triage are the superuser's.
        visibility: "private",
        status: "new",
        votes: [],
      });

      // Not awaited: the request is filed either way, and a slow relay must
      // not hold the submitter's page open. Failures are logged inside.
      notify.notifyNewRequest(context, created).catch(() => {});
      notify.notifyRequestReceived(context, created).catch(() => {});

      context.res = json(201, store.toOwnCard(created, caller.userId));
      return;
    }

    // ── PUT — edit own, or triage ───────────────────────
    if (method === "PUT") {
      const blocked = requireIdentity();
      if (blocked) { context.res = blocked; return; }
      if (!id) { context.res = json(400, { error: "Request id is required" }); return; }

      const existing = await store.getById(id);
      if (!existing || !ownVisible(existing)) {
        context.res = json(404, { error: "Request not found" });
        return;
      }

      const b = req.body || {};
      const patch = {};

      if (superuser) {
        // Triage. Each field is applied only when present, so a partial update
        // does not blank the rest.
        if (b.status !== undefined) {
          const status = store.normalizeStatus(b.status);
          if (!status) { context.res = json(400, { error: "Unknown status" }); return; }
          patch.status = status;
        }
        if (b.adminNote !== undefined) patch.adminNote = String(b.adminNote);
        if (b.shippedVersion !== undefined) patch.shippedVersion = String(b.shippedVersion);
        if (b.duplicateOf !== undefined) patch.duplicateOf = String(b.duplicateOf);
        if (b.sharedTitle !== undefined) patch.sharedTitle = String(b.sharedTitle);
        if (b.sharedDescription !== undefined) patch.sharedDescription = String(b.sharedDescription);

        if (b.visibility !== undefined) {
          const visibility = store.normalizeVisibility(b.visibility);
          if (!visibility) { context.res = json(400, { error: "Unknown visibility" }); return; }

          // Promotion requires the published wording to exist. Publishing raw
          // submitted text to every tenant is the exact failure the manual step
          // is there to prevent, and it must not be reachable by omitting a
          // field (§5).
          if (visibility === "shared") {
            const sharedTitle = patch.sharedTitle ?? existing.sharedTitle;
            if (!String(sharedTitle || "").trim()) {
              context.res = json(400, {
                error: "shared_title_required",
                message: "Write the published title before promoting a request to the shared board.",
              });
              return;
            }
          }
          patch.visibility = visibility;
        }
      } else {
        // The submitter's own request, and only while nobody has triaged it.
        // After that the record is part of a conversation, and rewriting the
        // thing that was answered is not an edit.
        if (existing.userId !== caller.userId) {
          context.res = json(403, { error: "not_your_request" });
          return;
        }
        if (existing.status !== "new") {
          context.res = json(409, {
            error: "already_triaged",
            message: "This request has already been picked up and can no longer be edited.",
          });
          return;
        }
        if (b.title !== undefined) {
          const title = String(b.title).trim();
          if (!title || title.length > store.TITLE_MAX) {
            context.res = json(400, { error: "Title is required and must be 120 characters or fewer." });
            return;
          }
          patch.title = title;
        }
        if (b.description !== undefined) {
          const description = String(b.description).trim();
          if (!description || description.length > store.DESCRIPTION_MAX) {
            context.res = json(400, { error: "Description is required and must be 4000 characters or fewer." });
            return;
          }
          patch.description = description;
        }
        if (b.type !== undefined) patch.type = store.normalizeType(b.type);
        if (b.publishAnonymously !== undefined) patch.publishAnonymously = b.publishAnonymously === true;
      }

      const updated = await store.update(id, patch);
      if (!updated) { context.res = json(404, { error: "Request not found" }); return; }

      // Only when the status actually moved — an edit to the note or the
      // published wording is not news for the person who asked.
      if (patch.status && patch.status !== existing.status) {
        notify.notifyStatusChange(context, updated, existing.status).catch(() => {});
      }

      context.res = json(200, store.toOwnCard(updated, caller.userId, { includeEmail: superuser }));
      return;
    }

    // ── DELETE ──────────────────────────────────────────
    if (method === "DELETE") {
      if (id && action === "thread" && messageId) {
        const blocked = requireIdentity();
        if (blocked) { context.res = blocked; return; }

        const request = await store.getById(id);
        if (!request || !ownVisible(request)) {
          context.res = json(404, { error: "Request not found" });
          return;
        }
        const message = await threadStore.getById(id, messageId);
        if (!message) { context.res = json(404, { error: "Message not found" }); return; }

        // Your own words, or a superuser's tidying. Nobody edits — a thread
        // whose messages silently change is worse than one with a visible gap.
        if (message.authorId !== caller.userId && !superuser) {
          context.res = json(403, { error: "not_your_message" });
          return;
        }

        await threadStore.remove(id, messageId);
        await store.update(id, threadStore.summarize(await threadStore.listByRequest(id)))
          .catch((err) => context.log.warn("[feature-requests] thread summary:", err?.message));
        context.res = json(200, { success: true });
        return;
      }

      if (!superuser) { context.res = json(403, { error: "forbidden" }); return; }
      if (!id) { context.res = json(400, { error: "Request id is required" }); return; }

      const removed = await store.remove(id);
      // The thread goes with its request. Left behind it would be unreachable
      // and would outlive the record that justified keeping it.
      if (removed) await threadStore.removeThread(id).catch(() => {});
      context.res = removed
        ? json(200, { success: true })
        : json(404, { error: "Request not found" });
      return;
    }

    context.res = json(405, { error: "Method not allowed" });
  } catch (err) {
    context.log.error("[feature-requests] error:", err?.message || err);
    context.res = json(500, { error: err?.message || "Internal server error" });
  }
};
