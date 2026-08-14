import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    label      : "Skills",
    fetchFn    : (api, orgId, opts) => gc.fetchAllSkills(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],

    // Skills are not accepted by the bulk division endpoint, so the division
    // goes onto the skill itself — see gc.updateSkillDivision.
    //
    // The read-back stays: this endpoint returns 200 for a body it ignores
    // entirely, so a silently discarded request is indistinguishable from a
    // move. It costs nothing, since the response is the updated skill.
    moveFn: async (api, orgId, divisionId, item) => {
      const updated = await gc.updateSkillDivision(api, orgId, item.id, divisionId);
      const after = updated?.division ? updated : await gc.fetchSkill(api, orgId, item.id);
      if (after?.division?.id !== divisionId) {
        throw new Error(
          `Accepted but not applied — the skill is still in ${after?.division?.name || "no division"}`
        );
      }
    },
  });
}
