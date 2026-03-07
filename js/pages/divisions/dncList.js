import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "DNCLIST",
    label      : "DNCLIST",
    fetchFn    : (api, orgId, opts) => gc.fetchAllDncLists(api, orgId, opts),
    columns    : [
      { header: "Name",     get: i => i.name     || "—" },
      { header: "DNC Code", get: i => i.dncCodes?.join(", ") || "—" },
    ],
  });
}
