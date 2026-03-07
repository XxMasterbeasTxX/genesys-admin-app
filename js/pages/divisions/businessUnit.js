import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "BUSINESSUNIT",
    label      : "Business Units",
    fetchFn    : (api, orgId, opts) => gc.fetchAllBusinessUnits(api, orgId, { ...opts, query: { expand: "division" } }),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
