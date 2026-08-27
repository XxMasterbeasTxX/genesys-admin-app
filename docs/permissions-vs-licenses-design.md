# Utilities — Permissions vs. Licenses — Design

Status: **Proposed** — awaiting go-ahead, no code written
Author: Genesys Admin App
Last updated: 2026-08-27

Companion to [wem-license-permissions-design.md](wem-license-permissions-design.md),
which needed this and did not have it.

## 1. What it is

Every permission in the org's catalog, against every licence that grants it —
one row per permission, one boolean column per licence.

```
PERMISSION                          LABEL              cloudCX1  cloudCX2  gc2WEMupgrade  gcSTAupgrade  …
quality:evaluation:add              Evaluation - Add             ✓         ✓
analytics:botflowsession:view       Botflow Session - View                 ✓
routing:queue:view                  Queue - View       ✓         ✓         ✓
```

Filter the `gc2WEMupgrade` column to ✓ and you have "permissions assigning WEM",
which is where this started. But the same sheet answers it for **any** licence
the org holds, which is the more useful thing.

## 2. Everything comes from two endpoints

| Endpoint | Gives |
| --- | --- |
| `GET /api/v2/authorization/permissions` | the catalog: `domain`, `entityType`, `action`, `label`, `allowsConditions`, `divisionAware` (paginated; **declares no required permission**) |
| `GET /api/v2/license/definitions` | per licence, `permissions.ids` — a flat list of `domain:entity:action` strings |

Invert the second and join it onto the first. That is the whole feature.

**No per-permission calls.** An earlier sketch of this proposed calling
`POST /api/v2/license/infer/permissions` once per permission to ask "does this
assign WEM". That endpoint is real — it is in the preview spec, body an array of
permission strings, response an array of licence ids — but it is unnecessary
here and it is **preview**, so it can change without notice. The definitions
already carry the mapping. Cost is one paginated catalog walk plus one
definitions call, and a by-id re-fetch for any definition that comes back
without `permissions.ids`.

## 3. Reading the matrix is the point

Because `permissions.ids` appears to be cumulative, a permission shows against
every licence tier that includes it. That is not noise — it is the tier
structure made visible:

    quality:evaluation:add   cloudCX2 ✓  cloudCX3 ✓  gc1WEMupgrade ✓

reads directly as *"bundled from CX 2 up; on CX 1 it needs the WEM add-on"* —
which is exactly the fact that took a day and a wrong subtraction to work out in
[wem-license-permissions-design.md §17](wem-license-permissions-design.md). Had
this page existed, that would have been a glance.

A permission with **no** ticks is equally informative: nothing licence-gated
about it.

## 4. What it does not claim

Only what the API says. No help-article cross-referencing, no billing
interpretation, no "this triggers a charge" — the WEM article's admin-permission
list and the licence's permission set are different things (10 versus 286 on one
org), and reconciling them is not this page's job. It reports the mapping; the
reader draws conclusions.

Two limits worth stating on the page:

- **Org-specific.** `/license/definitions` returns only licences the org can
  hold, so the columns differ per org and a `cloudCX3` org has no WEM column at
  all.
- **Snapshot.** Genesys changes licence contents; the sheet is true when run.

## 5. Placement — needs a decision

Asked for under **Utilities › Get Lists**. That would work, but Get Lists is
gated ALL of `presence:presenceDefinition:view` + `routing:wrapupCode:view`
(§ read-permission-gating-design.md), because it aggregates distinct datasets.
Adding this sheet adds `authorization:license:view` to that set, so anyone
holding the first two but not the third **loses Get Lists entirely**.

Recommendation: **its own page**, `Utilities › Permissions vs. Licenses`, access
key `utilities.permissionsVsLicenses`, gated on
`["authorization:grant:add", "authorization:license:view"]` (ANY — Genesys'
own alternatives for `/license/definitions`). Clean gate, and it is a derived
view rather than a straight list export, which is what Get Lists is for.

The name deliberately echoes **Roles › Permissions vs. Users**.

## 6. Shape

- Excel export, one sheet, plus an on-screen preview table with a text filter
  (permission or label) and a licence-column filter — the same controls as the
  Consumption export, whose users × licences matrix this mirrors.
- Sort by permission string, so domains group naturally.
- Columns: Permission, Label, Domain, Entity, Action, Division Aware,
  Conditions, then one column per licence id.

## 7. Files

| File | Change |
| --- | --- |
| `js/pages/utilities/permissionsVsLicenses.js` | New page. |
| `js/navConfig.js`, `js/pageRegistry.js`, `js/accessConfig.js` | Register route + access key. |
| `js/featurePermissionMap.js` | Read gate (§5). |
| `js/services/genesysApi.js` | Reuse `fetchLicenseDefinitions` / `fetchLicenseDefinition`; a catalog walker already exists in `roles/search.js` and should move here rather than be copied. |
| `docs/api-reference.md`, `README.md`, `docs/setup-guide.md` | Document, and add a test row. |

## 8. Open question

Whether to include a **Licence** column sourced from
`POST /api/v2/license/infer/permissions` — "the licence this permission
*requires*", as opposed to "licences that grant it". It is a different and
arguably sharper answer, but it costs one call per permission and depends on a
preview endpoint. Recommend shipping without it and adding it later if the
mapping alone proves insufficient.
