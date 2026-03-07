import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "SCRIPT",
    label      : "Scripts",
    fetchFn    : (api, orgId, opts) => gc.fetchAllScripts(api, orgId, opts),
    columns    : [
      { header: "Name",   get: i => i.name   || "—" },
      { header: "Status", get: i => i.status || "—" },
    ],
  });
}
