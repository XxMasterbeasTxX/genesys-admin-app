/**
 * Users › Roles, Queues & Skills › Copy from User
 *
 * Reset-copy one user's roles, skills, languages, and/or queues to one
 * or more target users.  The user picks which categories to copy via
 * checkboxes.  For each ticked category, the target user's existing
 * items are removed first, then the source user's items are applied
 * — producing an identical copy for that category only.
 */
import { escapeHtml } from "../../../utils.js";
import * as gc from "../../../services/genesysApi.js";

export default function renderCopyFromUser({ route, me, api, orgContext }) {
  const el = document.createElement("section");
  el.className = "card";

  const org = orgContext?.getDetails?.();
  if (!org) {
    el.innerHTML = `
      <h1 class="h1">Copy from User</h1>
      <hr class="hr">
      <p class="p">Please select a customer org from the dropdown above.</p>`;
    return el;
  }

  const orgId = org.id;

  el.innerHTML = `
    <h1 class="h1">Copy from User</h1>
    <hr class="hr">
    <p class="page-desc">
      Copy roles, skills, languages, and/or queue memberships from a source user
      to one or more target users. Each selected category is <strong>reset</strong>
      on the target — existing items are removed, then the source user's items are applied.
    </p>

    <!-- Step 1 — Source User -->
    <div class="cfu-step">
      <h2 class="cfu-step-title">1. Source User</h2>
      <div class="cfu-search-row">
        <input type="text" id="cfuSourceSearch" class="input" placeholder="Search by name or email…" autocomplete="off">
        <button class="btn" id="cfuSourceBtn">Search</button>
      </div>
      <div id="cfuSourceResults" class="cfu-results" hidden></div>
      <div id="cfuSourceCard" class="cfu-user-card" hidden></div>
    </div>

    <!-- Step 2 — What to copy -->
    <div class="cfu-step" id="cfuStep2" hidden>
      <h2 class="cfu-step-title">2. What to copy</h2>
      <div class="cfu-checks">
        <label class="cfu-check"><input type="checkbox" id="cfuChkRoles" checked> Roles <span class="cfu-badge" id="cfuBadgeRoles">0</span></label>
        <label class="cfu-check"><input type="checkbox" id="cfuChkSkills" checked> Skills <span class="cfu-badge" id="cfuBadgeSkills">0</span></label>
        <label class="cfu-check"><input type="checkbox" id="cfuChkLangs" checked> Languages <span class="cfu-badge" id="cfuBadgeLangs">0</span></label>
        <label class="cfu-check"><input type="checkbox" id="cfuChkQueues" checked> Queues <span class="cfu-badge" id="cfuBadgeQueues">0</span></label>
      </div>
    </div>

    <!-- Step 3 — Target Users -->
    <div class="cfu-step" id="cfuStep3" hidden>
      <h2 class="cfu-step-title">3. Target User(s)</h2>
      <div class="cfu-search-row">
        <input type="text" id="cfuTargetSearch" class="input" placeholder="Search by name or email…" autocomplete="off">
        <button class="btn" id="cfuTargetBtn">Search</button>
      </div>
      <div id="cfuTargetResults" class="cfu-results" hidden></div>
      <div id="cfuTargetChips" class="cfu-chips"></div>
    </div>

    <!-- Preview -->
    <div class="cfu-step" id="cfuPreview" hidden>
      <h2 class="cfu-step-title">Preview</h2>
      <div id="cfuPreviewContent"></div>
    </div>

    <!-- Actions -->
    <div class="cfu-step" id="cfuActions" hidden>
      <button class="btn" id="cfuCopyBtn">Copy</button>
      <button class="btn btn--secondary" id="cfuCancelBtn" style="display:none">Cancel</button>
    </div>

    <!-- Progress / status -->
    <div id="cfuStatus" class="cfu-status"></div>
    <div id="cfuProgressWrap" class="cfu-progress-wrap" hidden>
      <div id="cfuProgressBar" class="cfu-progress-bar"></div>
    </div>
    <div id="cfuLog" class="cfu-log" hidden></div>
  `;

  // ── References ────────────────────────────────────────
  const $srcSearch   = el.querySelector("#cfuSourceSearch");
  const $srcBtn      = el.querySelector("#cfuSourceBtn");
  const $srcResults  = el.querySelector("#cfuSourceResults");
  const $srcCard     = el.querySelector("#cfuSourceCard");

  const $chkRoles    = el.querySelector("#cfuChkRoles");
  const $chkSkills   = el.querySelector("#cfuChkSkills");
  const $chkLangs    = el.querySelector("#cfuChkLangs");
  const $chkQueues   = el.querySelector("#cfuChkQueues");
  const $badgeRoles  = el.querySelector("#cfuBadgeRoles");
  const $badgeSkills = el.querySelector("#cfuBadgeSkills");
  const $badgeLangs  = el.querySelector("#cfuBadgeLangs");
  const $badgeQueues = el.querySelector("#cfuBadgeQueues");

  const $step2       = el.querySelector("#cfuStep2");
  const $step3       = el.querySelector("#cfuStep3");
  const $tgtSearch   = el.querySelector("#cfuTargetSearch");
  const $tgtBtn      = el.querySelector("#cfuTargetBtn");
  const $tgtResults  = el.querySelector("#cfuTargetResults");
  const $tgtChips    = el.querySelector("#cfuTargetChips");

  const $preview     = el.querySelector("#cfuPreview");
  const $previewBody = el.querySelector("#cfuPreviewContent");
  const $actions     = el.querySelector("#cfuActions");
  const $copyBtn     = el.querySelector("#cfuCopyBtn");
  const $cancelBtn   = el.querySelector("#cfuCancelBtn");
  const $status      = el.querySelector("#cfuStatus");
  const $progWrap    = el.querySelector("#cfuProgressWrap");
  const $progBar     = el.querySelector("#cfuProgressBar");
  const $log         = el.querySelector("#cfuLog");

  // ── State ─────────────────────────────────────────────
  let sourceUser  = null;   // { id, name, email }
  let sourceData  = null;   // { roles, skills, languages, queues }
  const targets   = [];     // [{ id, name, email }]
  let cancelled   = false;

  // ── Helpers ───────────────────────────────────────────
  function setStatus(msg, cls) {
    $status.textContent = msg;
    $status.className = "cfu-status" + (cls ? ` cfu-status--${cls}` : "");
  }

  function setProgress(pct) {
    $progWrap.hidden = false;
    $progBar.style.width = `${pct}%`;
  }

  async function searchUsers(term) {
    if (!term.trim()) return [];
    const resp = await api.proxyGenesys(orgId, "POST", "/api/v2/users/search", {
      body: {
        pageSize: 25,
        pageNumber: 1,
        query: [{ type: "QUERY_STRING", value: term, fields: ["name", "email"] }],
      },
    });
    return (resp.results || []).map(u => ({
      id: u.id,
      name: u.name || "",
      email: u.email || "",
    }));
  }

  function renderResultsList($container, users, onPick) {
    if (!users.length) {
      $container.innerHTML = `<p class="muted" style="padding:8px">No users found.</p>`;
      $container.hidden = false;
      return;
    }
    $container.innerHTML = users.map(u => `
      <div class="cfu-result-row" data-uid="${escapeHtml(u.id)}">
        <strong>${escapeHtml(u.name)}</strong>
        <span class="muted" style="margin-left:8px">${escapeHtml(u.email)}</span>
      </div>
    `).join("");
    $container.hidden = false;
    $container.querySelectorAll(".cfu-result-row").forEach(row => {
      row.addEventListener("click", () => {
        const uid = row.dataset.uid;
        const picked = users.find(u => u.id === uid);
        if (picked) onPick(picked);
        $container.hidden = true;
      });
    });
  }

  // ── Source search ─────────────────────────────────────
  async function doSourceSearch() {
    const term = $srcSearch.value.trim();
    if (!term) return;
    $srcBtn.disabled = true;
    setStatus("Searching…");
    try {
      const users = await searchUsers(term);
      renderResultsList($srcResults, users, pickSource);
      setStatus("");
    } catch (err) {
      setStatus(`Search error: ${err.message}`, "error");
    } finally {
      $srcBtn.disabled = false;
    }
  }
  $srcBtn.addEventListener("click", doSourceSearch);
  $srcSearch.addEventListener("keydown", e => { if (e.key === "Enter") doSourceSearch(); });

  async function pickSource(user) {
    sourceUser = user;
    sourceData = null;
    $srcCard.hidden = false;
    $srcCard.innerHTML = `<div class="cfu-card-loading"><strong>${escapeHtml(user.name)}</strong> <span class="muted">${escapeHtml(user.email)}</span><br><span class="muted">Loading roles, skills, languages, queues…</span></div>`;
    $step2.hidden = true;
    $step3.hidden = true;
    $preview.hidden = true;
    $actions.hidden = true;

    try {
      const [roles, queues, userExpand] = await Promise.all([
        gc.getUserGrants(api, orgId, user.id),
        gc.getUserQueues(api, orgId, user.id),
        api.proxyGenesys(orgId, "GET", `/api/v2/users/${user.id}`, {
          query: { expand: "skills,languages" },
        }),
      ]);

      const skills = (userExpand.skills || []).map(s => ({
        id: s.id, name: s.name || "", proficiency: s.proficiency ?? 0,
      }));
      const languages = (userExpand.languages || []).map(l => ({
        id: l.id, name: l.name || "", proficiency: l.proficiency ?? 0,
      }));

      sourceData = { roles, skills, languages, queues };

      // Update badges
      $badgeRoles.textContent  = roles.length;
      $badgeSkills.textContent = skills.length;
      $badgeLangs.textContent  = languages.length;
      $badgeQueues.textContent = queues.length;

      // Render source card
      $srcCard.innerHTML = `
        <div class="cfu-card-info">
          <strong>${escapeHtml(user.name)}</strong>
          <span class="muted">${escapeHtml(user.email)}</span>
          <button class="btn btn-sm cfu-change-btn" id="cfuChangeSource">Change</button>
        </div>
        <div class="cfu-card-counts">
          <span>${roles.length} role(s)</span>
          <span>${skills.length} skill(s)</span>
          <span>${languages.length} language(s)</span>
          <span>${queues.length} queue(s)</span>
        </div>
      `;
      el.querySelector("#cfuChangeSource").addEventListener("click", () => {
        sourceUser = null;
        sourceData = null;
        $srcCard.hidden = true;
        $step2.hidden = true;
        $step3.hidden = true;
        $preview.hidden = true;
        $actions.hidden = true;
        $srcSearch.value = "";
        $srcSearch.focus();
      });

      $step2.hidden = false;
      $step3.hidden = false;
      updatePreview();
    } catch (err) {
      $srcCard.innerHTML = `<p class="cfu-status--error">Error loading user data: ${escapeHtml(err.message)}</p>`;
    }
  }

  // ── Target search ─────────────────────────────────────
  async function doTargetSearch() {
    const term = $tgtSearch.value.trim();
    if (!term) return;
    $tgtBtn.disabled = true;
    try {
      const users = await searchUsers(term);
      // Exclude the source user and already-added targets
      const excludeIds = new Set([sourceUser?.id, ...targets.map(t => t.id)]);
      const filtered = users.filter(u => !excludeIds.has(u.id));
      renderResultsList($tgtResults, filtered, addTarget);
    } catch (err) {
      setStatus(`Search error: ${err.message}`, "error");
    } finally {
      $tgtBtn.disabled = false;
    }
  }
  $tgtBtn.addEventListener("click", doTargetSearch);
  $tgtSearch.addEventListener("keydown", e => { if (e.key === "Enter") doTargetSearch(); });

  function addTarget(user) {
    if (targets.some(t => t.id === user.id)) return;
    targets.push(user);
    renderTargetChips();
    updatePreview();
  }

  function removeTarget(userId) {
    const idx = targets.findIndex(t => t.id === userId);
    if (idx >= 0) targets.splice(idx, 1);
    renderTargetChips();
    updatePreview();
  }

  function renderTargetChips() {
    $tgtChips.innerHTML = targets.map(t => `
      <span class="cfu-chip">
        ${escapeHtml(t.name)}
        <button class="cfu-chip-x" data-uid="${escapeHtml(t.id)}">&times;</button>
      </span>
    `).join("");
    $tgtChips.querySelectorAll(".cfu-chip-x").forEach(btn => {
      btn.addEventListener("click", () => removeTarget(btn.dataset.uid));
    });
  }

  // ── Checkboxes trigger preview update ─────────────────
  [$chkRoles, $chkSkills, $chkLangs, $chkQueues].forEach(cb => {
    cb.addEventListener("change", updatePreview);
  });

  // ── Preview ───────────────────────────────────────────
  function updatePreview() {
    const anyChecked = $chkRoles.checked || $chkSkills.checked || $chkLangs.checked || $chkQueues.checked;
    const hasTargets = targets.length > 0;

    if (!sourceData || !anyChecked || !hasTargets) {
      $preview.hidden = true;
      $actions.hidden = true;
      return;
    }

    let html = "";

    if ($chkRoles.checked && sourceData.roles.length) {
      html += `<details class="cfu-preview-section" open>
        <summary class="cfu-preview-header">Roles <span class="cfu-badge">${sourceData.roles.length}</span></summary>
        <table class="data-table" style="width:auto"><thead><tr><th>Role</th><th>Division</th></tr></thead><tbody>`;
      for (const r of sourceData.roles) {
        html += `<tr><td>${escapeHtml(r.roleName)}</td><td>${escapeHtml(r.divisionName)}</td></tr>`;
      }
      html += `</tbody></table></details>`;
    }

    if ($chkSkills.checked && sourceData.skills.length) {
      html += `<details class="cfu-preview-section" open>
        <summary class="cfu-preview-header">Skills <span class="cfu-badge">${sourceData.skills.length}</span></summary>
        <table class="data-table" style="width:auto"><thead><tr><th>Skill</th><th>Proficiency</th></tr></thead><tbody>`;
      for (const s of sourceData.skills) {
        html += `<tr><td>${escapeHtml(s.name)}</td><td style="text-align:center">${s.proficiency}</td></tr>`;
      }
      html += `</tbody></table></details>`;
    }

    if ($chkLangs.checked && sourceData.languages.length) {
      html += `<details class="cfu-preview-section" open>
        <summary class="cfu-preview-header">Languages <span class="cfu-badge">${sourceData.languages.length}</span></summary>
        <table class="data-table" style="width:auto"><thead><tr><th>Language</th><th>Proficiency</th></tr></thead><tbody>`;
      for (const l of sourceData.languages) {
        html += `<tr><td>${escapeHtml(l.name)}</td><td style="text-align:center">${l.proficiency}</td></tr>`;
      }
      html += `</tbody></table></details>`;
    }

    if ($chkQueues.checked && sourceData.queues.length) {
      html += `<details class="cfu-preview-section" open>
        <summary class="cfu-preview-header">Queues <span class="cfu-badge">${sourceData.queues.length}</span></summary>
        <table class="data-table" style="width:auto"><thead><tr><th>Queue</th></tr></thead><tbody>`;
      for (const q of sourceData.queues) {
        html += `<tr><td>${escapeHtml(q.queueName)}</td></tr>`;
      }
      html += `</tbody></table></details>`;
    }

    if (!html) {
      html = `<p class="muted">No items to copy in the selected categories.</p>`;
      $actions.hidden = true;
    } else {
      html += `<p class="muted" style="margin-top:8px">Target(s): <strong>${targets.map(t => escapeHtml(t.name)).join(", ")}</strong></p>`;
      $actions.hidden = false;
    }

    $previewBody.innerHTML = html;
    $preview.hidden = false;
  }

  // ── Copy execution ────────────────────────────────────
  $copyBtn.addEventListener("click", async () => {
    if (!sourceData || !targets.length) return;

    const doRoles  = $chkRoles.checked;
    const doSkills = $chkSkills.checked;
    const doLangs  = $chkLangs.checked;
    const doQueues = $chkQueues.checked;
    if (!doRoles && !doSkills && !doLangs && !doQueues) return;

    cancelled = false;
    $copyBtn.style.display = "none";
    $cancelBtn.style.display = "";
    $log.hidden = false;
    $log.innerHTML = "";
    setProgress(0);

    const totalUsers = targets.length;
    let completed = 0;

    function log(msg, cls) {
      const line = document.createElement("div");
      line.className = "cfu-log-line" + (cls ? ` cfu-log-line--${cls}` : "");
      line.textContent = msg;
      $log.appendChild(line);
      $log.scrollTop = $log.scrollHeight;
    }

    try {
      for (const target of targets) {
        if (cancelled) { log("Cancelled.", "error"); break; }
        log(`── ${target.name} (${target.email}) ──`);

        // Fetch target's current data for categories we need to reset
        let tgtRoles = [], tgtSkills = [], tgtLangs = [], tgtQueues = [];
        try {
          const fetches = [];
          if (doRoles)  fetches.push(gc.getUserGrants(api, orgId, target.id).then(r => { tgtRoles = r; }));
          if (doQueues) fetches.push(gc.getUserQueues(api, orgId, target.id).then(q => { tgtQueues = q; }));
          if (doSkills || doLangs) {
            fetches.push(
              api.proxyGenesys(orgId, "GET", `/api/v2/users/${target.id}`, {
                query: { expand: "skills,languages" },
              }).then(u => {
                if (doSkills) tgtSkills = (u.skills || []).map(s => ({ id: s.id }));
                if (doLangs)  tgtLangs  = (u.languages || []).map(l => ({ id: l.id }));
              })
            );
          }
          await Promise.all(fetches);
        } catch (err) {
          log(`  Error fetching target data: ${err.message}`, "error");
          completed++;
          setProgress((completed / totalUsers) * 100);
          continue;
        }
        if (cancelled) break;

        // ── Roles: remove existing, add source ──────────
        if (doRoles) {
          // Remove
          for (const g of tgtRoles) {
            if (cancelled) break;
            try {
              await gc.deleteUserRoleGrant(api, orgId, target.id, g.roleId, g.divisionId);
            } catch (err) {
              log(`  Remove role ${g.roleName}: ${err.message}`, "error");
            }
          }
          if (!cancelled && tgtRoles.length) log(`  Removed ${tgtRoles.length} existing role grant(s)`);
          // Add
          if (!cancelled && sourceData.roles.length) {
            try {
              await gc.grantUserRoles(api, orgId, target.id, sourceData.roles);
              log(`  Added ${sourceData.roles.length} role grant(s)`);
            } catch (err) {
              log(`  Error adding roles: ${err.message}`, "error");
            }
          }
        }

        // ── Skills: remove existing, add source ─────────
        if (doSkills && !cancelled) {
          for (const s of tgtSkills) {
            if (cancelled) break;
            try {
              await gc.deleteUserSkill(api, orgId, target.id, s.id);
            } catch (err) {
              log(`  Remove skill: ${err.message}`, "error");
            }
          }
          if (!cancelled && tgtSkills.length) log(`  Removed ${tgtSkills.length} existing skill(s)`);
          if (!cancelled && sourceData.skills.length) {
            try {
              await gc.addUserRoutingSkillsBulk(api, orgId, target.id,
                sourceData.skills.map(s => ({ id: s.id, proficiency: s.proficiency })));
              log(`  Added ${sourceData.skills.length} skill(s)`);
            } catch (err) {
              log(`  Error adding skills: ${err.message}`, "error");
            }
          }
        }

        // ── Languages: remove existing, add source ──────
        if (doLangs && !cancelled) {
          for (const l of tgtLangs) {
            if (cancelled) break;
            try {
              await gc.deleteUserLanguage(api, orgId, target.id, l.id);
            } catch (err) {
              log(`  Remove language: ${err.message}`, "error");
            }
          }
          if (!cancelled && tgtLangs.length) log(`  Removed ${tgtLangs.length} existing language(s)`);
          if (!cancelled && sourceData.languages.length) {
            try {
              await gc.addUserRoutingLanguagesBulk(api, orgId, target.id,
                sourceData.languages.map(l => ({ id: l.id, proficiency: l.proficiency })));
              log(`  Added ${sourceData.languages.length} language(s)`);
            } catch (err) {
              log(`  Error adding languages: ${err.message}`, "error");
            }
          }
        }

        // ── Queues: remove existing, add source ─────────
        if (doQueues && !cancelled) {
          for (const q of tgtQueues) {
            if (cancelled) break;
            try {
              await gc.removeQueueMember(api, orgId, q.queueId, target.id);
            } catch (err) {
              log(`  Remove queue ${q.queueName}: ${err.message}`, "error");
            }
          }
          if (!cancelled && tgtQueues.length) log(`  Removed from ${tgtQueues.length} existing queue(s)`);
          if (!cancelled && sourceData.queues.length) {
            // Add target to each source queue
            for (const q of sourceData.queues) {
              if (cancelled) break;
              try {
                await gc.addQueueMembers(api, orgId, q.queueId, [{ id: target.id }]);
              } catch (err) {
                log(`  Add to queue ${q.queueName}: ${err.message}`, "error");
              }
            }
            if (!cancelled) log(`  Added to ${sourceData.queues.length} queue(s)`);
          }
        }

        completed++;
        setProgress((completed / totalUsers) * 100);
        if (!cancelled) log(`  ✓ Done`);
      }

      if (!cancelled) {
        setStatus(`Copy complete — ${completed} user(s) processed.`, "success");
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, "error");
    } finally {
      $copyBtn.style.display = "";
      $cancelBtn.style.display = "none";
    }
  });

  $cancelBtn.addEventListener("click", () => {
    cancelled = true;
    setStatus("Cancelling…", "error");
  });

  // Close dropdowns on outside click
  el.addEventListener("click", (e) => {
    if (!$srcResults.contains(e.target) && e.target !== $srcSearch && e.target !== $srcBtn) {
      $srcResults.hidden = true;
    }
    if (!$tgtResults.contains(e.target) && e.target !== $tgtSearch && e.target !== $tgtBtn) {
      $tgtResults.hidden = true;
    }
  });

  return el;
}
