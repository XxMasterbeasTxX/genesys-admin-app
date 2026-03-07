import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "CONTACTLIST",
    label      : "Contact Lists",
    fetchFn    : (api, orgId, opts) => gc.fetchAllContactLists(api, orgId, opts),
    columns    : [
      { header: "Name",      get: i => i.name       || "—" },
      { header: "Column Count", get: i => i.columnNames?.length != null ? String(i.columnNames.length) : "—" },
    ],
  });
}
