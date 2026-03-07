import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "FLOW",
    label      : "Flows",
    fetchFn    : (api, orgId, opts) => gc.fetchAllFlows(api, orgId, opts),
    columns    : [
      { header: "Name",  get: i => i.name  || "—" },
      { header: "Type",  get: i => i.type  || "—" },
    ],
  });
}
