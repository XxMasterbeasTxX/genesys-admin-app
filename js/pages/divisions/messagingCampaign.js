import renderDivisionPage from "./_generic.js";
import * as gc from "../../services/genesysApi.js";

export default function render(ctx) {
  return renderDivisionPage(ctx, {
    objectType : "MESSAGINGCAMPAIGN",
    label      : "Messaging Campaigns",
    fetchFn    : (api, orgId, opts) => gc.fetchAllMessagingCampaigns(api, orgId, opts),
    columns    : [
      { header: "Name",           get: i => i.name           || "—" },
      { header: "Campaign Status", get: i => i.campaignStatus || "—" },
    ],
  });
}
