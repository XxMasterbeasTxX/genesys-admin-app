# Permissions vs. Users — WEM License Check — Design

Status: **Built** — shipped as release 4.7; probe skipped, see §5
Author: Genesys Admin App
Last updated: 2026-08-26

Sibling of the Hourly Interacting check (`js/pages/roles/hourlyInteracting.js`),
which this deliberately mirrors: same page, same third mode slot, same table,
same source attribution, same export.

## 1. The short answer

Yes, and with a better source than Hourly Interacting has.

Hourly Interacting scrapes a help article
(`api/scrape-disqualifying-permissions/index.js`) because Genesys publishes that
list as prose and nowhere else. **There is no equivalent article for WEM.** I
searched the Resource Center's WordPress REST index for "WEM add-on
permissions", "permissions require add-on license" and "workforce engagement
permissions"; the three plausible slugs
(`about-workforce-engagement-management-permissions`, `wem-add-on-permissions`,
`genesys-cloud-wem-add-on-i-and-ii-permissions`) all return the ~70 KB
not-found shell, against 419 KB for the real hourly-interacting article. That
list is not published.

It does not need to be. Genesys exposes the mapping **as an API**, per org, and
even exposes the inference engine itself.

## 2. The endpoints

All confirmed against the public OpenAPI spec
(`https://api.mypurecloud.com/api/v2/docs/swagger`) unless noted.

| Endpoint | Returns | Notes |
| --- | --- | --- |
| `GET /api/v2/license/definitions` | `[LicenseDefinition]` | Every licence the org can hold. `permissions.ids` is a flat list of permission strings; also carries `prerequisites` and `comprises`. Requires ANY of `authorization:grant:add`, `authorization:license:view`. |
| `GET /api/v2/license/definitions/{licenseId}` | one `LicenseDefinition` | Same shape, single. |
| `POST /api/v2/license/infer` | `[licenseId]` | **Body is an array of roleIds.** This is Genesys' own "what does this role cost you" engine — the thing the admin UI uses. |
| `POST /api/v2/license/infer/permissions` | `[licenseId]` | Body is an array of permission strings. Documented only in the JS SDK reference, **flagged preview** and absent from the public swagger. Do not build on it. |
| `GET /api/v2/license/users` | `[{id, licenses[]}]`, paginated | Licences a user is *actually assigned*. |

The app already wraps two of these — `fetchLicenseDefinitions` and
`fetchAllLicenseUsers` in [genesysApi.js:1181](../js/services/genesysApi.js:1181)
— for Export → Licenses → Consumption. `proxyGenesys` already forwards POST
bodies, so `/license/infer` needs no plumbing.

## 3. The design

**`POST /api/v2/license/infer` gives the verdict; the licence definition
explains it.** Splitting those two jobs is the whole point:

- *Does this role trigger WEM?* — ask Genesys. Its answer is the billing
  answer, and it stays correct when Genesys reshuffles licence contents.
- *Which permission did it?* — intersect the role's expanded permissions with
  the WEM definition's `permissions.ids`, locally, using the wildcard-aware
  matcher already written in `hourlyInteracting.js`
  (`buildDisqualifyingIndex` / `policyMatchesDisqualifying` /
  `getDisqualifyingFromRole`). That is presentation, not classification, so it
  is allowed to be approximate.

Flow, per search:

1. `GET /api/v2/license/definitions` → pick the WEM definitions. **Match on
   `/wem/i` in the id, then let the user confirm in a multi-select**, rather
   than hardcoding ids. Which WEM SKUs an org holds varies, and hardcoding is
   how this page rots.
2. `fetchAllAuthorizationRoles` + `fetchAllUsers({expand:["authorization"]})`
   in parallel — identical to Hourly Interacting.
3. `POST /api/v2/license/infer` with `[roleId]`, one call per role, batched at
   concurrency 10 via the existing `runBatched`. A role is *WEM-triggering* if
   any returned licence id is in the WEM set. Orgs run 50–250 roles, so this is
   5–25 sequential waves, comparable to the group-membership phase the hourly
   check already pays.
4. Any user holding a WEM-triggering role is a hit. Rows expand one per
   user × triggering role, matching the hourly table's shape.
5. Source attribution: reuse `buildSourceLabel` verbatim. Group **memberships**
   ride along on the step-2 bulk user fetch as `expand=authorization,groups`,
   so the only per-object work left is reading each group's role grants — and
   only for groups belonging to a user who actually has a triggering role.
   See §10.
6. `fetchAllLicenseUsers` → an **Assigned** column, so the table answers the
   question the finance side actually asks (§4).

Columns: User · Email · Status · Triggering Role · Source · Permissions that
triggered it · WEM licence assigned.

Filter pills, filter box, and Excel export are copied from `hourlyInteracting.js`.

## 4. Why the Assigned column earns its place

Triggering and assigned are independent, and both mismatches cost money:

- **Triggers WEM, no WEM licence assigned** — a permission is being granted
  that the org is not paying for. This is what shows up in a Genesys audit.
- **WEM licence assigned, triggers nothing** — the org is paying for a seat
  whose roles never needed it. This is the one customers want found.

Three pills: *Triggers WEM*, *Unlicensed trigger*, *Licence unused*.

## 5. The open questions, and why no probe is needed

An earlier revision of this document ended with three questions and a request
for one authenticated `GET /api/v2/license/definitions` against the demo org.
Two of the three dissolve in code, and the third was never a blocker. Building
first is the cheaper order.

1. **Does the list endpoint populate `permissions.ids`, or only the by-id
   endpoint?** Genesys commonly returns a skinny list and a fat single. This is
   a runtime branch, not a design fork: if a chosen definition comes back
   without `permissions?.ids?.length`, re-fetch it from
   `GET /license/definitions/{id}`. Costs two or three extra calls in the
   skinny case and nothing in the fat case, and needs no advance knowledge of
   which case we are in.

2. **Are a WEM definition's permission ids incremental or cumulative?** The
   worry was that a cumulative list — everything the base CX licence grants
   plus the WEM extras — would make the "which permission triggered it" column
   name half the catalogue. **Always subtract the prerequisites' permissions**
   and the question stops mattering:

   - cumulative → `{base + wem} − {base}` = `{wem}`. Correct.
   - incremental → `{wem} − {base}` = `{wem}`, since the sets barely overlap.
     A no-op. Correct.

   The subtraction is right under both hypotheses, so there is nothing to find
   out. And a permission that *is* in the base licence cannot trigger the
   add-on by definition, so nothing legitimate is lost to over-subtraction.

3. **The WEM licence ids in this org.** Never a build blocker — §3 step 1
   discovers them at runtime and puts them in front of the user. Hardcoding
   them was already rejected.

What a live run will still tell us is whether `infer` and the definition
intersection agree on real data. That is a validation question, and validation
wants a working page to validate.

## 6. Loose end found on the way

`api/lib/entitlementAllowlist.js` has no rule for `/api/v2/license`. The
positive allowlist fails closed on unmapped paths, so if
`ENFORCE_ENTITLEMENT_ALLOWLIST` is ever turned on, this page **and the existing
Export → Licenses → Consumption page** break for customer sessions. Needs:

```js
{ test: /^\/api\/v2\/license\b/i, modules: ["roles", "export.licenses", "export"] },
```

Pre-existing, not caused by this feature, but this feature doubles the blast
radius.

## 7. Files touched

| File | Change |
| --- | --- |
| `js/pages/roles/wemLicense.js` | New. `renderWemContent(container, ctx)`, lazily imported. |
| `js/pages/roles/search.js` | Third mode button + section, wired like `rsModeHourly` ([search.js:693](../js/pages/roles/search.js:693)). |
| `js/services/genesysApi.js` | `inferLicensesForRole(api, orgId, roleId)`; widen `fetchLicenseDefinitions` if §5.1 says the list is skinny. |
| `api/lib/entitlementAllowlist.js` | §6. |
| `js/releaseNotes.js` | Fold into the current release entry. |

No new Azure Function: unlike the hourly check, nothing here is scraped.

## 8. Alternative rejected

Scraping, or shipping a static `wemLicensePermissions.js` snapshot the way
`hourlyDisqualifyingPermissions.js` exists. Rejected: there is no page to
scrape, a hand-built snapshot has no maintainer and no upstream to diff
against, and the API answer is per-org and always current. The static list in
the hourly check is a fallback for a flaky scrape, not a pattern to copy where
a first-class API exists.

## 9. What was verified, and what was not

Verified, against a mock harness driving the real module:

- The three-way split. A user who triggers and holds WEM reads *Licensed*, one
  who triggers without reads *Unlicensed trigger*, one who holds without
  triggering reads *License unused*, and a user who does neither is absent from
  the table entirely.
- Prerequisite subtraction. A base-licence permission (`routing:queue:view`)
  carried by a WEM definition is not named as a trigger.
- The `infer` fallback. With `POST /api/v2/license/infer` failing, the amber
  notice appears and permission-matching produces the verdicts.
- Pills and the text filter, and that Export writes only the visible rows with
  the full permission list rather than the table's truncated `+n`.
- 16 assertions over the pure logic — cumulative vs. incremental subtraction,
  a selected licence used as its own prerequisite, skinny-vs-fat definitions,
  `comprises` recursion, a 404 definition, and wildcard expansion across
  domain / entity / actionSet — run against the functions extracted from the
  shipped source rather than retyped.

Not verified, and only a real org can:

- That `infer` and the definition intersection agree on live data. They agree
  by construction on the mock, which proves the plumbing and nothing about
  Genesys' actual licence contents.
- Which of §5's two shapes this org's `/license/definitions` returns. Both
  paths are exercised in the harness; which one runs in production is still
  unknown, and by design does not need to be.

## 10. Why there is no per-user fetch

The first cut copied Hourly Interacting's attribution phase wholesale, including
its `GET /api/v2/users/{id}?expand=groups` per matched user. That is the wrong
shape for this feature, and the difference is not small.

Hourly Interacting's matched set is users holding
`billing:user:hourlyInteracting` — typically a handful. **This page's matched
set is every user who triggers WEM or holds a WEM licence**, which on an org
where WEM is broadly deployed approaches the whole directory. A 1,000-user org
would have paid 1,000 sequential-ish round trips for data the bulk endpoint
hands over for free: `groups` is a valid `expand` on `GET /api/v2/users`
alongside `authorization`.

So the request profile scales as **pages + in-use roles + 2 × distinct groups**,
and not with user count at all. Measured on the harness: 13 calls total, zero
of them per-user.

That reframes where the scaling risk sits. It is not the licence-infer loop —
one call per in-use role, and an org with 188 roles pays 188 of them at
concurrency 10, which is nineteen waves. It is nothing, now. The remaining
unknown is only whether the licence API rate-limits that burst.

The same optimisation would apply to `hourlyInteracting.js`. Left alone
deliberately: it is a different page, its matched set is small enough that the
loop has never hurt, and widening this change into it would put an untested
edit on a working feature.

## 11. CX3 bundles WEM, and the page has to say so

Found on the first real run (2026-08-26), across two live orgs:

| Org | Base | WEM SKU in `/license/definitions` |
| --- | --- | --- |
| Nemlig | `cloudCX2` | `gc2WEMupgrade` — identified correctly |
| Demo | `cloudCX3` | **none** |

The customer then supplied the general rule, which makes the three cases
exhaustive rather than merely observed: `cloudCX1` takes `gc1WEMupgrade`,
`cloudCX2` takes `gc2WEMupgrade`, `cloudCX3` and above take neither. The
upgrades are **alternatives, not additions** — no org holds both, so there is
no such thing as an org with two WEM SKUs to test against.

`/license/definitions` returns only the licences an org can actually hold, and
**CX3 and above bundle WEM into the base licence**. So on a CX3 org the WEM
add-on is not unticked, it is absent — there is no such SKU to buy.

The `/wem/i` hint was never wrong. But the empty state it produced said
"No license id looked like WEM — tick the add-on licenses to check", which
sends someone hunting for a licence their org cannot have. On a CX3 org that
missing SKU *is the answer*: nobody can hold a WEM permission they are not
licensed for, because everyone with the base licence already has WEM.

The page now detects the highest `cloudCX<n>` the org can hold and, when
nothing pre-ticks at tier ≥ 3, names the bundling in both the status line and
the centred panel. It also points at the question that *is* answerable there
— tick the base licence to see whose roles require it — while saying plainly
that those results read as "needs cloudCX3", not "needs WEM".

Deliberately not done: pre-ticking `cloudCX3` automatically. Its permission set
minus its prerequisites is every CX3 extra, not the WEM subset, so every row
would flag and the column headed "Triggering Permissions" would be answering a
different question than its label claims. Better to make that the user's
explicit choice with the caveat attached.

## 12. The picker was my uncertainty, wearing a UI

§3 step 1 had the user confirm which licences count as WEM, on the reasoning
that hardcoding ids is how the page rots. That reasoning was about *not knowing
the ids* — and it resolved a build-time unknown by handing the decision to the
person least able to make it. An admin at a customer opening this page sees
`cxCloudSF`, `gcSTAupgrade`, `examplePremiumAppUserLicense` and is implicitly
asked which of them is WEM.

The hint never needed the help: it matched 2/2 on the first live orgs. So the
page decides, states what it found, and offers nothing to click.

- **Found** — "Checking against **gc2WEMupgrade**." Search enabled. Two SKUs
  read "Checking against **gc1WEMupgrade** and **gc2WEMupgrade**."
- **None** — the reason is named (`cloudCX3` bundles it, or the org simply has
  no add-on) and Search is disabled. Both reasons reach the same conclusion:
  there is no WEM licence for anyone here to hold.

An intermediate revision kept a **Change** link to the full list, justified as
"a silently wrong answer about licence compliance is worse than a link". That
justification does not survive contact with who the control is *for*: using it
correctly requires knowing which SKU is WEM, which is precisely the knowledge
the paragraph above establishes the admin does not have. It could only ever
have helped whoever was debugging the page. It also quietly widened the page's
job — point it at `gcSTAupgrade` and every label on the results table lies.

So the escape hatch is gone, and the recovery path for a missed org is to fix
the hint. That is the better loop anyway: it fixes the org that reported it and
every other org at once. 109 lines lighter.

One bug worth recording: `.wem-lic-chip` set `display:inline-flex`, which
outranks the UA sheet's `[hidden] { display:none }`. Setting `hidden` on the
chips left the JS assertions passing — `label.hidden` was true — while every
chip stayed on screen. It took reading the rendered text, not the DOM, to see
it. The chips are gone now, but the lesson is not: assert on rendered output.

## 13. This page's numbers will not match a concurrent bill

Cost an hour on the first real run, so it is written down.

Nemlig showed **40 users** on this page against **13** on the Genesys billing
page, and the obvious conclusion — that the page over-reports — was wrong.
They measure different things, and on a concurrent-licensing org they cannot
agree:

- **This page** reads `/api/v2/license/users`: who holds a licence **right now**.
- **The bill** reads peak concurrency: the largest number of licence holders
  **logged in simultaneously** at any point in the billing period.

From *Concurrent licensing model billing overview* in the Resource Centre:
users who hold a licence during the usage period are eligible for the
concurrency calculation, charges reflect the highest licence a user **was
assigned during the period**, and peaks shorter than 30 minutes are
disregarded and may span non-contiguous intervals.

Two consequences worth holding on to:

1. **Licences are assigned, not attached at login.** A tempting reading of
   "concurrent" is that the licence is drawn from a pool when someone signs in;
   it is not. Users hold licences, and concurrency counts how many holders were
   on at once.
2. **A point-in-time API cannot reconstruct the peak.** If 6 hold the licence
   today and the bill says 13, assignments changed during the period. No
   snapshot endpoint can recover that, and this page should not pretend to.
   Genesys publishes the **Concurrent Usage report**, which lists the counted
   users and their login times — that is the tool for "who were the 13".

So the division of labour is: the Concurrent Usage report answers *who was
counted*; Export → Licenses → Consumption answers *who holds a seat now*; and
this page answers *who could trigger one, and which role does it* — which is
the question it was built for.

## 14. Inactive users are deliberately out of scope

`5077e28` added `state: "any"` on the reasoning that a dormant account still
holding a WEM seat is obvious waste. That reasoning was wrong and it has been
reverted: **inactive users do not count towards licence billing**, so such an
account is not a seat anyone is paying for. Including them would have added
rows nobody can act on to a page whose whole purpose is finding real exposure.

The page therefore uses `/api/v2/users`' default of `state=active`, and the
neighbouring licence exports doing the same are correct rather than defective.
