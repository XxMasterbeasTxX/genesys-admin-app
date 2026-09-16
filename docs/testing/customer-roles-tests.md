# Customer Roles — Test Pass

Design: [`docs/customer-roles-design.md`](../customer-roles-design.md).
Written with the change, as the code was built; the automated part ran green
before the first commit.

Environment note: no flag. This ships enforced — a customer row without a
role is refused on add from the first deploy. A row from before the field
(dev test accounts only) is treated as `administrator` and logged
`[license] customer row without a role treated as administrator`.

## A. Automated

`scripts/` has no test runner; two harnesses were run from the repo root
with the stores, identity and registry stubbed.

**Server** — `api/licenses/index.js`, `api/supervisor-scope/index.js`,
`api/lib/licenseGate.js`. 57 checks, plus the 25 of the internal-user pass
re-run against the new code (two expectations updated: a customer add now
needs a role, and a customer session without the administrator role reads
`administrator_required` where it read `internal_only`).

| `/api/supervisor-scope` | Superuser | Customer-manager | Named, no role | Customer Administrator | Customer Supervisor |
|---|---|---|---|---|---|
| GET a customer's scope | 200 | 200 | 403 `customer_manager_required` | 200, **own org whatever `customerId`** | 403 `administrator_required` |
| PUT a customer's scope | 200 | 200 | 403 | 200, own org, logged under the customer | 403 |
| GET/PUT the internal org | 400 `internal_org_has_no_scope` | 400 | — | — | — |
| No `customerId` (internal) | 400 `customerId_required` | | | | |
| Unregistered org | 400 `not_a_customer` | | | | |

PUT validation: keys outside `customerPages.json` (an internal-only page, an
`administrator.*` page, a made-up key) are dropped and named in `dropped`;
the log entry `supervisorScope.set` carries `before` and `after`.

| `/api/licenses` on a **customer** org | Superuser | Customer-manager | Named, no role | Customer Administrator | Customer Supervisor |
|---|---|---|---|---|---|
| Add without a role | 400 `role_required` | 400 | 403 | 403 `internal_only` | 403 `internal_only` |
| Add with `customer-manager` | 400 `role_required` | | | | |
| Add an administrator | 200, `features: []`, logged with the role | 200 | 403 | 403 | 403 |
| Add a supervisor, pages ∩ scope | 200, pages outside the scope dropped | 200 | 403 | 403 | 403 |
| Add a supervisor, no page inside the scope | 400 `pages_required` | | | | |
| Add a supervisor, scope empty | 400 `scope_empty` | | | | |
| Add an administrator, scope empty | 200 | | | | |
| Remove | 200 | 200 | 403 | 403 `internal_only` | 403 |
| List | 200 | 200 | 403 | 200, **own org whatever `customerId`** | 403 `administrator_required` |
| `/role` → supervisor with pages | 200, logged | 200 | 403 `customer_manager_required` | 200, own org, logged under the customer by the Administrator | 403 |
| `/role` → administrator | 200, pages cleared | 200 | 403 | 200 | 403 |
| `/role` same again | `changed: false` | | | | |
| `/role` with `customer-manager` | 400 `role_required` | | | | |
| `/role` on someone not named | 404 `user_not_named` | | | | |
| Read own peak | — | — | — | 200 | 200 |

Internal org unchanged: add needs no role and the row carries `role: ""`;
`/role` accepts only `""` / `customer-manager` (`administrator` →
`invalid_role`) and only from a superuser.

The gate: an administrator's verdict carries `features: null`; a supervisor's
carries ticks ∩ scope (a tick outside the scope, and a tick that is not a
customer page, both fall away); a pre-roles row is `administrator` and
logged; an internal row carries no `features` field at all; a scope edit
reaches the supervisor on the next uncached check; an unreadable scope is
`license_check_failed` for a supervisor and never consulted for an
administrator.

**Client** — 46 checks in a browser harness mounting the real modules with
`fetch` stubbed:

- `resolveCustomerAccess` with `role: "administrator"` shows the two
  `administrator.*` pages and 76 others — no `customers.*`, no
  `deployment`/`utilities`/`flows.delete`. With `role: "supervisor"` and two
  leaf keys it shows exactly those two; every other page is `hidden` (not
  `denied-no-permission`), `administrator.*` included. An empty supervisor
  has no access; an administrator with no entitlements still has the section.
- `resolveAccess` (internal): `administrator.*` is hidden from superusers and
  everyone else; `customers.supervisorAccess` is shown to superusers and
  customer-managers, hidden from a plain colleague.
- The sidebar for the supervisor draws only Export and Interactions; for the
  administrator it draws Administrator and no Customers / Deployment /
  Utilities.
- Administrator › Users (customer mode): title, add box absent, no Remove,
  Edit per row, role column (`Administrator`, `Supervisor · 1 page`). Edit
  opens with the role pre-selected, the tree pruned to the scope's three
  pages, the user's page ticked; ticking another and saving PUTs
  `{ role: "supervisor", features: [both] }` and the row re-renders with
  `Supervisor · 2 pages`. Editing an administrator shows the pages hidden.
- Supervisor Access (customer mode): 76 page boxes, the three from the server
  ticked, Save disabled until a change; a section box is mixed when some of
  its pages are ticked and ticking it ticks them all; Save PUTs the ticked
  keys.
- Customers › Access (internal): the add box and Remove present; on a
  customer org the role control is present, Add stays disabled with a user
  ticked until a role is chosen, and for Supervisor until a page is ticked;
  on the internal org there is no role control and no role column. With an
  empty scope the Supervisor radio is disabled and the text links to
  Customers › Supervisor Access.
- Customers › Supervisor Access (internal) follows the header selector and
  says the internal org has no scope.

Also: `scripts/build-customer-pages.mjs --check` is current (76 pages);
`scripts/check-colours.mjs --strict` finds no literal.

## B. By hand — in dev, then prod

Needs: a customer org in the registry with two test users in the
integration's group; a superuser session; a customer-manager session.

| # | Case | Steps | Expect | Result |
|---|---|---|---|---|
| 1 | Sidebar, internal | Sign in as a superuser | Customers has **Access to Admin Tool** and **Supervisor Access**; no **Administrator** section | |
| 2 | Scope, internal | Customers › Supervisor Access, select the customer; tick Export (the section box) and Interactions › Move; Save | "Saved: N pages in the scope." Activity Log has `supervisorScope.set` with before `[]` | |
| 3 | Scope, internal org | Select the internal org (Demo) on the same page | "…is the internal organisation. It has no Supervisor scope." No tree | |
| 4 | Add without a role | Customers › Access, select the customer, search, tick a user | Add stays disabled; the role box says "Choose a role." | |
| 5 | Add an Administrator | Choose Administrator, Add, confirm | The confirm names the role. Row shows **Administrator**. Log `licenses.assign` with `role: administrator` | |
| 6 | Add a Supervisor | Tick the second user, choose Supervisor | The scope's pages appear as a tree; Add disabled until one is ticked. Tick Export › Users › Last Login; Add, confirm | Confirm lists the page. Row shows **Supervisor · 1 page** | |
| 7 | Empty scope refuses | On a customer whose scope is empty, tick a user | Supervisor radio disabled; text links to Supervisor Access; only Administrator can be chosen | |
| 8 | Administrator signs in | Sign in as user #5 | Full customer sidebar plus **Administrator › Supervisor Access** and **Administrator › Users**; no Customers | |
| 9 | Supervisor signs in | Sign in as user #6 | Sidebar shows **Export › Users › Last Login** and nothing else — no other sections, no Administrator. Not greyed: absent | |
| 10 | Supervisor, no permission | Give #6 a page whose Genesys permission they lack | The page is shown greyed with the permission named (unchanged behaviour inside the set) | |
| 11 | Supervisor, direct call | With `ENFORCE_ENTITLEMENT_ALLOWLIST=true`, call the proxy from #6's session for a page outside their ticks | `endpoint_not_entitled`. With it off, Genesys refuses on their own token as before | |
| 12 | Administrator edits the scope | As #8, Administrator › Supervisor Access: untick Last Login; Save | Saved; log entry under the customer's org by #8. Within five minutes / on next sign-in #6 has no pages | |
| 13 | Administrator edits a user | As #8, Administrator › Users: Edit #6 → tick a page from the new scope; Save | Row updates; log `licenses.role` under the customer by #8 | |
| 14 | Administrator promotes / demotes | Edit #6 → Administrator; Save. Edit again → Supervisor with one page; Save | Each logged; each effective within five minutes | |
| 15 | Administrator cannot add | As #8, Administrator › Users | No add box, no Remove. `POST /api/licenses/assign` from the session → 403 `internal_only` | |
| 16 | Administrator, another org | As #8, `PUT /api/supervisor-scope` with another customer's `customerId` | Own org's scope changed; the other untouched | |
| 17 | Supervisor cannot | As #9, `GET /api/supervisor-scope` and `GET /api/licenses` | 403 `administrator_required` | |
| 18 | Customer-manager | As an internal customer-manager: Supervisor Access for the customer; edit a user's role | Both work; for the internal org → 400 / "no scope" | |
| 19 | Plain colleague | As a named colleague with no role | No Customers section at all | |
| 20 | Internal list untouched | Customers › Access, select Demo | No role column, no role control; "Manages customer access" tick for superusers as before | |
