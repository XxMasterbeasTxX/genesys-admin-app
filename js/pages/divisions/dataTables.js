import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "DATATABLES",
    label      : "Data Tables",
    fetchFn    : (api, orgId, opts) => gc.fetchAllDataTables(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
