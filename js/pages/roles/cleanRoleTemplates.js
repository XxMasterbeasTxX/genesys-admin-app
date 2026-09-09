/**
 * Clean role templates — the permission sets behind Roles › Create › Templates.
 *
 * A "clean" role stops exactly at what the org already pays for, so nobody
 * creates an admin that quietly invokes an add-on nobody bought.
 *
 * Two shapes, from one rule:
 *
 *   Clean Admin      every base licence the org lists, plus every permission in
 *                    no licence at all.
 *   Clean <licence>  one add-on's own permissions, minus any also granted by
 *                    another add-on the org holds.
 *
 * WHY THAT IS ENOUGH. Licence definitions are org-scoped, so they already encode
 * what is free at that org's tier — no tier chain has to be walked. Measured
 * 2026-09-04 across three orgs: `cloudCX3` is *not* a superset of `cloudCX2`
 * (they overlap by 14 of ~270 each), yet all 275 `cloudCX2` permissions exist in
 * a CX 3 org's catalog with 261 of them attributed to NO licence — because on
 * CX 3 they cost nothing. The same shows in speech and text analytics: the 19
 * `speechAndTextAnalytics:*` permissions are `gcSTAupgrade` on CX 2 and
 * `cloudCX3` on CX 3. The org tells us what is included; we read it.
 *
 * WHY A LICENCE TEMPLATE SUBTRACTS OTHER ADD-ONS. Genesys assigns each user one
 * add-on, and a permission granted by two of them cannot be relied on to invoke
 * the one you asked for. WEM outranks STA, and 19 of STA's 23 permissions are
 * WEM's too — build "Clean STA" from all 23 on an org holding both and you get a
 * WEM role wearing an STA label. So a shared permission is dropped and the
 * licence holding it is named instead. Rare in practice: across three orgs the
 * only overlaps were WEM/STA (19) and agentAssist/agentAssistOmni (4).
 *
 * Consistent with Utilities › Get Lists › Permissions vs. Licenses, which is
 * where the numbers above were measured: plain `permissions.ids` per definition,
 * re-fetched by id when the list endpoint returns a skinny entry. `comprises` is
 * deliberately not followed — that would produce different sets from the ones
 * validated against live orgs.
 */

import { fetchLicenseDefinitions, fetchLicenseDefinition } from "../../services/genesysApi.js";

/**
 * Licences that come with the org's core subscription rather than as an add-on.
 *
 * `wallboardUser` is here because it is free with any CX licence — it is a
 * separate definition, so a role carrying it does infer `wallboardUser`, but
 * that costs nothing and an admin is expected to have it.
 *
 * An org may list several `cloudCXn` at once; they are near-disjoint, so all of
 * them are taken and the top tier decides in practice.
 */
export const BASE_LICENCE = /^(cloudCX\d+|communicate|collaborate|wallboard)/i;

/**
 * Permissions that bill purely by existing. Excluded from Clean Admin as a
 * belt-and-braces — no org measured put one outside an add-on, so the ordinary
 * rule already drops them, but this is the one class where being wrong costs
 * money rather than access.
 *
 * NOT excluded from a licence template: `billing:user:staUpgrade` is precisely
 * what a Clean STA role is for.
 */
const BILLING_TRIGGER = /^billing:user:/i;

/**
 * Every licence the org can hold, with its permissions resolved.
 * `permissions` may be empty on the list endpoint, so re-fetch by id when it is.
 */
export async function loadLicencePermissions(api, orgId) {
  const listed = await fetchLicenseDefinitions(api, orgId);
  const out = [];
  for (const listedDef of listed) {
    if (!listedDef?.id) continue;
    let full = listedDef;
    if (!full.permissions?.ids?.length) {
      try {
        full = await fetchLicenseDefinition(api, orgId, listedDef.id);
      } catch {
        full = listedDef; // a licence we cannot read contributes nothing
      }
    }
    out.push({
      id: listedDef.id,
      description: listedDef.description || full.description || "",
      permissions: new Set(full.permissions?.ids || []),
    });
  }
  return out;
}

/** Flatten the Create page's catalog into "domain:entity:action" strings. */
export function flattenCatalog(catalog) {
  const out = new Set();
  for (const [domain, entities] of Object.entries(catalog || {})) {
    for (const [entity, meta] of Object.entries(entities || {})) {
      for (const action of meta?.actions || []) out.add(`${domain}:${entity}:${action}`);
    }
  }
  return out;
}

/**
 * Build the template list for an org.
 *
 * @param licences  from loadLicencePermissions
 * @param catalog   the Create page's catalog object
 * @returns { baseIds, addonIds, templates }
 *
 * Every set is intersected with the catalog: a licence can name a permission the
 * org's catalog does not carry, and a role cannot grant what does not exist.
 */
export function buildTemplates(licences, catalog) {
  const all = flattenCatalog(catalog);
  const base = licences.filter((l) => BASE_LICENCE.test(l.id));
  const addons = licences.filter((l) => !BASE_LICENCE.test(l.id));

  const inCatalog = (set) => new Set([...set].filter((p) => all.has(p)));
  const union = (list) => {
    const out = new Set();
    for (const l of list) for (const p of l.permissions) out.add(p);
    return out;
  };

  // ── Clean Admin ──────────────────────────────────────────────────────────
  const licensed = union(licences);            // anything any licence claims
  const noLicence = new Set([...all].filter((p) => !licensed.has(p)));
  const adminPerms = inCatalog(
    new Set([...union(base), ...noLicence].filter((p) => !BILLING_TRIGGER.test(p))),
  );

  const templates = [{
    key: "clean-admin",
    kind: "admin",
    label: "Clean Admin",
    detail: base.length
      ? `${base.map((l) => l.id).join(", ")} + everything needing no licence`
      : "everything needing no licence",
    permissions: adminPerms,
    total: adminPerms.size,
    excluded: [],
    blocked: adminPerms.size === 0,
  }];

  // ── One template per add-on ──────────────────────────────────────────────
  for (const lic of addons) {
    const others = addons.filter((o) => o.id !== lic.id);
    const shared = [];
    for (const other of others) {
      const n = [...lic.permissions].filter((p) => other.permissions.has(p)).length;
      if (n) shared.push({ id: other.id, count: n });
    }
    shared.sort((a, b) => b.count - a.count);

    const otherPerms = union(others);
    const exclusive = inCatalog(new Set([...lic.permissions].filter((p) => !otherPerms.has(p))));

    templates.push({
      key: `licence:${lic.id}`,
      kind: "licence",
      licenceId: lic.id,
      label: `Clean ${lic.id}`,
      detail: lic.description || "",
      permissions: exclusive,
      total: lic.permissions.size,
      excluded: shared,
      blocked: exclusive.size === 0,
    });
  }

  return {
    baseIds: base.map((l) => l.id),
    addonIds: addons.map((l) => l.id),
    templates,
  };
}

/**
 * Turn a flat permission set into the Create page's `policies` shape.
 * Actions are validated against the catalog, so an action a licence names but
 * the catalog does not carry is dropped rather than posted and rejected.
 */
export function toPolicies(permissions, catalog) {
  const byEntity = new Map();
  for (const perm of permissions) {
    const [domain, entity, action] = String(perm).split(":");
    if (!domain || !entity || !action) continue;
    if (!catalog?.[domain]?.[entity]?.actions?.includes(action)) continue;
    const key = `${domain}:${entity}`;
    if (!byEntity.has(key)) byEntity.set(key, { domain, entity, actions: new Set() });
    byEntity.get(key).actions.add(action);
  }
  return [...byEntity.values()]
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.entity.localeCompare(b.entity))
    .map((p) => ({ ...p, condVar: "", condValues: [], condOp: "INCLUDES", condOpen: false }));
}

/** "gc2WEMupgrade (19) and gcSTAupgrade (4)" — for the excluded-permissions note. */
export function describeExcluded(excluded) {
  const parts = excluded.map((e) => `${e.id} (${e.count})`);
  if (parts.length <= 1) return parts[0] || "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
