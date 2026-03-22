# Proxy Authorization — Proposal

## Current State

### How Authentication Works Today

```
Browser                  Azure Function              Genesys Cloud
───────                  ──────────────              ─────────────
User logs in via         
PKCE OAuth (own org)     
        │                
        ▼                
POST /api/genesys-proxy  
  Authorization: Bearer <user's PKCE token>
  Body: { customerId, method, path, body? }
                         │
                         ▼
                         Checks: token header present? ──── No → 400
                         Looks up customer in customers.json
                         Reads GENESYS_<ID>_CLIENT_ID/SECRET from Key Vault
                         Gets Client Credentials token (cached)
                                │
                                ▼
                         Forwards request to Genesys API
                         using proxy client's token
                         (NOT the user's token)
                                │
                                ▼
                         Returns Genesys response to browser
```

### The Problem

1. **No token validation** — The proxy checks that an `Authorization` header exists, but never verifies the token is valid, unexpired, or belongs to a legitimate user.

2. **No authorization** — Any authenticated user can call any Genesys API endpoint through the proxy. The `GROUP_ACCESS` map in `accessConfig.js` only hides UI pages — it does not restrict API calls.

3. **Full proxy permissions** — Each proxy client has a single role with all permissions. Anyone who can reach `/api/genesys-proxy` can perform any action in any customer org.

4. **Fail-open fallback** — If the groups API call fails during access resolution, the app grants full UI access as a fallback (`accessService.js` line 79).

### What This Means in Practice

A user in the "Genesys App - Support" group cannot see the "Roles — Create" page in the nav. But they could open browser DevTools and call:

```js
fetch("/api/genesys-proxy", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <their-valid-token>"
  },
  body: JSON.stringify({
    customerId: "nuuday",
    method: "DELETE",
    path: "/api/v2/routing/queues/some-queue-id"
  })
})
```

This would succeed — the proxy would forward the DELETE using the proxy client's all-permissions token.

---

## Proposed Options

### Option 1: Token Validation Only

**Effort: Low**

Add a single check — validate the user's PKCE token before forwarding the request.

**Changes to `api/genesys-proxy/index.js`:**

```js
// After extracting the Bearer token from the Authorization header:
const userToken = req.headers.authorization?.replace("Bearer ", "");

// Validate it against the app's own Genesys org
const meResp = await fetch(`https://api.${APP_REGION}/api/v2/users/me`, {
  headers: { Authorization: `Bearer ${userToken}` }
});
if (!meResp.ok) {
  context.res = { status: 401, body: { error: "Invalid or expired token" } };
  return;
}
```

**Protects against:**
- Expired tokens
- Fabricated/invalid tokens
- Unauthenticated callers

**Does NOT protect against:**
- Authorized users exceeding their intended permissions (e.g., Support users making write calls)

**Performance consideration:** Adds one API call per proxy request. Can be mitigated with a short-lived cache (token → user identity, 5-minute TTL).

---

### Option 2: Group-Based Route Authorization (Server-Side)

**Effort: Medium**

Enforce the same `GROUP_ACCESS` rules server-side that currently exist client-side.

**How it works:**

1. Extract and validate the user's Bearer token (same as Option 1)
2. Call `GET /api/v2/users/me?expand=groups` to get group IDs → resolve group names → resolve access keys
3. Match the incoming Genesys API `method + path` against a route-to-access-key map
4. If the user's access keys don't cover the route → 403 Forbidden

**Route map example:**

```js
const ROUTE_ACCESS = [
  // Data Actions
  { method: "GET",    pattern: /^\/api\/v2\/integrations\/actions/,       access: "data-actions.edit" },
  { method: "PATCH",  pattern: /^\/api\/v2\/integrations\/actions/,       access: "data-actions.edit" },
  { method: "POST",   pattern: /^\/api\/v2\/integrations\/actions/,       access: "data-actions.edit" },

  // Data Tables
  { method: "GET",    pattern: /^\/api\/v2\/flows\/datatables/,           access: "data-tables.*" },
  { method: "POST",   pattern: /^\/api\/v2\/flows\/datatables$/,          access: "data-tables.create" },
  { method: "PUT",    pattern: /^\/api\/v2\/flows\/datatables\//,         access: "data-tables.edit" },

  // Roles
  { method: "GET",    pattern: /^\/api\/v2\/authorization\/roles/,        access: "roles.*" },
  { method: "POST",   pattern: /^\/api\/v2\/authorization\/roles$/,       access: "roles.create" },
  { method: "PUT",    pattern: /^\/api\/v2\/authorization\/roles\//,      access: "roles.edit" },

  // Interactions
  { method: "POST",   pattern: /^\/api\/v2\/analytics\/conversations/,    access: "interactions.search.*" },

  // ... etc for all endpoints the app uses
];
```

**Shared config:** Move `GROUP_ACCESS` and `SUPERUSER_IDS` to `api/lib/accessConfig.js` (CommonJS) importing from a shared JSON, or duplicate the data.

**Caching strategy:**

```js
// Cache: token string → { userId, accessKeys, expiresAt }
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function resolveUserAccess(userToken) {
  const cached = authCache.get(userToken);
  if (cached && Date.now() < cached.expiresAt) return cached;

  // Call users/me, resolve groups, build access keys...
  const result = { userId, accessKeys, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
  authCache.set(userToken, result);
  return result;
}
```

**Protects against:**
- Everything in Option 1
- Users calling endpoints their group membership doesn't permit
- Support users performing write operations they shouldn't have access to

**Trade-offs:**
- Must maintain the `ROUTE_ACCESS` map whenever new features use new endpoints
- Extra API call per unique token (cached for 5 minutes)
- Group→access key resolution logic is duplicated from the frontend

---

### Option 3: Path Allowlist (Block by Default)

**Effort: Medium**

Instead of access key mapping, define a strict allowlist of method+path combinations the app uses. Any request not on the list → rejected.

```js
const ALLOWED_ROUTES = [
  { method: "GET",    pattern: /^\/api\/v2\/authorization\/roles(\?|$)/ },
  { method: "GET",    pattern: /^\/api\/v2\/authorization\/roles\/[a-f0-9-]+$/ },
  { method: "POST",   pattern: /^\/api\/v2\/authorization\/roles$/ },
  { method: "PUT",    pattern: /^\/api\/v2\/authorization\/roles\/[a-f0-9-]+$/ },
  { method: "GET",    pattern: /^\/api\/v2\/flows\/datatables/ },
  { method: "POST",   pattern: /^\/api\/v2\/flows\/datatables$/ },
  { method: "PUT",    pattern: /^\/api\/v2\/flows\/datatables\/[a-f0-9-]+$/ },
  { method: "GET",    pattern: /^\/api\/v2\/oauth\/clients/ },
  { method: "POST",   pattern: /^\/api\/v2\/analytics\/conversations/ },
  // ... every endpoint the app uses
];
```

**Protects against:**
- All of Option 1
- Users calling endpoints the app doesn't use at all (e.g., DELETE on any resource)
- Arbitrary API access through the proxy

**Does NOT protect against:**
- Support users calling write endpoints that exist in the allowlist but their group shouldn't have access to (for that, combine with Option 2)

**Trade-offs:**
- Simpler than Option 2 (no group resolution needed)
- Must update whenever a new feature adds an endpoint
- No per-user distinction — all authenticated users can use all allowed routes

---

### Option 4: Hybrid (Recommended)

**Effort: Medium-High**

Combine all three:

1. **Validate token** (Option 1) — reject invalid/expired tokens
2. **Allowlist paths** (Option 3) — block endpoints the app doesn't use
3. **Group-based authorization** (Option 2) — restrict allowed endpoints by user group

This gives defense in depth:

| Layer | Stops |
|---|---|
| Token validation | Unauthenticated callers, expired sessions |
| Path allowlist | Arbitrary Genesys API calls (e.g., DELETE queues) |
| Group-based authorization | Support users making write calls they shouldn't |

**Implementation sketch:**

```js
module.exports = async function (context, req) {
  const { customerId, method, path, body, query } = req.body || {};

  // 1. Validate user token
  const user = await validateAndCacheUser(req.headers.authorization);
  if (!user) return respond(context, 401, "Invalid or expired token");

  // 2. Check path allowlist
  const route = findAllowedRoute(method, path);
  if (!route) return respond(context, 403, "This API endpoint is not permitted");

  // 3. Check user access (if route has an access key)
  if (route.access && !user.hasAccess(route.access)) {
    return respond(context, 403, "You do not have permission for this action");
  }

  // 4. Proceed with proxy call (existing logic)
  ...
};
```

---

## Additional Considerations

### Fail-Open vs. Fail-Closed

The current frontend access resolution fails open — if the groups API call fails, full access is granted (`accessService.js` line 79). For server-side enforcement, this should **fail closed**:

```js
// Frontend (current): fail open — usability over security
if (groupNames === null) return { hasAccess: () => true };

// Backend (proposed): fail closed — security over usability
if (groupNames === null) return respond(context, 503, "Could not verify permissions");
```

### Activity Logging

The existing `logAction()` service logs user actions client-side. For security-critical operations, consider also logging at the proxy level. This ensures actions are logged even if the frontend logging is bypassed.

### Static Web App Authentication

Azure Static Web Apps supports built-in authentication providers. The app currently does not use this — it handles auth entirely through Genesys Cloud PKCE. Adding SWA auth would provide a second authentication layer but would require users to log in twice (Azure AD + Genesys Cloud).

### Customer Org Restriction

Currently any authenticated user can proxy requests to any customer org. If certain users should only access certain orgs, this could be added as another authorization dimension (e.g., group → allowed customerIds).

---

## Summary

| Option | Token Validation | Path Control | Per-User Restrictions | Effort |
|---|---|---|---|---|
| 1. Token Validation | Yes | No | No | Low |
| 2. Group-Based Auth | Yes | No | Yes | Medium |
| 3. Path Allowlist | Yes | Yes | No | Medium |
| 4. Hybrid (2+3) | Yes | Yes | Yes | Medium-High |

**Recommendation:** Start with **Option 1** (token validation) as an immediate improvement — low effort, eliminates unauthenticated access. Then evaluate whether Options 2-4 are needed based on the threat model and user base size.
