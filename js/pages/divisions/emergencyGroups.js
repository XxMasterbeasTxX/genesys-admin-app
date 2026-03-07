import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "EMERGENCYGROUPS",
    label      : "EMERGENCYGROUPS",
    fetchFn    : (api, orgId, opts) => gc.fetchAllEmergencyGroups(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
