# Internal User Access — Test Pass

Design: [`docs/internal-user-access-design.md`](../internal-user-access-design.md).
Written with the change, as the code was built; the automated part ran green
before the first commit.

Environment note: everything below assumes `INTERNAL_NAMED_USERS_ENFORCED` is
**unset** (report mode) unless the row says otherwise. In report mode an
unnamed colleague is admitted and a warning is logged; nothing is refused.

## A. Automated — the who-may-what matrix

`scripts/` has no test runner; the matrix was exercised by a harness that
loads `api/licenses/index.js` and `api/lib/licenseGate.js` with the store,
identity and registry stubbed. 25 checks, all passing at the first commit:

| | Superuser | Customer-manager | Named, no role | Customer session |
|---|---|---|---|---|
| List the internal org | 200 | 403 `superuser_required` | 403 | 403 `internal_only` |
| Add to the internal org | 200 | 403 `superuser_required` | 403 | 403 |
| Add to a customer | 200 | 200 | 403 `customer_manager_required` | 403 `internal_only` |
| Remove from a customer | 200 | 200 | 403 | 403 |
| Grant `customer-manager` | 200 | 403 `superuser_required` | 403 | 403 |
| Read own peak | — | — | — | 200, own org only |

Plus: role on a customer org → `internal_org_only`; an unknown role →
`invalid_role`; role on someone not named → 404; no verified identity → 403
`identity_unavailable`.

The gate: superuser passes with no row; a named colleague passes with their
role; an unnamed colleague passes **with `unenforced: true`** while the setting
is unset and is refused `not_assigned` once it is `"true"`; an unnamed
**customer** is refused regardless of the setting; an unverifiable identity
is `identity_unavailable` and is not cached.

The client: `resolveAccess` shows `customers.access` to superusers and
customer-managers only, `deployment.onboarding` to superusers only, every
other page to any named user subject to their permissions; `All Groups`
(needing both `directory:group:view` and `directory:user:view`) is denied to
someone holding only one; with permissions unreadable every gated page is
denied and `verificationFailed` is set. All 95 pages mount.

## B. By hand — in dev, then prod

| # | Case | Steps | Expect | Result |
|---|---|---|---|---|
| 1 | Not in the Genesys group | Sign in with a user outside the integration's groups | Cannot reach the app at all (unchanged) | |
| 2 | Superuser, not named | Sign in as a superuser who has no row | In. Sidebar shows everything, including Onboarding and Customers › Access | |
| 3 | Superuser adds a colleague | Customers › Access, select the internal org (Demo), search, tick, Add | Row appears; Activity Log has `licenses.assign` for Demo | |
| 4 | The colleague signs in | Sign in as that person | In. Sidebar shows what their Genesys permissions allow; no Onboarding, no Customers › Access | |
| 5 | Unnamed colleague, report mode | Sign in as a group member with no row, setting unset | In as before. Function log shows `[license] internal caller not named (unenforced): <id>` | |
| 6 | Unnamed colleague, enforced | Set `INTERNAL_NAMED_USERS_ENFORCED=true`, sign in as #5 | "You have not been given access to this app yet — Ask a superuser to add you." No shell | |
| 7 | Same user, direct call | With #6's token, call `/api/genesys-proxy` and `/api/schedules` directly | 403 `user_not_licensed` from both | |
| 8 | Named without permission, direct call | As #4, call the proxy for a Genesys endpoint their permissions do not cover | Genesys itself refuses (server-side permission-domain check is the next piece) | |
| 9 | Grant customer access | As superuser, tick "Manages customer access" on #4's row, confirm | Tick holds; Activity Log has `licenses.role`; #4 now sees Customers › Access | |
| 10 | Customer-manager on the internal org | As #4 (now a manager), open Customers › Access, select Demo | "Only a superuser can change who has access to it." No box, no list | |
| 11 | Customer-manager on a customer | As #4, select a customer org, add a user | Works; Activity Log `licenses.assign` for that customer | |
| 12 | Customer-manager tries the role | As #4, `POST /api/licenses/role` directly | 403 `superuser_required` | |
| 13 | Withdraw the right | As superuser, untick #4's box, confirm | #4's Customers › Access disappears on next sign-in (≤5 min) | |
| 14 | Remove a colleague | As superuser, Remove #4's row, confirm | #4 sees the not-named screen within 5 minutes; sooner after sign-out | |
| 15 | Customer session | Sign in as a named customer user, call `/api/licenses/assign` directly | 403 `internal_only` — a customer can never add a user | |
| 16 | Onboarding endpoint | As #4 (not a superuser), `POST /api/onboarding-deploy` directly | 403 `superuser_required` | |
| 17 | Superuser cannot be locked out | Remove every row from Demo, set enforced | Superuser still signs in and can add | |
| 18 | Billing | Add and remove colleagues on Demo | No billing effect; Demo is a trustee org and is never swept | |

## C. Rollout order

1. Deploy with `INTERNAL_NAMED_USERS_ENFORCED` unset (dev, then prod).
2. Superusers name everyone who should be in, on the production page.
3. Read the function log for `not named (unenforced)` — that is the list of
   who was missed.
4. Set `INTERNAL_NAMED_USERS_ENFORCED=true` in dev; live with it; then prod.
5. Once it has been `"true"` in production long enough that nobody remembers
   it, remove the flag.
