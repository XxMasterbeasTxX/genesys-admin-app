import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "WORKBIN",
    label      : "WORKBIN",
    fetchFn    : (api, orgId, opts) => gc.fetchAllWorkbins(api, orgId, opts),
    columns    : [
      { header: "Name",        get: i => i.name        || "—" },
      { header: "Description", get: i => i.description || "—" },
    ],
  });
}
