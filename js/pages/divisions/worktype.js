import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "WORKTYPE",
    label      : "Work Types",
    fetchFn    : (api, orgId, opts) => gc.fetchAllWorktypes(api, orgId, opts),
    columns    : [
      { header: "Name",        get: i => i.name        || "—" },
      { header: "Description", get: i => i.description || "—" },
    ],
  });
}
