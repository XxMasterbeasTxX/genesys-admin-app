# Data Table Rules — Test Pass

Design: [`docs/data-table-rules-design.md`](../data-table-rules-design.md).
Written with the change, as the code was built; the automated part ran green
before the first commit.

Environment note: no flag. A table with no rules row behaves on the
Supervisor page as plain row editing with add and delete off.

## A. Automated

**Server** — `api/lib/dataTableRules.js`, `api/datatable-rules/index.js`.
49 checks with the store, identity and Genesys reads stubbed:

- `normalizeRules`: junk dropped, a Data Table lookup without a table id
  becomes no lookup, flags coerced to booleans, `hidden` kept.
- `parseRowWrite`: PUT/POST/DELETE on `…/rows` and `…/rows/{key}` are
  writes (the key URL-decoded); GET and the table itself are not.
- `checkRowWrite`: an unchanged row passes with **one** read (the current
  row); a column with no rule changes freely; Protected changed → refused
  naming the column; Mandatory emptied → refused; Mandatory omitted from
  the body keeps the current value; a queue changed to an existing name →
  ok, to a misspelling → refused, and a **prefix match is not a match**;
  skill, data-table key (`GET …/rows/{value}` 200 vs 404) and group (search,
  exact) each way; the row gone → refused, not crashed; POST refused unless
  `mayAddRows`, then validated (bad queue, missing mandatory); DELETE
  refused unless `mayDeleteRows`; Hidden changed → refused, unchanged or
  omitted → ok, a new row with a hidden value → refused, without → ok; no
  rules at all → passes with no reads.
- `/api/datatable-rules` who-may: a customer Administrator reads and sets
  for their own org whatever `customerId` they send, logged
  `dataTableRules.set` under the customer with before/after, unchanged
  rules not logged; a customer Supervisor with the Supervisor page reads,
  cannot set (`administrator_required`), without either page cannot read
  (`page_required`); an internal Administrator sets for a customer and for
  the internal org, needs a `customerId`, an unregistered org is refused;
  an internal Supervisor **with** the Edit page sets, with only the
  Supervisor page reads but cannot set (`edit_page_required`); a superuser
  sets; `tableId` required.

**Client** — 23 checks in a browser harness mounting the real Edit and
Supervisor pages with `fetch` stubbed (a two-table org, one with 231 keys):

- Edit, Schema mode: the header has Lookup / Lookup table / Protected /
  Mandatory / Hidden; every schema row has the controls; an integer
  column's lookup is disabled; the lookup-table dropdown lists the other
  table only; choosing Data Table reveals it; Save Schema PUTs the schema
  to Genesys and then the rules to the app, and the status says "Supervisor
  rules saved: 4 columns"; Rows mode shows the hints under the headers and
  no dropdowns (not enforced).
- Supervisor: the legend names the rules and the value counts; the 231
  keys of the referenced table were fetched in 3 pages of 100; the key is
  plain text; Queue is a dropdown of the three queues with no empty option
  (mandatory) and the current value selected; a value outside the list is
  shown as a marked, selected option; Priority is protected text; Ref is a
  dropdown of the 231 keys plus an empty option; the hidden Note column has
  no header and no cell; Add hidden and Delete shown per the table's
  switches; Save disabled until a change; changing the out-of-list queue to
  a listed one removes the marker, dirties the row and enables Save; Save
  PUTs the full row with the chosen queue, the key unchanged and the hidden
  Note carried along; the row reads "Saved"; a server refusal shows its
  sentence on the row.

Also: `scripts/build-pages.mjs --check` current (94 internal, 77 customer);
`scripts/check-colours.mjs --strict` finds no literal.

## B. By hand — in dev, then prod

Needs: an org with a Services-style table and a second table to look up
keys from; an Administrator session; a Supervisor whose pages include Data
Tables › Supervisor.

| # | Case | Steps | Expect | Result |
|---|---|---|---|---|
| 1 | Set rules | Data Tables › Edit, Schema mode: Queue → Lookup Queue + Mandatory; Priority → Protected; a string column → Lookup Data Table → pick the other table; another → Hidden; tick "may delete rows"; Save Schema | Status: schema saved, "Supervisor rules saved: 4 columns, may delete rows". Activity Log `dataTableRules.set` | |
| 2 | Lookup on a number | Try Lookup on an Integer column | The dropdown is disabled with a tooltip | |
| 3 | Hints | Switch to Rows mode | Hints under the headers; every cell still a free input | |
| 4 | Supervisor page | As the Supervisor: Data Tables › Supervisor, pick the table | Legend with the rules; Queue a dropdown of the org's queues; the key and Priority plain text; the hidden column absent; Add Row absent, Delete Selected present | |
| 5 | Data table keys | Look at the Data Table lookup column | A dropdown of the other table's keys; the status counted the load | |
| 6 | Out-of-list value | A row whose queue no longer exists | Shown as "… (current value, not in the list)"; saving another cell of that row works; changing the queue offers only listed values | |
| 7 | Mandatory | Empty a mandatory field on a row that allows it (a non-lookup mandatory) | Row status "Mandatory: …", Save counts it invalid | |
| 8 | Save | Change a queue to a listed one; Save | "✓ Saved 1 row(s)"; the value in Genesys is exactly the queue's name | |
| 9 | Server holds the line | From the Supervisor's session, `PUT …/rows/{key}` directly with a misspelled queue | 403 `datatable_rule` with the sentence naming the column | |
| 10 | Server: protected | Same, changing Priority | 403, "is protected and cannot be changed" | |
| 11 | Server: delete | With "may delete rows" off, `DELETE …/rows/{key}` from the Supervisor | 403 "may not delete rows" | |
| 12 | Administrator unbound | As the Administrator on Data Tables › Edit, Rows mode: type a misspelled queue and save | Saved — the rules bind Supervisors only | |
| 13 | Customer Administrator | As a customer Administrator with the Edit page: set rules | Saved and logged under the customer's org | |
| 14 | Internal Supervisor with Edit | As an internal Supervisor whose pages include Data Tables › Edit | May set rules; one with only the Supervisor page may not | |
| 15 | Orphaned rule | Rename a ruled column in the schema; Save; reload | The rule is listed as orphaned under the grid with "remove" | |
| 16 | Refresh | On the Supervisor page, rename a queue in Genesys; Refresh | The dropdown shows the new name | |
