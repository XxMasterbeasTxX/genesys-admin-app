import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "BUSINESSUNIT",
    label      : "BUSINESSUNIT",
    fetchFn    : (api, orgId, opts) => gc.fetchAllBusinessUnits(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
