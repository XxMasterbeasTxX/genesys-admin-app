# STA License — who can trigger a Speech & Text Analytics licence

**Status: DESIGN — not built. Awaiting go-ahead. No open questions: every data
and behavioural question is answered from three live orgs (§3).**

A fourth mode under **Roles › Permissions vs. Users**, beside Permission Search,
Hourly Interacting and WEM License. Same question as WEM, different add-on: who
holds a role carrying a permission that triggers an STA licence, which role did
it, and whether an STA licence is actually assigned to them.

---

## 1. Why this is small

The WEM page was written against the licence API in general, not against WEM.
Reading [`wemLicense.js`](../js/pages/roles/wemLicense.js) end to end, the whole
983-line pipeline keys off exactly one variable — `wemLicenseIds`, a plain array
of licence id strings, set once at load:

```js
wemLicenseIds = listedDefs
  .filter((d) => WEM_HINT.test(d.id || "") || WEM_HINT.test(d.description || ""))
  .map((d) => d.id);
```

Everything after that is licence-agnostic and needs no change:

| Concern | Where | WEM-specific? |
|---|---|---|
| Batched role inference (`/license/infer`) | `:630` | No — filters inferred ids against the list |
| Assigned licences (`/license/users`) | `:587`, `:649` | No — same filter |
| Per-licence permission subtraction | `wemOnlyPermissions()` `:166` | No — takes the id list as an argument |
| Wildcard-aware permission matching | `buildPermissionIndex()` `:204` | No |
| Source attribution (direct vs. group) | `buildSourceLabel()` `:259` | No |
| Filters, sort, Roles view, export | `:470`+ | No |
| Categories | `categorise()` `:308` | No — infer applies licence precedence itself (§3.4) |

The licence-specific surface is five things: the hint regex, the
bundled-from-tier constant, the on-screen copy, the DOM id prefix and the export
column label. The category model looked like a sixth — WEM outranks STA, so a
WEM-covered user might have been miscounted as a gap — but `/license/infer`
applies that precedence before the page ever sees it (§3.4). Nothing else
differs.

---

## 2. The choice: parameterise or duplicate

**Option A — copy `wemLicense.js` to `staLicense.js`.** Fast, zero risk to the
shipped WEM tab, and wrong. It duplicates 983 lines including
`wemOnlyPermissions()`, whose per-licence subtraction was subtly wrong until
`fcc6b54` — an org holding two SKUs had one licence's prerequisites cancel the
other's triggers. That class of bug is invisible until a specific org shape hits
it, and a copy guarantees the next such fix lands in one file and not the other.

**Option B — parameterise (recommended).** Extract the page into
`js/pages/roles/addonLicense.js`, taking a descriptor:

```js
const WEM = {
  key: "wem",
  label: "WEM License",
  name: "WEM",
  hint: /wem|workforce\s*engagement/i,
  bundledFromTier: 3,
  domPrefix: "wem",
  filePrefix: "WEM_License",
};

const STA = {
  key: "sta",
  label: "STA License",
  name: "STA",
  hint: /STAupgrade|speech\s*(and|&)?\s*text/i,   // see §3.1
  bundledFromTier: 3,
  domPrefix: "sta",
  filePrefix: "STA_License",
};
```

The two descriptors differ only in the hint, the labels and the prefixes —
`/license/infer` handles precedence itself (§3.4), so there is no third category
and no precedence field. The extraction is therefore mechanical.

`wemLicense.js` and `staLicense.js` become thin modules exporting
`renderWemContent` / `renderStaContent` bound to their descriptor, so
`search.js` and every doc reference keep working unchanged.

**The risk of B is real:** it rewrites shipped, production-tested code to add a
feature that does not require rewriting it. Mitigation: the extraction must be
*behaviour-preserving* — no improvements smuggled in — and the WEM pass (40
cases, green) is re-run in full before STA is wired up. If a WEM case regresses,
the refactor is wrong, not the test.

**Recommendation: B**, as two commits — the behaviour-preserving extraction with
WEM re-tested, then STA as a second descriptor. A bisect can then tell them
apart.

---

## 3. What the live data says

Measured 2026-09-04 from **Permissions vs. Licenses** exports for three orgs —
**3C Retail** (cloudCX2 with a WEM trial), **Milestone** (cloudCX2, no trial)
and **Demo** (cloudCX3) — plus a per-role `/license/infer` scan of the first two.

### 3.1 The licence id — and why the obvious hint fails

The STA add-on is **`gcSTAupgrade`**, carrying **23 permissions** on 3C Retail.

The natural hint `/sta\b/i` **does not match it**. `gcSTAupgrade` has no word
boundary after `STA` — the next character is `u` — so the regex fails, the
filter returns empty, and the page reports *"This org has no STA add-on"*. That
is indistinguishable on screen from a true negative, so the bug would have
looked like a working feature. Verified against every licence id seen across
both orgs:

| Candidate | Matches |
|---|---|
| `/sta\b/i` | **nothing** |
| `/sta/i` | `gcSTAupgrade` — but too loose against `description` (any "standard", "status", "installed") |
| `/STAupgrade\|speech\s*(and\|&)?\s*text/i` | `gcSTAupgrade` — **use this** |

Only one non-CX3 org was sampled, so whether Genesys also ships tier-paired
variants (`gc1STAupgrade`) the way WEM has `gc1WEMupgrade`/`gc2WEMupgrade` is
unconfirmed. `/STAupgrade/i` matches those too, so the hint is safe either way.

### 3.2 Bundling: same as WEM, `bundledFromTier: 3`

Three orgs, sampled 2026-09-04, make a clean natural experiment:

| Org | Tier | `gc2WEMupgrade` | `gcSTAupgrade` |
|---|---|---|---|
| 3C Retail | cloudCX2 **+ WEM trial** | yes | yes |
| Milestone | cloudCX2, no trial | **no** | yes |
| Demo | cloudCX3 | no | no |

Two things fall out of the middle row, which is the informative one:

**STA is standard on CX2.** Both CX2 orgs list `gcSTAupgrade`, including the one
with no trial of anything, and the permission set is byte-identical across them
— 23 permissions, same 23. So a licence definition's *content* is Genesys-wide;
only *which* definitions come back is org-specific.

**The WEM SKU tracks what the org actually holds, trial included.** Milestone is
CX2 with no WEM trial and has no `gc2WEMupgrade` at all, where 3C on the same
tier does. So `/license/definitions` reflects current entitlement rather than
tier eligibility — which is what both tabs already assume when they treat an
absent SKU as "nobody here can hold this".

`gcSTAupgrade` is absent on CX3 exactly as `gc2WEMupgrade` is, and Genesys
documents why: *"Speech and text analytics features are included as part of the
Genesys Cloud CX 1 WEM Add-on II or Genesys Cloud CX 2 WEM Add-on I, and Genesys
Cloud CX 3 license."* So the CX3 empty state ("this base licence includes it")
is correct for STA, and the descriptor takes `bundledFromTier: 3`.

### 3.3 WEM outranks STA — the rule, and why it looked like a problem

**19 of the 23 STA permissions are also in `gc2WEMupgrade`.** Every
`speechAndTextAnalytics:*` permission sits in both. Only four are STA-only:

- `billing:user:staUpgrade` — the explicit trigger, the STA analogue of
  `billing:user:hourlyInteracting`
- `routing:transcriptionSettings:add` / `:edit` / `:view`

And Genesys applies a precedence rule, quoted from
[the STA add-on article](https://help.genesys.cloud/articles/add-speech-and-text-analytics-upgrade-add-on-to-your-organization/):

> "each user can be assigned only one add-on at a time"

> "Because the WEM add-on includes a broader set of features, it takes
> precedence over the STA add-on."

**But `/license/infer` applies the rule itself** — measured 2026-09-04, and it
removes the problem rather than creating one.

### 3.4 Measured: infer applies precedence, so there is no third category

Every role on 3C Retail and Milestone was scanned for the 23 STA permissions and
its inference read back. The decisive evidence is a controlled pair: the role
**`Speech and Text Analytics Admin`** exists on both orgs with an identical
profile — 3 STA-only permissions, 25 shared.

| Org | WEM holdable? | `Speech and Text Analytics Admin` infers |
|---|---|---|
| 3C Retail | yes (trial) | `collaboratePro`, **`gc2WEMupgrade`** |
| Milestone | no | `collaboratePro`, **`gcSTAupgrade`** |

Same role, same permissions, different licence. The only variable is whether WEM
is holdable on the org. Supporting counts:

- On 3C, **`gcSTAupgrade` is inferred by no role at all** — 0 of the 23 roles
  holding STA permissions, including `# Speech and Text Analytics` which carries
  all four STA-only permissions and 31 shared ones. It infers `gc2WEMupgrade`.
- On Milestone, `gcSTAupgrade` is inferred by 6 roles. `# STA Upgrade` carries
  exactly one STA-only permission and nothing shared, and infers STA — so infer
  emits STA readily when nothing outranks it.

**Consequence: the port is faithful after all.** Because infer never returns STA
where WEM is holdable, a WEM-covered user never enters the STA tab — infer says
they trigger WEM, and the tab only ever sees what infer returns. There is no
false positive to guard against, so:

- **no `covered` category** — it could never populate
- **no `supersededBy` descriptor field** — nothing to configure
- STA keeps WEM's two categories, `licensed` and `gap`, unchanged

This also re-confirms the standing rule that `/license/infer` is the authority
and licence definitions only explain. A permission comparison of our own would
have reported 23 STA-triggering roles on 3C; infer reports none, and infer is
what Genesys bills from.

### 3.5 The empty STA tab on a two-SKU org — correct, and worth explaining

On 3C the STA tab will find **nobody**, because everyone who would trigger STA
triggers WEM instead. That is the right answer, but an empty table invites "is it
broken?". The page should say why: when the org holds a superseding add-on and
the result is empty, state it — *"This org also holds gc2WEMupgrade, which takes
precedence over STA, so Genesys assigns WEM instead."* Cheap, and it turns a
blank screen into an answer.

**A larger opportunity, deliberately not designed here.** 3C's STA exposure is
*masked* by the WEM trial. When that trial lapses, `gc2WEMupgrade` leaves the
definitions, and the 23 roles that currently infer WEM will begin inferring
`gcSTAupgrade` — turning today's invisible population into tomorrow's bill. A
"what would happen if this add-on lapsed" view would surface that, and this is
the org that proves the need. It is scope creep on the request as put, so it is
recorded here rather than built.

### 3.6 3C Retail's WEM is a TRIAL — read the measurements accordingly

As of 2026-09-04, 3C Retail has a **WEM trial** active. That makes it a
temporary fixture, so it matters which findings depend on it:

**Unaffected — these are properties of the licence definitions, which are
Genesys-wide, not org state:**

- the 23 permissions `gcSTAupgrade` carries
- the 19-of-23 overlap with `gc2WEMupgrade`
- the four STA-only permissions
- the hint regex, which is matched against ids and descriptions

**Affected — this depended on 3C currently holding both SKUs:**

- 3C as the two-SKU fixture proving precedence (§3.4). **The scan was run on
  2026-09-04, while the trial was live, so that finding is banked.** Had it
  lapsed first there was no other org to hand, and the design would have shipped
  a `covered` category it did not need.

**Resolved by Milestone (§3.2):** 3C's `gcSTAupgrade` is *not* a trial artefact.
Milestone is CX2 with no trial and carries the same 23-permission
`gcSTAupgrade`, so STA is standard at that tier. Only the WEM SKU is trial-
dependent at 3C.

**Consequence for the test pass:** 3C's role as "the org where the STA tab is
correctly empty" lasts only as long as the trial. Once it lapses, 3C becomes a
second Milestone — STA-only — and its 23 STA-permission roles start inferring
`gcSTAupgrade`. Re-run §7.1 against a fresh export rather than trusting a stale
expectation.

**Worth flagging to the customer, not to the code:** when the trial ends, every
user the WEM tab currently files as `licensed` becomes either a real charge or a
permission to strip. That is precisely the clean-up this feature was asked for,
and the useful moment to run it is *before* the trial lapses, not after the
first invoice.

### 3.7 The 2026-04-20 billing change — checked, and it validates the approach

Genesys changed STA billing effective **2026-04-20** (announced 2026-02-02):
*"This update decouples transcription usage from automatic license activation so
that billing is based on assigned permissions and actual usage."* It applies to
CX 1 and CX 2 only; CX 3 and CX 4 are unaffected — consistent with §3.2.

This was worth checking because a change to what triggers an add-on could have
invalidated the shipped WEM tab as well. It does not. What changed is that
**transcription usage** no longer auto-activates a licence — *"Transcription
usage alone no longer automatically triggers license charges"* — a route the app
never modelled. Permission-based triggering, which is what both tabs measure, is
still the model.

Better than that, the article's own permission list matches the licence
definition almost exactly. It names Routing > Transcription Settings
(view/add/edit), STA Settings (view/edit), Topic, Program, Category and Feedback
as billing automatically for administrators, plus **Billing > User > STA
Upgrade** as the explicit per-user upgrade. That is the same 23 permissions
`gcSTAupgrade` carries in the API, give or take a `category:publish` the article
lists and the API does not expose.

So the definition's permission set *is* the trigger set, documented and
measured agreeing. That is a stronger footing than the WEM page had when it
shipped, where the mapping was inferred from `/license/infer` alone.

---

## 4. Integration

Four small edits in [`search.js`](../js/pages/roles/search.js):

- a `<button class="rs-mode-btn" id="rsModeSta">STA License</button>` at `:193`
- a `<div id="rsStaSection" style="display:none"></div>` at `:238`
- a fourth entry in `MODES` at `:687`, lazy-importing `staLicense.js`
- nothing else — `activate()`, the denied-button handling and the first-allowed
  fallback all iterate `MODES` already

## 5. Gating

STA reads exactly the endpoints WEM reads — `/license/definitions`,
`/license/infer`, `/license/users` — so the required permissions are identical.
Add a sibling action rather than widening the existing one:

```js
"roles.search": {
  view: { all: ["authorization:role:view", "authorization:grant:view"] },
  wem:  ["authorization:grant:add", "authorization:license:view"],
  sta:  ["authorization:grant:add", "authorization:license:view"],
},
```

Duplicated on purpose. One action per tab is what the greyed-out mode buttons
already assume, and it stays right if the two ever diverge. This mirrors the
per-list decision in `utilities.getLists`.

## 6. Data questions — answered

| Question | Answer | Source |
|---|---|---|
| STA licence id | `gcSTAupgrade`, 23 permissions | 3C Retail export, 2026-09-04 |
| Tier-paired like WEM? | Not observed; single SKU. Hint covers both | one CX2 org sampled |
| Bundled at a CX tier? | Yes — absent on CX3, `bundledFromTier: 3` | Demo export + Genesys FAQ |
| Does WEM include STA? | Yes — 19 of 23 permissions shared | 3C Retail export + Genesys docs |

## 7. Test plan

### 7.1 The three orgs, and what each one proves

The sampling in §3.2 handed us a complete fixture set — each org isolates a
different branch, which is worth more than three similar orgs would be:

| Org | Shape | Proves |
|---|---|---|
| **3C Retail** | CX2, WEM **and** STA | The STA tab is **correctly empty** — infer gives everyone WEM (§3.4). The WEM tab carries the population. **Time-limited: the WEM SKU is a trial** |
| **Milestone** | CX2, STA only, no WEM | The real STA population — 6 roles infer `gcSTAupgrade`. This is the org the STA tab is *for* |
| **Demo** | CX3, neither | The bundled empty state, for both the WEM and STA tabs |

3C and Milestone together are the regression test for precedence: the same role
name with the same permission profile must resolve to WEM on one and STA on the
other. If the STA tab ever lists users on 3C, precedence has stopped being
applied somewhere and the verdicts are no longer Genesys's.

### 7.2 Cases

The WEM pass has 40 cases. STA reuses the same code, so the pass splits:

- **Regression (blocking, before STA is wired):** all 40 WEM cases re-run
  against the extracted module. Behaviour-preserving means all 40 stay green,
  and the WEM tab still shows exactly two categories.
- **STA-specific:** the identification line names `gcSTAupgrade` on 3C Retail;
  Demo (CX3) shows the bundled empty state and disables Search; a user holding
  `billing:user:staUpgrade` without an STA licence lands in `gap`; the Roles
  view groups by blast radius; export follows the visible rows.
- **Precedence (the case that matters):** the STA tab on **3C Retail must list
  nobody**, while the WEM tab lists the population — and the STA tab on
  **Milestone must list the users behind its 6 STA-inferring roles**. Same
  code, opposite results, decided entirely by which SKUs the org holds. An STA
  tab that shows users on 3C means precedence stopped being applied.
- **Empty is an answer, not a failure.** 3C's empty STA tab must carry the
  explanation from §3.5 rather than rendering a bare "no results".
- **Populations do not overlap.** Because infer assigns one add-on per role, a
  user appears in the WEM tab or the STA tab, never both. If a name shows in
  both on the same org, the id filter is not filtering.

Test rows are added to [`setup-guide.md`](setup-guide.md) in the same commit as
the behaviour, per the standing rule.
