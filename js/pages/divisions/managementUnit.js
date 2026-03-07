import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "MANAGEMENTUNIT",
    label      : "Management Units",
    fetchFn      : (api, orgId, opts) => gc.fetchAllManagementUnits(api, orgId, { ...opts, query: { expand: "division" } }),
    getDivision  : i => i.division ?? i.businessUnit?.division ?? null,
    setDivision  : (i, d) => { i.division = d; },
    columns      : [
      { header: "Name",          get: i => i.name                    || "—" },
      { header: "Business Unit", get: i => i.businessUnit?.name      || "—" },
    ],
  });
}
