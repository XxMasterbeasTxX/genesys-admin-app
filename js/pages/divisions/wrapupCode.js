import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    label      : "Wrap-up Codes",
    fetchFn    : (api, orgId, opts) => gc.fetchAllWrapupCodes(api, orgId, opts),
    columns    : [
      { header: "Name",        get: i => i.name        || "—" },
      { header: "Description", get: i => i.description || "—" },
    ],

    // Wrap-up codes are not accepted by the bulk division endpoint, so the
    // division is written onto the code itself — the same call Deployment ›
    // Basic and Wrapup Codes › Create/Edit already use. It is a full-replace
    // PUT, so name and description have to be sent back or they are lost, and
    // the returned version has to be kept: moving the same code twice without
    // reloading would otherwise fail the second time on a stale version.
    moveFn: async (api, orgId, divisionId, item) => {
      const updated = await gc.putWrapupCode(api, orgId, item.id, {
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        division: { id: divisionId },
        version: item.version,
      });
      if (updated?.version) item.version = updated.version;
      // Free confirmation — the response is the saved code. Genesys honours this
      // one today, but nothing about the call guarantees it keeps doing so.
      if (updated?.division && updated.division.id !== divisionId) {
        throw new Error(
          `Accepted but not applied — the code is still in ${updated.division.name || "another division"}`
        );
      }
    },
  });
}
