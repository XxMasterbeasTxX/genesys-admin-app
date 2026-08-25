/**
 * Data action helpers — template inlining and cross-org sanitising.
 *
 * Two facts about the Genesys action API drive everything here.
 *
 * 1. **Templates are often file references, not strings.** `RequestConfig` and
 *    `ResponseConfig` each carry both an inline template and a URI to one
 *    (`requestTemplate` / `requestTemplateUri`, `successTemplate` /
 *    `successTemplateUri`). An action whose Velocity template was stored as a
 *    `.vm` file comes back from GET with only the URI. Code that reads
 *    `config.request.requestTemplate` and writes it straight back therefore
 *    replaces a real template with an empty string, and Genesys silently
 *    substitutes its default `${input.rawRequest}`. `inlineActionTemplates`
 *    resolves those URIs so callers always see the real template text.
 *
 * 2. **Every `*Uri` in an action embeds that action's own id.** They are
 *    meaningless in another org — and, because they always differ, they also
 *    make two otherwise identical actions compare as different.
 *    `stripOrgSpecificUris` removes them before a cross-org create.
 *
 * The runner has its own copy of this logic in
 * `onboarding-runner/lib/genesysRest.js` — it is CommonJS and cannot import
 * from here. Keep the two in step.
 */

/**
 * Keys that reference a file belonging to one specific action in one specific
 * org. Safe to drop from anything being written to a different org, and safe
 * to ignore when comparing two actions for equality.
 */
export const ACTION_URI_KEYS = Object.freeze([
  "requestTemplateUri",
  "successTemplateUri",
  "inputSchemaUri",
  "successSchemaUri",
  "errorSchemaUri",
]);

/**
 * Schema variants Architect derives from the real schema. They are readOnly
 * output, are not accepted on create, and differ between orgs.
 */
export const ACTION_DERIVED_KEYS = Object.freeze([
  "inputSchemaFlattened",
  "successSchemaFlattened",
  "errorSchemaFlattened",
]);

/** The two (config section, uri key, template key, label) tuples we resolve. */
const TEMPLATE_FIELDS = [
  ["request",  "requestTemplateUri", "requestTemplate", "request template"],
  ["response", "successTemplateUri", "successTemplate", "success template"],
];

/**
 * Resolve any `.vm` template references on an action into inline strings.
 *
 * Mutates and returns `action`. A template that is already inline is left
 * alone. When a fetch fails the URI is deliberately **kept** — dropping it
 * would leave the action with neither a template nor a pointer to one, which
 * is precisely the silent-default failure this helper exists to prevent — and
 * the field is named in `action.templateFetchFailures` so the caller can tell
 * the user rather than writing a blank template back.
 *
 * @param {(uri: string) => Promise<string|null>} fetchTemplate
 *        Resolves a template URI to its text, or null if it cannot.
 * @param {Object} action  Action as returned by GET (with `includeConfig=true`).
 * @returns {Promise<Object>} the same action object.
 */
export async function inlineActionTemplates(fetchTemplate, action) {
  const failures = [];

  for (const [section, uriKey, tplKey, label] of TEMPLATE_FIELDS) {
    const cfg = action?.config?.[section];
    if (!cfg || !cfg[uriKey] || cfg[tplKey]) continue;

    let text = null;
    try {
      text = await fetchTemplate(cfg[uriKey]);
    } catch {
      text = null;
    }

    if (typeof text === "string") {
      cfg[tplKey] = text;
      delete cfg[uriKey];
    } else {
      failures.push(label);
    }
  }

  if (failures.length) action.templateFetchFailures = failures;
  return action;
}

/**
 * Read a template body out of whatever the proxy returned for a `.vm` GET.
 *
 * Both proxies parse the response as JSON and fall back to `{ raw: text }`, so
 * a Velocity template arrives either as a bare string or wrapped in `raw`.
 */
export function templateTextOf(resp) {
  if (typeof resp === "string") return resp;
  if (resp && typeof resp.raw === "string") return resp.raw;
  return null;
}

/** Deep copy of `value` with every key in `keys` removed at any depth. */
function withoutKeys(value, keys) {
  if (Array.isArray(value)) return value.map((v) => withoutKeys(v, keys));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (keys.has(k)) continue;
      out[k] = withoutKeys(v, keys);
    }
    return out;
  }
  return value;
}

/**
 * Copy of `value` with every org-specific file reference removed.
 *
 * Use on the `contract` and `config` of an action being written to a different
 * org than the one it was read from. Does not touch the input.
 */
export function stripOrgSpecificUris(value) {
  return withoutKeys(value, new Set([...ACTION_URI_KEYS, ...ACTION_DERIVED_KEYS]));
}
