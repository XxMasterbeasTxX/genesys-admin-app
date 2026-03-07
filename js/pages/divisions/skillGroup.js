import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "SKILLGROUP",
    label      : "Skill Groups",
    fetchFn    : (api, orgId, opts) => gc.fetchAllSkillGroups(api, orgId, { ...opts, query: { expand: "division" } }),
    columns    : [
      { header: "Name",        get: i => i.name        || "—" },
      { header: "Description", get: i => i.description || "—" },
    ],
  });
}
