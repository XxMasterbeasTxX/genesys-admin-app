# Audit Feature — Technical Specification

## Overview

An audit query page allowing users to search and filter audit events within a Genesys Cloud organisation.

---

## API Endpoints Used

| Purpose | Method | Endpoint |
| --- | --- | --- |
| Fetch service mapping | GET | `/api/v2/audits/query/servicemapping` |
| Submit audit query | POST | `/api/v2/audits/query` |
| Poll query status | GET | `/api/v2/audits/query/{transactionId}` |
| Fetch query results | GET | `/api/v2/audits/query/{transactionId}/results` |
| Resolve user names | GET | `/api/v2/users/{userId}` |

### Service Mapping Response Shape

```json
{
  "services": [
    {
      "name": "Architect",
      "entities": [
        {
          "name": "Flow",
          "actions": ["Checkin", "Checkout", "Create", "Delete", "Publish", ...]
        }
      ]
    }
  ]
}
```

Fetched once on page load and cached for the session. Drives all dropdowns dynamically — no hardcoded service/entity/action lists.

---

## Audit Query Constraints

- **Max interval per request:** 30 days
- **Data retention:** 365 days (1 year back from today)
- **Pagination:** cursor-based, 25 results per page — must follow cursor until exhausted
- **Wide date ranges** must be split into 30-day chunks and queries run sequentially, then results merged

---

## Query Request Body Shape

```json
{
  "interval": "2026-01-01T00:00:00Z/2026-01-31T23:59:59Z",
  "serviceName": "Architect",
  "filters": [
    { "property": "EntityType", "value": ["Flow"] },
    { "property": "Action",     "value": ["Publish", "Delete"] }
  ],
  "sort": [{ "name": "timestamp", "sortOrder": "DESC" }],
  "pageSize": 25
}
```

> `filters` array is optional — omit to return all events for the service.

---

## Page UX Flow

### Step 1 — Required inputs (triggers API query)

| Field | Type | Notes |
| --- | --- | --- |
| Date From | date picker | Min: today − 365 days |
| Date To | date picker | Max: today |
| Service Name | single select (searchable) | Populated from service mapping on load |

Clicking **Search** fires the query (chunked if > 30 days). Results arrive and populate the table.

### Step 2 — Client-side result filters (narrow displayed results, no new API call)

| Filter | Type | Behaviour |
| --- | --- | --- |
| Entity Type | single select | Options = entities for selected service from mapping. Resets Action filter when changed. |
| Action | single select | Options = actions for selected Entity Type (cascades from Entity Type). Disabled until Entity Type is chosen. |
| Changed By | single select (searchable) | Options = distinct resolved user names from current result set. Fully independent — can be used alone or alongside any combination of Entity Type / Action. |

**Filter independence rules:**

- Entity Type and Action are cascading — Action options are scoped to the selected Entity Type, and Action resets when Entity Type changes.
- Changed By is orthogonal to both — it can be applied with no other filter set, with Entity Type only, with Entity Type + Action, or with Action only (if arrived at that state).
- All active filters combine as AND — a row must match every active filter to be shown.
- Clearing any filter immediately re-evaluates the visible result set without a new API call.

All three filters operate on the already-fetched result set — no new API calls.

---

## Results Table Columns

| Column | Source | Notes |
| --- | --- | --- |
| Date & Time | `timestamp` | Formatted, sortable |
| Service | `serviceName` | |
| Entity Type | `entityType` | |
| Entity Name | `entity.name` | May be a GUID if name not available |
| Action | `action` | |
| Changed By | `user.id` → resolved name | Batch-resolve GUIDs to names after results load |
| Details | `properties[]` | Collapsed by default — click row to expand diff |

### Expandable Row (property diff)

Shows a table of changed fields:

| Property | Old Value | New Value |
| --- | --- | --- |
| title | Agent | Senior Agent |
| department | Support | Operations |

For Create/Delete with no diff, show a simple message (e.g. "Entity created" / "Entity deleted").

---

## Actor Name Resolution

1. Collect all unique `user.id` GUIDs from results
2. Batch-resolve via parallel `GET /api/v2/users/{userId}` calls (or bulk endpoint if available)
3. Build a `{ guid → displayName }` map and apply to all rows

---

## Results Presentation

The page is laid out in two zones:

### Zone 1 — Query inputs (top)

```text
Date From  [2026-02-01]   Date To  [2026-03-08]
Service    [Architect              ▼]      [Search]
```

### Zone 2 — Filters + table (appear after first Search)

```text
Narrow results:
Entity Type  [Flow       ▼]
Action       [Publish    ▼]   (disabled until Entity Type chosen)
Changed By   [John Smith ▼]   (always enabled)

243 results  (12 shown after filters)

┌──────────────────────┬──────────────┬─────────────┬───────────────────────┬─────────┬─────────────┬─────────┐
│ Date & Time          │ Service      │ Entity Type │ Entity Name           │ Action  │ Changed By  │ Details │
├──────────────────────┼──────────────┼─────────────┼───────────────────────┼─────────┼─────────────┼─────────┤
│ 2026-03-08 14:22:01  │ Architect    │ Flow        │ Main IVR              │ Publish │ John Smith  │ ▶       │
│ 2026-03-07 09:11:45  │ Architect    │ Flow        │ Sales Queue Flow      │ Publish │ John Smith  │ ▶       │
└──────────────────────┴──────────────┴─────────────┴───────────────────────┴─────────┴─────────────┴─────────┘
```

**Expanded row (click Details ▶ to toggle):**

```text
┌──────────────────────────────────────────────────────────┐
│ Changes on Main IVR — Publish — 2026-03-08 14:22:01     │
├─────────────────────┬──────────────────┬─────────────────┤
│ Property            │ Old Value        │ New Value       │
├─────────────────────┼──────────────────┼─────────────────┤
│ version             │ 14               │ 15              │
│ description         │ Main flow v14    │ Main flow v15   │
└─────────────────────┴──────────────────┴─────────────────┘
```

- Result count shown as "X results (Y shown after filters)" so the user can see filter impact at a glance
- Filters + table are hidden until the first Search is executed
- Rows with no property diff (e.g. Create/Delete) show a plain message instead of a diff table: *"Entity created"* / *"Entity deleted"*

---

## Loading Strategy

- Show progress bar + status text while chunked queries run (e.g. "Fetching 3 of 9 intervals…")
- Render table after all chunks complete
- Cursor-based pagination is exhausted automatically per chunk — all results for the selected range are fetched before the table renders

---

## Navigation

| Item | Value |
| --- | --- |
| Main menu label | **Audit** |
| Page label | **Search** |
| Route | `/audit/search` (TBC based on router conventions) |
| Nav config group | Audit |

---

## Phase 1 — Scope

- Date range + Service Name required (API query)
- Client-side filters: Entity Type → Action → **Changed By** (user)
- "Changed By" is included in phase 1 because it costs nothing extra — user names are already resolved as part of result rendering, so it is just another dropdown on already-fetched data
- Design tweaks and UX polish happen after phase 1 testing before moving to phase 2

---

## Phase 2 — Planned Additions

### User-as-primary-filter mode

A separate search mode where the user selects a **person** first (typeahead on user name) and then optionally narrows by service/entity/action.

**Why this is phase 2, not phase 1:**

- The audit API requires `serviceName` in every query — there is no cross-service query mode
- A user-first search with no service selected would require firing up to 44 separate service queries × N date chunks, which is a fundamentally different (heavier) architecture
- Keeping it out of phase 1 avoids over-engineering before the basic flow is validated

**Phase 2 design options (to be decided):**

- Option A: User-first mode fires queries for all services in parallel (expensive, needs short date range or service pre-selection)
- Option B: User-first mode requires the user to also select one or more services (cheaper, less friction)
- Option C: User-first mode queries only the most common services by default (Directory, Routing, PeoplePermissions) with an option to expand

### Other future filters (noted)

- Filter by Entity ID / Entity Name
- Possibly: filter by changed property value
