# Supervisor Templates — Test Pass

Design: [`docs/supervisor-templates-design.md`](../supervisor-templates-design.md).
Written with the change; the automated part ran green before the first
commit.

## A. Automated — the roles harness, 27 checks

`/api/supervisor-templates`, `/api/licenses` with `templateId`, and the
gate; stores, identity and registry stubbed in the store's real shapes.

- **Templates:** none at first; a name is required; a create keeps pages ∩
  scope and tables ∩ open and counts the rest, and is logged as a create;
  a second template with the same name in any case → `name_taken`; two
  templates list by name; rename + re-tick by id, logged naming the old
  name; an unknown id → 404; a plain internal colleague may not; a
  customer Administrator lists their own org's whatever `customerId` they
  send; a customer Supervisor may not.
- **Rows on a template:** assign stores the extras minus the template's
  own pages and tables, logged with the template; a template alone with
  nothing extra is fine; the template's open tables satisfy "at least one
  table"; an unknown template → `template_unknown`; no template and no
  pages → `pages_required` as before; Reset is the same call with no
  extras and reports unchanged when already so; deleting a template in
  use → 409 with the count and the names; after moving them, deleted,
  logged and gone.
- **The gate:** template ∪ extras ∩ scope, template tables ∩ open; a
  template edit reaches the row while the extra stays; a deleted template
  contributes nothing and the extras remain; a template that cannot be
  read fails closed.

Plus every earlier harness re-run green (97 → 124 in the roles harness;
rules 76; access 25; division scope 34).

**Browser** (23 DOM checks, both pages with the API stubbed): the Template
column reads "Sales + 2", "Sales", "—"; the role cell counts effective
pages; Reset is enabled only for the row with extras; the edit's Template
dropdown holds the row's template; its pages and tables are ticked and
locked while the extra is free; the count says "1 beyond the template";
Untick all keeps the locked ones; "(none)" lifts the locks and keeps the
ticks; Save sends the template with the extras only; Reset sends the
template with none, and the row's cell and button follow. On Supervisor
Access: the Editing options; the scope's tree and count; a template's
pruned tree, ticks, tables and Rename/Delete; a tick enables Save; Save
PUTs the template; Delete in use names the Supervisors; "+ New template…"
creates it and selects it.

## B. By hand — in dev, then prod

| # | Case | Steps | Expect | Result |
|---|---|---|---|---|
| 1 | Create | Supervisor Access, Editing → "+ New template…", name "Sales", tick pages and a data table, Save | Saved; the dropdown lists "Template: Sales" | |
| 2 | On add | Customers › Access, add a Supervisor with Template = Sales and one extra page | Row shows Template "Sales + 1"; the Supervisor sees the template's pages plus the extra | |
| 3 | Template edit | On Supervisor Access, add a page to Sales, Save | Within five minutes the Supervisor has it; their extra page is still there | |
| 4 | Reset | Reset to template on that row, confirm | Template column "Sales"; the extra page gone; button greyed | |
| 5 | Locked | Edit the row: try to untick a template page | Greyed; Untick all leaves it; choosing "(none)" frees it | |
| 6 | Delete in use | Delete Sales while a Supervisor is on it | Refused, naming them | |
| 7 | Rename | Rename Sales to "Sales team" | The list's Template column follows | |
| 8 | Customer side | As a customer Administrator: Administrator › Supervisor Access and › Users | The same, for their org only | |
| 9 | Scope narrows | Untick a page from the scope that Sales holds | Gone from the template's tree and from every Supervisor on it | |
| 10 | Deleted template | Delete an unused template a row once pointed at (edit the row to "(none)" first, then re-point a row in storage) | The list says "(deleted)"; the row keeps its own pages | |
| 11 | Default's tables | Editing = Default, open Data Tables › Supervisor | Only the tables ticked "Visible to Supervisors" on Data Tables › Edit, ticked and greyed, no buttons | |
