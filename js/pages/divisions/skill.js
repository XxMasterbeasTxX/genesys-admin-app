import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "SKILL",
    label      : "Skills",
    fetchFn    : (api, orgId, opts) => gc.fetchAllSkills(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
