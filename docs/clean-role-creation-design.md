# Roles — Create: clean, licence-scoped roles

**Status: DESIGN — not built. Awaiting go-ahead. Measurements come from three
live orgs and two console scans, 2026-09-04 to 2026-09-09. One question is open
and is answered by the first run rather than blocking the build — see §4.**

Two additions to **Roles › Create**, which are really one feature:

- **Clean Admin** — everything the org's core licence already pays for, and
  nothing beyond it. An admin who can administer what the org bought and cannot
  accidentally invoke an add-on.
- **A clean role per licence** — Clean STA, Clean WEM, Clean Wallboard, one for
  every licence the org holds. The same machinery, scoped to one licence instead
  of the base stack.

---

## 1. What "clean" means

Strict base only. The point is that nobody accidentally invokes a licence the
org is not paying for, so an add-on is excluded even when the org owns it.

**Clean Admin** =

```
  every cloudCXn the org lists      (all of them — an org may list CX1, CX2 and
                                     CX3 together; the top tier decides, and the
                                     sets are near-disjoint, so union them)
+ communicate
+ collaborate*
+ wallboardUser                     (free with any CX licence, so it costs
                                     nothing and belongs in an admin role)
+ every permission in NO licence at all
```

**Clean `<licence>`** = that licence's own permissions, minus any also granted by
another add-on the org holds — see §4, which is where this gets interesting.
Intended to sit *alongside* a base admin role rather than replace it, which keeps
the billable surface explicit and small.

---

## 2. The org's own definitions already do the work

This is the finding that makes the feature small, and it was not what I
expected.

`cloudCX3` is **not** a superset of `cloudCX2` — they overlap by **14**
permissions out of ~270 each. So I assumed the tier chain would have to be
walked through `prerequisites` to gather CX1 + CX2 + CX3.

It does not, because **licence definitions are org-scoped and already encode
what is free at that org's tier.** Measured:

- All **275** `cloudCX2` permissions exist in a CX3 org's catalog, and **261 of
  them come back attributed to no licence at all** — because on CX3 they cost
  nothing. The remaining 14 are claimed by `cloudCX3`.
- The 19 `speechAndTextAnalytics:*` permissions are `gcSTAupgrade` on a CX2 org
  and **`cloudCX3`** on a CX3 org — exactly as Genesys documents CX3 bundling
  STA.

So `base licences ∪ no-licence permissions` is sufficient, with no tier walking,
no hardcoded tier table and no help-article scraping. The org tells us what is
included; we read it.

**A correction this turned up.** A comment in `fetchPermissionsVsLicenses`
(`js/pages/utilities/getLists.js`) claims licence permission sets are cumulative
across tiers. They are not. It has never mattered — one org holds one tier, so
the claim was never observable — but it is wrong and should be fixed in the same
change.

### Modelled against three live orgs

| Org | Tier | Clean Admin | Excluded | Largest exclusions |
|---|---|---|---|---|
| 3C Retail | CX2 (+WEM trial) | 1413 / 1689 | 276 | WEM 212, Predictive Engagement 60, STA 23 |
| Milestone | CX2 | 1301 / 1405 | 104 | Predictive Engagement 60, STA 23, cxCloudSF 8 |
| Demo | CX3 | 1675 / 1823 | 148 | Workitems 61, Predictive Engagement 60, cxCloudSN 10 |

These include `wallboardUser`, which is free with any CX licence. An earlier
draft excluded it and read 11, 10 and 10 permissions lower.

No `billing:user:*` permission lands in the clean set on any of the three — they
are always claimed by their own add-on, so the natural rule excludes them. They
are still excluded explicitly as a belt-and-braces, because they are the one
class of permission that bills purely by existing.

---

## 3. The role catalogue

One entry per licence in the org's `/license/definitions`, plus the Clean Admin
composite. Nothing is hardcoded: the list is whatever that org can hold, the
same source that drives Utilities › Get Lists › Permissions vs. Licenses.

Base licences are auto-detected as `/^(cloudCX\d+|communicate|collaborate)/i`
plus `wallboardUser`, and stated read-only — the same pattern as the WEM and STA
tabs, which decide for themselves and say what they found rather than asking the
admin to know which SKU is which.

---

## 4. A clean licence role excludes what another add-on also grants

**Rule.** Clean `<licence>` = that licence's permissions, **minus any also
granted by another add-on the org holds**. A shared permission cannot be relied
on to invoke the licence you asked for — Genesys may assign the other one — so
including it would produce a role that silently bills for something else.

Permissions shared with the **base** are kept: they are free at this tier, so
they cannot escalate anything.

This turns out to be a narrow case. Across the three orgs there are exactly two
add-on-to-add-on overlaps:

| Org | Overlap | Effect on the clean role |
|---|---|---|
| 3C Retail | `gc2WEMupgrade` ∩ `gcSTAupgrade` = 19 | Clean STA drops 23 → **4** |
| Milestone | `agentAssistLicense` ∩ `agentAssistOmniLicense` = 4 | Clean agentAssist drops 4 → **0** |
| Demo | none | every clean role is the full licence |

Everything else — Predictive Engagement (60), Workitems (61), cxCloudSN (10),
Teams (4) — is wholly exclusive, so its clean role is simply the whole licence.

**Two consequences the page must handle rather than hide.**

*The set can be empty.* Every one of `agentAssistLicense`'s 4 permissions is also
in `agentAssistOmniLicense`, so a clean role for it would contain nothing. The
page must say so and offer the superset instead, not create an empty role.

*The remainder must be named.* On 3C Retail, Clean STA is
`billing:user:staUpgrade` plus `routing:transcriptionSettings:{view,add,edit}`.
That is enough to set the STA flag and manage transcription settings, but it
cannot administer topics, programs or categories — because those 19 permissions
are WEM's as well. The page says which licence holds the rest:

> Clean STA — **4 of 23** permissions.
> The other 19 are also granted by **gc2WEMupgrade**, which takes precedence on
> this org: granting them would assign WEM rather than STA. Create a **Clean
> WEM** role if the topic, program and category administration is needed.

**One thing this design does not yet prove.** The exclusive rule is *intended*
to escape the precedence trap, but no measurement yet shows that a role built
from only the exclusive permissions actually infers `gcSTAupgrade` on an org
that also holds WEM. Every 3C role we measured held shared permissions too. The
verification in §5 answers it on the first run, and if the answer is that even
the exclusive set infers WEM, then an STA-scoped role is impossible on such an
org and the page should say exactly that instead.

### 4b. Why the shared permissions cannot simply be included: WEM outranks STA

Genesys assigns each user **one** add-on, and WEM wins over STA. 19 of STA's 23
permissions are also in the WEM SKU. Measured on 3C Retail, which holds both:

| Org | Role | Holds | `/license/infer` says |
|---|---|---|---|
| 3C Retail | Speech and Text Analytics Admin | 3 STA-only + 25 shared | **`gc2WEMupgrade`** |
| Milestone | Speech and Text Analytics Admin | 3 STA-only + 25 shared | **`gcSTAupgrade`** |

Identical permissions, opposite answer; the only variable is whether the org
holds WEM. And `# Speech and Text Analytics` on 3C holds **all four**
STA-exclusive permissions — including `billing:user:staUpgrade`, which Genesys
documents as explicitly upgrading the user to STA — and still infers WEM.
`gcSTAupgrade` was inferred by **zero** of that org's 23 STA-permission roles.

**Consequence.** Building Clean STA from all 23 permissions would produce a WEM
role wearing an STA label. That is why §4 excludes the shared 19 rather than
including them and reporting the damage afterwards: the role stays scoped to the
licence you asked for, and the page names WEM as the owner of the rest.

---

## 5. Verification

`POST /api/v2/license/infer` takes **role ids**, so it can only judge a role that
exists. That is the authoritative check — the same call the Genesys admin UI
makes, and the one the WEM and STA tabs already trust.

`POST /api/v2/license/infer/permissions` takes a **permission list** and would
check before anything is created, which is the better shape. It is flagged
preview in the JS SDK reference and absent from the public swagger, which is why
`docs/api-reference.md` records it as deliberately unused.

**Proposed:** best-effort pre-flight on `/license/infer/permissions`, then the
authoritative `/license/infer` after creation.

- If the preview endpoint answers, the warning arrives *before* the role exists.
- If it 404s, errors or returns an unexpected shape, the page skips it silently
  and nothing is lost.
- Either way the post-create infer runs and its verdict is what is shown.

So the preview endpoint can only help, and its eventual removal breaks nothing.

**The verdict is shown, not buried.** After creation:

> Created **Clean Admin (CX3)** — 1,665 permissions.
> Verified with Genesys: this role invokes **cloudCX3**, **communicate**,
> **collaboratePro**, **wallboardUser**. No add-on licence.

and when it is not clean:

> ⚠ This role invokes **gc2WEMupgrade**. WEM takes precedence over STA on this
> org, so Genesys assigns WEM. [Delete the role] [Keep it]

The caveat that rides on every licence verdict in this app applies here too:
infer says which add-on is *assigned*. Whether that becomes a charge depends on
named vs. concurrent licensing, which no API exposes.

---

## 6. The flow

1. **Templates** — a labelled dropdown of every pre-made role the org can have:
   Clean Admin at the top, then one entry per licence it holds, named for the
   licence (Clean STA, Clean WEM, Clean Wallboard, Clean Predictive Engagement).
   The list is built from `/license/definitions`, so it is whatever that org can
   actually hold and nothing is hardcoded. Detection is read-only — the base
   stack is named on screen, not offered as a set of tickboxes, the same way the
   WEM and STA tabs state the licence they identified.

   **The dropdown mirrors the Licence column of Permissions vs. Licenses
   exactly** — same call, same list, no entries greyed and none hidden. A licence
   the org cannot hold is not in that column, so it is not a template either;
   there is nothing to explain and nothing to grey.

   The one template that cannot produce a role — where every permission is also
   in another add-on (§4) — is still listed, because it *is* a licence this org
   holds. Selecting it explains itself in the preview and disables Create, rather
   than being pre-emptively greyed in the list. The explanation belongs where you
   are looking, not on the control you have not clicked yet.
2. **Preview** — the permission set is loaded into the **existing permission
   builder**, grouped by domain and collapsed, so any permission can be
   deselected before creating. This is not new UI: Copy Between Orgs already
   pre-fills the same builder from roles of this size.
3. **Name** — free text, defaulted to something sensible (`Clean Admin (CX3)`,
   `Clean STA`) and editable.
4. **Create** — `POST /api/v2/authorization/roles`, then verify and report.

Reuses `loadCatalog()`, the `policies` state shape (`{domain, entity, actions}`)
and `buildPermissionPolicies()` unchanged. `applyHourlyFilter()` is the existing
precedent for a preset that filters a permission set before submission.

---

## 7. Size: measured, not assumed

Wildcards were removed on 2026-06-01, so a role of this kind must enumerate every
permission. Measured on Demo:

| Existing role | Policies | Permissions | Payload |
|---|---|---|---|
| `#SuperMaster Admin (Old UI)` | 648 | 1684 | 70.3 KB |
| `# SuperMaster Admin` | 630 | 1660 | 68.4 KB |
| `Master Admin` | 323 | 925 | 35.7 KB |

A Clean Admin on Demo is 1,665 permissions — slightly **smaller** than roles that
already exist there, through the same API. No ceiling concern, and 70 KB is
nowhere near the proxy's limits (the SWA constraint is the 45-second timeout, not
payload size).

Worth noting: `#SuperMaster Admin` at 1,684 sits ~19 above the clean line of
1,665, which suggests it currently invokes at least one add-on. Running infer on
it would say which, and would make a good before/after for this feature.

---

## 8. Gating

Role creation keeps its existing write gate, unchanged.

The Templates control needs the licence read permissions the WEM and STA tabs
use (`authorization:grant:add` / `authorization:license:view`), because it is
built from `/license/definitions`.

**There is no per-template gate**, and an earlier draft of this document was
wrong to propose one. It is the same call that populates Permissions vs.
Licenses: if it answered, every licence it returned is readable, so a template
cannot be individually denied. The permission question is one binary about the
control as a whole, not a question per entry.

Without those permissions the Templates dropdown is disabled with the permission
named — the Get Lists treatment, because this one *is* actionable: the admin can
go and ask for it. Create still works by hand, so nothing is lost but the
presets.

That is the line between the two behaviours in this page. **Missing permission →
say what is missing**, because the reader can act on it. **Licence the org does
not hold → do not show it at all**, because there is nothing to act on and a
greyed entry would only be noise.

---

## 9. Test plan

Rows are added to `docs/setup-guide.md` in the same commit as the behaviour.

- **Clean Admin on Demo (CX3):** the type list names `cloudCX3`, `communicate`,
  `collaboratePro`, `wallboardUser` as the base; the preview holds ~1,665
  permissions; created; infer reports base licences only, no add-on.
- **Clean Admin on Milestone (CX2):** ~1,291 permissions, and Predictive
  Engagement, STA and cxCloudSF permissions are provably absent.
- **Deselection sticks:** remove a domain in the preview and confirm the created
  role does not contain it.
- **Clean STA on Milestone:** 23 permissions, infer reports `gcSTAupgrade`.
- **Clean STA on 3C Retail (both SKUs):** the preview holds **4** permissions,
  not 23 — `billing:user:staUpgrade` and `routing:transcriptionSettings:*` — and
  the page names `gc2WEMupgrade` as holding the other 19. Then check what infer
  says about the created role: `gcSTAupgrade` confirms the exclusive rule escapes
  precedence; `gc2WEMupgrade` means an STA-scoped role is impossible on this org
  and the page must say so instead. **This is the open question in §4 and the
  first run answers it.**
- **The dropdown matches the Licence column:** the templates offered on an org
  are Clean Admin plus exactly the licences that org's Permissions vs. Licenses
  export lists — nothing extra, nothing greyed out.
- **A template with an empty exclusive set:** on Milestone, `agentAssistLicense`
  is offered like any other; selecting it explains that all 4 of its permissions
  are also in `agentAssistOmniLicense`, names that as the alternative, and
  disables Create. No empty role is ever created.
- **Clean Wallboard on any CX org:** ~10 permissions, infer reports
  `wallboardUser`, and the page does not warn — it is free with CX.
- **Naming:** the default is editable and the created role carries the name given.
- **Gating:** a user without the licence permissions sees the clean presets
  disabled with the permission named, and can still use Create normally.
