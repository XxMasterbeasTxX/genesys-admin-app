import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "CAMPAIGN",
    label      : "CAMPAIGN",
    fetchFn    : (api, orgId, opts) => gc.fetchAllCampaigns(api, orgId, opts),
    columns    : [
      { header: "Name",           get: i => i.name           || "—" },
      { header: "Campaign Status", get: i => i.campaignStatus || "—" },
    ],
  });
}
