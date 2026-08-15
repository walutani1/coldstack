const SMARTLEAD_APP_BASE_URL = "https://app.smartlead.ai";

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/* Operator-verified Smartlead app URL formats (2026-07-12):
   - /app/email-campaign/all                      all campaigns
   - /app/email-campaign/{id}/{tab}               tab: analytics | inbox | ...
   - /app/master-inbox?sortBy=REPLY_TIME_DESC     master inbox
   - /app/lead/{leadId}/view                      lead detail (global lead id,
     the same id space as the API's lead id / our stored smartlead_lead_id)
   - /app/email-accounts/emails                   all sending accounts
   - /app/crm/lists/all-leads/leads               all leads table */

/** Link to a campaign page in the Smartlead app. */
export function buildSmartleadCampaignUrl(
  campaignId: string,
  tab: "analytics" | "inbox" = "analytics",
) {
  return `${SMARTLEAD_APP_BASE_URL}/app/email-campaign/${encodeURIComponent(campaignId)}/${tab}`;
}

/** Direct link to a lead's detail view in the Smartlead app. */
export function buildSmartleadLeadUrl(smartleadLeadId: string) {
  return `${SMARTLEAD_APP_BASE_URL}/app/lead/${encodeURIComponent(smartleadLeadId)}/view`;
}

/**
 * Best link for a conversation: the lead's detail view when we know the
 * Smartlead lead id, else the campaign's inbox tab, else nothing.
 */
export function buildSmartleadConversationUrl(input: {
  campaignId?: string | null;
  smartleadLeadId?: string | null;
}) {
  const smartleadLeadId = clean(input.smartleadLeadId);
  if (smartleadLeadId) return buildSmartleadLeadUrl(smartleadLeadId);
  const campaignId = clean(input.campaignId);
  if (campaignId) return buildSmartleadCampaignUrl(campaignId, "inbox");
  return undefined;
}
