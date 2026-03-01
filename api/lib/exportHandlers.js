/**
 * Export Handler Registry
 *
 * Maps exportType strings to handler modules.
 * Each handler must export:
 *
 *   async function execute(context, schedule) → {
 *     success: boolean,
 *     filename: string,
 *     base64: string,          // base64-encoded file content
 *     mimeType: string,
 *     summary: string,         // human-readable summary
 *     error?: string,
 *   }
 *
 * To add a new export type:
 *   1. Create api/lib/exports/<type>.js
 *   2. Register it in the `handlers` map below
 */

const handlers = {
  allGroups: () => require("./exports/allGroups"),
  allRoles: () => require("./exports/allRoles"),
  filteredRoles: () => require("./exports/filteredRoles"),
  lastLogin: () => require("./exports/lastLogin"),
  trustee: () => require("./exports/trustee"),
};

/**
 * Get the handler for an export type.
 * @param {string} exportType
 * @returns {{ execute: Function } | null}
 */
function getHandler(exportType) {
  const factory = handlers[exportType];
  if (!factory) return null;
  return factory();
}

/**
 * List all registered export type keys.
 */
function listTypes() {
  return Object.keys(handlers);
}

module.exports = { getHandler, listTypes };
