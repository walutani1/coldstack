export type ReplySentimentType = "positive" | "negative" | "neutral";

export type DncReason = "explicit_request" | "email_defunct";

export type SystemRole = "fallback" | "out_of_office" | "do_not_contact" | "wrong_person";

export type ReplyCategory = {
  id: string;
  value: string;
  label: string;
  description: string | null;
  sentimentType: ReplySentimentType;
  suppress: boolean;
  dnc: boolean;
  draftReply: boolean;
  draftGuidance: string | null;
  color: string | null;
  sortOrder: number;
  active: boolean;
  systemRole: SystemRole | null;
};

export function categoryByValue(
  categories: readonly ReplyCategory[],
  value: string | null | undefined,
): ReplyCategory | null {
  if (!value) return null;
  return categories.find((category) => category.value === value) ?? null;
}

export function categoryFromLabel(
  categories: readonly ReplyCategory[],
  label: string | null | undefined,
): ReplyCategory | null {
  if (!label) return null;
  const normalized = label.trim().toLowerCase();
  return categories.find((category) => category.label.toLowerCase() === normalized) ?? null;
}

export function fallbackCategory(categories: readonly ReplyCategory[]): ReplyCategory {
  const fallback = categories.find((category) => category.systemRole === "fallback");
  const last = categories[categories.length - 1];
  if (fallback) return fallback;
  if (last) return last;
  throw new Error("Reply taxonomy must contain at least one category.");
}

export function roleCategory(
  categories: readonly ReplyCategory[],
  role: SystemRole,
): ReplyCategory | null {
  return categories.find((category) => category.systemRole === role) ?? null;
}

export function smartleadCategoryToValue(
  categories: readonly ReplyCategory[],
  label: string | null | undefined,
): string | null {
  if (!label) return null;
  const normalized = label.trim().toLowerCase();
  const hit = categoryFromLabel(categories, normalized);
  if (hit) return hit.value;
  if (normalized.includes("bounce")) return fallbackCategory(categories).value;
  return null;
}

export const SEEDED_REPLY_CATEGORIES: readonly ReplyCategory[] = [
  {
    id: "seed-interested",
    value: "interested",
    label: "Interested",
    description:
      "The lead expresses genuine interest in the offering itself or explicitly asks to move forward or hear more about it — a real buying signal, not merely a polite or helpful reply.",
    sentimentType: "positive",
    suppress: false,
    dnc: false,
    draftReply: true,
    draftGuidance:
      "They showed interest. Thank them, add one concise relevant proof point if configured, then propose one concrete low-effort next step. One question only.",
    color: null,
    sortOrder: 0,
    active: true,
    systemRole: null,
  },
  {
    id: "seed-meeting-request",
    value: "meeting_request",
    label: "Meeting Request",
    description: "The lead asks to schedule a meeting or call.",
    sentimentType: "positive",
    suppress: false,
    dnc: false,
    draftReply: true,
    draftGuidance:
      "They want to talk. Confirm warmly and make scheduling effortless: offer to send times or ask what works this week. No pitching, the meeting is the win.",
    color: null,
    sortOrder: 1,
    active: true,
    systemRole: null,
  },
  {
    id: "seed-information-request",
    value: "information_request",
    label: "Information Request",
    description:
      "The lead asks US a specific question about the offering or requests more detail about what we do, in a way that signals they are evaluating it — not a reply that merely shares information about their own company.",
    sentimentType: "positive",
    suppress: false,
    dnc: false,
    draftReply: true,
    draftGuidance:
      "They asked for information. Answer their question directly in the first lines, add a relevant configured proof point, and end with ONE easy question that qualifies or routes.",
    color: null,
    sortOrder: 2,
    active: true,
    systemRole: null,
  },
  {
    id: "seed-referral",
    value: "referral",
    label: "Referral",
    description:
      'The lead is not the buyer but points us to another specific, named person who owns this area — a genuine human hand-off. NOT an out-of-office stand-in and NOT an automated "no longer with the company" notice.',
    // Neutral, not positive (071): most referrals arrive as automated
    // departure notices, and counting them as positives clouded analytics.
    sentimentType: "neutral",
    suppress: false,
    dnc: false,
    draftReply: true,
    draftGuidance:
      "They pointed to someone else. Thank them by name, confirm you'll reach out to the person they named, and optionally ask one small question (e.g. whether a quick intro is easier). Keep it very short.",
    color: null,
    sortOrder: 3,
    active: true,
    systemRole: null,
  },
  {
    id: "seed-engaged",
    value: "engaged",
    label: "Engaged",
    description:
      "The lead replied constructively and shared genuinely helpful context or information about their company, process, or how things work there — but did NOT express buying interest and did NOT name a specific person to contact. A useful, non-committal engagement: not positive, not negative.",
    sentimentType: "neutral",
    suppress: false,
    dnc: false,
    draftReply: true,
    draftGuidance:
      "They engaged and shared useful context. Thank them, briefly acknowledge what they shared, and ask ONE focused follow-up that moves toward the right owner or a concrete next step. Keep it short and low-pressure.",
    color: null,
    sortOrder: 4,
    active: true,
    systemRole: null,
  },
  {
    id: "seed-wrong-person",
    value: "wrong_person",
    label: "Wrong Person",
    description:
      "The recipient says they are not the right person but does NOT name a specific person to contact instead. If they name someone to reach out to, use Referral.",
    sentimentType: "neutral",
    suppress: false,
    dnc: false,
    draftReply: true,
    draftGuidance:
      "They said it isn't them. Thank them briefly and ask one small question to find the right owner. Keep it very short.",
    color: null,
    sortOrder: 5,
    active: true,
    systemRole: "wrong_person",
  },
  {
    id: "seed-out-of-office",
    value: "out_of_office",
    label: "Out Of Office",
    description: "The message is an automated temporary-absence or out-of-office reply.",
    sentimentType: "neutral",
    suppress: false,
    dnc: false,
    draftReply: false,
    draftGuidance: null,
    color: null,
    sortOrder: 6,
    active: true,
    systemRole: "out_of_office",
  },
  {
    id: "seed-not-interested",
    value: "not_interested",
    label: "Not Interested",
    description: "The lead declines the offering without asking to stop all contact.",
    sentimentType: "negative",
    suppress: true,
    dnc: false,
    draftReply: false,
    draftGuidance: null,
    color: null,
    sortOrder: 7,
    active: true,
    systemRole: null,
  },
  {
    id: "seed-do-not-contact",
    value: "do_not_contact",
    label: "Do Not Contact",
    description: "The lead explicitly asks to be removed or never contacted again, or is hostile or abusive.",
    sentimentType: "negative",
    suppress: true,
    dnc: true,
    draftReply: false,
    draftGuidance: null,
    color: null,
    sortOrder: 8,
    active: true,
    systemRole: "do_not_contact",
  },
  {
    id: "seed-uncategorizable",
    value: "uncategorizable",
    label: "Uncategorizable",
    description: "The reply does not clearly fit another active category.",
    sentimentType: "neutral",
    suppress: false,
    dnc: false,
    draftReply: false,
    draftGuidance: null,
    color: null,
    sortOrder: 9,
    active: true,
    systemRole: "fallback",
  },
];

/** @deprecated UI fallback only — remove when clients read from DB */
export const REPLY_CATEGORIES = SEEDED_REPLY_CATEGORIES;

/** @deprecated UI fallback only — remove when clients read from DB */
export function getReplyCategory(value: string | null | undefined): ReplyCategory {
  return categoryByValue(REPLY_CATEGORIES, value) ?? fallbackCategory(REPLY_CATEGORIES);
}

export const DNC_REASON_LABELS: Record<DncReason, string> = {
  explicit_request: "Asked never to be contacted",
  email_defunct: "Email address no longer in use",
};
