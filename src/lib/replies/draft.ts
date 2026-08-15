import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "@/lib/env";
import type { Colleague } from "@/lib/replies/research";
import type { AiSettings } from "@/lib/settings-store";

type DraftInput = {
  settings: AiSettings;
  guidance: string | null;
  leadName: string;
  company: string;
  thread: string;
  latestReply: string;
  colleagues: Colleague[];
  userNote?: string;
};

function personaSentence(settings: AiSettings): string {
  const { senderName, senderTitle, senderCompany } = settings;
  if (senderName) {
    return `The sender is ${senderName}${senderTitle ? `, ${senderTitle}` : ""}${senderCompany ? ` at ${senderCompany}` : ""}.`;
  }
  if (senderTitle && senderCompany) return `The sender's role is ${senderTitle} at ${senderCompany}.`;
  if (senderTitle) return `The sender's title is ${senderTitle}.`;
  if (senderCompany) return `The sender represents ${senderCompany}.`;
  return "";
}

export function buildDraftPrompt(input: DraftInput): string {
  const firstName = input.leadName.split(/\s+/)[0] || "there";
  const colleagueLines =
    input.colleagues.length > 0
      ? input.colleagues
          .map(
            (colleague) =>
              `- ${colleague.name}${colleague.title ? `, ${colleague.title}` : ""} (${colleague.source === "crm" ? "in our lead list" : "found via web"})`,
          )
          .join("\n")
      : "(none found)";
  const persona = personaSentence(input.settings);
  const styleExamples = input.settings.styleExamples
    .map((example) => {
      const lead = example.leadMessage
        ? `The lead wrote:\n"""\n${example.leadMessage}\n"""\n`
        : "";
      return `${lead}The reply sent (match this voice):\n"""\n${example.reply}\n"""`;
    })
    .join("\n\n");
  const styleBlock = styleExamples ? `\nWriting examples from the sender:\n${styleExamples}\n` : "";
  const signature =
    input.settings.signature ||
    (input.settings.senderName ? `Best,\n${input.settings.senderName}` : "");
  const signatureRule = signature ? `\n- Sign off exactly:\n${signature}` : "";
  const extraRules = input.settings.extraVoiceRules
    ? `\nAdditional voice rules:\n${input.settings.extraVoiceRules}`
    : "";

  return `${input.settings.draftContext}${persona ? `\n\n${persona}` : ""}${styleBlock}
Voice rules:
- Greeting line: "Hi ${firstName}," plus a short thanks for the reply, on the same line. A single exclamation mark is fine here and NOWHERE else.
- Short paragraphs, one or two sentences each, with a blank line between them. No bullet points, no marketing language, no links.
- Plain, casual, and low-pressure. Use natural contractions.
- NEVER use em dashes. Use commas, periods, or split the sentence instead.
- Ask exactly ONE question in the whole email, and keep the closer low-pressure.
- Use people's first names. Only reference names that appear in the thread or the colleague list below, NEVER invent a name or title.
- Body under 110 words.${signatureRule}${extraRules}

Lead: ${input.leadName || "unknown"} at ${input.company || "unknown"}.

People who may work at the same company (use one if it helps routing; skip if not useful):
${colleagueLines}

Email thread so far (oldest first):
${input.thread}

Their most recent reply:
"""
${input.latestReply}
"""
${input.userNote ? `\nThe reviewer added this guidance, follow it:\n"""${input.userNote}"""\n` : ""}
Situation: ${input.guidance ?? "Reply appropriately and briefly."}

Return ONLY the email body text (no subject line, no commentary).`;
}

export async function draftReply(input: DraftInput): Promise<string | null> {
  try {
    const client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: input.settings.model ?? getEnv().ANTHROPIC_MODEL,
      max_tokens: 700,
      messages: [{ role: "user", content: buildDraftPrompt(input) }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}
