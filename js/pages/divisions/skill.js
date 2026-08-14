import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    label      : "Skills",
    fetchFn    : (api, orgId, opts) => gc.fetchAllSkills(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],

    // Skills are not accepted by the bulk division endpoint either, so the
    // division goes onto the skill itself. Unlike wrap-up codes the method is
    // still unconfirmed — see gc.updateSkill. A skill carries no version, so
    // there is no conflict token to carry forward.
    moveFn: (api, orgId, divisionId, item) =>
      gc.updateSkill(api, orgId, item.id, {
        name: item.name,
        division: { id: divisionId },
      }),
  });
}
