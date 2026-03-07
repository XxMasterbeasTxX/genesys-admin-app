import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "MANAGEMENTUNIT",
    label      : "Management Units",
    fetchFn    : (api, orgId, opts) => gc.fetchAllManagementUnits(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
