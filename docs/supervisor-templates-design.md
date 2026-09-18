# Supervisor Templates — Design

Status: **Built** — agreed in conversation 2026-09-18 and built the same day
Author: Genesys Admin App
Last updated: 2026-09-18
Test pass: [`docs/testing/supervisor-templates-tests.md`](testing/supervisor-templates-tests.md)

## 0. The requirement

In the user's words: "In supervisor access, I would like to be able to
create templates. It should be a dropdown just above the page selector
window. I should have a default, which is the one used right now, and then
be able to add as many templates as I want. Then in Access to Admin
Tool/Users, when adding/editing a supervisor, I should be able to select
the template. When the template is selected, I should still be able to
check more pages and data tables for the individual user. Then in the user
overview, I should have one more column named "Template". […] I also need
a new button in front of edit. Name Reset to template. It should only be
active if the user has a template assigned as well as other separate
pages."

And the rule that decided the model: "When the template is altered, it
should automatically update the users who has it, but it should not reset
their other page assignments. That should only be doable by pressing the
Reset to template button."

## 1. What a template is

A named set of pages and data tables, per org, stored beside the
Supervisor scope (`orgsettings`, row key `supervisorTemplate|<id>`, columns
`name`, `features`, `dataTables`, `setBy`, `setAt`). Templates are drawn
*from the scope*: a template's pages are validated against the scope and
its tables against the tables open to Supervisors, the rest dropped and
counted in the reply. Unticking a page in the scope takes it out of every
template at sign-in, as it does out of every Supervisor. Names are unique
per org, case-insensitively, at most 60 characters.

## 2. Live, not a snapshot — the confirmed model

A Supervisor's row stores the template (`templateId`) and **their extras
separately** (`features`, `dataTables` — the pages and tables beyond the
template; the endpoint strips any overlap on save). At sign-in the gate
computes

    pages  = scope ∩ (template.features ∪ row.features)
    tables = open  ∩ (template.dataTables ∪ row.dataTables)   when the pages include Data Tables › Supervisor

so editing a template reaches every Supervisor on it within the gate's
five-minute cache, no row touched, and their extras stay exactly as they
were. **Reset to template** is the same role call with no extras. A
template since deleted contributes nothing; the row keeps its extras and
the list says "(deleted)" until it is edited.

A row with no template is unchanged from before: its `features` are its
pages.

## 3. Who may

Whoever may set the scope (`api/lib/scopeRights.js`, shared with
`/api/supervisor-scope`): internal superusers and customer-managers for
any customer org, superusers only for the internal org, a customer's own
Administrators for their org (the `customerId` they send is ignored).

## 4. The endpoint — `/api/supervisor-templates`

| Call | Does |
|---|---|
| `GET ?customerId=` | `{ templates: [{ id, name, features, dataTables, setAt }] }`, by name |
| `PUT { customerId, id?, name, features, dataTables }` | create (no id) or overwrite; `name_required`, `name_taken`, `template_unknown`; reply `{ template, dropped, droppedTables }` |
| `DELETE { customerId, id }` | refused **409 `template_in_use`** with `users` and `names` while any active row is on it; else `{ deleted }` |

Every create, change (naming the old name on a rename) and delete is
written to the activity log under the caller's verified identity, in the
customer's own log when a customer made it.

`/api/licenses/assign` and `/role` take `templateId`: it must be one of
the org's own (`template_unknown`); the template's pages count towards
"at least one page" and its open tables towards "at least one table" with
the Supervisor page; what is stored is the extras.

## 5. Supervisor Access

An **Editing** dropdown above the tree: "Default — the Supervisor scope"
(what the page always edited), then "Template: <name>" for each, then
"+ New template…", which asks for a name and creates the template empty,
selected, ready to tick. With a template selected the tree is pruned to
the scope, the data tables picker sits under Data Tables › Supervisor
(the shared `tablesPicker` component), and Rename and Delete appear.
Rename saves the template as held, ticks included. Delete confirms, and
on refusal names the Supervisors on it. Switching with unsaved changes
asks first.

## 6. Customers › Access and Administrator › Users

In the role control, above the page tree: a **Template** dropdown,
"(none)" or a template. Picking one ticks its pages and tables and
**locks** them (ticked, greyed; kept through Untick all and a section's
untick — `createPageTree.setLocked`, `tablesPicker.setLocked`); more can
be ticked, not fewer — to have fewer, pick another template or none. The
count reads "7 of 20 pages … (2 beyond the template)".

On the list: a **Template** column after Role — the name, "+ 2" for the
extras beyond it, "—" without one, "(deleted)" for a template that is
gone — and a **Reset to template** button before Edit, enabled only when
the row has a template *and* extras. It confirms, naming what will go,
and saves; Modified by/on stamp as any role change. The role cell counts
the effective pages and tables.

## 7. Not done, deliberately

- No template on an Administrator: they have everything.
- No "apply template to the scope": templates are subsets of it, not the
  other way round.
- Deleting a template in use is refused rather than folding its pages
  into each user's own ticks — that would turn a live link into a
  snapshot behind the Administrator's back.
