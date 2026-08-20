/**
 * Release Notes page.
 *
 * Lists all entries from releaseNotes.js (newest first). The first
 * entry is highlighted as the latest release. A Back button returns
 * to the previous view via browser history.
 */
import { escapeHtml } from "../utils.js";
import { RELEASE_NOTES } from "../releaseNotes.js";

export function renderReleaseNotesPage(isInternal = false) {
  const root = document.createElement("section");
  root.className = "release-notes";

  const header = document.createElement("div");
  header.className = "release-notes__header";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "release-notes__back";
  backBtn.textContent = "← Back";
  backBtn.addEventListener("click", () => {
    if (window.history.length > 1) window.history.back();
    else window.location.hash = "#/";
  });

  const title = document.createElement("h1");
  title.className = "h1";
  title.textContent = "Release Notes";

  header.append(backBtn, title);
  root.append(header);

  if (!RELEASE_NOTES.length) {
    const empty = document.createElement("p");
    empty.className = "p";
    empty.textContent = "No release notes yet.";
    root.append(empty);
    return root;
  }

  // Internal-only entries are shown to customers as a placeholder rather than
  // removed. Removing them left visible holes in a numbered sequence — five
  // consecutive versions missing between 2.7 and 2.1 — and a gap invites the
  // question a placeholder answers and ends. Hiding leaked more than showing.
  //
  // It also keeps "Latest" honest: the badge follows the first entry in this
  // list, so filtering meant a customer could see the sidebar say v4.0 while the
  // notes badged v3.9 as the latest. Every version is present now, for everyone.
  const visibleNotes = RELEASE_NOTES;

  const list = document.createElement("div");
  list.className = "release-notes__list";

  visibleNotes.forEach((entry, i) => {
    const card = document.createElement("article");
    card.className = "release-notes__entry";
    if (i === 0) card.classList.add("release-notes__entry--latest");

    // What a customer reads on an entry written for staff. `customerSummary`
    // lets a mostly-internal release still say the one thing that affects them;
    // without it the line says plainly that nothing does.
    const withheld = !isInternal && entry.internalOnly;
    const title = withheld ? "Internal improvements" : entry.title;
    const changes = withheld
      ? [entry.customerSummary || "Nothing in this release affects your organisation."]
      : (entry.changes ?? []);

    const items = changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("");

    // Each entry carries its own explicit version. The newest entry is
    // also flagged as "Latest" and matches the sidebar footer.
    const versionLabel = entry.version ?? null;

    card.innerHTML = `
      <div class="release-notes__entry-head">
        ${versionLabel ? `<span class="release-notes__version">v${escapeHtml(versionLabel)}</span>` : ""}
        ${i === 0 ? `<span class="release-notes__badge">Latest</span>` : ""}
        ${isInternal && entry.internalOnly ? `<span class="release-notes__badge" style="background:#7c3aed">Internal only</span>` : ""}
        ${entry.date ? `<span class="release-notes__date">${escapeHtml(entry.date)}</span>` : ""}
      </div>
      ${title ? `<h2 class="release-notes__title">${escapeHtml(title)}</h2>` : ""}
      <ul class="release-notes__changes">${items}</ul>
    `;

    list.append(card);
  });

  root.append(list);
  return root;
}
