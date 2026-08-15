// Shared row/DTO types across server queries, actions, and the client UI.

export type ReplyEventRow = {
  id: string;
  smartlead_message_id: string | null;
  smartlead_lead_id: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  body: string | null;
  smartlead_category: string | null;
  status: string;
  received_at: string | null;
  created_at: string;
};

export type ProposalDto = {
  id: string;
  replyEventId: string | null;
  leadId: string | null;
  leadEmail: string | null;
  status: "pending" | "approved" | "declined";
  sentiment: string | null;
  sentimentType: "positive" | "negative" | "neutral" | null;
  isReferral: boolean;
  positiveLead: boolean | null;
  summary: string | null;
  nextStep: string | null;
  reasoning: string | null;
  aiProvider: string | null;
  proposedChanges: Record<string, unknown>;
  actionSuppress: boolean;
  actionDnc: boolean;
  actionValue: string | null;
  dncReason: "explicit_request" | "email_defunct" | null;
  userNote: string | null;
  suggestedReply: string | null;
  research: { name: string; title: string | null; email: string | null; source: "crm" | "web" }[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

export type EventDto = {
  id: string;
  subject: string | null;
  bodyText: string;
  smartleadCategory: string | null;
  campaignId: string | null;
  campaignName: string | null;
  smartleadLeadId: string | null;
  receivedAt: string;
};

export type Conversation = {
  key: string; // lower(from_email)
  leadEmail: string;
  leadId: string | null;
  name: string;
  company: string | null;
  title: string | null;
  /** Normalized https linkedin.com profile URL (server-validated), or null. */
  linkedinUrl: string | null;
  industry: string | null;
  employeeCount: number | null;
  campaignName: string | null;
  smartleadUrl?: string;
  lastInboundAt: string | null;
  latestAt: string;
  snippet: string;
  hasPending: boolean;
  categoryValue: string | null;
  sentimentType: "positive" | "negative" | "neutral" | null;
  events: EventDto[];
  proposals: ProposalDto[];
};

export type ThreadMessage = {
  direction: "inbound" | "outbound";
  from: string;
  /** Display name of the sending inbox (what the lead sees), when resolvable. */
  fromName: string | null;
  to: string;
  subject: string;
  bodyText: string;
  time: string;
};

export type SendContext = {
  campaignId: string;
  emailStatsId: string;
  replyMessageId: string;
  replyEmailTime: string;
} | null;

export type ActionResult = { ok: boolean; message: string };

export type NotificationChannelType = "email" | "slack";

export type NotificationChannel = {
  id: string;
  channel_type: NotificationChannelType;
  label: string | null;
  /** Email address or Slack incoming-webhook URL, depending on channel_type. */
  target: string;
  /** Category values (taxonomy) this channel receives; null = all replies. */
  categories: string[] | null;
  /** Smartlead campaign ids this channel receives; null = all campaigns. */
  campaign_ids: string[] | null;
  enabled: boolean;
  created_at: string;
};

export type NotificationDelivery = {
  id: string;
  channel_id: string;
  kind: "reply" | "test";
  status: "sent" | "failed";
  error: string | null;
  created_at: string;
};

/** Transport readiness, computed server-side from app settings and env fallback. */
export type EmailTransportStatus =
  | { configured: true; provider: "resend" | "smtp"; from: string; source: "app" | "env" | "mixed" }
  | { configured: false; reason: string; source: "app" | "env" | "mixed" };
