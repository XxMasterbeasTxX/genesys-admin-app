import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "EMERGENCYGROUPS",
    label      : "Emergency Groups",
    fetchFn    : (api, orgId, opts) => gc.fetchAllEmergencyGroups(api, orgId, { ...opts, query: { expand: "division" } }),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
