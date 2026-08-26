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
