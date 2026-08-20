# Throbbers — Design

Status: **Implemented** — all eight steps of §11 are done
Author: Genesys Admin App
Last updated: 2026-08-20

## 1. Purpose

Every asynchronous operation in the app must show a **running throbber next to
the text that describes it**, for as long as the operation is in flight.

The reason is not decoration. A status line reading `Fetching group
memberships… 340 / 1200` and a status line left behind by a request that died
are the same pixels. A progress bar frozen at 40% because the next page of
results is slow, and one frozen because the proxy timed out, are the same
pixels. The user cannot tell "working" from "broken" by looking, so they wait,
then reload, then lose the run.

A throbber is the only element on the page whose motion is *evidence* that the
browser is still alive and the work is still going. It is therefore required
**even where a progress bar already exists** — the bar says *what* is
happening, the throbber says *that* something is still happening. The two
answer different questions and neither substitutes for the other.

Today 67 modules do asynchronous work and 9 of them show a throbber.

## 2. Confirmed decisions

- **One shared primitive**, `.spin`, in [`css/styles.css`](../css/styles.css).
  The four page-local `@keyframes` copies are retired (§3).
- **The throbber sits inline, immediately before the status text**, and moves
  with it. Not in a corner, not in the page header — next to the words that are
  changing, because that is the pair the eye reads together.
- **Throbbers appear on pages that already have a progress bar** (§8). This is
  the point of the exercise, not an exception to it.
- **Busy is inferred from the message containing `…`** (§6.2), overridable with
  an explicit argument. Verified against all 929 `setStatus()` calls: 197
  contain an ellipsis and every one of them is a busy message. No false
  positives, no misses.
- **The throbber element is created once and re-parented, never re-rendered**
  (§6.3). Rewriting `innerHTML` restarts the CSS animation, which produces a
  stuttering throbber on exactly the pages that need one most.
- **The shared helper keeps the existing `setStatus(msg, type)` signature**, so
  the 929 existing call sites do not change. Each page loses its local copy of
  the function and gains throbbers everywhere for free.
- **`prefers-reduced-motion` softens the animation, it does not remove it**
  (§10). Removing it would delete the one signal this design exists to provide.
- **The router throbber waits ~150 ms before appearing** (§9); status-line
  throbbers appear immediately. A throbber that blinks on every navigation
  teaches the user to stop looking at throbbers, which costs the signal this
  whole design is buying.
- **Throbbers are local only.** No global "something is loading" indicator in
  the app header (§13).

## 3. What exists today

Five hand-rolled implementations, four of them copy-pasted into page-local
`<style>` blocks:

| Class | Defined in | Shape |
|---|---|---|
| `.tc-spin` | [`testCases.js:74`](../js/pages/deployment/testCases.js) | 14px inline glyph in the status line — the reference |
| `.fo-spin` | [`flowOverview.js:143`](../js/pages/flows/flowOverview.js) | same, plus a 10px per-tab badge |
| `.df-spin` | [`deleteFlow.js:262`](../js/pages/flows/deleteFlow.js) | same, behind a third `spinner` argument |
| `.ob-spin` | [`onboarding.js:123`](../js/pages/deployment/onboarding.js) | step-list glyph, geometry set inline on the element |
| `.cu-loading-spinner` | [`styles.css:2622`](../css/styles.css) | 36px block, centred in a panel — 4 rolesSkills pages |

Three of the five are visually identical and differ only in the border colour
they hard-code (`var(--text)` vs `rgba(255,255,255,.25)`, the latter being
wrong in light mode). A sixth, `showSpinner()` in
[`documentation/create.js:140`](../js/pages/export/documentation/create.js), is
a misnomer: it toggles a progress bar, and that page has no spinner at all.

## 4. The gap

### 4.1 The status line — 60 modules, 197 busy call sites

Sixty modules define the same function, differing only in a CSS prefix:

```js
function setStatus(msg, type = "") {
  $status.textContent = msg;
  $status.className = "dt-status" + (type ? ` dt-status--${type}` : "");
}
```

Twenty-one prefixes are in use — `te-` (17 files), `dt-` (11), `di-` (4),
`cs-` (3), `is-` (3), `st-` (2), `rs-` (2), `wc-` (2), `cu-` (2), `rj-` (2),
and `sp-`, `se-`, `jf-`, `mi-`, `fr-`, `rcb-`, `rc-`, `cfu-`, `gl-`, `pc-`,
`wcm-` once each. The prefix is the *only* thing that varies. This is the
single largest win in the document: one helper, sixty one-line changes, 197
sites lit.

### 4.2 Dropdowns and comboboxes filled asynchronously — 18 sites

A dead `<option>`, or a disabled input carrying placeholder text, with nothing
moving:

`datatables/copySingleOrg.js:58,82` · `datatables/create.js:80,323` ·
`datatables/edit.js:249` · `deployment/onboarding.js:330` ·
`export/billing/singleOrg.js:202` · `interactions/move.js:136,143` ·
`phones/webrtc/changeSite.js:168,174` · `phones/webrtc/createWebRtc.js:303` ·
`users/directRouting/addUsers.js:575` · `flows/journeyFlow.js:198` ·
`roles/create.js:291,325` · `roles/search.js:197` · `audit/search.js:128`

### 4.3 Panels and tables printing a bare "Loading…" — 18 sites

Precisely the case `.cu-loading` already solves on four pages, absent on
eighteen others:

`admin/activityLog.js:227` · `export/scheduledExports.js:35` ·
`components/schedulePanel.js:502` ·
`interactions/recordings/jobsList.js:77,226,285` · `gdpr/requestStatus.js:70` ·
`flows/journeyFlow.js:424` · `requests.js:171` · `utilities/getLists.js:480` ·
`utilities/ipRanges.js:196` · `utilities/permissionCatalog.js:102` ·
`interactions/searchRecent.js:358` · `roles/create.js:677,776` ·
`roles/copy/copyBetweenOrgs.js:815`

### 4.4 Progress bars with a dead lead-in — 36 modules

Seven duplicated bar families (`te-`, `dt-`, `di-`, `is-`, `mi-`, `wc-`,
`cs-`), none with an indeterminate state. The universal pattern is
`setProgress(0)` followed by the first and usually slowest request — see
[`lastLogin.js:241`](../js/pages/export/users/lastLogin.js). A zero-width bar
sits motionless until counting starts, and stalls again at every slow item
after that.

### 4.5 Per-control actions with no local feedback

The click happens here; the only acknowledgement is a page-level status line
somewhere else, or the button simply greys out:

- [`requests.js`](../js/pages/requests.js) — vote (`:531`), open discussion
  (`:553`), delete message (`:567`), delete request (`:590`), save edit
  (`:615`), post message (`:635`), triage save (`:658`). Several set no status
  at all unless they fail.
- [`schedulePanel.js:449,468`](../js/components/schedulePanel.js) — modal save
  and delete.
- [`deployment/basic.js:1670`](../js/pages/deployment/basic.js) — 55 awaits of
  real deployment work behind one `Processing N tab(s)…` line.
- [`jobsList.js:226,285`](../js/pages/interactions/recordings/jobsList.js) —
  row expansion fetches filters into the row.

### 4.6 The app shell — nothing at all

- **Boot.** [`app.js:156`](../js/app.js) authenticates, then awaits
  `/api/org-config` against an empty nav and an empty main. Only the `Auth: …`
  pill text changes.
- **Navigation.** [`router.js:62`](../js/router.js) awaits `resolve(route)`,
  which is one of **87 dynamic `import()`s** in
  [`pageRegistry.js`](../js/pageRegistry.js). The outgoing page stays on
  screen, inert, until the module lands. Four pages (`activityLog`,
  `getLists`, `ipRanges`, `permissionCatalog`) also fetch data before returning
  their element, so the stall is network-length.
- **Org switch.** [`app.js:369`](../js/app.js) re-renders the whole page on
  customer change, silently.

## 5. The primitive

Added to [`css/styles.css`](../css/styles.css) near the `.btn` block, so it is
core furniture rather than a page concern:

```css
/* ── Throbber ─────────────────────────────────────────── */
@keyframes spin { to { transform: rotate(360deg); } }

.spin {
  display: inline-block;
  flex: none;
  width:  var(--spin-size, 14px);
  height: var(--spin-size, 14px);
  border: var(--spin-weight, 2px) solid var(--border);
  border-top-color: var(--spin-color, var(--text));
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: -2px;
}

.spin--sm    { --spin-size: 11px; }
.spin--block { --spin-size: 36px; --spin-weight: 3px;
               --spin-color: var(--accent, #3b82f6); }
.spin--btn   { --spin-size: 12px; --spin-color: currentColor; margin-right: 6px; }

/* The centred panel wrapper — generalises today's .cu-loading. */
.spin-panel {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 16px; padding: 60px 0;
}
.spin-panel[hidden] { display: none; }
```

Both themes are handled by `var(--border)` and `var(--text)`, which is what the
three hard-coded `rgba(255,255,255,.25)` copies get wrong today. `--accent` is
never declared in `:root`; every use in the stylesheet is
`var(--accent, #3b82f6)`, and the throbber follows that convention rather than
introducing a new colour.

`.cu-loading` / `.cu-loading-spinner` become thin aliases of `.spin-panel` /
`.spin--block`, so the four rolesSkills pages need no markup change.

## 6. The status helper

### 6.1 Shape

Added to [`js/utils.js`](../js/utils.js):

```js
/**
 * Status line with a throbber.
 *
 * Returns the `setStatus(msg, type)` the pages already call, so adopting it is
 * a one-line change per page. A message containing `…` is treated as a busy
 * message and gets a throbber; pass `busy` explicitly to override.
 */
export function makeStatus($el, baseClass) {
  const spin = document.createElement("span");
  spin.className = "spin";
  spin.setAttribute("aria-hidden", "true");
  const text = document.createTextNode("");
  $el.replaceChildren(text);
  $el.setAttribute("role", "status");

  return function setStatus(msg, type = "", busy = null) {
    const s = String(typeof msg === "function" ? msg() : (msg ?? ""));
    const isBusy = busy === null ? s.includes("…") : !!busy;

    text.nodeValue = isBusy ? ` ${s}` : s;
    if (isBusy && !spin.isConnected) $el.insertBefore(spin, text);
    else if (!isBusy && spin.isConnected) spin.remove();

    $el.className = baseClass + (type ? ` ${baseClass}--${type}` : "");
  };
}
```

A page then replaces its local function with:

```js
const setStatus = makeStatus($status, "dt-status");
```

### 6.2 Why the ellipsis is the signal

Every busy message in the app already ends its clause with `…`. That is not an
accident of style; it is what the ellipsis means. Checked exhaustively:

| | Count |
|---|---|
| `setStatus()` call sites | 929 |
| …of which contain `…` | 197 |
| …of which are busy messages | **197** |
| …of which are *not* busy messages | **0** |

Seventeen of the 197 carry the ellipsis mid-string, with a counter appended
after it — `` `Resolving group role grants… ${n} / ${total}` ``,
`` `Moving phone ${i + 1} of ${total}… ${name}` ``. The test is therefore
`includes`, **not** `endsWith`; an `endsWith` test would have missed precisely
the longest-running operations in the app.

Three dots count as well as the character. One page
([`createEditMapping.js`](../js/pages/wrapupCodes/createEditMapping.js)) wrote
`Loading wrapup codes...`; its text was normalised to the house-style `…`, but
the test accepts both so a future `...` cannot silently lose its throbber.

The explicit third argument exists for the cases the convention cannot see: a
message with no ellipsis that is nevertheless busy, or the reverse. It is
positioned to match [`deleteFlow.js:379`](../js/pages/flows/deleteFlow.js),
which already has `setStatus(msg, type, spinner)` — that page adopts the helper
with no call-site edits at all.

### 6.3 Why the node is reused

The existing implementations do
`$el.innerHTML = '<span class="spin"></span> ' + msg` on every call. That
destroys and recreates the element, so the CSS animation restarts from 0° each
time. On a page whose status updates once per flow this is invisible. On
`Resolving group role grants… 340 / 1200`, updating many times a second, the
throbber never advances past the first few degrees — it reads as *frozen*,
which is the exact failure mode this design exists to prevent.

Keeping one `<span>` and only attaching or detaching it means the rotation is
continuous for the whole operation and restarts only on a genuine idle → busy
transition. It also removes the `escapeHtml` round-trip, and with it the
possibility of an unescaped org or flow name breaking the status line.

**A message seeded in the markup must be preserved.** Twenty pages open with
their first status already written into the HTML —
`<div class="cs-status">Loading sites…</div>`. Taking the element over with
`replaceChildren` erases that message, so the helper reads the existing text
first and replays it through the setter, which also means a seeded `…` message
carries its throbber from the first paint rather than from the first update.

**The attachment test must be `spin.parentNode === $el`, not `spin.isConnected`.**
`isConnected` asks whether the node is in the *document*, and a page builds its
whole DOM detached — the router appends it only afterwards (`router.js`
`replaceChildren`). Written with `isConnected` the removal branch never runs
during render, so the throbber goes up on the first busy message and stays up
for good, over every later message including the errors. This was written the
wrong way first and caught by driving a busy → idle cycle on a detached element;
any test that appends to `document.body` first passes and misses it.

## 7. The other shapes

**Select / combobox (§4.2).** The control keeps its `Loading …` placeholder and
is wrapped so a `.spin.spin--sm` sits at its right edge, removed when the real
options are written. The placeholder text alone is the current design, and it
is indistinguishable from a control that failed to populate.

**Panel and table (§4.3).** The bare `Loading…` paragraph is replaced by the
`.spin-panel` block already used on the rolesSkills pages, so the eighteen
sites in §4.3 match the four that got it right.

**Button and row action (§4.5).** A `.spin.spin--btn` is prepended inside the
button for the duration, alongside `disabled`. `--spin-color: currentColor`
makes it inherit the button's own text colour, so it works on the
accent-filled primary buttons and the plain secondary ones without a variant
each. A small `withBusy(btn, fn)` wrapper in `utils.js` handles attach → await
→ detach, including the failure path, so no call site can leave a throbber
spinning forever after an error.

## 8. Pages that already have a progress bar

These get a throbber too. The bar and the throbber sit on the same row: the
throbber first, then the status text, with the bar beneath.

The bar is *determinate and honest* — it tells the user how much is left. It is
also motionless for the entire duration of any single slow request, which on
the export pages is most of the run: `setProgress(0)` is followed by the first
and largest fetch, and every subsequent step holds the bar still while its
request is outstanding. Only the throbber distinguishes that from a hung proxy.

Additionally, `.progress-bar--indeterminate` gives the bar a travelling
highlight during the lead-in before the first real percentage arrives, so the
0% state is not mistaken for 0% progress. This is a secondary improvement; the
throbber is the requirement.

The seven duplicated bar families are consolidated into one `.progress-wrap` /
`.progress-bar` pair at the same time, since they are byte-identical apart from
the prefix. This is bundled here rather than deferred because touching all
thirty-six of these pages twice is worse than touching them once.

## 9. The app shell

- **Boot.** `app-main` renders a `.spin-panel` reading `Loading your
  organisations…` from the first line of `main()` until the router takes over,
  replacing the current blank screen.
- **Navigation.** [`router.js`](../js/router.js) shows the same block in the
  outlet if `resolve(route)` has not settled within ~150 ms. The delay matters:
  a cached module resolves in a few milliseconds, and a throbber that flashes
  on every navigation is visual noise that trains the user to ignore throbbers.
- **Org switch.** Covered by the same router change, since it re-renders
  through `router.render()`.

## 10. Accessibility

- Each status line carries `role="status"` (implicit `aria-live="polite"`), so
  the message is announced. The throbber is `aria-hidden="true"` — it is
  redundant to a screen reader, which has the text.
- Buttons showing an in-button throbber get `aria-busy="true"`.
- Under `prefers-reduced-motion: reduce` the rotation is replaced by a slow
  opacity pulse rather than removed:

  ```css
  @media (prefers-reduced-motion: reduce) {
    .spin { animation: spin-pulse 1.4s ease-in-out infinite; }
    @keyframes spin-pulse { 50% { opacity: 0.25; } }
  }
  ```

  A user who has asked for less motion still needs to know the app is alive.
  Deleting the indicator would answer their preference by removing the
  information, which is not the trade they asked for.

## 11. Rollout

Ordered so that each step is independently shippable, and the risky part comes
after the mechanical part.

| # | Step | Scope | State |
|---|---|---|---|
| 1 | `.spin` primitive + `makeStatus` + `withBusy` | 2 files | **done** |
| 2 | Retire the 5 local spinners; alias `.cu-loading` | 5 files | **done** |
| 3 | Adopt `makeStatus` across the 60 status lines | 60 files | **done** |
| 4 | Async selects and comboboxes → `makeControlBusy` | 13 files | **done** |
| 5 | Panels and tables → `.spin-panel` / inline | 14 files | **done** |
| 6 | Button and row actions → `withBusy` | 4 files | **done** |
| 7 | Indeterminate lead-in on every progress bar | 33 files | **done** |
| 8 | Shell: boot and router | 3 files | **done** |

Four helpers ended up in [`js/utils.js`](../js/utils.js) rather than the three
the plan named: `makeStatus`, `makeControlBusy`, `withBusy` and `spinPanel`.

**Step 4** puts the throbber on the control's **label**, not the control — a
`<select>` cannot hold one, and wrapping it risks the grid it sits in. Three of
the eighteen sites needed no work: the flow combobox on
[`journeyFlow.js`](../js/pages/flows/journeyFlow.js) and both roles comboboxes
load behind a `setStatus("…")` that step 3 already lit. Two rows without a label
([`addUsers.js`](../js/pages/users/directRouting/addUsers.js) and
[`audit/search.js`](../js/pages/audit/search.js)) take the throbber beside the
control itself.

**Step 6** also caught three status setters the §4.1 sweep missed, because they
are not called `setStatus`: `setFormStatus` in
[`schedulePanel.js`](../js/components/schedulePanel.js) and `setModalMsg` /
`setDefaultMsg` in
[`createEditMapping.js`](../js/pages/wrapupCodes/createEditMapping.js). The last
two write a bare type class rather than a BEM modifier, so they pass no base
class and keep managing `className` themselves.

**Step 7 did not consolidate the seven progress-bar families.** The rename would
have touched thirty-six files' markup for no user-visible change, and
`.progress-bar--indeterminate` composes with any of the seven as it stands. What
shipped is the part that matters: `setProgress(0)` now marks the bar
indeterminate and it travels until a real figure arrives, across 33 helpers, with
all 22 reset paths clearing the class again.
[`roles/search.js`](../js/pages/roles/search.js) and
[`hourlyInteracting.js`](../js/pages/roles/hourlyInteracting.js) already had
their own indeterminate state and were left alone — the second renders inside the
first, so it inherits that page's style block.

The indeterminate state was brought forward to
[`documentation/create.js`](../js/pages/export/documentation/create.js) in step 1,
where the bar crawled to 80 % over eight seconds and then held for the rest of a
~29 s run. Next to a working throbber that is actively misleading, so the invented
percentage went at the same time as the page gained its throbber.

Step 3 carries the whole §4.1 win and is the one to verify carefully. Of the 60
status lines, 52 took the one-line swap unchanged. The other eight, as built:

- [`testCases.js`](../js/pages/deployment/testCases.js) and
  [`flowOverview.js`](../js/pages/flows/flowOverview.js) — both state `busy`
  outright in a `(busy, msg)` argument order. **Adapted, not flipped**: each
  keeps its own two-line wrapper over the shared helper. Reversing 36 call sites
  between them would have bought only cosmetic consistency, and a mis-transcribed
  site fails silently — a message rendered as a `type`, or a dropped `busy`.
- [`deleteFlow.js`](../js/pages/flows/deleteFlow.js) — already
  `(msg, type, spinner)`. Kept explicit rather than switched to inference: every
  busy state on that page already flags itself, so inference would add only risk.
- [`requests.js`](../js/pages/requests.js),
  [`getLists.js`](../js/pages/utilities/getLists.js),
  [`permissionCatalog.js`](../js/pages/utilities/permissionCatalog.js),
  [`interactions/totals.js`](../js/pages/export/interactions/totals.js) — these
  also toggle `$status.style.display`; each keeps a wrapper that preserves it.
- [`subjectRequest.js`](../js/pages/gdpr/subjectRequest.js) — the one page whose
  type argument defaulted to something (`level = "info"`) rather than to nothing.
  `te-status--info` is unstyled, so nothing rendered differently either way, but
  the wrapper keeps the intent.

`function setStatus` is hoisted and `const setStatus` is not, so every file was
checked for a call that runs before the new declaration. Five call earlier in the
file, all from within handlers invoked later — including three passed to
`createMultiSelect`, which fires `onChange` only from DOM listeners, never during
construction. No page needed the declaration moved.

## 12. Out of scope

- **Skeleton loaders.** A throbber answers "is it alive". Skeletons answer
  "what will appear here", which is a different and larger piece of work.
- **Cancellation.** Several long runs already have a Cancel button; giving
  every throbber one is not part of this.
- **Timeout handling.** A throbber that has spun for four minutes is still
  lying. The `/api` cap is 45 seconds, so a companion change — surfacing a
  timeout as an error rather than an eternal throbber — is worth its own note,
  but it is not this document.

## 13. Rejected alternatives

**A global throbber in the app header**, active whenever any request is
outstanding, as a backstop for work the per-page pass misses. Rejected. Two
indicators for the same fact compete for attention, and the one that is always
somewhere in the corner is the one the eye learns to filter out — which then
costs the local throbber its meaning as well. The whole value of a throbber is
that its motion is *specific* to the thing the user is waiting for. Coverage is
better bought by finishing the rollout in §11 than by a catch-all that dilutes
every throbber it sits above.

**Suppressing short-lived throbbers everywhere.** Applied to the router only
(§9), not to status lines. On a status line the text is changing anyway, so the
throbber costs no extra visual event; suppressing it there would introduce a
gap where a fast step looks different from a slow one for no gain.
