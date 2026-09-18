# Colour Tokens — Design

Status: **Implemented** — all seven steps of §11 done; Phase 2 (the recolour) is the user's
Author: Genesys Admin App
Last updated: 2026-09-16

## 1. Purpose

**No hard-coded colours anywhere in the app. Every colour derives from one
single place.**

That is the whole requirement, and it is stated that bluntly because the
current state is the opposite of it. A recolour of light mode — the thing that
prompted this — is today a hunt through some 1,600 literal values in 70 files,
and it would be the same hunt again the next time. The user wants to change a
lot of the light palette, and wants that to be an edit to one file.

Three things follow from "one place" that are worth stating up front:

- **Both modes live there**, side by side. Light mode stops being a set of
  patches on dark and becomes the second column of one table.
- **Every page switches.** Twelve pages currently render their dark colours
  in light mode because their own style blocks never had a light override.
  That is an error, not a choice, and it is fixed as a consequence of the
  refactor rather than as extra work.
- **It has to stay true.** The 24 light-mode patch blocks in the stylesheet
  are what "one place" turns into without a guard, one feature at a time. So
  the guard is part of the design, not an afterthought.

## 2. Confirmed decisions

- **One file, `css/tokens.css`**, holding every colour in the app in both
  modes and nothing else (§4). Loaded before `styles.css`.
- **Semantic tokens, flat.** `--danger`, not `--red-400`. No palette tier
  underneath: it would be one more layer between the user and the value they
  are there to edit.
- **Attribute-driven theming, not `prefers-color-scheme` in CSS** (§5). A
  manual theme switch is coming next, and a media-query design would have to
  be restructured for it. Each light value therefore exists exactly once, under
  `:root[data-theme="light"]`. A three-line script in `<head>` sets the
  attribute from the OS preference at boot; the switch later just overrides it.
- **The Flow Overview canvas keeps its own palette** (§8). It has three
  backgrounds — dark, light, white — chosen by the user from a selector on the
  page, deliberately independent of the app theme: the diagram is easiest to
  read dark, and the user switches it to light only before exporting a PDF. That
  stays. Its colours still come from `tokens.css`, resolved at draw time.
- **Phase 1 is a pure refactor** (§10): dark looks the same, light looks the
  same where it was already patched and *corrected* where it was not. Phase 2 —
  the actual recolour — is the user editing one block of one file.
- **A colour check runs in CI** (§9). Zero literals outside `tokens.css` is the
  only passing result.
- **The nine merges in §6.1 are approved** as listed. Every one folds a one-off
  or near-duplicate shade into its family's main value.
- **The four light values with no current source land as placeholders** — the
  proposed Tailwind-600 shades — so Phase 1 passes the check and nothing is
  pink-on-white. They are tuned in Phase 2 with everything else.
- **`--tag-purple` and `--tag-teal` stay** as named tokens. They mean "a distinct
  category", not ok/warn/danger, and a name keeps that meaning.
- **The five one-offs fold into their nearest family** — pink → `--danger`,
  dark magenta → `--tag-purple`, dark teal → `--tag-teal`. Ten uses, no new
  tokens, nothing left outside the set.
- **Excel and PDF document palettes are out of scope** here (§12). They must
  *not* follow the app theme, but they should also be one file. Parked.
- **The manual theme switch UI is out of scope** here (§12). The mechanism it
  needs is laid by §5; the control and where it lives is the next
  conversation.

## 3. What exists today

### 3.1 The tokens that exist

Seven, all neutral, defined at [`styles.css:6`](../css/styles.css) with a light
override at line 1656: `--bg`, `--panel`, `--panel-2`, `--text`, `--muted`,
`--border`, `--shadow`. Used 518 times. This part works.

`--accent` is referenced 20 times as `var(--accent, #3b82f6)` and **defined
nowhere** — every use runs on its fallback.

### 3.2 Everything else

| Where | `var()` | hex | rgb/rgba | distinct hex |
|---|---|---|---|---|
| `styles.css`, dark default | 540 | 329 | 289 | 50 |
| `styles.css`, 24 light patches | 12 | 135 | 149 | 40 |
| 13 page `<style>` blocks + templates (JS) | 578 | 367 | 159 | — |
| inline `style="…color:…"` attributes (JS) | 128 | 51 | — | — |
| `download.html` | 0 | 6 | — | — | |

The 81 distinct hex values in the stylesheet are Tailwind shades and fall into
four families with no name — blue, red, green, amber — plus a scattering of
one-offs. Dark uses the 400-shades consistently (`#f87171` ×66, `#3b82f6` ×40,
`#34d399` ×33, `#fbbf24` ×17); light patches use 600/700-shades chosen rule by
rule. **Dark is the authored mode and is coherent; light is the derived mode
and is not.**

**79 surfaces** use `rgba(255,255,255,0.0x)` — dark's idiom for "slightly
lighter than the panel". None of these are inside a light block; each needs its
own selector override in light, and only some have one.

**41 hex values exist only in dark** and are never overridden in any light
block. The consequential one is `#f87171`: 66 uses, overridden to `#dc2626` in
17 places, leaving roughly 49 error and warning states rendering pale pink on
white.

**12 of the 13 page style blocks have no light override.** Only
[`testCases.js`](../js/pages/deployment/testCases.js) does it right — it scopes
its own tokens and flips them under a light media query. The other twelve
(Flow Overview 60 colours, Roles Create 67, Roles Compare 52, Journey Flow 38,
Roles Search 33, …) render dark values in light mode.

**51 inline `style="color:#…"` attributes** are literals. An inline style is
unreachable by any media query, so these are locked in both modes.

### 3.3 The diagram canvases

[Flow Overview](../js/pages/flows/flowOverview.js) draws its flow to SVG and,
for PDF export, rasterises through a `<canvas>` — and a 2D canvas context cannot
read a CSS variable. That is why its palette is a JS object of literals:
`THEMES = { dark, light, white }`, nine neutrals each, plus four accents
(jump, dependency, selection, start) and thirteen per-action-kind colours in
[`flowModel.js`](../js/lib/flowModel.js) that "read on any background". The
`Background` selector on the page picks the variant; `tc()` returns it at draw
time. Journey Flow has a smaller equivalent.

This is the one place where literals had a reason. The reason is real; the
answer is to resolve tokens to literals at draw time, not to leave them in JS
(§8).

## 4. The one place: `css/tokens.css`

Two blocks. Nothing else in the file. **Twenty-three tokens** as shipped:

```css
:root {                                   /* dark — the default */
  color-scheme: dark;
  --bg  --panel  --panel-2  --text  --muted  --text-inverse  --border  --shadow
  --lift       #ffffff   /* base for "slightly lighter than the panel" surfaces */
  --backdrop   #000000   /* base for scrims and insets */
  --accent  --accent-strong  --accent-quiet
  --ok      --ok-strong      --ok-quiet
  --warn    --warn-strong    --warn-quiet
  --danger  --danger-strong  --danger-quiet
  --tag-purple  --tag-teal
}
:root[data-theme="light"] { color-scheme: light; /* the same 23, light values */ }
```

Every dark value is the value the app used before; every light value is the
value the deleted light patches used, except the four `-quiet` placeholders.

**Tints and borders are not tokens.** The first draft of this design had
`--accent-tint`, `--accent-border` and so on, one pre-mixed alpha per family.
Building the sweep showed why that cannot meet §10's "dark looks the same":
the stylesheet uses *forty-odd* distinct alphas — blue backgrounds alone at
0.06, 0.10, 0.12, 0.15, 0.16, 0.18, 0.22 and 0.26 — and collapsing them to
two per family would have changed every hover state in dark. So an alpha
variant is **derived from its base token at draw time**:

```css
background: color-mix(in srgb, var(--accent-strong) 12%, transparent);
```

The alpha is a number, not a colour; the colour is the token. Dark stays
exact, and in light the tint follows the light hue automatically. The eight
tint/border tokens were removed rather than left unreferenced in the one
file that is supposed to hold nothing dead.

`--lift` and `--backdrop` exist for the same reason. The 79 "slightly lighter"
surfaces were `rgba(255,255,255,0.0x)` — white at a low alpha — and a light
page needs them *black* at that alpha. `--lift` is white in dark and black in
light, and every such surface is `color-mix(in srgb, var(--lift) 6%,
transparent)`. Scrims and insets are the same shape on `--backdrop`, which is
opaque black in both modes.

## 5. Choosing the theme

No `@media (prefers-color-scheme)` anywhere in CSS. The attribute decides, and a
script ahead of the stylesheets — `js/theme.js`, shared by `index.html` and
`download.html` — sets it, so there is no flash of the wrong theme:

```html
<script>
  (function () {
    var saved = null;
    try { saved = localStorage.getItem("theme"); } catch (e) {}
    document.documentElement.dataset.theme =
      saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  })();
</script>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/styles.css">
```

Behaviour today: nothing writes `localStorage.theme`, so the OS decides, exactly
as now. A small listener on the media query keeps following the OS if it
changes while the app is open — but only while there is no saved preference.

Behaviour once the manual switch exists: it writes `theme`, sets the attribute,
and the OS is no longer consulted. That is the entire mechanism; the UI is the
next conversation.

`color-scheme` is carried in the token blocks because it is what makes the
browser draw scrollbars, `<select>` popups and date pickers in the right mode. A
manual switch that left those dark on a white page would look broken.

## 6. The sweep

Worked by family, not by file — every `#f87171` in the app becomes
`var(--danger)` in one pass, wherever it is.

### 6.1 The merge table

Dark uses 50 distinct hex values; the token set has 33. Some values merge. Most
of these are drift — two shades of the same intent — but none are silent: every
merge is listed here for approval, and any can be split back out into its own
token.

**Blue → `--accent` family** (282 uses)

| Today | Uses | Becomes | Note |
|---|---|---|---|
| `#60a5fa` | 49 | `--accent` | |
| `#3b82f6` | 80 | `--accent-strong` | |
| `#93c5fd` | 50 | `--accent-quiet` | |
| `#4c8dff` | 15 | `--accent` | *merge* — a one-off shade, visually between the two |
| `#9dc1ff` | 5 | `--accent-quiet` | *merge* | |
| `#a5b4fc` | 2 | `--accent-quiet` | *merge* — indigo-300, on blue |
| `#2563eb` `#1d4ed8` | 40 | light values of the above | absorbed by the light block |

**Red → `--danger` family** (170 uses)

| Today | Uses | Becomes | Note |
|---|---|---|---|
| `#f87171` | 102 | `--danger` | |
| `#ef4444` | 6 | `--danger-strong` | |
| `#fca5a5` | 5 | `--danger-quiet` | |
| `#d9534f` `#ff8a8a` `#ff8b87` | 6 | `--danger` | *merge* — three near-identical one-offs |
| `#dc2626` `#b91c1c` `#b42318` `#b3261e` | 30 | light values | absorbed |

**Green → `--ok` family** (125 uses)

| Today | Uses | Becomes | Note |
|---|---|---|---|
| `#34d399` | 42 | `--ok` | emerald-400 |
| `#4ade80` | 24 | `--ok` | *merge* — green-400; the two are used for the same thing |
| `#58c4a0` `#7ddda1` `#7ee2a8` | 15 | `--ok` | *merge* — one-offs |
| `#22c55e` | 3 | `--ok-strong` | |
| `#86efac` `#6ee7b7` | 10 | `--ok-quiet` | |
| `#16a34a` `#15803d` `#1a7f45` `#14805e` | 21 | light values | absorbed |

**Amber → `--warn` family** (116 uses)

| Today | Uses | Becomes | Note |
|---|---|---|---|
| `#fbbf24` | 41 | `--warn` | |
| `#f59e0b` `#f0b429` | 24 | `--warn-strong` | |
| `#e0a34a` `#e8bf6a` | 10 | `--warn` | *merge* — muddier one-offs |
| `#ffd28a` | 4 | `--warn-quiet` | | |
| `#fb923c` | 3 | `--warn-strong` | *merge* — orange-400 |
| `#b45309` `#8a5a00` `#92400e` `#c2410c` | 25 | light values | absorbed |

**Neutrals**

| Today | Uses | Becomes |
|---|---|---|
| `#fff` `#ffffff` | 21 | `--text-inverse` |
| `#6b7280` | 12 | `--muted` (it is gray-500 — muted text in JS templates) |
| `rgba(255,255,255,0.06)` and friends | 79 | `--surface-hover` / `--surface-raised` by alpha |
| `rgba(0,0,0,0.5–0.6)` | ~12 | `--backdrop` |
| `#e0e0e0` `#444` `#888` `#999` `#ddd` | 8 | `--muted` or `--border` by use — reviewed individually |

**One-offs** — `#c084fc` and `#2dd4bf` become `--tag-purple` and `--tag-teal`.
The remaining five (`#ffb3f0`, `#933a86`, `#128274` and two others; ten uses)
fold into the nearest family: pink → `--danger`, dark magenta → `--tag-purple`,
dark teal → `--tag-teal`. Decided, not guessed.

Alpha variants are not collapsed. Each becomes `color-mix(in srgb,
var(--base) N%, transparent)` at its own alpha, so `rgba(59,130,246,0.18)` and
`rgba(59,130,246,0.10)` stay two different intensities of the same token (§4).

The inventory contains a few false positives — `#334`, `#9998`, `#10005` — which
are ID-like strings in templates, not colours. The sweep script excludes them by
context and they are not counted above.

### 6.2 What happens to the 24 light blocks

They are deleted in full. Checked, not assumed: the 24 blocks hold 196 rules
and 291 declarations, and **every one of the 291 is a colour** — `background`
×130, `color` ×107, `border-color` ×43, the six token overrides, and
`color-scheme`. There is nothing in them that is not a colour, so there is
nothing to move out and keep. Once the tokens carry the light values, the
blocks say nothing the tokens do not.

The one declaration that survives is `color-scheme: light`, which moves into
`tokens.css` (§5).

### 6.3 `var(--accent, #3b82f6)` fallbacks

Twenty of these. Worth recording what step 1 did to them: defining
`--accent` (as `#60a5fa`) meant the fallback `#3b82f6` stopped firing, so
fifteen checkboxes, radios and the block throbber silently shifted to the
lighter blue between step 1 and step 3. The sweep maps each by the value its
fallback *used* to produce — `var(--accent, #3b82f6)` → `var(--accent-strong)`,
`var(--accent, #60a5fa)` → `var(--accent)` — which puts the original back.
A fallback whose token now exists (`var(--panel-2, #1e2433)`) loses the
literal; one whose token never existed (`--panel-3`, `--success`) is
re-pointed at the token that means the same thing.

## 7. The JavaScript side

**Page `<style>` blocks (13).** Same sweep. The twelve that have no light
override get one for free, because tokens carry it. `testCases.js`, which
already does this correctly with its own `--tc-high` / `--tc-med`, is folded
onto the shared tokens — its private ones were `--ok` and `--warn` under another
name.

**Inline `style="color:…"` (51 literals).** Become `var(--…)`. Inline styles
resolve variables perfectly well — the other 128 already do. The problem was
only ever the literal.

**Colour constants in templates** (`const MUTED = "var(--muted)"` and the like
in several pages). Already tokens; unchanged.

**The `.spin` throbber** uses `var(--border)` / `var(--text)` and `--spin-color`
overrides. Already compliant.

## 8. The diagram canvases

Flow Overview's canvas needs literal values at draw time — the 2D canvas used
for PDF rasterising cannot read a variable, and the standalone SVG it builds for
export must render outside the app. The requirement is still "from one place";
what changes is *when* the value is resolved.

The palette moves into `tokens.css` as scoped blocks, one per background
variant, on the layout element's own attribute (`.fo-layout[data-canvas]`) —
**not** on `<html>`, because the canvas theme is independent of the app theme
by design:

```css
.fo-layout[data-canvas="dark"]  { --fo-bg: #0d1117; --fo-node: #161b22; --fo-stroke: #30363d;
                                  --fo-text: #c9d1d9; --fo-subtext: #8b949e; … }
.fo-layout[data-canvas="light"] { --fo-bg: #f6f8fa; --fo-node: #ffffff; … }
.fo-layout[data-canvas="white"] { --fo-bg: #ffffff; … }

/* theme-independent: read on any background */
:root { --fo-jump: #8957e5; --fo-dep: #2c8a9a; --fo-select: #f0b429; --fo-start: #2ea043;
        --kind-task: #6e7681; --kind-decision: #4a6fa5; … /* 13 action kinds */ }
```

The `Background` selector sets `data-canvas` on the layout element. A small
reader — `resolveTokens(names, { className, attrs })` in `utils.js` — reads
each token off a throwaway probe carrying that class and attribute, so it works
whether or not the page is attached yet, and returns the same
`{ bg, nodeFill, … }` object `tc()` returned before, cached per background. Nothing downstream changes:
SVG attributes, the canvas `fillStyle`, the standalone export all receive the
same literal strings they receive now, only sourced from the stylesheet at the
moment of drawing.

The thirteen per-action-kind colours in `flowModel.js` follow the same route:
`ACTION_KINDS` keeps a `color` field but its value becomes a token name, and
`kindColor()` resolves it through the reader.

Journey Flow is live SVG only — nothing rasterised, nothing exported — so it
needs no resolver: `var()` and `color-mix()` go straight into its `fill` and
`stroke` attributes. Its strokes derive from its fills, and three of its fills
are the same colours as action kinds and share those tokens. Its canvas already
followed `--bg` and still does.

In fullscreen the whole Flow Overview layout paints from the canvas palette —
background, and the app tokens re-pointed at their canvas equivalents — so the
side panel and tabs follow the `Background` selector rather than the app
theme. Outside fullscreen the page chrome follows the app.

The default background stays **dark**, as it is now — the diagram is easiest to
read dark, and the user switches to light only before exporting. That is a
deliberate per-page choice and is not changed by the app theme.

## 9. The colour check

`scripts/check-colours.mjs`. It scans `css/`, `js/` (excluding `js/lib/`
vendor bundles), `index.html` and `download.html` for any hex, `rgb()`, `rgba()`,
`hsl()` or CSS named colour, and reports every one found outside
`css/tokens.css`. Exit code 1 if the count is not zero.

It runs as a step in the Static Web Apps workflow ahead of the deploy, so a
literal that gets past review does not get deployed. It also runs locally in a
few milliseconds, so nobody has to wait for CI to find out.

Why this is part of the design and not a nice-to-have: the 24 light patches are
what "one place" turns into without it. Every one was reasonable at the time.

## 10. Phase 1 and Phase 2

**Phase 1 — the refactor.** Tokens hold today's values. Acceptance is:

- The colour check reports **zero**.
- Dark looks the same as today, save for the merges in §6.1, each of which the
  user has seen and approved.
- Light looks the same as today wherever a light patch existed, and *better*
  where one did not — the twelve dark-only pages now switch, and the pale-pink
  error states are red.
- All 13 page style blocks switch with the attribute. Any page that does not is
  a defect.
- The Flow Overview `Background` selector still gives dark, light and white, and
  a PDF exported on each looks as it does today.

**Phase 2 — the recolour.** The user edits `:root[data-theme="light"]` in
`tokens.css`. No other file.

## 11. Rollout

| # | Step | Scope | State |
|---|---|---|---|
| 1 | `tokens.css` with today's values; head script; load order | 3 files | **done** |
| 2 | `check-colours.mjs`, reporting only (prints the count, does not fail) | 1 file | **done** |
| 3 | Sweep `styles.css` by family; delete the 24 light blocks | 1 file, 882 values | **done** |
| 4 | Sweep the page style blocks, inline attributes and JS strings | 32 files, 397 values | **done** |
| 5 | Canvas palettes → scoped tokens + runtime reader; `flowModel` kinds | 4 files, 115 values | **done** |
| 6 | `download.html` | 1 file, 6 values | **done** |
| 7 | Check switches to failing; added to the SWA workflow | 2 files | **done** |

Step 2 before step 3 on purpose: the count is the progress bar for the work,
and the check is how the last few hidden ones are found. It started at
**1,383**; step 3 took it to **501**. Widening the check to the app modules in
`js/lib/` (it had been skipping the whole directory, vendor bundles and ours
alike) found 17 more in `flowModel.js`, for an honest **518**. Step 4 took it
to **121**: the three diagram files and `download.html`, nothing else. Step 5
took it to **6** — all in `download.html`. Step 6 took it to **zero**, and
step 7 makes zero the only number the build accepts.

**Steps 6 and 7.** `download.html` is a standalone pop-up with its own inline
stylesheet, so it now loads `tokens.css` and follows the theme like the app
does. The theme script it needed is the same one `index.html` had inline;
rather than paste it into a second `<head>` it is one file, `js/theme.js`,
loaded as a plain script by both. The check runs `--strict` as a step in the
Static Web Apps workflow, before the deploy step, so a literal fails the build
rather than shipping; it was confirmed to exit 1 on a planted `#ff0000` and 0
without it. The production branch carries its own copy of that workflow and
gets the same step at the next merge.

**How step 5 was verified.** The three canvas palettes were resolved through
`resolveTokens` and compared with the old `THEMES` object value by value: 42
values, none different. All 18 action kinds resolve to their old colours.
Journey Flow's six node fills are exact; its strokes now derive as the fill
mixed a quarter toward `--backdrop`, and four of six land within two units of
the old hand-picked stroke — `Disconnect` and `TransferToAcd` sit about ten
units off on one channel, on a one-pixel outline. `var()` and `color-mix()`
were confirmed to compute inside SVG `fill` and `stroke` attributes. Then the
case worth the whole exercise: fullscreen on every combination of app theme
and canvas background. The first pass had dark text on a dark canvas when the
app was light — the layout re-tokened `--text`, but most of the panel
*inherits* `color`, already computed outside the layout — so the fullscreen
rule now sets `color` itself. All six combinations read correctly. One
regression was caught before it shipped: a `tc().start` inside the page
template ran before `state` existed; in a style block the token can simply be
`var(--fo-start)`.

**How step 4 was verified.** All 95 page modules mounted; every page style
block's 577 rules were applied to a live element under the old token set and
the new — both scoped side by side in one document, since toggling a `<link>`
makes Chrome re-fetch it and briefly read as no tokens at all — and 4,039
computed properties compared. Twenty-five distinct changes, every one an
approved merge or a derived value chosen on purpose: filled buttons whose
hover was a hand-picked darker shade now derive it (`color-mix` of the token
toward `--backdrop`), the two destructive-action buttons likewise, and the
`createEditMapping` toggle, which was painted light-on-dark with its own greys,
now uses `--muted`, `--backdrop` and `--text-inverse`. `app.js` styles the
security notice printed to the *devtools console*, where `var()` cannot
resolve; it now reads `--danger` and `--muted` from the live token sheet at
call time — still the one place, resolved a moment later. The two Excel
palette files are excluded from the check by name, with the reason.

**How step 3 was verified.** Every one of the stylesheet's 1,379 rules was
applied to a live element under the old stylesheet and again under the new,
in dark, and 16,548 computed colour properties compared. Fifty-six distinct
changes came out. Fifty-five are the approved merges of §6.1 — or those same
merges seen through a tint — with `#4ade80` → `--ok` the largest at 74
properties, exactly as listed. The fifty-sixth was the step-1 fallback shift
described in §6.3, which the sweep reverses. Nothing else moved. A first pass
of that comparison read declarations back from the CSSOM and reported one
amber border turning into the text colour; that was the probe, not the
stylesheet — a shorthand containing `var()` does not round-trip through
`cssText` — and a real element confirmed the border exact. The lesson is
recorded here because it will bite the next person too.

## 12. Parked, deliberately

**The manual theme switch** — decided and built after Phase 1; see §14.

**Excel and PDF document palettes.** A document's look must be fixed — a
workbook exported by a dark-mode user must not come out dark. So these do *not*
follow the tokens. But they are in seven files today, with 31 distinct colours,
and two copies of `excelStyles.js` (one server-side under `api/lib/`, one
browser-side under `js/utils/`) kept in step by hand. They should be one file.
That is its own piece of work and is not touched here.

## 13. Resolved questions

All four were put to the user on 2026-09-16 and answered; the answers are in §2.

1. The nine merges — **approved as listed.**
2. The four *proposed* light values — **placeholders**, tuned in Phase 2.
3. `--tag-purple` / `--tag-teal` — **kept** as named tokens.
4. The five one-offs — **folded** into the nearest family.

Nothing remains open. The design is complete and waits only on the go-ahead.

## 14. The manual switch

Decided on 2026-09-16, after the user had tested Phase 1, and built the same
day. Four questions, four answers:

- **Where:** the header, next to Refresh Token. It is a global setting, and the
  header is where the other global things are.
- **How many modes:** three — Dark, Light, System. System follows the OS, as the
  app always had, and keeps following it if it changes while the app is open.
  Once Dark or Light is chosen, System is how the OS gets a say again.
- **Remembered:** per browser, in `localStorage.theme`. System is the absence of
  a value. This is exactly the seam §5 laid; nothing else changed.
- **The control:** a single round button showing the icon of the mode that is
  *on* — moon, sun, or a monitor for System — cycling dark → light → system on
  click. The user asked for this rather than a select or a segmented control:
  the state is readable at a glance, and every click has a visible effect
  (a different theme, or at least a different icon). The tooltip spells it out:
  "Theme: System (following your OS — currently dark). Click for Dark."

`js/theme.js` owns all of it — the boot-time choice it already made, the
button, the cycle, the saved value — so the switch works on every page state,
including the sign-in gate, and `download.html` gets the theme without the
button. The button lives in `index.html` beside its neighbours and uses their
pill style, sized for an icon.

Verified: the cycle in all three states with icon, saved value, applied
attribute and tooltip agreeing at each step; a saved Light surviving a reload
against an OS that prefers dark, with the sun icon present from first paint;
`color-scheme` following.
