# Python Tool → Web App Conversion Reference

This document maps every function in the Python Genesys Admin Tool to what's needed to convert it for the Genesys Admin Web App. Use this as a lookup when porting a feature.

---

## Table of Contents

1. [Architecture Differences](#architecture-differences)
2. [Conversion Patterns](#conversion-patterns)
3. [Function Reference by Category](#function-reference-by-category)
   - [Actions (Phone Management)](#1-actions-phone-management)
   - [Conversations](#2-conversations)
   - [CSV Import (Create from CSV)](#3-csv-import-create-from-csv)
   - [CSV Export (Get to CSV)](#4-csv-export-get-to-csv)
   - [Data Actions](#5-data-actions)
   - [Data Tables](#6-data-tables)
   - [Flows](#7-flows)
   - [Users](#8-users)
   - [GDPR](#9-gdpr)
   - [Billing](#10-billing)
   - [Documentation Export](#11-documentation-export)
4. [Conversion Priority Suggestions](#conversion-priority-suggestions)

---

## Architecture Differences

| Aspect | Python Tool | Web App |
| --------- | ------------- | --------- |
| **Auth** | `GenesysAPIClient(client_id, client_secret, env).authenticate()` | `api.proxyGenesys(orgId, method, path)` — backend handles auth |
| **Credentials** | `load_credentials()` from local config files | Azure Key Vault via Managed Identity (automatic) |
| **Customer selection** | Login dialog → pick org config file | Org selector dropdown in header |
| **API calls** | Direct via PureCloud SDK (`UsersApi`, `RoutingApi`, etc.) | Via proxy: `api.proxyGenesys(orgId, "GET", "/api/v2/...")` |
| **File input (CSV/Excel)** | `tkinter.filedialog` → local filesystem | File upload `<input type="file">` → parsed in browser |
| **File output (CSV/Excel)** | Written to local filesystem | Generated in browser → download via Blob URL |
| **Progress** | `log_progress("PROGRESS:XX")` → GUI progress bar | Progress bar element in the page DOM |
| **Pagination** | `while True` loop with `page_number++` | Same loop, but inside the Azure Function or chained frontend calls |
| **Subprocess model** | GUI tab runs script as `subprocess.Popen(sys.argv)` | Page calls `api.proxyGenesys()` directly |

---

## Conversion Patterns

### Pattern 1: Read-only Export (List/Get data)

**Python:** Script fetches data → writes CSV/Excel to disk
**Web App:** Page calls proxy → displays data in table → optional "Download CSV" button

```text
Python source file → Read API endpoints → Create page with:
  1. Fetch data via api.proxyGenesys()
  2. Render in HTML table
  3. Add "Export CSV" button that generates download in browser
```

**Where to look in Python:**

- `GUI/Scripts/GUI_CSV_*_Get.py` — the API call logic and column definitions
- `GUI/Scripts/GUI_Users_Export_*.py` — the API call logic and data transformations
- `GUI/Scripts/GUI_Documentation_*_Export.py` — the API endpoints and field mappings

### Pattern 2: CSV/Excel Import (Create/Configure)

**Python:** Script reads CSV → calls POST/PUT APIs for each row
**Web App:** User uploads file → page parses it → calls proxy for each row with progress

```text
Python source file → Read CSV column expectations + API calls → Create page with:
  1. File upload input
  2. Parse CSV in browser (use FileReader API)
  3. Loop rows, call api.proxyGenesys() for each
  4. Show progress bar + results table
```

**Where to look in Python:**

- `GUI/Scripts/GUI_CSV_*_Create.py` — CSV column format and API payloads
- `GUI/Config/GUI_tab_csv_add.py` — UI input fields and validation

### Pattern 3: Action (No file I/O)

**Python:** Script takes parameters → makes API calls → returns results
**Web App:** Page with input fields → calls proxy → shows results

```text
Python source file → Read input parameters + API calls → Create page with:
  1. Input fields (text, dropdowns)
  2. "Execute" button
  3. Progress/results display
```

**Where to look in Python:**

- `GUI/Scripts/GUI_Actions_*.py` — the action logic
- `GUI/Scripts/GUI_Conversations_*.py` — the action logic
- `GUI/Config/GUI_tab_actions_*.py` — UI layout and input validation

---

## Function Reference by Category

### 1. Actions (Phone Management)

#### Change Phone Site

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Actions_Phones_ChangeSite.py` |
| **GUI tab** | `GUI/Config/GUI_tab_actions_phones_change_site.py` |
| **What it does** | Moves all phones from one site to another |
| **API endpoints** | `GET /api/v2/telephony/providers/edges/sites`, `GET /api/v2/telephony/providers/edges/phones`, `PUT /api/v2/telephony/providers/edges/phones/{phoneId}` |
| **User inputs** | From Site (name), To Site (name) |
| **Output** | Results log (per phone: success/fail) |
| **Conversion pattern** | Pattern 3 (Action) |
| **Complexity** | Medium — needs site name lookup → phone list → bulk update |

#### Create WebRTC Phones

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Actions_Phones_CreateWebRTC.py` |
| **GUI tab** | `GUI/Config/GUI_tab_actions_phones_create_webrtc.py` |
| **What it does** | Creates WebRTC phones for users without "collaborate" license |
| **API endpoints** | `GET /api/v2/authorization/divisions`, `GET /api/v2/telephony/providers/edges/phonebasesettings`, `GET /api/v2/users`, `POST /api/v2/telephony/providers/edges/phones` |
| **User inputs** | Site ID |
| **Output** | Results log (per user: created/skipped/error) |
| **Conversion pattern** | Pattern 3 (Action) |
| **Complexity** | Medium — needs division + phone base lookups, then bulk create |

---

### 2. Conversations

#### Disconnect Conversations

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Conversations_Disconnect.py` |
| **GUI tab** | `GUI/Config/GUI_tab_conversations_disconnect.py` |
| **What it does** | Force-disconnects conversations (single ID, multiple IDs, or all in a queue) |
| **API endpoints** | `POST /api/v2/conversations/{conversationId}/disconnect`, `GET /api/v2/analytics/conversations/details/query` |
| **User inputs** | Mode (single/multiple/queue), conversation ID(s) or queue ID |
| **Output** | Per-conversation success/fail status |
| **Conversion pattern** | Pattern 3 (Action) |
| **Complexity** | Low-Medium — simple API calls, queue mode needs analytics query |

#### Interaction Search

| | |
| --- | --- |
| **Python script** | Self-contained in GUI tab (no separate script file) |
| **GUI tab** | `GUI/Config/GUI_tab_interaction_search.py` |
| **Config** | `GUI/Config/GUI_config.py` — `INTERACTION_SEARCH_PANEL_TEXTS` (line ~8716), `INTERACTION_SEARCH_PANEL_SETTINGS` (~8790), `INTERACTION_SEARCH_PANEL_COLORS` (~8834), `INTERACTION_SEARCH_EXCEL_SETTINGS` (~8849) |
| **What it does** | Searches conversation records by date range with optional participant data attribute filters (key/value). Shows results in a table with click-to-expand detail pane (participants, disconnect types, wrap-up codes, ANI/DNIS). Exports to styled Excel. |
| **API endpoints** | `POST /api/v2/analytics/conversations/details/jobs` (submit async job), `GET /api/v2/analytics/conversations/details/jobs/{jobId}` (poll status), `GET /api/v2/analytics/conversations/details/jobs/{jobId}/results` (fetch paginated results with cursor) |
| **Why async jobs API** | Only the async jobs path returns `AnalyticsConversation` with participant `attributes` (data). The sync query endpoint returns `AnalyticsConversationWithoutAttributes`. |
| **User inputs** | Date From, Date To (calendar pickers, default: last 7 days), Participant Data filters (key/value pairs, addable/removable list) |
| **Client-side filtering** | After fetching all conversations, filters client-side: a conversation matches if ANY participant has attributes matching ALL specified key/value pairs (case-insensitive) |
| **Output** | Table: Conversation ID, Start/End Time, Direction, Media Type, ANI, DNIS, Disconnect Type. Detail pane: all participants with purpose, name, attributes, queue ID, wrap-up code/note. Right-click: copy Interaction ID. |
| **Excel export** | Two sheets — "Interactions" (summary with styling/filters) and "Participant Data" (one row per attribute per participant) |
| **Conversion pattern** | Pattern 1 (Export) + Pattern 3 (Action) hybrid — search with inputs, display in table, optional Excel download |
| **Complexity** | Medium-High — async job polling, cursor-based pagination, client-side attribute filtering, detail pane with participant drill-down |

#### Move Queue Interactions

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Move_Queue_Interactions.py` |
| **GUI tab** | `GUI/Config/GUI_tab_move_queue_interactions.py` |
| **What it does** | Transfers interactions from one queue to another with media type filtering |
| **API endpoints** | `POST /api/v2/analytics/conversations/details/query`, `GET /api/v2/routing/queues/{queueId}`, `PATCH /api/v2/conversations/{id}/participants/{participantId}` |
| **User inputs** | Source queue ID, destination queue ID, media types (voice/email/callback/message/all) |
| **Output** | Per-interaction transfer results |
| **Conversion pattern** | Pattern 3 (Action) |
| **Complexity** | Medium — analytics query + participant-level PATCH |

---

### 3. CSV Import (Create from CSV)

#### Create DataTable

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_DataTable_Create.py` |
| **What it does** | Creates an Architect DataTable from CSV schema (column name + type) |
| **API endpoints** | `POST /api/v2/flows/datatables`, `GET /api/v2/authorization/divisions` |
| **CSV columns** | `column_name`, `column_type` |
| **Additional inputs** | Table name, key column name, division name |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | Low |

#### Add/Update DataTable Values

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_DataTable_Add_Update_Values.py` |
| **What it does** | Upserts rows into an existing DataTable from CSV |
| **API endpoints** | `GET /api/v2/flows/datatables`, `GET /api/v2/flows/datatables/{id}`, `PUT /api/v2/flows/datatables/{id}/rows/{rowId}`, `POST /api/v2/flows/datatables/{id}/rows` |
| **CSV columns** | Dynamic — matches DataTable schema |
| **Additional inputs** | DataTable name |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | Medium — needs schema fetch + upsert logic |

#### Create DID Pools

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_DID_Pools_Create.py` |
| **What it does** | Creates DID pools, checking for duplicates |
| **API endpoints** | `GET /api/v2/telephony/providers/edges/didpools`, `POST /api/v2/telephony/providers/edges/didpools` |
| **CSV columns** | `start_number`, `end_number`, `service_provider`, `comment`, `provider` |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | Low |

#### Create External Contacts

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_ExternalContacts_Create.py` |
| **What it does** | Creates external contacts from CSV with full field mapping |
| **API endpoints** | `POST /api/v2/externalcontacts/contacts` |
| **CSV columns** | `firstname`, `lastname`, `work_email`, various phone fields, address fields |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | Medium — complex field mapping |

#### Create/Configure Queues

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_Queues_Create_Configure.py` |
| **What it does** | Creates or updates queues with media channel settings |
| **API endpoints** | `GET /api/v2/routing/queues`, `POST /api/v2/routing/queues`, `PUT /api/v2/routing/queues/{queueId}` |
| **CSV columns** | Queue name + per-media-type settings (alerting timeout, service level, ACW) |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | High — 5 media channels × multiple settings per channel |

#### Create Schedule Groups

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_ScheduleGroups_Create.py` |
| **What it does** | Creates/updates schedule groups with schedule references |
| **API endpoints** | `GET /api/v2/authorization/divisions`, `GET /api/v2/architect/schedules`, `GET /api/v2/architect/schedulegroups`, `POST /api/v2/architect/schedulegroups`, `PUT /api/v2/architect/schedulegroups/{id}` |
| **CSV columns** | Group name, division, open/closed/holiday schedule names |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | Medium — needs name→ID resolution for divisions and schedules |

#### Create Schedules

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_Schedules_Create.py` |
| **What it does** | Creates schedules with RRULE generation from CSV |
| **API endpoints** | `POST /api/v2/architect/schedules` |
| **CSV columns** | 20+ columns: name, division, dates, times, recurrence flags (Mon–Sun), frequency |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | High — RRULE generation from day flags and recurrence settings |

#### Create Skills

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_Skills_Create.py` |
| **What it does** | Creates routing skills from CSV |
| **API endpoints** | `POST /api/v2/routing/skills` |
| **CSV columns** | `Skill` |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | Low |

#### Create Wrapup Codes

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_WrapupCodes_Create.py` |
| **What it does** | Creates wrapup codes from CSV |
| **API endpoints** | `POST /api/v2/routing/wrapupcodes` |
| **CSV columns** | `Wrapup Code` |
| **Conversion pattern** | Pattern 2 (CSV Import) |
| **Complexity** | Low |

---

### 4. CSV Export (Get to CSV)

#### Export DataTable Values

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_DataTable_Get_Values.py` |
| **What it does** | Exports all rows from a DataTable to CSV |
| **API endpoints** | `GET /api/v2/flows/datatables`, `GET /api/v2/flows/datatables/{id}/rows` |
| **Output columns** | Dynamic — matches DataTable schema |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Low-Medium — pagination + dynamic columns |

#### Export DID Pools

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_DID_Pools_Get.py` |
| **What it does** | Exports DID pools to CSV |
| **API endpoints** | `GET /api/v2/telephony/providers/edges/didpools` |
| **Output columns** | Start number, end number, provider, comments |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Low |

#### Export External Contacts

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_ExternalContacts_Get.py` |
| **What it does** | Exports all external contacts to CSV |
| **API endpoints** | `GET /api/v2/externalcontacts/contacts` |
| **Output columns** | Name, phones, emails, addresses |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Low-Medium — pagination + field flattening |

#### Export Queues

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_Queues_Get.py` |
| **What it does** | Exports queue configurations with all media channel settings |
| **API endpoints** | `GET /api/v2/routing/queues` |
| **Output columns** | Queue name + per-media-type alerting/service level/ACW settings |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Medium — wide column set across 5 media types |

#### Export Schedules

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_CSV_Schedules_Get.py` |
| **What it does** | Exports schedules with RRULE decomposition |
| **API endpoints** | `GET /api/v2/architect/schedules` |
| **Output columns** | Schedule fields + decomposed recurrence |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Medium — RRULE parsing |

---

### 5. Data Actions

#### List Data Actions

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_DataActions_List.py` |
| **What it does** | Lists all data actions (for dropdown selection) |
| **API endpoints** | `GET /api/v2/integrations/actions` |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Low |

#### Export Data Actions

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_DataActions_Export.py` |
| **What it does** | Exports selected data actions to JSON files with full config |
| **API endpoints** | `GET /api/v2/integrations/actions/{actionId}?expand=contract&includeConfig=true` |
| **User inputs** | Select actions from list |
| **Output** | JSON files (one per action), optional zip download |
| **Conversion pattern** | Pattern 1 (Export) — but outputs JSON files, not table |
| **Complexity** | Medium |

---

### 6. Data Tables

#### Copy DataTable

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_DataTable_Copy.py` |
| **GUI tab** | `GUI/Config/GUI_tab_datatable_copy.py` |
| **What it does** | Copies a DataTable (schema + optionally data) |
| **API endpoints** | `GET /api/v2/flows/datatables/{id}`, `POST /api/v2/flows/datatables`, `GET /api/v2/flows/datatables/{id}/rows`, `POST /api/v2/flows/datatables/{id}/rows` |
| **User inputs** | Source table ID, new name, copy data (yes/no) |
| **Conversion pattern** | Pattern 3 (Action) |
| **Complexity** | Medium |

---

### 7. Flows

#### List Flows

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Flows_List.py` |
| **What it does** | Lists all non-deleted flows (for selection) |
| **API endpoints** | `GET /api/v2/flows?deleted=false` |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Low |

#### Export Flows

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Flows_Export.py` |
| **What it does** | Exports selected flows as YAML or Architect format files |
| **API endpoints** | `POST /api/v2/flows/export/jobs`, `GET /api/v2/flows/export/jobs/{jobId}` |
| **User inputs** | Select flows, choose format (YAML/Architect) |
| **Output** | Flow files as download |
| **Conversion pattern** | Pattern 1 (Export) — async job with polling |
| **Complexity** | Medium-High — async export job + download |

---

### 8. Users

#### Export All Groups

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Users_Export_All_Groups.py` |
| **What it does** | Exports all users with group memberships to Excel |
| **API endpoints** | `GET /api/v2/users?state=any&expand=dateLastLogin,team`, `GET /api/v2/groups` |
| **Output columns** | Name, Email, Division, Active, LastLogin, WorkTeam, Group |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Medium — cross-reference users × groups |

#### Export All Roles

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Users_Export_All_Roles.py` |
| **What it does** | Exports all users with role assignments to Excel |
| **API endpoints** | `GET /api/v2/users?state=any&expand=authorization,dateLastLogin` |
| **Output columns** | Name, Email, Division, Active, LastLogin, Role |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Medium |

#### Export Last Login

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Users_Export_LastLogin.py` |
| **What it does** | Exports user login data with license info, optional inactivity filter |
| **API endpoints** | `GET /api/v2/license/users`, `GET /api/v2/users?expand=division,dateLastLogin` |
| **User inputs** | Optional: filter by months inactive |
| **Output columns** | Name, Email, Division, Active, LastLogin, License |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Medium — license cross-reference + optional filter |

#### Export Licenses

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Users_Export_Licenses.py` |
| **What it does** | Exports license consumption data with optional filter |
| **API endpoints** | `GET /api/v2/license/users` |
| **User inputs** | Optional: license type filter |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Low-Medium |

#### Export Roles (filtered)

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Users_Export_Roles.py` |
| **What it does** | Exports users filtered by specific role names |
| **API endpoints** | `GET /api/v2/authorization/divisions`, `GET /api/v2/users`, `GET /api/v2/authorization/subjects/{userId}` |
| **User inputs** | Role names to filter |
| **Conversion pattern** | Pattern 1 (Export) |
| **Complexity** | Medium — per-user role lookup |

#### Lookup Single User

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Users_Get_Single_User.py` |
| **GUI tab** | `GUI/Config/GUI_tab_actions_single_user.py` |
| **What it does** | Searches for a user by name, shows details + roles + groups |
| **API endpoints** | `GET /api/v2/users?expand=...`, `GET /api/v2/authorization/subjects/{userId}` |
| **User inputs** | User display name |
| **Conversion pattern** | Pattern 3 (Action) |
| **Complexity** | Low |

---

### 9. GDPR

#### Search GDPR Subjects

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_GDPR_Subjects_Get.py` |
| **GUI tab** | `GUI/Config/GUI_tab_gdpr.py` |
| **What it does** | Searches for GDPR subjects by type (name/address/phone/email) |
| **API endpoints** | `GET /api/v2/gdpr/subjects` |
| **User inputs** | Search type (NAME/ADDRESS/PHONE/EMAIL), search value |
| **Conversion pattern** | Pattern 3 (Action) |
| **Complexity** | Low |

---

### 10. Billing

#### Billing Export

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Billing_Export.py` (+ several variants for date ranges, comparisons, scheduled) |
| **GUI tab** | `GUI/Config/GUI_tab_billing.py` |
| **What it does** | Exports subscription/billing data to formatted Excel |
| **API endpoints** | `GET /api/v2/billing/trusteebillingoverview/{trusteeOrgId}` |
| **User inputs** | Date range, org selection |
| **Output** | Formatted Excel workbook |
| **Conversion pattern** | Pattern 1 (Export) — but complex Excel formatting |
| **Complexity** | High — complex Excel formatting, multiple billing variants |

---

### 11. Documentation Export

#### Export All Documentation

| | |
| --- | --- |
| **Python script** | `GUI/Scripts/GUI_Documentation_Export_All.py` (orchestrator) |
| **Individual modules** | `GUI/Scripts/GUI_Documentation_*_Export.py` (20+ modules) |
| **GUI tab** | `GUI/Config/GUI_tab_documentation.py` |
| **What it does** | Exports comprehensive org documentation across 13+ categories into multi-sheet Excel workbooks |
| **Categories** | Queues, Users, Call Routing (IVRs), Wrapup Codes, Triggers, Trunks, Data Actions, Integrations, DID Pools, DID Numbers, Policies, DataTables, Flow Outcomes, Flow Milestones, Schedules, Schedule Groups, Flows, Email, Messaging, Web Deployments, Messenger Deployments, OAuth Clients, Outbound (Campaigns, Contact Lists, Rules, etc.), Agent Copilots, Prompts, Sites |
| **Conversion pattern** | Pattern 1 (Export) — very large, multi-module |
| **Complexity** | Very High — 20+ sub-modules, each with own API endpoints and field mappings |

**Individual documentation modules and their API endpoints:**

| Module | API Endpoint |
| --------- | ------------- |
| Queues | `GET /api/v2/routing/queues` |
| Users | `GET /api/v2/users` |
| Call Routing (IVRs) | `GET /api/v2/architect/ivrs` |
| Wrapup Codes | `GET /api/v2/routing/wrapupcodes` |
| Triggers | `GET /api/v2/processautomation/triggers` |
| Trunks | `GET /api/v2/telephony/providers/edges/trunks` |
| Data Actions | `GET /api/v2/integrations/actions` |
| Integrations | `GET /api/v2/integrations` |
| DID Pools | `GET /api/v2/telephony/providers/edges/didpools` |
| DID Numbers | `GET /api/v2/telephony/providers/edges/dids` |
| Policies | `GET /api/v2/recording/mediaretentionpolicies` |
| DataTables | `GET /api/v2/flows/datatables` + `/rows` |
| Flow Outcomes | `GET /api/v2/flows/outcomes` |
| Flow Milestones | `GET /api/v2/flows/milestones` |
| Schedules | `GET /api/v2/architect/schedules` |
| Schedule Groups | `GET /api/v2/architect/schedulegroups` |
| Flows | `GET /api/v2/flows` |
| Email | `GET /api/v2/routing/email/domains` |
| Message Routing | `GET /api/v2/routing/message/recipients` |
| Web Deployments | `GET /api/v2/webdeployments/deployments` |
| Messenger Deployments | `GET /api/v2/webdeployments/configurations` |
| OAuth Clients | `GET /api/v2/oauth/clients` |
| Outbound Campaigns | `GET /api/v2/outbound/campaigns` |
| Prompts | `GET /api/v2/architect/prompts` |
| Sites | `GET /api/v2/telephony/providers/edges/sites` |
| Agent Copilots | `GET /api/v2/assistants` |

---

## Conversion Priority Suggestions

Based on usefulness, complexity, and quick wins:

### Quick Wins (Low complexity, high value)

1. **Lookup Single User** — simple search, great first page to build
2. **List Data Actions** — simple GET + table display
3. **List Flows** — simple GET + table display
4. **Create Skills** — simple CSV upload + POST per row
5. **Create Wrapup Codes** — simple CSV upload + POST per row
6. **Search GDPR Subjects** — simple search with inputs
7. **Export DID Pools** — simple GET + table/download

### Medium Effort, High Value

1. **Interaction Search** — high daily use, async job + detail pane
2. **Disconnect Conversations** — very useful day-to-day action
3. **Export DataTable Values** — commonly needed
4. **Add/Update DataTable Values** — commonly needed
5. **Export Users + Roles** — high visibility report
6. **Copy DataTable** — useful utility

### Larger Features (build later)

1. **Export/Import Queues** — wide data model
2. **Move Queue Interactions** — complex participant handling
3. **Create/Configure Queues from CSV** — 5 media channels
4. **Documentation Export** — 20+ modules, build incrementally
5. **Billing Export** — complex Excel formatting
6. **Flow Export** — async job pattern
