# Interactions › Search — filter bar redesign — Design

Status: **Proposed** — awaiting go-ahead. See §6.4 for the recommendation.
Author: Genesys Admin App
Last updated: 2026-08-22

Mockup: [mockups/interactions-search-redesign.html](mockups/interactions-search-redesign.html)
— static, uses the app's real `styles.css`, open it directly in a browser.

Findings on the same page's *behaviour* are separate:
[interactions-search-notes.md](interactions-search-notes.md).

## 1. Purpose

The page looks disordered, and it is worth being precise about why rather than
restyling by taste.

**Every control lives in one container.** `.is-controls` holds the date range,
four scope dropdowns and the whole participant-data block in a single flex
container, so the browser decides the grouping — and the grouping changes with
window width:

| Width | What happens |
|---|---|
| 1600px | One long row; participant data trails off to the right |
| 1440px | Division wraps down beside Participant Data Filter |
| 1100px | Direction/Media/Division on row 2, then the participant-data block breaks apart — **Exclude on one line, Multi-value on the next** |

Nothing on the page says which controls belong together, because at any given
width they do not. That is the whole of the problem; the rest below are smaller
things visible once it is fixed.

The `flex-wrap` itself is **not** the fault — other pages use the identical rule
without trouble by splitting their controls across several containers. See
§6.3, which is where the recommendation comes from.

## 2. Confirmed decisions

*(none yet — this document is the proposal)*

## 3. What changes, and what each change fixes

### 3.1 Three bands instead of one wrap row

**When** (dates + quick ranges), **Where** (queue, direction, media, division),
**Participant data**. Each band is its own grid row with a caption on the left.

Fixes the root cause: grouping stops depending on window width. The captions do
the real work — they name the question each row answers, which is what turns
three rows of controls into a form rather than a wall.

### 3.2 Quick ranges become a segmented control, beside the dates

Today they sit in a control group whose label is `&nbsp;` — a blank label used
purely to force baseline alignment with the fields next to it. The hack is
visible: four buttons floating under nothing, placed *before* the dates they are
shortcuts for.

They move next to Date from / Date to, joined into one segmented control, with a
real label. A selected range can then show as active, which it cannot today.

### 3.3 Exclude and Multi-value become one element

`.fb-options` holds both with `white-space: nowrap`, so wrapping cannot separate
them. This is the single worst artefact at 1100px and it is a one-line fix.

### 3.4 Two field widths, not five

Dates are 160px, participant-data key/value 140px, dropdowns size to content.
Nothing lines up. The proposal uses **160px** and **200px** only, so fields form
columns down the bands.

### 3.5 One Export menu instead of three buttons

"Export Interactions", "Export Selected Participant Data" and "Export All
Participant Data" are three long labels dominating the action row, and they push
Search — the primary action — to the far left of a very wide bar.

They collapse into `Export ▾` with three items. Search gets `btn--primary`
styling so the eye lands on it first.

### 3.6 The status line stands alone

The tip ("Right-click a row to copy the Conversation ID") and the status line are
both small grey text, stacked, visually identical. One is static help; the other
is live and carries the throbber. The tip moves to the results area; the status
keeps its own space.

### 3.7 One line gets deleted

> "Queue, Media, and Division filters are server-side. Participant Data is
> client-side."

Implementation detail surfaced as UI — and it becomes **wrong** if participant
data moves server-side, which
[interactions-search-notes.md](interactions-search-notes.md) §1 says it can. If
the distinction matters to a user it is really about speed, and should say so.

## 4. What was verified

Screenshots stopped working partway through, so the mockup's *geometry* was
measured rather than eyeballed. At 1280px and at 1100px — the width where the
current page breaks worst:

| Check | Result |
|---|---|
| Three bands, each its own row | ✅ |
| No band's fields interleaving with another's | ✅ |
| Exclude + Multi-value on one line | ✅ (1 row at both widths) |
| Distinct field widths | ✅ exactly two: 160, 200 |
| Horizontal page scroll | ✅ none |

**Not verified: how it looks.** Open the mockup and judge that yourself — the
measurements say the structure holds, not that the result is attractive.

## 5. Not in scope

- The results table, detail pane and distribution chart. The controls are what
  reads as messy; changing the table as well would make the diff unreviewable.
- Any behaviour change. This is layout and wording only. The server-side
  participant-data work in the notes doc is separate and can land before or
  after.

## 6. The decision this needs

**One-page tidy, or a shared component?**

Counted rather than assumed. Eight prefixes across roughly thirty pages:

| Prefix | Pages | Layout |
|---|---|---|
| `dt-` | 11 | **`flex-direction: column`** — stacked, no wrapping |
| `di-` | 10 | `flex-wrap` |
| `is-` | 3 | `flex-wrap` |
| `cs-` | 3 | `flex-wrap` |
| `wc-` | 2 | `flex-wrap` |
| `mi-` | 1 | `flex-wrap` |
| `rc-`, `rs-` | 2 | **no CSS at all** |

Five of them — `is-`, `di-`, `cs-`, `wc-`, `mi-` — are **byte-identical**:

```css
display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px;
```

Nineteen pages, one rule, copied five times under different names. The
`-control-group` half is likewise identical across all six that have CSS.

### 6.1 Two corrections to the argument above

**`dt-` already solves this.** Eleven pages — the largest family — stack their
controls in a column and never wrap, so they do not have the problem this
document is about. The band layout in §3.1 is therefore not a new invention; it
is close to what most of the app already does. That is a stronger argument for a
shared component than the one first written here, and it reframes the question:
not "invent a pattern" but "**which of the two existing patterns wins**".

**`rc-` and `rs-` have no CSS whatsoever.** `roles/compare.js` (8 control
groups) and `roles/search.js` (5) use classes that appear nowhere in
`styles.css`, so those pages fall back to default block flow. Unrelated to this
redesign and worth its own look.

### 6.2 Where it would actually pay

Density is what makes wrapping bite — two controls wrap harmlessly. The wrapping
pages with enough controls to look disordered:

| Page | Control groups |
|---|---|
| `interactions/disconnect.js` | 9 |
| `interactions/search.js` | 8 |
| `audit/search.js` | 8 |
| `interactions/transcripts/search.js` | 7 |
| `interactions/searchRecent.js` | 6 |
| `admin/activityLog.js` | 6 |

**Six pages, not thirty** — and three of them (`is-`) are near-identical search
forms that would convert almost mechanically. The dense `dt-` pages
(`dataactions/edit.js` at 16 groups, `datatables/edit.js` at 12) need nothing;
they already stack.

### 6.3 The class was never the problem — the usage was

Disconnect was rendered before settling this, and it is **already tidy** despite
being the densest wrapping page. The reason changes the recommendation:

| Page | Control groups | Containers |
|---|---|---|
| `interactions/disconnect.js` | 9 | **7** |
| `audit/search.js` | 8 | 2 |
| `interactions/search.js` | 8 | **1** |
| `interactions/transcripts/search.js` | 7 | **1** |
| `interactions/searchRecent.js` | 6 | **1** |
| `admin/activityLog.js` | 6 | **0** |

Disconnect splits its controls across **seven** `.di-controls` containers — Mode,
the mode-specific input, Media Types, the address block, the dates, the actions.
It already has de-facto bands; it simply does not caption them. Search puts all
eight groups in **one** container and leaves the grouping to the browser.

**Same CSS rule, opposite outcome, depending on whether a page splits its rows.**
Which means §1's diagnosis was right about the symptom and wrong about the cause:
`flex-wrap` is not at fault, one container holding everything is.

Worth noting Disconnect landed in that shape by accident rather than judgement —
the address block added on 2026-08-21 went in as its own container because that
was the convenient place to put it, not because anyone chose bands.

### 6.4 Recommendation

**Search first, as a container split rather than a component.** Three
containers — When, Where, Participant data — fixes the wrap-soup and the
Exclude/Multi-value split, and needs no new prefix, no new CSS, and no decision
about the other five pages.

Then look at the refinements — band captions, the two-width scale, the segmented
quick-ranges, the Export menu — with a working page in front of you instead of a
mockup, and extract `fb-*` only if they prove worth generalising.

This supersedes the earlier recommendation in this section, which was to build
`fb-*` as a shared component up front. That was argued from a CSS-prefix count
without checking how the pages actually used the class. The count was real; the
conclusion drawn from it was not.

§3's individual changes all still stand — they are just no longer bundled with
a decision about the app's component strategy.

It remains a call about where the app is going rather than about this page.

## 7. Build order

Once §6 is settled:

1. **Split `.is-controls` into three containers** — When, Where, Participant
   data. Markup only; no new CSS, no new prefix. This is the fix for §1 and
   §3.3 on its own, and is worth reviewing before anything else is added.
2. **The refinements, judged on the split page**: band captions, the two-width
   scale, the segmented quick-ranges. Each is optional and separable.
3. **Actions row** — primary Search, Export menu, tip relocated.
4. **Delete the server-side/client-side hint** (§3.7).
5. **Check the other breakpoints** at 1600/1440/1280/1100/980, and in light mode
   — the mockup has only been measured in dark.
6. **Release note** — one entry; this is customer-visible, as Search is not on
   `CUSTOMER_EXCLUDED_KEYS`.

Steps 1 and 2 are the whole visible change and can be reviewed together.
