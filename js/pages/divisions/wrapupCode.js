import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "WRAPUPCODE",
    label      : "Wrap-up Codes",
    fetchFn    : (api, orgId, opts) => gc.fetchAllWrapupCodes(api, orgId, opts),
    columns    : [
      { header: "Name",        get: i => i.name        || "—" },
      { header: "Description", get: i => i.description || "—" },
    ],
  });
}
