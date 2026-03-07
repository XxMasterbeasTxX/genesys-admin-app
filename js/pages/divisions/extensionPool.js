import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "EXTENSIONPOOL",
    label      : "EXTENSIONPOOL",
    fetchFn    : (api, orgId, opts) => gc.fetchAllExtensionPools(api, orgId, opts),
    columns    : [
      { header: "Name",        get: i => i.name        || "—" },
      { header: "Start Number", get: i => i.startNumber || "—" },
      { header: "End Number",   get: i => i.endNumber   || "—" },
    ],
  });
}
