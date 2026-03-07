import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "TEAM",
    label      : "Work Teams",
    fetchFn    : (api, orgId, opts) => gc.fetchAllTeams(api, orgId, { ...opts, query: { expand: "division" } }),
    columns    : [
      { header: "Name",        get: i => i.name        || "—" },
      { header: "Description", get: i => i.description || "—" },
    ],
  });
}
