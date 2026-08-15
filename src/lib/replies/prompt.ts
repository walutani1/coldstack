import { htmlToText } from "@/lib/html";
import type { SmartleadMessage } from "@/lib/smartlead";
import {
  fallbackCategory,
  roleCategory,
  type ReplyCategory,
} from "@/lib/taxonomy";

export function renderThread(messages: SmartleadMessage[]) {
  return messages
    .map((message) => {
      const who = message.type === "REPLY" ? "LEAD REPLY" : "US (sent)";
      return `[${who} · ${message.time}]\n${htmlToText(message.email_body)}`;
    })
    .join("\n\n---\n\n");
}

function extractionShape(categories: ReplyCategory[]) {
  return `{
  "category": "one of: ${categories.map((category) => category.value).join(", ")}",
  "positive_lead": true or false,
  "is_referral": true or false,
  "referee_name": "the colleague's name if they point to someone else, else null",
  "referee_title": "the colleague's role if stated, else null",
  "referee_email": "the colleague's email if stated, else null",
  "summary": "one concise sentence on where this conversation stands",
  "next_step": "recommended next action for the sender",
  "reasoning": "one sentence: why this category",
  "is_automated": true or false,
  "dnc": true or false,
  "email_defunct": true or false,
  "temporary_absence": true or false,
  "ooo_return_date": "YYYY-MM-DD if an out-of-office reply states a return date, else null"
}`;
}

export function buildPrompt(input: {
  thread: string;
  latestReply: string;
  leadName: string;
  company: string;
  smartleadCategory: string | null;
  categories: ReplyCategory[];
  campaignContext: string;
  userNote?: string;
}) {
  const fallback = fallbackCategory(input.categories);
  const wrongPerson = roleCategory(input.categories, "wrong_person");
  const automatedCategory = roleCategory(input.categories, "out_of_office") ?? fallback;
  const definitions = input.categories
    .filter((category) => category.description)
    .map((category) => `- ${category.value} ("${category.label}"): ${category.description}`)
    .join("\n");
  const wrongPersonRule = wrongPerson
    ? ` Use "${wrongPerson.value}" when a human says they are not the right person but does NOT name a specific person to contact; if they name someone to reach out to, use the referral category instead.`
    : "";

  return `You are analyzing a reply to a cold email so a human can update their CRM. Do not browse the web, do not call tools.

Today's date: ${new Date().toISOString().slice(0, 10)}.

Campaign context:
${input.campaignContext}

Lead: ${input.leadName || "unknown"} at ${input.company || "unknown"}.
Smartlead's own auto-category for this reply: ${input.smartleadCategory ?? "none"}.

Full email thread (oldest first):
${input.thread}

The most recent reply from the lead:
"""
${input.latestReply}
"""
${input.userNote ? `\nThe human reviewer added this correction or context. Weight it heavily:\n"""${input.userNote}"""\n` : ""}
Return ONLY valid JSON in exactly this shape, no markdown, no extra keys:
${extractionShape(input.categories)}

Category definitions:
${definitions}

Rules:
- "category" must be one of the allowed values.${wrongPersonRule}
- "is_automated": true for machine-generated responses: out-of-office and vacation auto-replies, autoresponders, ticket confirmations, "no longer with the company" auto-notices. Automated responses are category "${automatedCategory.value}" unless the automated text itself clearly establishes a better category.
- "email_defunct": true ONLY when the message indicates this address is permanently dead or unattended: the person left the company, the mailbox is disabled or unmonitored, or the email is "no longer in use". A temporary vacation/OOO is NOT defunct. This adds just that one email address to the do-not-send block list so no more sends are wasted on it.
- "dnc": true ONLY when a human is hostile/abusive OR explicitly demands to be removed / never contacted again. That triggers a permanent do-not-contact block. Never set it merely because a response is automated.
- "is_referral": true only when a HUMAN message names another person who owns this area. Automated messages must set it false, including out-of-office stand-ins and no-longer-with-company notices naming successors. Always fill the referee_* fields when contact details are stated, even when is_referral is false.
- "temporary_absence": true ONLY when a person is temporarily away and coming back: vacation, parental or medical leave, travel, conference. false for generic autoresponders (ticket confirmations, "we received your inquiry", marketing auto-replies) and for permanent departures/dead mailboxes.
- "ooo_return_date": for out-of-office replies that state when the person is back, resolve it to a full YYYY-MM-DD date using today's date (e.g. "back 7/14" or "returning Tuesday the 14th" -> the upcoming July 14). null when no date is stated or it cannot be resolved confidently.
- Keep summary and next_step short and factual.`;
}
