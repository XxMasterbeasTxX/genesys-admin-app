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
    // division goes onto the skill itself. Unlike wrap-up codes the call is
    // still unconfirmed — see gc.updateSkill.
    //
    // The PATCH answers 200 whether or not it honours `division`, which once
    // put "✓ Moved" against a skill Genesys still shows as Unassigned. A write
    // this uncertain has to be read back before it is called done: the response
    // when it carries a division, the skill itself when it does not.
    moveFn: async (api, orgId, divisionId, item) => {
      const updated = await gc.updateSkill(api, orgId, item.id, {
        name: item.name,
        division: { id: divisionId },
      });
      const after = updated?.division ? updated : await gc.fetchSkill(api, orgId, item.id);
      if (after?.division?.id !== divisionId) {
        throw new Error(
          `Accepted but not applied — the skill is still in ${after?.division?.name || "no division"}`
        );
      }
    },
  });
}
