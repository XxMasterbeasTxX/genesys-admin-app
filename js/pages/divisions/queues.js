import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "QUEUE",
    label      : "Queues",
    fetchFn    : (api, orgId, opts) => gc.fetchAllQueues(api, orgId, opts),
    columns    : [
      { header: "Name", get: i => i.name || "—" },
    ],
  });
}
