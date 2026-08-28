/**
 * Data action testing — contract reading, input collection, result rendering.
 *
 * Shared by **Data Actions › Edit** (its Test section) and **Data Actions ›
 * Test** (the whole page). Every function here either takes data and returns an
 * HTML string, or reads a container element it is handed — the pages own their
 * own layout and wiring, this owns what a test means.
 *
 * It exists because the alternative was a second copy. The Velocity template
 * inlining once lived only in `copyBetweenOrgs.js` while the Edit page and the
 * Onboarding runner silently wrote empty templates for months; that was the
 * same shape of duplication, and it cost a release to find. See
 * [[genesys-template-storage]] in the design docs.
 *
 * **Output values are escaped everywhere.** A result is third-party response
 * data on its way into `innerHTML`.
 */
import { escapeHtml } from "../utils.js";

/**
 * Properties of a JSON schema, looking through an array wrapper.
 *
 * Genesys contracts describe a list either as an object with `properties` or as
 * `{ type: "array", items: { properties } }`; callers want the fields either
 * way. Returns null when there is nothing to show, which callers use to decide
 * whether to render a section at all.
 */
export function extractSchemaProps(schema) {
  if (!schema) return null;
  if (schema.properties && Object.keys(schema.properties).length) return schema.properties;
  if (schema.items?.properties && Object.keys(schema.items.properties).length) return schema.items.properties;
  return null;
}

/**
 * Input fields for an action's contract, as HTML.
 *
 * The field is keyed by the schema property name and *labelled* by its title,
 * which can differ — so the key is shown as the placeholder, making it visible
 * which name the value will actually be sent under.
 */
export function inputFieldsHtml(contract) {
  const props = extractSchemaProps(contract?.input?.inputSchema);
  if (!props || !Object.keys(props).length) {
    return `<p class="ed-note">This action takes no input parameters.</p>`;
  }
  return Object.entries(props).map(([key, def]) => {
    const label = def.title || key;
    const type = def.type || "string";
    return `
      <div class="dt-control-group ed-field">
        <label class="dt-label">${escapeHtml(label)} <span class="ed-type">(${escapeHtml(type)})</span></label>
        <input class="dt-input ed-test-field" data-key="${escapeHtml(key)}" data-type="${escapeHtml(type)}"
               type="text" placeholder="${escapeHtml(key)}" />
      </div>`;
  }).join("");
}

/**
 * Read the input fields inside `container` into a parameters object.
 *
 * Returns `{ inputs, errors }`. A numeric field holding something that is not a
 * number is reported in `errors` rather than sent as `NaN`, which serialises to
 * `null` and makes the action fail for a reason the result never explains.
 * Empty fields are omitted, as an unset parameter.
 *
 * Fields that failed get the `ed-invalid` class; valid ones have it cleared.
 */
export function collectInputs(container) {
  const inputs = {};
  const errors = [];

  container.querySelectorAll(".ed-test-field").forEach((field) => {
    const key = field.dataset.key;
    const type = field.dataset.type;
    const raw = field.value.trim();
    field.classList.remove("ed-invalid");
    if (!raw) return; // unset parameter

    if (type === "integer" || type === "number") {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        errors.push(key);
        field.classList.add("ed-invalid");
        return;
      }
      inputs[key] = type === "integer" ? Math.trunc(num) : num;
    } else if (type === "boolean") {
      inputs[key] = raw.toLowerCase() === "true";
    } else {
      inputs[key] = raw;
    }
  });

  return { inputs, errors };
}

/** Format one output value for display, without hiding its shape. */
export function formatValue(v) {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Whether a test failed, and the reason if it did.
 *
 * `TestExecutionResult` carries its own `success` flag: an action that runs and
 * fails still returns HTTP 200, so the status code says nothing.
 */
export function outcomeOf(result) {
  const failed = result?.success === false;
  const detail = failed
    ? (result.error?.message
       || (result.operations || []).filter((o) => o.success === false)
            .map((o) => `${o.name}: ${o.error?.message || "failed"}`).join(" | "))
    : "";
  return { failed, detail };
}

/**
 * The request the action actually sent, from the execution steps.
 *
 * Genesys resolves the URL template in its own step and reports the result as
 * `[GET] https://…`. Without it on screen, an empty result is indistinguishable
 * between "there is no such data" and "you asked for page 10 of 100" — a
 * distinction that has cost three false bug reports.
 *
 * @returns {string|null} the resolved request line, or null if the steps do not
 *   carry one (an action that failed before resolving the URL).
 */
export function resolvedRequestOf(result) {
  const op = (result?.operations || []).find(
    (o) => typeof o.result === "string" && /https?:\/\//.test(o.result)
  );
  return op ? op.result : null;
}

/** Rows for one declared output — see `outputsTableHtml`. */
function outputRows(key, def, value, compare) {
  const label = escapeHtml(def.title || key);
  const type  = escapeHtml(def.type || "string");
  // Marked only when a comparison was asked for AND the values differ.
  const diff  = compare !== undefined && JSON.stringify(compare) !== JSON.stringify(value);
  const mark  = diff ? ` <span class="ed-diff" title="Differs from the other target">≠</span>` : "";

  if (Array.isArray(value)) {
    if (!value.length) {
      return `<tr><td>${label}</td><td>${type}</td><td><em>empty</em>${mark}</td></tr>`;
    }
    const head = `<tr><td>${label}</td><td>${type}</td>`
      + `<td>${value.length} item${value.length === 1 ? "" : "s"}${mark}</td></tr>`;
    const items = value.map((v, i) =>
      `<tr class="ed-out-item"><td>${label}-${i}</td><td></td>`
      + `<td>${escapeHtml(formatValue(v))}</td></tr>`
    ).join("");
    return head + items;
  }

  return `<tr><td>${label}</td><td>${type}</td>`
    + `<td>${escapeHtml(formatValue(value))}${mark}</td></tr>`;
}

/**
 * The Outputs table: one row per field the action declares it returns.
 *
 * An array expands into one indexed row per element, named as Genesys names
 * them (`skills-0`, `skills-1`, …) — rendering it as `["a","b","c"]` in a single
 * cell is unreadable at any real length, and an array is the common shape.
 *
 * @param {Object} contract      The action's contract.
 * @param {Object} finalResult   `result.finalResult` from the test.
 * @param {Object} [opts.compareTo]  Another target's `finalResult`; when given,
 *                                   fields whose value differs are marked.
 * @returns {string|null} null when the action declares no outputs.
 */
export function outputsTableHtml(contract, finalResult, { compareTo } = {}) {
  const props = extractSchemaProps(contract?.output?.successSchema);
  if (!props || !finalResult || typeof finalResult !== "object") return null;

  const rows = Object.entries(props).map(([key, def]) =>
    outputRows(key, def, finalResult[key], compareTo ? compareTo[key] : undefined)
  ).join("");

  return `
    <table class="dt-schema-table">
      <thead><tr><th>Output</th><th>Type</th><th>Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * The Steps table — `operations[]` from the result.
 *
 * This is the part that makes a failure diagnosable: without it the failing
 * stage is buried in the raw envelope.
 *
 * @returns {string|null} null when the result carries no operations.
 */
export function stepsTableHtml(result) {
  const ops = result?.operations || [];
  if (!ops.length) return null;

  const rows = ops.map((o) => `
    <tr>
      <td>${escapeHtml(String(o.step ?? ""))}</td>
      <td>${escapeHtml(o.name || "—")}</td>
      <td>${o.success === false
            ? '<span class="ed-step-fail">failed</span>'
            : '<span class="ed-step-ok">ok</span>'}</td>
      <td>${escapeHtml(o.error?.message || "")}</td>
    </tr>`).join("");

  return `
    <table class="dt-schema-table">
      <thead><tr><th>#</th><th>Step</th><th>Result</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Read-only contract preview — input and output fields with their types. */
export function contractPreviewHtml(contract) {
  if (!contract) return "<em>No contract</em>";
  const sections = [];

  for (const [heading, props] of [
    ["Input",  extractSchemaProps(contract.input?.inputSchema)],
    ["Output (success)", extractSchemaProps(contract.output?.successSchema)],
  ]) {
    if (!props) continue;
    const rows = Object.entries(props).map(([key, def], i) =>
      `<tr><td>${i + 1}</td><td>${escapeHtml(def.title || key)}</td>`
      + `<td>${escapeHtml(def.type || "string")}</td></tr>`
    ).join("");
    sections.push(`<strong>${heading}</strong>
      <table class="dt-schema-table">
        <thead><tr><th>#</th><th>Field</th><th>Type</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  return sections.length ? sections.join("") : "<em>Empty contract</em>";
}
