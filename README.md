# Genesys Admin Tool

Internal web application for the Genesys Team to perform administrative actions across multiple customer Genesys Cloud orgs.

## What changed recently

- **Utilities — IP Ranges (new page)** under **Utilities > IP Ranges**: dual-mode public IP/CIDR viewer for firewall whitelisting. **Genesys** mode lists per-region ranges via the new `GET /api/ipranges` proxy (client-credentials auth through a configured customer org); all 15 Genesys regions are selectable (regions without configured credentials are marked "— no creds"). Four Cloud Media Services CIDRs (not published through the API) are injected server-side for commercial regions. **Amazon** mode loads the global AWS feed via `GET /api/aws-ipranges` (anonymous, 15-min server-side cache) with a region picker (default `eu-central-1`). Shared filters: group-by, direction/IP-type, CIDR search, and a searchable multi-select Services dropdown, plus Copy CIDRs and Export to Excel.
- **Billing exports — 6 new pages** under **Export > Billing**: Single Org, All Orgs (Latest), Calendar Year, Date Range, Custom Orgs, and Period Comparison. All use the same trustee billing overview endpoint (`GET /api/v2/billing/trusteebillingoverview/{trustorOrgId}?billingPeriodIndex=N`) and produce styled multi-section Excel workbooks matching the Python `GUI_Billing_Export*.py` output (per-org sheet, period banner, regular licenses, AI tokens breakdown, items with overage).
- Trustee billing override map (`api/lib/customers.json` → `trusteeForOrg`) controls which trustee credential is used per customer.
- Scheduled variants for **Single Org**, **All Orgs (Latest)**, and **Calendar Year** (server-side handlers in `api/lib/exports/billing*.js` — Calendar Year always exports the previous calendar year).
- Period parity with Python: AI fair-use override (`350` / `250` depending on hours), AI rollup name-based detection (`AI_NAME_PATTERN`), two-pass non-AI fair-use allocation (e.g. Voice Transcription), BYOC committed = `trunc(cxCount × multiplier)`, and `hasAi` gate = `aiRollup > 0`.
- Added **Wrapup Codes — Create/Edit/Mapping** page at root nav path **Wrapup Codes > Create/Edit/Mapping**.
- New page supports wrapup create/edit, live search, row-click mapping expansion, and Genesys-style slider controls for outbound mapping flags.
- Added **Default Mapping** panel to view/edit outbound `defaultSet` values and show impact count for wrapup codes inheriting defaults.
- Improved mapping save robustness with conflict-safe retry and compatibility handling for legacy mapping key/flag formats.
- Updated docs and API usage notes to include outbound wrapup mapping endpoints and feature ownership context.

## What it does

### Features

- **Interaction Search — Recent (<48h)** — Search conversations from the last 48 hours, today, or yesterday using the synchronous query API (results appear immediately). Server-side filters: Queue (searchable), Direction (Inbound/Outbound), Media Type, Division. Client-side Participant Data attribute filters with key/value matching, exclude mode, and multi-value (CSV) support. Inline row expand shows matched PD values as pills. Sortable results table; click-to-expand detail; right-click to copy Conversation ID. Export Interactions to styled Excel.
- **Interaction Search — Historical (>48h)** — Search historical conversations by date range (up to 48 hours ago) using the async analytics jobs API. Date ranges longer than 7 days are automatically split into 7-day chunks, each running its own async job to avoid proxy timeouts; progress and status messages update per chunk. Quick-select buttons: Last Week, Last Month, Previous 7 Days, Previous 30 Days. Server-side filters: Queue (searchable), Direction (Inbound/Outbound), Media Type, Division. Client-side Participant Data attribute filters with key/value matching, exclude mode, and multi-value (CSV) support. Inline row expand and right-side detail pane. Collapsible results section (auto-collapses when Multi-value is active to surface the Value Distribution chart). Value Distribution bar chart for multi-value PD keys. Three export buttons: **Export Interactions** (all result rows), **Export Selected Participant Data** (only the filtered PD keys — one row per Conv ID/key/value; CSV values split into individual rows when Multi-value is checked), **Export All Participant Data** (all participant attributes across all conversations). All exports use styled Excel (blue header, alternating rows, auto-filter, frozen row).
- **Transcript Search** — Search conversations and verify whether a Speech & Text Analytics (STA) transcript exists for each one. Two search modes: **Date & Filters** (pick a single day + optional time window, queue, media type, direction — submits an async analytics job) and **Conversation ID(s)** (paste one or more IDs separated by commas, spaces, or newlines — fetches each conversation directly). Transcript existence is checked in parallel batches of 10 via `GET .../transcripturl` (200 = exists, 404 = does not). Live stacked bar chart shows Found / No Transcript / Not Checked counts updating in real time. Transcript filter toggle (All / Found / No Transcript / Not Checked). Click any row to expand and read the full STA transcript content inline. Export to Excel: Conversation ID, Start/End Time, Duration, Queue, Agent, Media Type, Direction, Transcript Exists, Checked At. Access key: `interactions.search.transcripts.search`.
- **Move Interactions** — Move conversations between queues with media type filtering and date range controls
- **Disconnect Interactions** — Force-disconnect stuck/orphaned conversations in three modes: single ID, multiple IDs (comma/newline separated), or empty an entire queue. Queue mode uses a hybrid scan strategy: the most recent 48 hours are scanned via the synchronous analytics query API (6-hour buckets) with a per-conversation GET for accurate media-type detection, ensuring today's callbacks and other interactions are never missed due to analytics ingestion lag; older history is covered by up to 6 × 31-day async analytics job windows. Status messages display the current phase — `[Recent sync]` or `[Historical async]` — so operators can track progress. Disconnects execute in parallel batches of 10 for maximum throughput, with a 50 ms pause between batches. Media type filter and date range (older/newer than) filters. Progress shown via status text and progress bar — no table, just a summary of Disconnected / Failed counts on completion.
- **Data Tables — Create** — Create a new data table in the selected org. Required fields: Name, Division, Key (display name of the primary key column, always stored as string). Optional: Description and schema columns. Schema column builder supports Boolean, Decimal, Integer, and String types with optional default values per column. Columns can be reordered by dragging the grip handle. Schema can be imported from an Excel file: select a file, pick the sheet, and the form is pre-filled (Name from row 1; Key, Division, Description from rows 2–4; schema columns from row 5+ — A=Column Name, B=Type, C=Default value optional — invalid or empty defaults are silently skipped). Multiple tabs in the same file can be imported in sequence without re-selecting the file. A **Download Template** button downloads the pre-formatted Excel template directly.
- **Data Tables — Edit** — Edit an existing data table in the selected org with a two-mode editor (**Schema** / **Rows**). Data tables are loaded when the page opens, and selecting a table auto-loads its schema and rows (no separate Load button). **Schema mode** supports the full schema editor (drag reorder, add/remove/modify columns, save via full `PUT /api/v2/flows/datatables/{id}`). **Rows mode** provides bulk row editing in a paged grid with full-table search, page size selector (50/100/200), Add Row, row checkboxes, Select-all-on-page, Delete Selected, Undo All, Refresh Rows, and per-row save status. Row saves use create/update/delete flows (`POST`/`PUT`/`DELETE`) depending on row state. Access key: `data-tables.edit`.
- **Interaction Totals** — Visualise interaction counts by Media Type, Voice Direction, and ACD / Non-ACD routing as horizontal bar charts. Date range picker with quick-select presets: Last Week (ISO Mon–Sun), Last Month, Last 3 Months, Last Year. Optional Media Type and Direction filters narrow the API query. Uses the Conversation Aggregates API (`POST /api/v2/analytics/conversations/aggregates/query`) with `nConversations` metric for fast pre-computed counts at any scale. Total Interactions is computed as the sum of all media-type counts. Voice direction uses `originatingDirection` groupBy. ACD / Non-ACD routing uses a hybrid approach: `interactionType` dimension for voice (contactCenter = ACD, enterprise = Non-ACD) combined with `nOffered` metric (firstQueue filter) for non-voice media types (callback, chat, email, message). **Export to Excel** produces a styled summary workbook with title rows (Interaction Totals, Org name, Period, Filters) above a Category/Value/Count/Percentage data table. **Email** section with toggle, recipients, and message to send the Excel as an attachment via Mailjet. **Schedule** panel for automated daily/weekly/monthly export with period preset dropdown (Last Week / Last Month / Last 3 Months / Last Year). Server-side handler in `api/lib/exports/interactionTotals.js`. Access key: `export.interactions.totals`.
- **Deployment — Basic** — Bulk-create core Genesys Cloud objects from a single Excel workbook. Select a `.xlsx`/`.xls` file; each sheet is matched by tab name to a specific object type and processed automatically. Supported tabs: **DID Pools** (A=Number Start E.164, B=Number End, C=Description, D=Comment, E=Provider: PURE_CLOUD_VOICE / BYOC_CLOUD / BYOC_PREMISES — skipped if an overlapping pool already exists); **Divisions** (A=Name, B=Description — skipped if name already exists); **Sites** (A=Name, B=Media Model Cloud/Premises, C=Media Regions comma-sep for Cloud, D=Location Name, E=TURN Relay Site/Geo, F=Caller ID, G=Caller Name, H=Description — skipped if name already exists); **Skills** (A=Name — skipped if name already exists); **Skills - Language** (A=Name — skipped if name already exists); **Site - Number Plans** (A=Site Name, B=Plan Name, C=Classification, D=Match Type: numberList/digitLength/intraCountryCode/interCountryCode/regex, E=Priority, F=State, G=Numbers one per row for multi-number types, H=Digit Length e.g. 4-10, I=Match Pattern, J=Normalized Format — GET→merge→PUT per site, preserving existing plans); **Site - Outbound Routes** (A=Site Name, B=Route Name, C=Classification Types one per row, D=Distribution: SEQUENTIAL/RANDOM, E=Trunk Names one per row resolved by name, F=State true/false — existing routes not in sheet are untouched; routes matched by name are updated, new ones created); **Schedules** (A=Name req, B=Division, C=Description, D=Start req ISO-8601 no-tz e.g. 2026-01-01T08:00:00.000, E=End req same format, F=RRule optional iCal string e.g. FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR — times interpreted in org timezone; existing schedules matched by name are updated); **Schedule Groups** (multi-row per group — rows sharing the same Group Name are folded into one upsert: A=Group Name req, B=Division first-row-only, C=Description first-row-only, D=Time Zone first-row-only validated against Genesys allowed values e.g. Europe/Copenhagen, E=Type req: open/closed/holiday, F=Schedule Name req resolved by name — existing groups matched by name are updated); **Users** (multi-row per user — rows sharing the same E-mail are folded into one upsert: A=User display name req for new, B=E-mail req, C=Phone Name, D=Phone Site, E=Division, F=Skill one per row, G=Role one per row, H=Extension, I=DID Direct Number, J=Phone Type exact base-settings name, K=Queue one per row — upserts user by email; restores deleted/inactive users before other steps; grants roles and skills additively; creates phone if not found; sets extension and DID as user addresses; adds users to queues in bulk after all users processed; per-step failures are warnings not fatal); **Wrapup Codes** (A=Name req, B=Division, C=Description, D=Queue Name — if set, assigns the code to that queue after upsert; existing codes matched by name are updated); **Queues** (A=Queue Name req, B=Division req, C=Description, D=Scoring Method: TimestampAndPriority/PriorityOnly, E=Last Agent Routing: Disabled/QueueMembersOnly/AnyAgent, F=ACW Prompt: OPTIONAL/MANDATORY/MANDATORY_TIMEOUT/MANDATORY_FORCED_TIMEOUT/AGENT_REQUESTED, G=Skill Eval Method: NONE/BEST/ALL, H=Enable Transcription, I=Enable Manual Assignment, J=Suppress Recording, K=Calling Party Name, L=Calling Party Number, M=Call In-Queue Flow, N=Email In-Queue Flow, O=Message In-Queue Flow, P=Call Script, Q=Callback Script, R=Chat Script, S=Email Script, T=Message Script, U–Z=Call media: Alerting/AutoAnswer/AutoAnswerAlertTone(s)/ManualAnswerAlertTone(s)/SL%/SLDurationMs, AA–AF=Callback media, AG–AL=Chat media, AM–AR=Email media, AS–AX=Message media — blank cells are omitted; only Queue Name and Division are required; invalid non-blank values skip the row). Row 1 per sheet is always a header and is skipped. Results shown per row (✓ created/updated/skipped / ✗ error) with a per-tab summary. All creations logged to the Activity Log with a `[Deployment]` prefix.
- **Deployment — Data Tables** — Bulk-create data tables from an Excel workbook in a single click. Select a `.xlsx`/`.xls` file and every sheet is processed automatically: each sheet produces one data table using the same fixed row format (row 1 = Name, row 2 = Key, row 3 = Division, row 4 = Description, rows 5+ = A=Column Name, B=Type, C=Default value optional — invalid or empty defaults silently skipped). Results are shown inline (✓ created / ✗ error per sheet) with a final summary. A **Download Template** button downloads the pre-formatted Excel template directly. All creations are logged to the Activity Log.
- **Data Tables — Copy (Single Org)** — Copy a data table (structure + optionally rows) within the same org, with division selection
- **Data Tables — Copy between Orgs** — Copy a data table (structure + optionally rows) from one customer org to another, with target division selection
- **Data Actions — Copy between Orgs** — Copy a data action (contract + config) from one customer org to another, with target integration mapping and draft/publish toggle. Searchable source-action picker for orgs with many actions. Velocity templates stored as `.vm` file references in the source org are fetched and inlined so the copy is an exact replica (request template, success template, translation map, headers).
- **Data Actions — Edit** — View, edit, and test existing data actions with draft/publish workflow, filter by status/category/integration. Edit name, category, request config (URL template, method, body, headers) and response config (translation map, success template) for any action; edit input/output contract schemas for draft-only actions. Save drafts, validate, publish, and run inline tests.
- **Wrapup Codes — Create/Edit/Mapping** — Manage wrapup codes and outbound dialer wrap-up mappings in one page. Root navigation path: `Wrapup Codes > Create/Edit/Mapping`. Page auto-loads all wrapup codes (Name, Id, Description, Division) with live search and Create button. Click a row to expand mapping editor; each row supports Genesys-style Yes/No slider controls for Contact Uncallable, Number Uncallable, Right Party Contact, plus Business Category segment (None/Failure/Neutral/Success) with validation. Supports reset-to-default per row, version-safe save with 409 retry, and robust handling of legacy mapping key/flag formats. Includes a top-right **Default Mapping** panel to view and edit `defaultSet`, with impact count showing how many wrapup codes currently inherit default values. Access key: `wrapupCodes.createEditMapping`.
- **WebRTC Phones — Create** — Bulk-create WebRTC phones for all licensed users in a site, skipping collaborate licenses and existing phones, with Excel log export
- **WebRTC Phones — Change Site** — Move selected WebRTC phones from one site to another using a searchable multi-select phone picker, with progress tracking and Excel log export
- **Trustee Export** — Export a matrix of trustee-org users and their access across all customer orgs, determined by group membership, with per-trustee-org Excel sheets and styled formatting matching the Python tool output
- **Last Login Export** — Export user login data with license information for a selected org. One row per user-license combination, optional inactivity filter (months), collapsible preview with per-column filters, styled Excel matching the Python tool output. Supports per-org scheduled automation.
- **All Groups Export** — Export all users (active, inactive, and deleted) with their group memberships for a selected org. One row per user-group combination (shared Index per user), collapsible preview with per-column filters, styled Excel matching the Python tool output. Supports per-org scheduled automation.
- **All Roles Export** — Export all users with role assignments for a selected org. Users with no roles are excluded. One row per (user, role, source): direct assignments show `Manually assigned` / `User`; roles inherited via a group show `Inherited` / group name; if a role is both directly assigned and inherited, both rows appear. Columns: Index, Name, Email, Division, Active, Date Last Login, Role, **Assigned** (Manually assigned / Inherited), **Assigned by** (User or group name). Attribution is resolved via `GET .../users/{id}?expand=groups` and `GET .../authorization/subjects/{groupId}`, batched in parallel (25 concurrent). Collapsible preview with per-column filters, styled Excel. Supports per-org scheduled automation.
- **Filtered on Role(s) Export** — Export active users filtered by one or more roles. Roles are loaded dynamically per org; one row per user with boolean columns for each selected role. Supports per-org scheduled automation with role selection stored in the schedule config.
- **Queues/Skills Export** — Export users with columns **Name, Queue, Skill, Language Skill**. Filters are split into Group 1 (**User, Groups, Work Teams**) and Group 2 (**Queues, Skills, Language Skills**): Group 1 selects candidate users; Group 2 filters row values. Logic is **OR within each filter**, **AND across filters**. Row model is one row per Queue × Skill × Language Skill combination with blanks when a dimension is missing (unless that dimension is actively filtered). Preview supports pagination (50/100/200). Download uses iframe-safe helper flow. Supports email and per-org scheduled automation.
- **Queues/Skills Scheduled Filters** — Queues/Skills schedules can store optional filter config for Users, Groups, Work Teams, Queues, Skills, and Language Skills. If no filters are selected, scheduled runs export all users in the selected org. If filters are selected, scheduled runs apply the same Group 1/Group 2 logic as the manual page.
- **Skill/Role/Queue Templates Export** — Export all skill templates for the selected org to a multi-sheet Excel workbook. Templates are loaded automatically from Azure Table Storage — no manual selection required. Seven sheets: **Overview** (template name, role/skill/language/queue counts, user/group/team assignment counts, schedule count), **Roles** (one row per template × role × division), **Skills** (template, skill, proficiency), **Languages** (template, language, proficiency), **Queues** (template, queue), **Members** (template, type — User/Group/Work Team, name, assigned by), **Schedules** (template, mode, schedule type, time, day/date, enabled, targets, last run, last run status, created by). Single-click export with preview table, download, email, and schedule panel. Supports per-org scheduled automation. Access key: `export.users.skillTemplates`.
- **Roles Export (All Orgs)** — Export roles for all configured orgs in a single multi-sheet workbook (one sheet per org). Accurate member counts, on-demand only.
- **Billing — Single Org** — Export the latest complete billing period for a single trustor org to a styled Excel workbook. Resolves the org's trustee customer via `customers.json::trusteeForOrg`, fetches the trustor org ID with `GET /api/v2/organizations/me`, then calls `GET /api/v2/billing/trusteebillingoverview/{trustorOrgId}?billingPeriodIndex=1`. Workbook contains one sheet with the metadata banner (License Type, Billing Period, Billable Items, AI Tokens summary when applicable), Regular Licenses, AI Tokens Usage Breakdown (when present), and Items with Overage. Period dropdown supports Current (in-progress), Latest complete (default), Two periods ago, Three periods ago. Supports email and per-org scheduled automation (server-side handler `api/lib/exports/billingSingleOrg.js`). Access key: `export.billing.singleOrg`.
- **Billing — All Orgs (Latest)** — Export the latest complete billing period for every billable customer org in a single workbook (one sheet per org, sheet name truncated to 31 chars). Iterates trustor customers sequentially, calling `GET /api/v2/billing/trusteebillingoverview/{trustorOrgId}?billingPeriodIndex=1` per org. Supports email and scheduled automation (server-side handler `api/lib/exports/billingAllOrgsLatest.js`). Access key: `export.billing.allOrgsLatest`.
- **Billing — Calendar Year** — Export 12 months of billing data per org for a chosen calendar year (default: current year). Walks billing period indices 1..N, includes periods that fall within Jan–Dec of the target year (`period.start.year == calendarYear`), stops once 2 consecutive periods are entirely after the target year (`periods_after_year >= 2`) or on 404. Per-org sheet stacks all matched periods vertically with metadata banner + `Completed Periods` count, then per-period blue divider + green summary subheader + license rows. Supports email and scheduled automation — the scheduled handler (`api/lib/exports/billingCalendarYear.js`) always exports the **previous** calendar year (current year − 1). Access key: `export.billing.calendarYear`.
- **Billing — Date Range** — Export billing data for a custom month range (from-month/year to to-month/year, default: last 3 completed months) across all billable orgs. Period filter logic mirrors Python `_export_date_range`: a period is included if it overlaps `[fromDate, toDate]`; walk stops after 2 consecutive periods entirely before `fromDate` (`periods_past_range >= 2`). Per-org sheet has a top metadata banner with the range label and per-period blue divider + green `─── BILLING SUMMARY ───` subheader (period dates moved into the banner — no separate Billing Period k/v row). Browser only — no scheduled variant. Access key: `export.billing.dateRange`.
- **Billing — Custom Orgs** — Export a single billing period (Current / Latest complete / Two periods ago / Three periods ago) for a user-picked subset of orgs. Org checkbox list with select-all / deselect-all controls and a live `(N selected)` counter; one sheet per selected org. Browser only — no scheduled variant. Access key: `export.billing.customOrgs`.
- **Billing — Period Comparison** — Side-by-side comparison of 2–4 billing periods for a single org, with variance Δ / % columns between adjacent periods (green for positive, red for negative). Org dropdown + period checkboxes (auto-cap at MAX=4, auto-sorted chronologically oldest → newest on the sheet). Re-uses the cached billing overview from `fetchBillingPeriods` (no extra API calls). Unique single-sheet layout: merged title banner, generated timestamp, per-period header (Prepay Qty / Usage Qty / Overage Qty) merged with per-gap variance header (Δ Absolute / % Percentage). Comparison row built from shared `processBillingOverview` output: regular rows verbatim plus a synthesized `AI Tokens` row (prepay=`aiFairUse`, usage=`aiRollup`, overage=`aiBillable`) when `summary.hasAi`. Variance: `Δ = next.usage − cur.usage`; `% = Δ/cur` (or `±9999%` when `cur=0` and `Δ ≠ 0`). Browser only — no scheduled variant. Access key: `export.billing.periodComparison`.
- **Roles — Compare** — Three modes selectable via a top toggle:
  - **Compare Roles** — Compare permission policies across 2–10 roles from the same org side by side. Roles are loaded on page load; select any combination and click Compare to fetch each role's full permission set in parallel via `GET /api/v2/authorization/roles/{id}`. Wildcard permissions (`*` entity or `*` action) are automatically expanded against the full Genesys permission catalog (`GET /api/v2/authorization/permissions`). Results grouped by domain (collapsible) with a permission matrix: Entity column + one column per role showing action tags or `—`. Rows colour-coded: amber = differs, green = identical. Toggle All / Differences only, filter, expand/collapse all. Export to Excel: Domain, Entity, one column per role.
  - **Compare Users** — Compare the effective permissions of exactly 2 users. Search-as-you-type user picker (`POST /api/v2/users/search`, CONTAINS on name + email). For each user, direct role assignments are fetched via `GET /api/v2/authorization/subjects/{userId}` and group memberships via `GET /api/v2/users/{userId}?expand=groups`; each group's roles are fetched via `GET /api/v2/authorization/subjects/{groupId}` with the group name resolved via `GET /api/v2/groups/{groupId}`. Permissions are unioned per user with full attribution per cell: role name + **Assigned manually** or **Inherited from Group: GroupName**. Defaults to Differences only. Export to Excel includes a `ColName — via roles` attribution column per user.
  - **Hourly Interacting** — Check all or selected roles for CX Cloud (Hourly Interacting) readiness. Multi-select role picker with an "All roles" checkbox to scan every role in the org. Fetches the current list of 323 disqualifying permissions from `GET /api/scrape-disqualifying-permissions` (with static fallback) and the full permission catalog in parallel. Each role's policies are checked against the disqualifying list; wildcard `*` actions are expanded to actual permission names via the catalog. Roles with no disqualifying permissions are classified **CX Cloud Ready** (non-expandable); roles with at least one disqualifying permission are classified **Full CX** (expandable accordion showing a Domain / Entity / Forbidden Permissions table). Summary bar with total, CX Cloud Ready, and Full CX counts. Filter pills (All / CX Cloud Ready / Full CX), text filter, expand/collapse all. Export to Excel: Role, Domain, Entity, Forbidden Permissions, CX Cloud Ready. Access key: `roles.compare`.
- **Roles — Permissions vs. Users** — Two modes selectable via a top toggle:
  - **Permission Search** — Search for all users who hold a specific permission in the org. Select a domain, entity, and one or more actions from the full permission catalog. On search: (1) the catalog is used to find all roles that carry the permission (`GET /api/v2/authorization/roles?permission={domain}:{entity}:{action}` + client-side wildcard filter); (2) all org users are fetched with `expand=authorization` to cross-reference membership; (3) for each matching user the source is resolved asynchronously — direct assignment vs. inherited via group (batches of 10, using `GET /api/v2/authorization/subjects/{userId}`, `GET /api/v2/users/{userId}?expand=groups`, and per-group `GET /api/v2/authorization/subjects/{groupId}` + `GET /api/v2/groups/{groupId}`). Results stream into a table as they resolve. Trustee-org users are excluded. Client-side action-filter chips narrow results after load. Progress bar tracks Step 1 (catalog), Step 2b (per-user group fetch), and Step 3 (attribution). Export to Excel with filename `Roles_Search_{Org}_{Domain}_{Entity}_{Actions}_{timestamp}.xlsx`. Access key: `roles.search`.
  - **Hourly Interacting** — Analyse which users hold the `billing:user:hourlyInteracting` permission and whether they are eligible for the Hourly Interacting license or require a Full CX license. Fetches the current list of 323 disqualifying permissions from `GET /api/scrape-disqualifying-permissions` (with static fallback from `js/lib/hourlyDisqualifyingPermissions.js`). For each user with the billing permission, all their roles are checked against the disqualifying list. Users with no disqualifying permissions are classified **Hourly**; users with at least one disqualifying permission are classified **Full CX** with one result row per billing-role × forbidden-role combination. Status pills show unique user counts for each category. Export to Excel. Access key: `roles.search`.
- **Roles — Create** — Create a new authorization role with a full permission builder. Domain and entity are selected via searchable comboboxes fed from the permission catalog. Action checkboxes cascade from the entity selection. **Add** appends a policy row (the domain stays selected so the next entity can be picked immediately); adding a duplicate domain+entity merges actions. **Add All Entities** adds every entity in the selected domain at once with all their actions. Policy rows are grouped by domain under collapsible amber-labelled accordion sections (all expanded by default). Each row has an inline **✎ edit** button to modify its action set without removing and re-adding the row. For permissions where any selected action supports conditions (`allowConditions=true` in the catalog), an inline **Conditions** panel can be opened per row to configure a condition variable (QUEUE_ID, MEDIA_TYPE, SKILL_ID, or DIVISION_ID), operator (INCLUDES / EQUALS), and values (multi-select with search; queues, skills, and divisions are lazy-loaded). Submit creates a new role via `POST /api/v2/authorization/roles`. Access key: `roles.create`.
- **Roles — Edit** — Edit an existing authorization role. A searchable combobox loads all roles in the org (`GET /api/v2/authorization/roles`). Selecting a role fetches its full `permissionPolicies` (`GET /api/v2/authorization/roles/{id}`); wildcard actions (`actionSet:["*"]`) and wildcard entities (`entityName:"*"`) are automatically expanded against the catalog so `*` never appears as a raw tag. Policies are pre-loaded into the same permission builder used by Create, with domain sections collapsed by default in edit mode. The domain stays selected after adding an entity; **Add All Entities** adds all entities for the selected domain at once. Each row has an inline **✎ edit** button to modify its action set without removing and re-adding. Conditions panels are pre-populated from `resourceConditionNode`. Save submits a full-replace `PUT /api/v2/authorization/roles/{id}`. Access key: `roles.edit`.
- **Roles — Copy (Same Org)** — Copy an authorization role within the same org. A searchable combobox loads all roles; selecting one pre-fills the name with "Copy of {name}", the description, and the full permission builder with all policies expanded against the permission catalog. Name and description are freely editable before submitting. The complete permission builder (domain/entity/action picker, **Add All Entities**, inline **✎ edit**, Conditions panels) is available for review and adjustment. Optional **Make Hourly Interacting** checkbox: when checked, the created role has all disqualifying permissions stripped and `billing:user:hourlyInteracting` added at create-time; a collapsible post-creation summary lists every removed and added permission. Submit creates a new role via `POST /api/v2/authorization/roles`. Access key: `roles.copy.singleOrg`.
- **Roles — Copy (Between Orgs)** — Copy an authorization role from one customer org to another. Select a source org and target org, then click **Load Source Roles** — this fetches all roles from the source org and loads the permission catalog from both orgs in parallel. Selecting a source role pre-fills the name ("Copy of {name}"), description, and permission builder. Permissions that exist in the source org's catalog but are absent from the target org's catalog are flagged with ⚠ (kept by default, removable). The full permission builder is available to review and edit before creating. Optional **Make Hourly Interacting** checkbox: when checked, the created role has all disqualifying permissions stripped and `billing:user:hourlyInteracting` added at create-time; a collapsible post-creation summary lists every removed and added permission. Submit posts to `POST /api/v2/authorization/roles` on the **target** org. Access key: `roles.copy.betweenOrgs`.
- **Documentation Export** — Generate a full Genesys Cloud configuration export for a selected org, mirroring the Python `Export_All.py` output. Produces up to 42 alphabetically sorted configuration sheets (Agent Copilots, DID Numbers, Flows, Queues, Users, OAuth clients, Outbound, etc.) plus a styled Index cover sheet with table of contents and clickable hyperlinks. A second workbook containing all DataTable contents (one sheet per table with its rows, plus an Index cover sheet showing row counts) is bundled as a ZIP when present. Export can take 5–10 minutes for large orgs. Supports per-org scheduled automation.
- **Scheduled Exports** — Automate any export on a daily, weekly, or monthly schedule with email delivery. Per-export automation toggle, reusable schedule panel with org selector and custom config fields, "All Scheduled Exports" overview page with Last Run and Last Run Status columns (Success / Failure — error description). Server-side execution via Azure Timer Trigger (every 5 minutes) + Azure Functions. Catch-up logic ensures missed runs are retried. All times in Danish time (Europe/Copenhagen, CET/CEST).
- **Template Scheduling** — Automate template application to users, groups, and work teams via Azure Durable Functions for precise time-based execution. Targets (individual users, groups, and work teams) are selected when creating the schedule and stored with it; group and work team members are resolved live from Genesys at execution time. Supports Reset mode (wipe skills/languages/queues, re-apply template) and Add mode (additive). Schedule types: One-time, Daily, Weekly, Monthly. Durable Functions orchestrator computes exact fire times in Copenhagen timezone and sleeps via `createTimer` — no polling required.
- **Email notifications** — Send export results as email with attachments via Mailjet (EU-based, GDPR-compliant). Centralized email service reusable by any page.
- **GDPR — Subject Request** — Submit GDPR data subject requests for a selected customer org. Guided step-by-step flow: choose request type (Article 15 Right of Access, Article 16 Right to Rectification, Article 17 Right to Erasure), enter known identifiers (name, email, phone, address, social handles), review matched subjects returned by Genesys, enter replacement values for rectification requests, then confirm and submit. After submission, a direct link to Request Status is shown.
- **GDPR — Request Status** — View all previously submitted GDPR requests for a selected customer org. Columns: Date, Type, Subject, Subject Type, Status, Completed, Details, and full Request ID. For fulfilled Article 15 Access requests, individual request details are fetched to retrieve download URLs; files are downloaded via the authenticated proxy (not direct links). Expired downloads (Genesys retains exports for ~7 days) display a greyed-out "Expired" label with a tooltip instead of a broken link.
- **Flows — Journey Flow** — Visualise Genesys journey-flow path data for an Architect flow as an interactive SVG diagram. Pick an org and flow from a searchable combobox, select a date range and category, then click Load. All 8 categories (All, Abandoned, AgentEscalation, Complete, Disconnect, Error, RecognitionFailure, Transfer) are fetched in parallel on load and cached client-side — switching category in the dropdown re-renders instantly from cache with no additional API call. Nodes are sized proportionally to visit count, connected by Bézier edges scaled by flow count, and are draggable with a Reset Layout button. Milestone and outcome IDs are resolved to display names. Access key: `flows.journey`.
- **Direct Routing — Add user(s)** — Assign the `directrouting` integration tag to user phone numbers (Work Phone 1–3) or email addresses, manage the primary phone number, and configure agent-level backup routing. Multi-select user picker → Load Details fetches addresses + backup settings in parallel batches of 10. Only users with at least one Work Phone or email address are shown (others are skipped with a count). Email domain validation: inbound email domains are fetched from `GET /api/v2/routing/email/domains`; if a user's email domain is not configured in Genesys, the DR checkbox is hidden and an orange warning is shown. Collapsible Addresses and Backup Settings sections per user. Fixed-width address table (Type 20%, Address 40%, Primary 15%, Direct Routing 25%) for consistent column alignment across cards. Deselectable radio buttons for both Primary and Direct Routing (clicking a checked radio unchecks it). Bulk pre-select dropdown to set the same phone type across all loaded users. Backup routing supports None, User (search-as-you-type picker), or Queue (dropdown) with Wait for Agent toggle and configurable wait duration. Change detection: only users with actual modifications are submitted. Apply patches addresses/primary via `PATCH /api/v2/users/{id}` and backup via `PUT/DELETE /api/v2/routing/users/{id}/directroutingbackup/settings`. Progress bar and per-user status. Activity Log entry on completion. Access key: `users.directRouting.add`.
- **Divisions** — Reassign objects between divisions across the full Genesys Cloud object hierarchy. All pages share an identical two-column layout: load objects (with source-division filter + text search) on the left; choose target division and apply on the right. Table section is collapsible and auto-collapses after each apply. Uses `POST /api/v2/authorization/divisions/{id}/objects/{TYPE}`.
  - **People:** Users — Work Teams
  - **Routing:** Queues — Call Routes — Emergency Groups — Extension Pools — Routing Schedules — Routing Schedule Groups — Skill Groups
  - **Architect:** Flows *(with Type dropdown filter)* — Flow Milestones — Flow Outcomes — Scripts *(with Status column — Published/Draft — and Status filter)* — Data Tables
  - **Outbound:** Campaigns — Contact Lists — DNC Lists — Email Campaigns — Messaging Campaigns
  - **Workforce Management:** Business Units — Management Units
  - **Task Management:** Workbins — Work Types
- **Skill Templates — Create Template** — Create reusable templates of roles (with per-role division access), skills (with proficiency levels 1–5), language skills (with proficiency levels 1–5), and queues for bulk user provisioning. Templates are stored in Azure Table Storage (not in Genesys, which has no native template concept). Two-panel page: left panel lists all templates for the selected org (columns: Name, Roles, Skills, Languages, Queues, Created By, Actions); right panel is an inline editor with four collapsible sections (Roles, Skills, Language Skills, Queues). Roles section shows a role card per added role, each with an embedded division multi-select. Skills section has a searchable multi-select plus per-skill proficiency radio buttons (1–5, default 3). Language Skills section has a searchable multi-select plus per-language proficiency radio buttons (1–5, default 3). Queues section has a searchable multi-select. Full CRUD: create, edit (owner or admin only), delete (owner or admin only). Data is partitioned by org in the `skilltemplates` Azure Table. A 🕐 schedule button in each template row opens an inline schedule panel for automated template application. Access key: `users.rolesSkills.createTemplate`.
- **Skill Templates — Add Users To Templates** — Assign and remove users, groups, and work teams from skill templates. Two-panel page: left panel lists all templates for the selected org with a search filter (template list shows breakdown by type — e.g. "3 users · 1 group · 2 teams"); right panel shows template details (read-only horizontal collapsible sections for Roles, Skills, Languages, Queues), three side-by-side assigned columns (Users, Groups, Work Teams) with individual remove and bulk-remove via checkboxes, and three equal-width add sections (Add Users, Add Group, Add Work Team). Add Users supports three modes: Search (by name/email), By Group, and By Division. Add Group and Add Work Team use searchable single-select dropdowns (already-assigned entries are excluded). Adding a group or work team fetches all members and applies the template to each member automatically, with a confirm modal listing the member count before proceeding. Removing a group or work team strips the template from all members and deletes the assignment record. Granular progress bar for all operations. Template assignments are stored in Azure Table Storage (`templateassignments` table) with a `type` field (`user`, `group`, or `workteam`) plus entity metadata (`groupId`/`groupName` or `workteamId`/`workteamName`). Access key: `users.rolesSkills.addUsersToTemplates`.
- **Template Schedules** — Automate template application to users, groups, and work teams on a precise schedule. Two modes: **Reset** (wipe ALL existing skills, languages, and queue memberships, then re-apply only the template — roles are untouched) and **Add** (additive — merge template items on top of existing assignments). Schedule types: One-time, Daily, Weekly, Monthly. All times in Danish time (Europe/Copenhagen). Schedules are managed via an inline panel on the Create Template page (🕐 button) with a **Targets** section: search and add individual users (by name/email), groups (dropdown), or work teams (dropdown) — selected targets are displayed as removable chips with type labels (U/G/WT) and stored as a JSON array in the schedule. At least one target is required. Group and work team members are resolved live from the Genesys API at execution time, so membership changes are automatically picked up. Dedicated **Template Schedules** overview page showing all schedules with targets summary, enable/disable toggle, mode badge (Reset/Add), next run time, and last run status. Execution uses Azure Durable Functions for precise scheduling — an HTTP-triggered starter manages orchestrator instances that sleep via `context.df.createTimer(exactDateTime)` until the exact fire time, then call an activity that triggers the SWA template runner endpoint. Access key: `users.rolesSkills.templateSchedules`.
- **Copy from User** — Copy roles, skills, languages, and/or queue memberships from a source user to one or more target users. Three-step flow: (1) search & select source user — auto-fetches and displays counts of roles, skills, languages, and queues; (2) tick which categories to copy (all checked by default); (3) search & add one or more target users (shown as removable chips). Preview panel shows exactly what will be applied (role+division, skill+proficiency, language+proficiency, queue name). Each selected category is **reset** on every target — existing items are removed first, then the source's items are applied (categories not ticked are left untouched). Live progress bar, per-target log, and cancel button. Access key: `users.rolesSkills.copyFromUser`.
- **Configure Users** — Assign roles, skills, language skills, and queue memberships to one or more users at once. Two-panel layout: left panel for user selection, right panel for configuration. User selection modes: Search (by name/email), By Group, By Role, Reports To (search manager → pick → load direct reports), Location, and By Division — matching Genesys's native filter options. Right panel has an Apply button at the top, followed by five collapsible sections: Templates (multi-select to apply one or more saved templates), Roles (with per-role division picker), Skills (with proficiency 1–5), Language Skills (with proficiency 1–5), and Queues. In Add mode, each selected role must have at least one division selected before Apply is enabled. Template items and manual items are merged additively (no duplicates) on apply. Progress bar and per-user log (✓/✗) shown during execution. Genesys APIs used: `POST /api/v2/authorization/roles/{roleId}` (grant roles), `PATCH /api/v2/users/{userId}/routingskills/bulk` (skills), `PATCH /api/v2/users/{userId}/routinglanguages/bulk` (languages), `POST /api/v2/routing/queues/{queueId}/members` (queues). Access key: `users.rolesSkills.configureUsers`.
- **Activity Log** — Internal log of all write/mutative actions performed through the tool. Every create, copy, move, disconnect, publish, and GDPR submit records who did it, for which org, when, and a plain-language description. Visible to all logged-in users at `/activity-log` via the header link. Client-side filters: action type, org (admin only), user (admin only), and free-text search. Entries are stored in Azure Table Storage and fetched via `/api/activity-log`. Retention is indefinite; the log cannot be cleared from the UI.
- **Audit — Search** — Query Genesys Cloud audit events across any date range. Ranges ≤ 14 days automatically query **all realtime-supported services** concurrently using the synchronous `POST /api/v2/audits/query/realtime` endpoint (no polling, cursor-paginated to retrieve all results) — results appear in seconds. For ≤ 14-day ranges with a specific service not supported by the realtime endpoint, falls back to the standard async query API automatically. Ranges > 14 days require a service selection and always use the async chunked pipeline (`POST /api/v2/audits/query` → poll → cursor-paginated results, 30-day chunks). Preset quick-filters: Today, Last 7 days, Last month, Last 3 months. Auto-runs today's query on page load with no service pre-selected (all services). Client-side filters: Entity Type → Action (cascading) + Changed By. Results table: Date & Time, Service, Entity Type, Entity Name (resolved via 40+ mapped API paths with `(deleted)` label on 404), Action, Changed By (user or OAuth client name). Click any row to expand a detail panel showing metadata, changed properties (old → new values), additional context, and a raw API response dump. Sticky table header, sortable latest-first, configurable rows per page (50/100/150/200). A blue/amber hint below the service dropdown indicates the current query mode. **Export to Excel** button (far right of filter bar) exports all filtered results — one row per property change — with columns: Date & Time, Service, Entity Type, Entity Name, Action, Changed By, Level, Remote IP, Property, Old Value, New Value, Additional Context.
- **Utilities — IP Ranges** — View public IP address ranges (CIDR blocks) for firewall whitelisting in two modes via a top toggle. **Genesys Public IP Ranges** mode lists per-region ranges proxied from `GET /api/v2/ipranges` using client-credentials auth (a configured customer org in the requested region); all 15 Genesys regions appear in the region dropdown, and regions without configured credentials are marked **"— no creds"** and return a clear error when selected. Four Cloud Media Services CIDRs — which Genesys publishes only in the Help Center, not via the API — are injected server-side as `CLOUD_MEDIA_SERVICES` entries for commercial regions (FedRAMP excluded). **Amazon IP Ranges** mode loads the global AWS feed (`https://ip-ranges.amazonaws.com/ip-ranges.json`) via `GET /api/aws-ipranges` (anonymous, 15-min in-process cache, `?force=true` to bypass), with a region picker populated from the feed (default `eu-central-1`). Both modes share: group-by (Service groups / flat table), direction (Genesys) or IP-type (AWS) filter, CIDR text search, and a searchable multi-select **Services** dropdown. Collapsible service groups, sortable columns, **Copy CIDRs**, and **Export to Excel**. Access key: `utilities.ipRanges`.
- **Alphabetical nav sorting** — All menu items are always sorted alphabetically at every level
- **Top-level menu groups** — Data Actions, Data Tables, Deployment, Divisions, Export, Interactions, Phones, Roles, and Users each have their own top-level nav section
- **Editable filter tags** — Click a filter tag to edit it; right-click a result row to copy its Conversation ID

### Platform

- **Secure credential storage** — Customer Client IDs/Secrets managed in Azure Key Vault, delivered to the backend via encrypted app settings
- **Org selector** — Pick any customer org from a dropdown; all pages use that org
- **Proxied API calls** — All Genesys API calls go through an Azure Functions backend that handles authentication
- **Centralized API service** — Shared `genesysApi.js` module with helpers for analytics, users, queues, flows, data tables, data actions, integrations, divisions, and more
- **OAuth PKCE login** — Team members authenticate via Genesys Cloud (your own org)
- **Refresh Token** — Header button clears the current session and forces a fresh PKCE login, useful for clearing a stale token
- **Welcome page** — App always starts on a clean welcome screen; no page or org is pre-selected
- **Dark/light theme** — Adapts to OS preference automatically
- **Iframe-safe Excel export** — Uses SheetJS (xlsx-js-style) with a `download.html` helper page for reliable downloads inside Genesys Cloud iframes. Data is passed via `window.opener` (not the URL hash) to support large exports without hitting browser URL-length limits. All exports use standard cell styling: blue header, alternating rows, auto-filter, frozen row.

## Architecture

The app runs as **two separate Function Apps** plus a Static Web App frontend, and is deployed as **two independent environments — dev and prod** (see [Environments](#environments)):

1. **Static Web App (Standard plan)** — hosts the SPA and the HTTP-triggered API in [api/](api/) (14 functions, Node.js 18).
2. **Timer / Durable Function App (Consumption — Windows)** — separate Function App in [timer-functions/](timer-functions/) that owns the timer trigger and the Durable Functions orchestrator/activity used for precise template-schedule execution.

### Environments

Two isolated environments run the same codebase from two branches:

| | Dev | Prod |
| --- | --- | --- |
| Branch | `main` | `production` |
| Static Web App | `genesys-admin-app-dev` | `genesys-admin-app-prod` |
| Storage account | separate (dev) | separate (prod) |
| Key Vault | `genesys-admin-kv-dev` | `genesys-admin-kv-prod` |
| Timer Function App | `genesys-admin-timer-dev` | `genesys-admin-timer-prod` |
| Resource group | `Genesys_Apps_DEV` | `Genesys_Apps_PROD` |

Each branch has its own SWA CI/CD workflow (`.github/workflows/azure-static-web-apps-*.yml`) with its own deploy token. `js/config.js` derives `oauthRedirectUri` from `window.location.origin`, so the same code works on both URLs — **both SWA URLs must be registered as Authorized redirect URIs** on the shared Genesys OAuth client. Develop on `main` (→ dev), then merge `main` → `production` (→ prod).

```text
Browser (SPA)                    Azure Static Web App (Standard)
┌─────────────┐                 ┌────────────────────────────────────────────┐
│  Frontend   │───── /api/* ───▶│  Azure Functions — HTTP API (Node 18)      │
│  (JS SPA)   │                 │    ├─ GET  /api/customers                  │
│             │                 │    ├─ POST /api/genesys-proxy              │
│  Org select │                 │    ├─ POST /api/send-email ───────────────────▶ Mailjet API
│  dropdown   │                 │    ├─ *    /api/schedules                  │   (EU servers)
└─────────────┘                 │    ├─ POST /api/scheduled-runner           │
                                │    ├─ *    /api/template-schedules         │
                                │    ├─ POST /api/template-runner            │
                                │    ├─ *    /api/templates                  │
                                │    ├─ *    /api/template-assignments       │
                                │    ├─ *    /api/activity-log               │
                                │    ├─ POST /api/doc-export                 │
                                │    ├─ GET  /api/ipranges (Genesys)         │
                                │    ├─ GET  /api/aws-ipranges (Amazon) ────────▶ ip-ranges.amazonaws.com
                                │    └─ GET  /api/scrape-disqualifying-      │
                                │             permissions                    │
                                └────────┬───────────────────────────────────┘
                                         │
                                         │ HTTP (function key)
                                         ▼
 Azure Timer / Durable Function App (Consumption, Windows — separate resource)
┌──────────────────────────────────────────────────────────────────┐
│  timer-functions/                                                │
│   ├─ schedule-trigger          (TimerTrigger — every 5 min)      │
│   │     └─ POSTs ──▶ /api/scheduled-runner   (export schedules)  │
│   │                                                              │
│   ├─ template-schedule-starter (HTTP — called from SWA API on    │
│   │     schedule create/update; starts an orchestrator instance) │
│   ├─ template-schedule-orchestrator                              │
│   │     (Durable — sleeps via createTimer(exactDateTime),        │
│   │      then invokes the activity at the scheduled moment)      │
│   └─ template-schedule-activity                                  │
│         (Calls Genesys APIs to apply the template to targets)    │
└──────────────────────────────────────────────────────────────────┘

          Encrypted app settings (both Function Apps)
          ─────────────────────────────────────────────
          GENESYS_<ORG>_CLIENT_ID / GENESYS_<ORG>_CLIENT_SECRET   (per customer)
          MAILJET_API_KEY / MAILJET_SECRET_KEY
          AZURE_STORAGE_CONNECTION_STRING
          SCHEDULE_RUNNER_KEY    + TIMER_FUNCTION_URL              (export schedules)
          TEMPLATE_RUNNER_KEY    + TEMPLATE_FUNCTION_URL           (template schedules)
                                         │
                          ┌──────────────┴───────────────┐
                          ▼                              ▼
                   ┌──────────────┐             ┌────────────────────┐
                   │ Azure Key    │             │ Azure Table        │
                   │ Vault        │             │ Storage            │
                   │ (source of   │             │  ├─ schedules      │
                   │  truth for   │             │  ├─ skilltemplates │
                   │  secrets)    │             │  ├─ templateassign │
                   │              │             │  │   ments         │
                   │              │             │  ├─ templateschedu │
                   │              │             │  │   les           │
                   │              │             │  └─ activitylog    │
                   └──────────────┘             └────────────────────┘
```

### Function inventory

| Function | Trigger | Folder | Purpose |
| --- | --- | --- | --- |
| `customers` | HTTP GET | [api/customers/](api/customers/) | Returns the customer list (`customers.json`) for the org dropdown |
| `genesys-proxy` | HTTP POST | [api/genesys-proxy/](api/genesys-proxy/) | Authenticated proxy for all Genesys Cloud API calls (client-credentials per org) |
| `ipranges` | HTTP GET | [api/ipranges/](api/ipranges/) | Genesys public IP ranges per region (client-credentials); injects Cloud Media Services CIDRs for commercial regions |
| `aws-ipranges` | HTTP GET | [api/aws-ipranges/](api/aws-ipranges/) | Proxies the Amazon `ip-ranges.json` feed (anonymous, 15-min server-side cache) |
| `send-email` | HTTP POST | [api/send-email/](api/send-email/) | Sends export results via Mailjet (EU) |
| `schedules` | HTTP CRUD | [api/schedules/](api/schedules/) | CRUD for scheduled exports (Table Storage) |
| `scheduled-runner` | HTTP POST | [api/scheduled-runner/](api/scheduled-runner/) | Invoked every 5 min by the timer trigger; runs due export schedules |
| `template-schedules` | HTTP CRUD | [api/template-schedules/](api/template-schedules/) | CRUD for template schedules; notifies the Durable starter on changes |
| `template-runner` | HTTP POST | [api/template-runner/](api/template-runner/) | Applies a template to users/groups/work teams on demand or from the orchestrator |
| `templates` | HTTP CRUD | [api/templates/](api/templates/) | CRUD for skill templates (Table Storage) |
| `template-assignments` | HTTP CRUD | [api/template-assignments/](api/template-assignments/) | CRUD for template→user/group/work-team assignments |
| `activity-log` | HTTP GET/POST | [api/activity-log/](api/activity-log/) | Reads and writes audit-log entries (Table Storage) |
| `doc-export` | HTTP POST | [api/doc-export/](api/doc-export/) | Generates the Documentation Export workbook (config + data tables) |
| `scrape-disqualifying-permissions` | HTTP GET | [api/scrape-disqualifying-permissions/](api/scrape-disqualifying-permissions/) | Live scrape of CX Cloud disqualifying permissions list |
| `schedule-trigger` | TimerTrigger (every 5 min) | [timer-functions/schedule-trigger/](timer-functions/schedule-trigger/) | Wakes up and POSTs to `/api/scheduled-runner` |
| `template-schedule-starter` | HTTP POST | [timer-functions/template-schedule-starter/](timer-functions/template-schedule-starter/) | Starts a Durable orchestrator instance for a template schedule |
| `template-schedule-orchestrator` | Durable Orchestrator | [timer-functions/template-schedule-orchestrator/](timer-functions/template-schedule-orchestrator/) | Sleeps until the scheduled moment, then calls the activity |
| `template-schedule-activity` | Durable Activity | [timer-functions/template-schedule-activity/](timer-functions/template-schedule-activity/) | Calls Genesys APIs to apply the template at execution time |

> **Note:** [timer-functions-check/](timer-functions-check/) is a parallel copy of the Durable Function App used as a staging/verification deployment. The empty stub folders [api/recordings-export/](api/recordings-export/) and [api/recordings-export-runner/](api/recordings-export-runner/) are placeholders (no code) and can be ignored or removed before deployment.

- **Frontend:** Vanilla JavaScript SPA with hash-based routing, deployed as an Azure Static Web App
- **Backend:** Azure Functions (Node.js 18) auto-deployed from the `api/` folder
- **Secrets:** Azure Key Vault is the source of truth; secret values are copied into encrypted SWA app settings read via `process.env`
- **CI/CD:** GitHub Actions — push to `main` triggers automatic deployment

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Vanilla JS (ES Modules), HTML, CSS |
| Backend API | Azure Functions (Node.js) |
| Hosting | Azure Static Web Apps (Standard) |
| Secrets | Azure Key Vault |
| Auth (team) | Genesys Cloud OAuth 2.0 PKCE |
| Auth (customers) | OAuth 2.0 Client Credentials (via backend) |
| Email | Mailjet v3.1 Send API (EU, GDPR-compliant) |
| Schedule & template storage | Azure Table Storage |
| Scheduled runner | Azure Timer Trigger (every 5 min, Consumption/Windows Function App) |
| Template scheduling | Azure Durable Functions (precise timer-based orchestration) |
| CI/CD | GitHub Actions |

## Project Structure

```text
genesys-admin-app/
├── index.html                    App shell
├── download.html                 Iframe-safe file download helper
├── staticwebapp.config.json      SPA routing + Node 18 runtime config
├── css/styles.css                Styles (dark + light theme)
├── .github/
│   └── workflows/
│       ├── azure-static-web-apps-*.yml   SWA CI/CD (auto-generated)
│       └── scheduled-runner.yml          Manual trigger for scheduled exports (cron disabled)
├── js/
│   ├── app.js                    App entry point (auth, routing, org selector)
│   ├── config.js                 OAuth & region config
│   ├── nav.js                    Sidebar navigation renderer (alphabetical sorting)
│   ├── navConfig.js              Navigation tree definition
│   ├── pageRegistry.js           Route → page loader map
│   ├── router.js                 Hash-based SPA router
│   ├── utils.js                  Shared utilities (formatting, Excel export, etc.)
│   ├── accessConfig.js           Access control mapping (group name → access keys)
│   ├── lib/
│   │   ├── xlsx.bundle.js        xlsx-js-style library (SheetJS + cell styling)
│   │   ├── hourlyDisqualifyingPermissions.js  Static snapshot of 323 disqualifying permissions for Hourly Interacting
│   │   ├── jspdf.umd.min.js     jsPDF library (PDF export)
│   │   ├── jszip.min.js          JSZip library (ZIP file creation)
│   │   └── svg2pdf.umd.min.js   svg2pdf library (SVG-to-PDF conversion)
│   ├── components/
│   │   ├── multiSelect.js        Reusable multi-select dropdown
│   │   └── schedulePanel.js      Reusable automation schedule panel
│   ├── pages/
│   │   ├── welcome.js            Welcome / landing page
│   │   ├── notfound.js           404 page
│   │   ├── accessdenied.js       Access denied page
│   │   ├── placeholder.js        Generic "coming soon" stub
│   │   ├── activityLog.js        Internal activity log viewer
│   │   ├── audit/
│   │   │   └── search.js            Audit Search (realtime + async dual-path, preset filters, row-expand detail panel, Export to Excel)
│   │   ├── dataactions/
│   │   │   ├── copyBetweenOrgs.js   Copy data action between orgs
│   │   │   └── edit.js              Edit / test existing data actions
│   │   ├── datatables/
│   │   │   ├── create.js            Create data table (schema builder, drag-to-reorder columns, Excel import)
│   │   │   ├── edit.js              Edit existing data table (Schema/Rows toggle, bulk row grid, add/delete/undo/search/pagination)
│   │   │   ├── copySingleOrg.js     Copy table within same org
│   │   │   └── copyBetweenOrgs.js   Copy table between orgs
│   │   ├── deployment/
│   │   │   ├── basic.js             Bulk-deploy DID Pools, Divisions, Sites, Skills, Number Plans, Outbound Routes, Schedules, Schedule Groups, Wrapup Codes, Queues, Users (upsert by name where supported)
│   │   │   └── datatables.js        Bulk-create data tables from Excel workbook
│   │   ├── divisions/
│   │   │   ├── _generic.js          Shared generic renderer with hooks (extraFilters, extraFilterFn, onItemsLoaded)
│   │   │   ├── users.js             People — Users
│   │   │   ├── team.js              People — Teams
│   │   │   ├── queues.js            Routing — Queues
│   │   │   ├── callroute.js         Routing — Call Routes
│   │   │   ├── emergencyGroups.js   Routing — Emergency Groups
│   │   │   ├── extensionPool.js     Routing — Extension Pools
│   │   │   ├── routingSchedules.js  Routing — Schedules
│   │   │   ├── routingScheduleGroups.js  Routing — Schedule Groups
│   │   │   ├── skillGroup.js        Routing — Skill Groups
│   │   │   ├── flow.js              Architect — Flows (Type dropdown filter)
│   │   │   ├── flowMilestone.js     Architect — Flow Milestones
│   │   │   ├── flowOutcome.js       Architect — Flow Outcomes
│   │   │   ├── script.js            Architect — Scripts (Status column + filter)
│   │   │   ├── dataTables.js        Architect — Data Tables
│   │   │   ├── campaign.js          Outbound — Campaigns
│   │   │   ├── contactList.js       Outbound — Contact Lists
│   │   │   ├── dncList.js           Outbound — DNC Lists
│   │   │   ├── emailCampaign.js     Outbound — Email Campaigns
│   │   │   ├── messagingCampaign.js Outbound — Messaging Campaigns
│   │   │   ├── businessUnit.js      Workforce Mgmt — Business Units
│   │   │   ├── managementUnit.js    Workforce Mgmt — Management Units
│   │   │   ├── workbin.js           Task Mgmt — Workbins
│   │   │   └── worktype.js          Task Mgmt — Worktypes
│   │   ├── gdpr/
│   │   │   ├── subjectRequest.js    GDPR Subject Request (Articles 15, 16, 17)
│   │   │   └── requestStatus.js     GDPR Request Status + Article 15 download links
│   │   ├── interactions/
│   │   │   ├── search.js            Historical Interaction Search (>48h, async jobs API, 7-day chunking)
│   │   │   ├── searchRecent.js      Recent Interaction Search (<48h, sync query API)
│   │   │   ├── move.js              Move Interactions between queues
│   │   │   ├── disconnect.js        Force-disconnect conversations (parallel batch of 10, status + progress only)
│   │   │   └── transcripts/
│   │   │       └── search.js        Transcript Search (date+filters or ID list, STA transcript check, live chart, click-to-expand)
│   │   ├── roles/
│   │   │   ├── compare.js           Roles Compare — three modes: Compare Roles (permission matrix with wildcard expansion), Compare Users, Hourly Interacting (CX Cloud readiness check)
│   │   │   ├── search.js            Roles Permissions vs. Users — mode toggle: Permission Search + Hourly Interacting
│   │   │   ├── hourlyInteracting.js Hourly Interacting analysis — lazy-loaded from search.js, classifies Hourly vs Full CX
│   │   │   ├── create.js            Roles Create / Edit / Copy (Same Org) — shared module (mode param), permission builder with conditions
│   │   │   └── copy/
│   │   │       ├── copySingleOrg.js  Thin wrapper: calls create.js with mode="copySingle"
│   │   │       └── copyBetweenOrgs.js Copy role between orgs — own builder, target-org catalog comparison
│   │   ├── users/
│   │   │   └── rolesSkills/
│   │   │       ├── addUsersToTemplates.js Add Users To Templates — assign/remove users from templates
│   │   │       ├── configureUsers.js Configure Users — Assign roles, skills, languages, queues to users (single or bulk)
│   │   │       ├── createTemplate.js Skill Templates — Create/Edit/Delete templates (roles, skills, languages, queues) + schedule button
│   │   │       ├── templateSchedules.js Template Schedules overview — enable/disable, status, delete
│   │   │       └── copyFromUser.js  Copy from User — reset-copy roles/skills/languages/queues from one user to targets
│   │   ├── flows/
│   │   │   └── journeyFlow.js       Journey Flow — interactive SVG flow-path diagram (client-side category cache)
│   │   ├── export/
│   │   │   ├── scheduledExports.js   All Scheduled Exports overview (with Last Run Status column)
│   │   │   ├── licenses/
│   │   │   │   └── consumption.js   License Consumption export + per-org automation
│   │   │   ├── documentation/
│   │   │   │   └── create.js        Documentation export (full config workbook + DataTables ZIP, per-org scheduled automation)
│   │   │   ├── roles/
│   │   │   │   ├── allOrgs.js       Roles export — all orgs, multi-sheet workbook
│   │   │   │   └── singleOrg.js     Roles export — single org + automation
│   │   │   ├── interactions/
│   │   │   │   └── totals.js        Interaction Totals — bar charts by media/direction/routing + export/email/schedule
│   │   │   └── users/
│   │   │       ├── allGroups.js     All Groups export + per-org automation
│   │   │       ├── allRoles.js      All Roles export + per-org automation
│   │   │       ├── filteredRoles.js  Filtered on Role(s) export + dynamic role picker
│   │   │       ├── lastLogin.js      Last Login export + per-org automation
│   │   │       ├── skillTemplates.js Skill/Role/Queue Templates export + per-org automation
│   │   │       └── trustee.js       Trustee access matrix export + automation
│   │   ├── phones/
│   │   │   └── webrtc/
│   │   │       ├── changeSite.js     Change site for WebRTC phones
│   │   │       └── createWebRtc.js  Bulk-create WebRTC phones
│   │   └── utilities/
│   │       └── ipRanges.js          IP Ranges — Genesys + Amazon public CIDR viewer (dual-mode toggle)
│   └── services/
│       ├── apiClient.js          HTTP client + Genesys proxy wrapper
│       ├── authService.js        OAuth 2.0 PKCE authentication
│       ├── customerService.js    Customer list loader
│       ├── emailService.js       Centralized email service (Mailjet via /api/send-email)
│       ├── genesysApi.js         Centralized Genesys Cloud API service
│       ├── activityLogService.js  Write entries to the internal activity log
│       ├── orgContext.js         Selected org state management
│       ├── scheduleService.js    Schedule CRUD API wrappers
│       ├── templateScheduleService.js  Template schedule CRUD API wrappers
│       ├── templateService.js    Template CRUD API wrappers
│       └── templateAssignmentService.js  Template assignment CRUD (users, groups, work teams)
├── api/                          Azure Functions backend
│   ├── customers/                GET /api/customers
│   ├── aws-ipranges/             GET /api/aws-ipranges (Amazon IP ranges feed — anonymous, 15-min cache)
│   ├── doc-export/               POST /api/doc-export (on-demand documentation export)
│   ├── genesys-proxy/            POST /api/genesys-proxy
│   ├── ipranges/                 GET /api/ipranges (Genesys IP ranges — client-credentials per region)
│   ├── scrape-disqualifying-permissions/  GET /api/scrape-disqualifying-permissions (Hourly Interacting)
│   ├── send-email/               POST /api/send-email (Mailjet)
│   ├── schedules/                CRUD /api/schedules (schedules management)
│   ├── scheduled-runner/         POST /api/scheduled-runner (export execution)
│   ├── template-schedules/       CRUD /api/template-schedules (template schedule management)
│   ├── template-runner/          POST /api/template-runner (template execution engine — reset/add modes)
│   ├── templates/                CRUD /api/templates (skill template management)
│   ├── template-assignments/     CRUD /api/template-assignments (user/group/workteam ↔ template mapping)
│   └── lib/
│       ├── customers.json        Customer metadata (15 orgs)
│       ├── genesysAuth.js        Client Credentials token cache per org
│       ├── scheduleStore.js      Azure Table Storage CRUD for schedules
│       ├── templateScheduleStore.js  Azure Table Storage CRUD for template schedules
│       ├── templateStore.js      Azure Table Storage CRUD for skill templates
│       ├── templateAssignmentStore.js  Azure Table Storage CRUD for template assignments (users, groups, work teams)
│       ├── exportHandlers.js     Export type → handler registry
│       └── exports/
│           ├── allGroups.js         Server-side All Groups export handler
│           ├── allRoles.js          Server-side All Roles export handler
│           ├── documentation.js     Server-side Documentation export (42 sheets + DataTables workbook)
│           ├── filteredRoles.js     Server-side Filtered on Role(s) export handler
│           ├── licensesConsumption.js Server-side License Consumption export handler
│           ├── interactionTotals.js Server-side Interaction Totals export handler
│           ├── rolesSingleOrg.js    Server-side Roles Single Org export handler
│           ├── lastLogin.js         Server-side Last Login export handler
│           ├── skillTemplates.js     Server-side Skill/Role/Queue Templates export handler
│           └── trustee.js           Server-side trustee export handler
└── docs/
    ├── setup-guide.md            Full deployment guide
    ├── api-reference.md          Complete list of all API endpoints used
    └── conversion-reference.md   Python → JS migration reference
```

## Scheduled Exports

The app supports automated, server-side export execution with email delivery.

### How it works

1. **Schedule creation** — On any export page with automation enabled (e.g. Trustee, Last Login, All Roles, All Groups, Filtered on Role(s), License Consumption, Skill Templates), toggle on automation and configure a daily/weekly/monthly schedule with email recipients. Per-org exports include an org selector in the schedule form; Filtered on Role(s) also shows a dynamic role picker; License Consumption also shows a dynamic licence filter; Last Login also has an inactivity filter.
2. **Azure Timer Trigger** — A standalone Azure Function App (`genesys-admin-timer`) fires every 5 minutes and POSTs to `/api/scheduled-runner` with a shared secret
3. **Server-side execution** — The Azure Function checks Azure Table Storage for due schedules, runs the export using client credentials, and emails the result via Mailjet
4. **Catch-up logic** — If a run is missed, the next cycle picks it up automatically. Only one run per schedule per day.
5. **All times are Danish time** — Europe/Copenhagen (CET in winter, CEST in summer)

### Template Schedules

Template schedules use Azure Durable Functions for precise scheduling instead of polling.

1. **Schedule creation** — On the Create Template page, click the 🕐 button to open an inline schedule panel. Choose Reset or Add mode, schedule type (One-time, Daily, Weekly, Monthly), and time/day settings. Add targets: search for individual users by name/email, select groups from a dropdown, or select work teams from a dropdown. Selected targets are shown as removable chips with type labels. At least one target is required.
2. **Durable Functions orchestrator** — When a schedule is created or updated, the SWA API notifies the `genesys-admin-timer` Function App via an HTTP starter endpoint. The starter launches a Durable Functions orchestrator that computes the exact next fire time in Copenhagen timezone and sleeps via `context.df.createTimer(exactDateTime)` — no polling.
3. **Activity execution** — When the timer fires, the orchestrator calls an activity function that POSTs to `/api/template-runner` on the SWA with the schedule ID.
4. **Template runner** — The SWA endpoint resolves the schedule, loads the template, and reads the stored targets array. For user targets, the user ID is used directly. For group targets, members are fetched live from `GET /api/v2/groups/{id}/members`. For work team targets, members are fetched live from `POST /api/v2/teams/{id}/members/query`. All resolved user IDs are deduplicated, then the template is applied in the configured mode (Reset: wipe skills/languages/queues then re-apply; Add: merge additively). Roles are never touched.
5. **Recurring schedules** — After execution, the orchestrator calls `context.df.continueAsNew()` to loop and compute the next fire time. One-time schedules complete after a single execution.

### Permissions

- Any logged-in user can create a schedule
- Only the creator (or admin `thva@tdc.dk`) can edit or delete a schedule
- The "All Scheduled Exports" overview page lists all schedules across all export types

### Required configuration

See [docs/setup-guide.md](docs/setup-guide.md) for full details. In summary:

| Setting | Where | Purpose |
| --- | --- | --- |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure SWA app settings | Azure Table Storage for schedule data |
| `SCHEDULE_RUNNER_KEY` | Azure SWA app settings + Timer Function App | Shared secret to protect the runner endpoints |
| `SWA_URL` | Azure Timer Function App setting | Static Web App URL for the timer trigger to call |
| `TIMER_FUNCTION_URL` | Azure SWA app settings | Timer Function App URL for Durable Functions notifications |

## Quick Start (local development)

1. Serve the frontend with any static file server:

   ```bash
   npx serve .
   ```

2. For the API, install and use the [Azure Static Web Apps CLI](https://github.com/Azure/static-web-apps-cli):

   ```bash
   npm install -g @azure/static-web-apps-cli
   cd api && npm install && cd ..
   swa start . --api-location api
   ```

3. Log in to Azure CLI (`az login`) for local Key Vault access

## Deployment

See [docs/setup-guide.md](docs/setup-guide.md) for the complete step-by-step deployment guide covering:

- Azure Static Web App creation (Standard plan)
- Azure Key Vault setup
- Managed Identity + RBAC configuration
- Customer credential import
- Mailjet email service configuration
- GitHub Actions CI/CD
- Genesys Cloud OAuth client setup

## Adding a New Customer

1. Add 2 secrets to Azure Key Vault:

   ```bash
   az keyvault secret set --vault-name genesys-admin-kv \
     --name "genesys-<id>-client-id" --value "..."
   az keyvault secret set --vault-name genesys-admin-kv \
     --name "genesys-<id>-client-secret" --value "..."
   ```

2. Copy the values into SWA app settings (env var names use underscores, uppercase):

   ```bash
   az staticwebapp appsettings set --name genesys-admin-app \
     --resource-group genesys-admin-app_group \
     --setting-names "GENESYS_<ID>_CLIENT_ID=..." "GENESYS_<ID>_CLIENT_SECRET=..."
   ```

3. Add an entry to `api/lib/customers.json`:

   ```json
   { "id": "<id>", "name": "Customer Name", "region": "mypurecloud.de" }
   ```

4. Commit and push

## Adding a New Feature Page

1. Create a page module in `js/pages/<category>/` (folder should mirror the nav tree)
2. Register the route in `js/pageRegistry.js`
3. Add a nav entry in `js/navConfig.js`
4. Commit and push

Pages receive `{ route, me, api, orgContext }` and can call customer APIs via:

```javascript
// Direct proxy call
const data = await api.proxyGenesys(orgContext.get(), "GET", "/api/v2/...");

// Or use the centralized Genesys API service (preferred)
import { fetchAllQueues } from "../services/genesysApi.js";
const queues = await fetchAllQueues(api, orgContext.get());
```

## License

Internal tool — not for public distribution.
