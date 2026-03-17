/**
 * Roles › Copy — from current org
 *
 * Thin wrapper: delegates to the shared create/edit/copy module
 * with mode = "copySingle".
 */
import renderRolesCreate from "../create.js";

export default (ctx) => renderRolesCreate({ ...ctx, mode: "copySingle" });
