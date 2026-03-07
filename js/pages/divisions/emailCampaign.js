import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "EMAILCAMPAIGN",
    label      : "Email Campaigns",
    fetchFn    : (api, orgId, opts) => gc.fetchAllEmailCampaigns(api, orgId, opts),
    columns    : [
      { header: "Name",           get: i => i.name           || "—" },
      { header: "Campaign Status", get: i => i.campaignStatus || "—" },
    ],
  });
}
