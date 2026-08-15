import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { getCampaignSequences, type SmartleadSequenceEmail } from "@/lib/smartlead";
import { createHash } from "node:crypto";
import { activeColumnModel, generateCustomColumnValue, getColumnById, getCustomExportVariables, getEmailQaDetails, getTableColumns, runCustomColumn, TENURE_FALLBACK, type CustomColumn, type GenerateCellResult } from "@/lib/enrichment/custom-columns";
import { getEmailReviewConfig } from "@/lib/enrichment/email-review-config";
import { isMeteredProvider, reasoningOptions, runEnrichmentPrompt, type EnrichmentPromptResult } from "@/lib/enrichment/llm-runner";
import { getEffectiveCampaignForTable } from "@/lib/enrichment/workspace";

/* Email review (QA) support: render a campaign's live sequence with a lead's
   variables filled in, gather every variable and its source context, and (in the
   runner) check the result for hallucinations before export. */

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* Collapse Smartlead spintax {a|b|c} to its first option so a preview reads as one
   coherent email. Runs innermost-first for nested spintax and never touches
   {{variables}} (their inner {name} has no pipe). */
export function collapseSpintax(text: string): string {
  let prev = "";
  let out = text;
  while (out !== prev) {
    prev = out;
    out = out.replace(/\{([^{}]*)\}/g, (match, inner: string) => (inner.includes("|") ? inner.split("|")[0] : match));
  }
  return out;
}

/* Convert Smartlead's HTML body to readable plain text: block/br tags become
   newlines, other tags drop, common entities decode. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "-")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

export type FillResult = { text: string; unfilled: string[] };

/* Replace {{name}} tokens. Known lead/column variables get their value. Smartlead
   runtime natives ({{sl_*}}) become a readable placeholder (they only resolve at
   send time). Anything else is left as-is and reported as unfilled so QA flags it. */
export function fillTemplate(template: string, vars: Record<string, string>): FillResult {
  const unfilled: string[] = [];
  const text = template.replace(TEMPLATE_VAR_RE, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const value = vars[name];
      if (!value) unfilled.push(name);
      return value;
    }
    if (name.startsWith("sl_")) return `[${name.replace(/^sl_/, "").replace(/_/g, " ")}]`;
    unfilled.push(name);
    return `{{${name}}}`;
  });
  return { text, unfilled };
}

/* Punctuation-artifact check across EVERY active variant's render. The main
   renders only show each step's first variant, so a template defect in variant
   B/C - e.g. "{{role_responsibility}} , you've" left behind when a variable was
   deleted from the copy - is invisible to the verifier without this. A value
   carrying stray trailing whitespace produces the same fingerprint and is
   caught the same way. */
function renderArtifactIssues(sequences: SmartleadSequenceEmail[], vars: Record<string, string>): string[] {
  const issues: string[] = [];
  for (const seq of sequences) {
    const texts = seq.variantTexts ?? [`${seq.subject}\n${seq.body}`];
    texts.forEach((raw, index) => {
      const rendered = fillTemplate(htmlToText(collapseSpintax(raw)), vars).text
        // Tokens still unresolved here (Smartlead runtime {{sl_*}}, or a blank
        // variable the blank check reports on its own) stand in as a word so
        // their gap is not itself misread as a punctuation artifact.
        .replace(/\{\{\s*[\w.]+\s*\}\}/g, "X");
      for (const line of rendered.split("\n")) {
        const hit = line.match(/[ \t\u00A0]+[,.;!?]/);
        if (!hit) continue;
        const at = hit.index ?? 0;
        const snippet = line.slice(Math.max(0, at - 30), at + 10).trim();
        const variant = texts.length > 1 ? ` variant ${String.fromCharCode(65 + index)}` : "";
        issues.push(`email ${seq.step}${variant}: space before punctuation ("...${snippet}...")`);
      }
    });
  }
  return [...new Set(issues)];
}

/* One rendered email for the QA preview. */
export type QaEmail = { step: number; subject: string; body: string; unfilled: string[] };
/* One variable's value plus where it came from, for the hallucination check. */
export type QaVariable = { name: string; value: string; filled: boolean };
export type QaContextFields = {
  finalFirstName: string;
  firstNameRaw: string;
  finalCompanyName: string;
  companyRaw: string;
  title: string;
  roleLevel: string;
  companyWhatTheyMake: string;
  companyMarkets: string;
  companySummary: string;
  linkedinHeadline: string;
};

export type EmailQaPayload = {
  campaignId: string;
  emails: QaEmail[];
  /* The verifier's copy: identical to `emails` but with Smartlead runtime tokens
     ({{sl_*}}) stripped, so the model never sees (and never mis-flags) a value
     Smartlead fills in itself, like the day of the week. Not stored. */
  verifierEmails: QaEmail[];
  variables: QaVariable[];
  context: QaContextFields;
  /* Variable names used anywhere in the sequence, so the checker/UI know the set. */
  usedVariables: string[];
  /* Punctuation defects found in ANY active variant's render (template-level
     copy problems a per-variable check cannot see). Non-empty holds the lead. */
  renderArtifacts: string[];
};

/* Gather everything needed to render + check the sequence for one lead: the live
   templates filled in, each variable's value, and the original source fields so a
   human (and the checker) can verify nothing was hallucinated. */
export async function buildEmailQaPayload(campaignId: string, tableId: string, leadId: string): Promise<EmailQaPayload> {
  const admin = getAdminClient();
  const [{ data: leadRow, error: leadErr }, sequences] = await Promise.all([
    admin.from("leads").select("*").eq("id", leadId).maybeSingle(),
    getCampaignSequences(campaignId),
  ]);
  if (leadErr) throw new Error(`Lead load: ${leadErr.message}`);
  if (!leadRow) throw new Error("Lead not found.");
  const row = leadRow as Record<string, unknown>;

  // company_summary (scraped research) for context display.
  let cs: Record<string, unknown> = {};
  if (row.company_id) {
    const company = await admin.from("companies").select("company_summary").eq("id", String(row.company_id)).maybeSingle();
    const raw = (company.data as { company_summary?: unknown } | null)?.company_summary;
    if (raw && typeof raw === "object") cs = raw as Record<string, unknown>;
  }

  const finalFirstName = str(row.final_first_name);
  const finalCompanyName = str(row.final_company_name);
  const domain = str(row.domain);
  // Native fields Smartlead fills from the lead record we push on export (see
  // exportLeadCore / addCampaignLeads). Kept aligned with that call so the preview
  // shows exactly what the recipient gets; first_name/company_name use the cleaned
  // value, falling back to raw only when the clean one is missing (QA then flags).
  const vars: Record<string, string> = {
    first_name: finalFirstName || str(row.first_name),
    last_name: str(row.last_name),
    email: str(row.email),
    company_name: finalCompanyName || str(row.company),
    website: domain ? `https://${domain.replace(/^https?:\/\//, "")}` : "",
    // Smartlead's linkedin_profile field is the URL we push from linkedin_url.
    linkedin_profile: str(row.linkedin_url),
    // Smartlead fills sl_day_of_the_week at send time; fill the current weekday so
    // the preview reads naturally and QA never treats it as missing.
    sl_day_of_the_week: DAY_NAMES[new Date().getDay()],
  };

  // Custom variables come from EXACTLY the export path: getCustomExportVariables
  // (the table's variable -> column mappings), with the same legacy fallback as
  // exportLeadCore when a table has no mappings. This guarantees the preview and
  // the QA check match what Smartlead actually sends - no variable that previews
  // filled but sends blank, or the reverse.
  const customVars = await getCustomExportVariables(tableId, leadId);
  const sendVars = Object.keys(customVars).length > 0
    ? customVars
    : { title: str(row.final_title), operations_task: str(row.operations_task), ops_candidate: str(row.ops_candidate) };
  for (const [name, value] of Object.entries(sendVars)) vars[name] = value;

  const emails: QaEmail[] = sequences.map((seq: SmartleadSequenceEmail) => {
    const subject = fillTemplate(collapseSpintax(seq.subject), vars);
    const body = fillTemplate(htmlToText(collapseSpintax(seq.body)), vars);
    return {
      step: seq.step,
      subject: subject.text,
      body: body.text,
      unfilled: [...new Set([...subject.unfilled, ...body.unfilled])],
    };
  });

  // The verifier's copy: {{sl_*}} runtime tokens are FILLED with stand-ins (the
  // current weekday via vars, or fillTemplate's readable placeholder), never
  // stripped. Deleting a mid-sentence token used to turn
  // "great {{sl_day_of_the_week}} {{first_name}}," into "great Cindy," - which
  // the checker rightly flagged as broken template grammar, holding real leads
  // on a defect that does not exist in the sent email.
  const tidy = (t: string) => t.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const verifierEmails: QaEmail[] = sequences.map((seq) => {
    const subject = fillTemplate(collapseSpintax(seq.subject), vars);
    const body = fillTemplate(htmlToText(collapseSpintax(seq.body)), vars);
    return {
      step: seq.step,
      subject: tidy(subject.text),
      body: tidy(body.text),
      unfilled: [...new Set([...subject.unfilled, ...body.unfilled])],
    };
  });

  // Which variables the sequence actually uses (so QA only judges relevant ones).
  // Scan every active variant body too, so a variable used only in an A/B variant
  // that is not the one shown is still detected and checked.
  const used = new Set<string>();
  for (const seq of sequences) {
    const scan = [seq.subject, seq.body, ...(seq.variantTexts ?? [])].join("\n");
    for (const m of scan.matchAll(TEMPLATE_VAR_RE)) used.add(m[1]);
  }
  const usedVariables = [...used];
  const variables: QaVariable[] = usedVariables
    .filter((name) => !name.startsWith("sl_"))
    .map((name) => ({ name, value: vars[name] ?? "", filled: Boolean(vars[name]) }));

  return {
    campaignId,
    emails,
    verifierEmails,
    variables,
    usedVariables,
    renderArtifacts: renderArtifactIssues(sequences, vars),
    context: {
      finalFirstName,
      firstNameRaw: str(row.first_name),
      finalCompanyName,
      companyRaw: str(row.company),
      title: str(row.title),
      roleLevel: str(row.role_level),
      companyWhatTheyMake: str(cs.what_they_make),
      companyMarkets: str(cs.markets),
      companySummary: str(cs.summary),
      linkedinHeadline: str((row.linkedin_profile as { headline?: unknown } | null)?.headline),
    },
  };
}

/* ── Verify + self-repair ─────────────────────────────────────────────────── */

// Values that read like a model erroring or refusing rather than real copy.
// The "i won't fabricate" / "the context doesn't include" shapes are real
// refusals that shipped past the original list (a tenure cell exported a full
// explanation paragraph), so match refusal INTENT broadly - these cells hold
// short marketing copy where first-person refusal phrasing never appears.
const AI_ERROR_RE = /\b(as an ai|i(?:'m| am) sorry|i can(?:'t|not)\b|i (?:am|'m) unable|i won'?t\b|i will not\b|language model|i (?:do|don't) (?:not )?have (?:enough|access)|cannot (?:comply|help|assist|provide)|not enough (?:information|context)|insufficient (?:information|context)|unable to (?:determine|generate|find)|the context (?:doesn'?t|does not|didn'?t|did not)\b|(?:could|can) you provide|please provide)\b/i;
export function looksLikeAiError(value: string): boolean {
  return AI_ERROR_RE.test(value);
}

// Short description of where a variable came from, so the checker can judge
// whether the value is faithful to its source (hallucination check).
function variableSource(name: string, ctx: QaContextFields): string {
  if (name === "first_name") return `the lead's first name (raw: "${ctx.firstNameRaw}")`;
  if (name === "company_name") return `the normalized company name (raw company on file: "${ctx.companyRaw}")`;
  if (name === "tenure") return `LinkedIn experience / headline: "${ctx.linkedinHeadline}"`;
  if (name === "role_responsibility") return `job title "${ctx.title}" (${ctx.roleLevel}); LinkedIn headline "${ctx.linkedinHeadline}"`;
  if (name.startsWith("ops_task")) return `company research - makes: "${ctx.companyWhatTheyMake}"; markets: "${ctx.companyMarkets}"`;
  return "a generated field";
}

export type VerifierResult = {
  verdict: "ready" | "needs_review";
  variables: { name: string; ok: boolean; issue: string }[];
  notes: string[];
  // The verifier CALL itself failed (runner down / rate-limited / timed out) - not
  // a content verdict. The caller must not persist this as "needs review".
  failed?: boolean;
  failure?: string;
};

function parseVerdict(text: string): VerifierResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "needs_review", variables: [], notes: ["The QA check output could not be read."] };
  try {
    const j = JSON.parse(match[0]) as { verdict?: unknown; variables?: unknown; notes?: unknown };
    const variables = Array.isArray(j.variables)
      ? (j.variables as Record<string, unknown>[])
          .map((v) => ({ name: String(v.name ?? ""), ok: v.ok !== false, issue: str(v.issue) }))
          .filter((v) => v.name)
      : [];
    const notes = Array.isArray(j.notes) ? (j.notes as unknown[]).map(str).filter(Boolean) : [];
    return { verdict: j.verdict === "ready" ? "ready" : "needs_review", variables, notes };
  } catch {
    return { verdict: "needs_review", variables: [], notes: ["The QA check returned invalid JSON."] };
  }
}

/* One email-review run makes several model calls (the verifier, the ops-task
   check, per-variable re-checks, and any manual-mode proposal generations). This
   accumulates their token + time spend so the WHOLE review's cost is recorded on
   the email-review cell (and thus counted in the table total, classified by the
   real provider). Auto-repairs are deliberately NOT accumulated here: they run
   through runCustomColumn and record their spend on their own AI cell. */
type QaSpend = { input: number; output: number; ms: number; provider: string | null };
function newQaSpend(): QaSpend { return { input: 0, output: 0, ms: 0, provider: null }; }
/* One review can mix providers (a column may pin a different model than the global
   verifier). The cell holds a single provider, so prefer an API one: API is the
   metered route and the ONLY source of counted tokens (CLI reports none), so a run
   that touched the API must route there or its real tokens would read as free. */
function accProvider(acc: QaSpend, provider: string | undefined): void {
  if (!provider) return;
  if (!acc.provider || (isMeteredProvider(provider) && !isMeteredProvider(acc.provider))) acc.provider = provider;
}
function accResult(acc: QaSpend, res: EnrichmentPromptResult): void {
  if (!res.ok) return;
  acc.ms += res.durationMs;
  accProvider(acc, res.provider);
  if (res.usage) { acc.input += res.usage.inputTokens; acc.output += res.usage.outputTokens; }
}
function accGen(acc: QaSpend, gen: GenerateCellResult): void {
  if (!gen.ok) return;
  acc.ms += gen.durationMs;
  accProvider(acc, gen.provider);
  if (gen.usage) { acc.input += gen.usage.inputTokens; acc.output += gen.usage.outputTokens; }
}

async function verifyEmails(payload: EmailQaPayload, model: string, effort: string | null, spend: QaSpend): Promise<VerifierResult> {
  const emails = payload.verifierEmails
    .map((e) => `[Email ${e.step}] Subject: ${e.subject || "(none - this is a follow-up threaded to the previous email, which is normal)"}\n${e.body}`)
    .join("\n\n");
  const vars = payload.variables
    .map((v) => `- ${v.name} = ${JSON.stringify(v.value)}  (from ${variableSource(v.name, payload.context)})`)
    .join("\n");
  const prompt = `You are the final QA check before these cold emails go to a real prospect. Your job is narrow: make sure every variable is filled in and that nothing reads like it came from an AI model (a tell that this is automated). Be lenient - assume the copy and template are intentional.

Flag a variable ONLY if:
- it is blank, empty, or still shows a {{token}}; or
- it reads like an AI model talking: an apology, refusal, "as an AI", "I cannot", "I'm sorry", "insufficient information", a note to the user, or a bracketed placeholder left in; or
- it is obvious gibberish or clearly about a different company than the one in the source data (a real hallucination).

Do NOT flag: shortened or casual company names, tone, style, grammar nitpicks, phrasing, missing subject lines (follow-ups are threaded), or spintax. company_name is deliberately shortened to sound like a human wrote it - "MAMCO" for "MAMCO Precision Molding" is CORRECT; only flag it if it is a completely different or nonsense company. Never invent problems.

Return ONLY minified JSON: {"verdict":"ready"|"needs_review","variables":[{"name":"...","ok":true,"issue":""}],"notes":[]}. verdict is "needs_review" only if at least one variable is genuinely blank or has an AI tell; otherwise "ready".

=== Emails (variables filled in) ===
${emails}

=== Variables and their source data ===
${vars}`;
  // The local CLI occasionally returns prose/truncated JSON that will not parse; a
  // genuine verdict returns first-try. Retry ONCE on an unreadable result so an
  // intermittent format blip does not become a false "needs review" that blocks
  // export. A real runner failure (not a parse issue) returns immediately.
  let last: VerifierResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await runEnrichmentPrompt(prompt, { model, ...reasoningOptions(700, effort) });
    accResult(spend, res);
    if (!res.ok) return { verdict: "needs_review", variables: [], notes: [`QA check failed: ${res.message}`], failed: true, failure: res.message };
    const parsed = parseVerdict(res.text);
    const parseFailed = parsed.variables.length === 0 && parsed.notes.some((n) => /could not be read|invalid JSON/i.test(n));
    if (!parseFailed) return parsed;
    last = parsed;
  }
  // Persistent parse failure is a runner/format problem, not a content verdict.
  // Mark it FAILED so the caller retries instead of writing a false "needs
  // review" - critical now that notes no longer block, since an unparsed verdict
  // has no variable flags and would otherwise read as clean and export unchecked.
  return {
    ...(last ?? { verdict: "needs_review" as const, variables: [], notes: ["The QA check returned an unreadable result."] }),
    failed: true,
    failure: "verifier output was unreadable after a retry",
  };
}

async function judgeVariable(name: string, value: string, ctx: QaContextFields, model: string, effort: string | null, spend: QaSpend): Promise<{ ok: boolean; issue: string }> {
  const prompt = `A cold email uses the variable "${name}" with value: ${JSON.stringify(value)}, generated from ${variableSource(name, ctx)}. Accept it unless it is blank, reads like an AI model (apology, refusal, "as an AI", a placeholder, a note to the user), or is obvious gibberish / a clearly different company. Shortened or casual forms are fine and expected. Reply ONLY minified JSON: {"ok":true|false,"issue":"short reason if not ok"}.`;
  const res = await runEnrichmentPrompt(prompt, { model, ...reasoningOptions(150, effort) });
  accResult(spend, res);
  if (!res.ok) return { ok: false, issue: `re-check failed: ${res.message}` };
  const match = res.text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, issue: "re-check could not be read" };
  try {
    const j = JSON.parse(match[0]) as { ok?: unknown; issue?: unknown };
    return { ok: j.ok === true, issue: str(j.issue) };
  } catch {
    return { ok: false, issue: "re-check returned invalid JSON" };
  }
}

/* The house style for the ops-task idea bullets, shared by the batch check and
   the per-repair re-check so both judge the same way. Kept lenient: only clear
   violations are flagged, never a good, specific, natural bullet. */
const OPS_TASK_RULES = `Each value is ONE operational-idea bullet in a cold email. A GOOD bullet reads as one natural sentence, usually starting "an automation that ...", "an AI agent that ...", or "a tool that ...", in plain conversational language. Being specific and technical about the business is good and expected.
A bullet is BAD only if it clearly:
- starts with the company's product or material name, or reads as a stacked noun label (like "copper cathode quality certificate builder for each shipment lot") instead of a natural sentence with a verb; or
- repeats the email's lead-in text (for example it starts with "Here is an idea for an automation or agent you can build ..."); or
- is blank, a leftover placeholder/token, or reads like an AI error or note to the user.`;

/* Batch style check across all the ops-task bullets for one lead: judges each
   against OPS_TASK_RULES and also flags any two that start with the same opener
   word AND main verb (so the three do not read alike). Returns name -> issue for
   only the failing bullets. Fails open (no flags) if the check itself errors, so
   a checker outage never blocks the review. */
async function reviewOpsTasks(tasks: { name: string; value: string }[], model: string, effort: string | null, spend: QaSpend): Promise<Map<string, string>> {
  const failing = new Map<string, string>();
  if (!tasks.length) return failing;
  const list = tasks.map((t) => `${t.name}: ${JSON.stringify(t.value)}`).join("\n");
  const prompt = `You are checking the operational-idea bullets in a cold email.
${OPS_TASK_RULES}
Also flag a bullet if it starts with the SAME opener word AND the same main verb as another bullet below - the bullets should not all read alike.
Be lenient: only flag clear violations, never a good natural bullet.

Bullets:
${list}

Return ONLY minified JSON: {"tasks":[{"name":"ops_task_1","ok":true,"issue":""}]} with one entry per bullet; set a short issue only when ok is false.`;
  const res = await runEnrichmentPrompt(prompt, { model, ...reasoningOptions(400, effort) });
  accResult(spend, res);
  if (!res.ok) return failing;
  const match = res.text.match(/\{[\s\S]*\}/);
  if (!match) return failing;
  try {
    const j = JSON.parse(match[0]) as { tasks?: Record<string, unknown>[] };
    for (const t of j.tasks ?? []) {
      const name = String(t.name ?? "");
      if (name && t.ok === false) failing.set(name, str(t.issue) || "does not follow the operational-idea bullet style");
    }
  } catch { /* ignore malformed JSON: treat as no style flags */ }
  return failing;
}

/* Single-bullet re-check used after a repair regenerates an ops-task cell, so the
   loop only accepts a value that actually fixed the style. Fails open on a
   checker error to avoid burning both repair attempts on an outage. */
async function judgeOpsTaskStyle(value: string, model: string, effort: string | null, spend: QaSpend): Promise<{ ok: boolean; issue: string }> {
  const prompt = `You are checking one operational-idea bullet from a cold email: ${JSON.stringify(value)}.
${OPS_TASK_RULES}
Be lenient: accept any good, natural bullet; reject only a clear violation.
Return ONLY minified JSON: {"ok":true|false,"issue":"short reason if not ok"}.`;
  const res = await runEnrichmentPrompt(prompt, { model, ...reasoningOptions(150, effort) });
  accResult(spend, res);
  if (!res.ok) return { ok: true, issue: "" };
  const match = res.text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: true, issue: "" };
  try {
    const j = JSON.parse(match[0]) as { ok?: unknown; issue?: unknown };
    return { ok: j.ok !== false, issue: str(j.issue) };
  } catch { return { ok: true, issue: "" }; }
}

/* ── Sentence-fragment guardrail (tenure + role_responsibility) ─────────────
   These fill "after {tenure} {role_responsibility} at {company}, ..." and must be
   clean CORE phrases - the general verifier ignores phrasing, so a title's messy
   extras (a location like "Cloverdale", a rank, a company) can leak in and break
   the human-written line. A deterministic red-flag catches the clearest structural
   leaks; a lenient LLM pass catches the subtler ones (adjectival place, raw-title
   copy). Both feed the same repair/propose loop as the ops-task check. */

/* Cheap, near-zero-false-positive structural checks. role_responsibility is a bare
   "-ing" phrase, so an "at" (the sentence already says "at {company}") or a comma
   is always a leaked place/title fragment; tenure should never be an exact decimal. */
function sentenceFieldRedFlag(name: string, value: string): string | null {
  const v = value.trim();
  if (name === "role_responsibility") {
    if (/\bat\b/i.test(v)) return `contains "at ...": the email already says "at [company]", so "${v}" produces the broken "...${v} at [company]". Use a bare core phrase like "leading operations".`;
    if (/[,;]/.test(v)) return `contains a comma/semicolon that reads like a copied title fragment: "${v}".`;
  }
  if (name === "tenure") {
    if (/\d+\.\d+/.test(v)) return `is an exact decimal ("${v}"); say it naturally, like "over two years".`;
  }
  return null;
}

/* Batch check across tenure + role_responsibility for one lead: deterministic
   red-flags first, then a lenient LLM pass (given the real title/company) for the
   subtler leaks. Returns name -> issue for only the failing fields. Fails open on a
   checker error so an outage never blocks the review. */
async function reviewSentenceFields(fields: { name: string; value: string }[], ctx: QaContextFields, model: string, effort: string | null, spend: QaSpend): Promise<Map<string, string>> {
  const failing = new Map<string, string>();
  const forLlm: { name: string; value: string }[] = [];
  for (const f of fields) {
    const flag = sentenceFieldRedFlag(f.name, f.value);
    if (flag) failing.set(f.name, flag);
    else forLlm.push(f);
  }
  if (!forLlm.length) return failing;
  const list = forLlm.map((f) => `${f.name}: ${JSON.stringify(f.value)}`).join("\n");
  const prompt = `You are checking short personalization phrases slotted into ONE cold-email sentence:
"after {tenure} {role_responsibility} at {company}, ..."
The lead's real job title is ${JSON.stringify(ctx.title)} at company ${JSON.stringify(ctx.finalCompanyName || ctx.companyRaw)}.

- role_responsibility must be the person's CORE function as a short natural phrase (e.g. "leading operations", "managing production"). Flag it ONLY if it: names a location, site, plant, region, facility, or a company (e.g. "leading cloverdale operations", "running the texas facility"); copies the raw job title or a rank label (director, manager, vp, head of); or reads clearly unnatural in the sentence. Normal overlap is fine ("Operations Manager" -> "managing operations"). Ordinary business terms (supply chain, go-to-market, R&D, P&L, customer success) are fine.
- tenure must be a natural spoken duration (e.g. "over two years"). Flag ONLY if it names a place or company, or reads clearly unnatural.

Be lenient: flag only a CLEAR problem, never a good natural phrase.
Fields:
${list}
Return ONLY minified JSON: {"fields":[{"name":"role_responsibility","ok":true,"issue":""}]} with one entry per field; set a short issue only when ok is false.`;
  const res = await runEnrichmentPrompt(prompt, { model, ...reasoningOptions(300, effort) });
  accResult(spend, res);
  if (!res.ok) return failing;
  const match = res.text.match(/\{[\s\S]*\}/);
  if (!match) return failing;
  try {
    const j = JSON.parse(match[0]) as { fields?: Record<string, unknown>[] };
    for (const t of j.fields ?? []) {
      const name = String(t.name ?? "");
      if (name && t.ok === false && !failing.has(name)) failing.set(name, str(t.issue) || "leaked source data or reads unnatural");
    }
  } catch { /* ignore malformed JSON: treat as no flags */ }
  return failing;
}

/* Single-field re-check after a repair regenerates tenure/role_responsibility, so
   the loop only accepts a value that is actually clean. Deterministic first, then a
   lenient single-field LLM check; fails open on a checker error. */
async function judgeSentenceField(name: string, value: string, ctx: QaContextFields, model: string, effort: string | null, spend: QaSpend): Promise<{ ok: boolean; issue: string }> {
  const flag = sentenceFieldRedFlag(name, value);
  if (flag) return { ok: false, issue: flag };
  const prompt = `A cold email uses ${name} = ${JSON.stringify(value)} in the sentence "after {tenure} {role_responsibility} at {company}, ...". The lead's real job title is ${JSON.stringify(ctx.title)} at company ${JSON.stringify(ctx.finalCompanyName || ctx.companyRaw)}. Accept it unless it names a location/site/plant/region or the company (by any form of its name), copies the raw title or a rank label (director, manager, vp, head of), is an exact decimal duration, or reads clearly unnatural. Normal overlap and ordinary business terms are fine. Reply ONLY minified JSON: {"ok":true|false,"issue":"short reason if not ok"}.`;
  const res = await runEnrichmentPrompt(prompt, { model, ...reasoningOptions(150, effort) });
  accResult(spend, res);
  if (!res.ok) return { ok: true, issue: "" };
  const match = res.text.match(/\{[\s\S]*\}/);
  if (!match) return { ok: true, issue: "" };
  try {
    const j = JSON.parse(match[0]) as { ok?: unknown; issue?: unknown };
    return { ok: j.ok !== false, issue: str(j.issue) };
  } catch { return { ok: true, issue: "" }; }
}

export type EmailQaRepair = { name: string; from: string; to: string | null; accepted: boolean; reason: string; note: string };
export type EmailQaResult = { ok: true; verdict: "ready" | "needs_review"; repaired: number } | { ok: false; message: string };

/* Inspection payload for the click-to-view dialog. The emails, variables, and
   context are rendered LIVE against the campaign's current copy (so editing the
   Smartlead copy is reflected immediately), while the verdict, issues, and repair
   log come from the last run. `reviewed` is false if the review never ran. */
export async function getEmailQaInspection(qaColumnId: string, leadId: string): Promise<{
  verdict: "ready" | "needs_review";
  reviewed: boolean;
  campaignName: string;
  emails: QaEmail[];
  variables: QaVariable[];
  context: QaContextFields | null;
  issues: string[];
  repairs: EmailQaRepair[];
} | null> {
  const column = await getColumnById(qaColumnId);
  if (!column || column.kind !== "email_qa") return null;
  const stored = (await getEmailQaDetails(qaColumnId, leadId)) as {
    verdict?: "ready" | "needs_review"; campaignName?: string; emails?: QaEmail[]; variables?: QaVariable[];
    context?: QaContextFields; issues?: string[]; repairs?: EmailQaRepair[];
  } | null;
  const campaign = await getEffectiveCampaignForTable(column.tableId);
  let live: EmailQaPayload | null = null;
  if (campaign) { try { live = await buildEmailQaPayload(campaign.id, column.tableId, leadId); } catch { live = null; } }
  if (!stored && !live) return null;
  return {
    verdict: stored?.verdict ?? "needs_review",
    reviewed: Boolean(stored),
    campaignName: campaign?.name ?? stored?.campaignName ?? "",
    emails: live?.emails ?? stored?.emails ?? [],
    variables: live?.variables ?? stored?.variables ?? [],
    context: live?.context ?? stored?.context ?? null,
    issues: stored?.issues ?? [],
    repairs: stored?.repairs ?? [],
  };
}

/* Run the email review for one lead: render + gather, verify, then for every bad
   variable that maps to an AI column, call runCustomColumn (an independent
   generation) with the critique as guidance, re-check, and overwrite the cell
   with the accepted value. Re-render, take the final verdict, and store the whole
   inspection payload in the QA cell's details. */
/* Manual-mode flag: precompute a proposed fix for every flagged AI-column cell
   (generate-only, no writeback), open a fresh current review item + proposals,
   and set the QA cell to "Needs review" so the lead cannot export until a human
   resolves it. Cells are left untouched. */
async function proposeReview(params: {
  column: CustomColumn;
  leadId: string;
  campaign: { id: string; name: string };
  payload: EmailQaPayload;
  bad: Map<string, string>;
  colByKey: Map<string, CustomColumn>;
  updatedBy: string;
  spend: QaSpend;
}): Promise<EmailQaResult> {
  const { column, leadId, campaign, payload, bad, colByKey, updatedBy, spend } = params;
  const admin = getAdminClient();
  const now = new Date().toISOString();

  type PendingProposal = {
    column_id: string | null; column_key: string; column_label: string; issue: string;
    original_value: string; proposed_value: string | null; expected_cell_revision: number | null;
    expected_generation_version: number | null; validation_status: string; selected: boolean; provider: string | null;
  };
  const proposals: PendingProposal[] = [];
  const sourceRevisions: Record<string, number> = {};
  const issues: string[] = [];

  for (const [name, reason] of bad) {
    const original = payload.variables.find((v) => v.name === name)?.value ?? "";
    issues.push(`${name}: ${reason}`);
    const col = colByKey.get(name);
    if (!col) {
      // Not a regenerable AI column (e.g. a blank built-in field): record the
      // issue, but there is nothing to auto-propose - the source must be fixed.
      proposals.push({ column_id: null, column_key: name, column_label: name, issue: reason, original_value: original, proposed_value: null, expected_cell_revision: null, expected_generation_version: null, validation_status: "failed", selected: false, provider: null });
      continue;
    }
    const cell = await admin.from("enrichment_cell_values").select("revision").eq("column_id", col.id).eq("lead_id", leadId).maybeSingle();
    const rev = Number((cell.data as { revision?: number } | null)?.revision) || 0;
    sourceRevisions[col.key] = rev;
    const guidance = `The value produced for this field was: ${JSON.stringify(original)}. The email review flagged it because: ${reason}. Produce a corrected value that fixes exactly that, following all the original rules.`;
    const gen = await generateCustomColumnValue(col.id, leadId, guidance);
    accGen(spend, gen);
    proposals.push({
      column_id: col.id, column_key: col.key, column_label: col.label, issue: reason, original_value: original,
      proposed_value: gen.ok ? gen.value : null,
      expected_cell_revision: rev, expected_generation_version: col.generationVersion,
      validation_status: gen.ok ? "valid" : "failed", selected: gen.ok, provider: gen.ok ? gen.provider : null,
    });
  }

  const copyHash = createHash("sha256").update(JSON.stringify(payload.emails)).digest("hex").slice(0, 32);
  const snapshot = { emails: payload.emails, variables: payload.variables, context: payload.context, campaignName: campaign.name };

  // Supersede any existing current review for this lead, then open a new one.
  await admin.from("enrichment_review_items").update({ is_current: false }).eq("table_id", column.tableId).eq("lead_id", leadId).eq("is_current", true);
  const itemRes = await admin.from("enrichment_review_items").insert({
    table_id: column.tableId, lead_id: leadId, qa_column_id: column.id, campaign_id: campaign.id,
    mode_at_run: "manual", status: "pending", is_current: true,
    issues, snapshot, source_revisions: sourceRevisions, campaign_copy_hash: copyHash, created_by: updatedBy,
  }).select("id").single();
  if (itemRes.error) return { ok: false, message: itemRes.error.message };
  const reviewItemId = String((itemRes.data as { id: string }).id);

  const propRows = proposals.map((p) => ({ review_item_id: reviewItemId, kind: "initial", created_by: updatedBy, ...p }));
  if (propRows.length) {
    const insP = await admin.from("enrichment_review_proposals").insert(propRows);
    if (insP.error) return { ok: false, message: insP.error.message };
  }

  const existing = await admin.from("enrichment_cell_values").select("revision").eq("column_id", column.id).eq("lead_id", leadId).maybeSingle();
  const revision = (Number((existing.data as { revision?: number } | null)?.revision) || 0) + 1;
  const details = { verdict: "needs_review" as const, reviewItemId, campaignId: campaign.id, campaignName: campaign.name, emails: payload.emails, variables: payload.variables, context: payload.context, issues };
  const { error } = await admin.from("enrichment_cell_values").upsert({
    column_id: column.id, lead_id: leadId, value: "Needs review", revision,
    generation_version: column.generationVersion, model: null, provider: spend.provider ?? "email-qa",
    input_tokens: spend.input || null, output_tokens: spend.output || null, duration_ms: spend.ms || null,
    details, updated_at: now, updated_by: updatedBy,
  }, { onConflict: "column_id,lead_id" });
  if (error) return { ok: false, message: error.message };

  await admin.from("lead_runs").insert({
    lead_id: leadId, action: "email_qa", provider: spend.provider ?? "email-qa", ok: true,
    message: `Email review: proposed ${proposals.filter((p) => p.proposed_value).length} fix(es), needs review`,
    details: { column_id: column.id, table_id: column.tableId, verdict: "needs_review", review_item_id: reviewItemId, input_tokens: spend.input || null, output_tokens: spend.output || null, duration_ms: spend.ms || null },
  });
  return { ok: true, verdict: "needs_review", repaired: 0 };
}

export async function runEmailQa(qaColumnId: string, leadId: string, updatedBy: string): Promise<EmailQaResult> {
  const column = await getColumnById(qaColumnId);
  if (!column) return { ok: false, message: "Column not found." };
  if (column.kind !== "email_qa") return { ok: false, message: "Not an email review column." };
  const campaign = await getEffectiveCampaignForTable(column.tableId);
  if (!campaign) return { ok: false, message: "Tag this list to a Smartlead campaign before running the email review." };

  const colByKey = new Map((await getTableColumns(column.tableId)).filter((c) => c.kind === "ai").map((c) => [c.key, c]));
  // Accumulates the review's own model-call spend (verify + judges + manual-mode
  // proposal generations) so it lands on the email-review cell. Auto-repairs
  // record separately on their AI cells and must not be added here.
  const spend = newQaSpend();
  // The gate runs on the model chosen on the email-review column itself, for the
  // active mode - the same rule every other column follows.
  const model = await activeColumnModel(column);
  const effort = column.reasoningEffort;
  let payload = await buildEmailQaPayload(campaign.id, column.tableId, leadId);

  // Problems = deterministic (blank / AI-error text) plus the verifier's findings.
  const bad = new Map<string, string>();
  for (const v of payload.variables) {
    if (!v.filled) bad.set(v.name, "blank or unfilled");
    else if (looksLikeAiError(v.value)) bad.set(v.name, "reads like an AI error message");
  }
  // Campaign-copy artifacts live in the Smartlead template (or a value's stray
  // whitespace), not in one lead's fields: hold the lead and surface the exact
  // snippet under a pseudo-variable. Nothing is regenerable here - the fix is
  // editing the template (or the flagged value), then re-running the review.
  if (payload.renderArtifacts.length > 0) {
    bad.set("campaign_copy", payload.renderArtifacts.join(" | "));
  }
  // Only our real variables can be flagged/repaired; ignore Smartlead natives
  // (sl_*) and any stray name the checker invents - they are not our columns.
  const knownVariables = new Set(payload.variables.map((v) => v.name));
  const firstVerdict = await verifyEmails(payload, model, effort, spend);
  // A runner failure (CLI exited, rate-limited, timed out) is NOT a content
  // verdict: bail with a retryable error rather than writing a misleading
  // "Needs review" cell that blocks export. The durable job retries; a manual run
  // shows this message.
  if (firstVerdict.failed) {
    return { ok: false, message: `The email review could not run its check (${firstVerdict.failure ?? "runner error"}). This is a runner problem, not a content issue - retry it. If the local CLI keeps failing (it is rate-limited during large batches), switch the enrichment runner to an API provider under Settings.` };
  }
  for (const v of firstVerdict.variables) {
    if (!v.ok && knownVariables.has(v.name) && !v.name.startsWith("sl_")) bad.set(v.name, v.issue || "flagged by the QA check");
  }

  // Ops-task style guardrail: the general verifier ignores phrasing, so check the
  // operational-idea bullets against the house style (natural "an X that..."
  // sentence, not a product-first noun label, not all alike) and route any
  // violation into the same repair loop that regenerates the cell.
  const opsTaskVars = payload.variables.filter((v) => v.name.startsWith("ops_task") && v.filled);
  if (opsTaskVars.length) {
    const styleFail = await reviewOpsTasks(opsTaskVars.map((v) => ({ name: v.name, value: v.value })), model, effort, spend);
    for (const [name, issue] of styleFail) if (knownVariables.has(name) && !bad.has(name)) bad.set(name, issue);
  }

  // Sentence-fragment guardrail: tenure + role_responsibility must be clean core
  // phrases (the general verifier ignores phrasing, so a leaked location/rank/company
  // slips through). Route any leak into the same repair loop.
  const sentenceVars = payload.variables.filter((v) => (v.name === "role_responsibility" || v.name === "tenure") && v.filled)
    // "your time" is the approved tenure fallback when no real duration exists;
    // it is deliberately duration-free, so no phrasing check may judge it.
    .filter((v) => !(v.name === "tenure" && v.value === TENURE_FALLBACK));
  if (sentenceVars.length) {
    const fieldFail = await reviewSentenceFields(sentenceVars.map((v) => ({ name: v.name, value: v.value })), payload.context, model, effort, spend);
    for (const [name, issue] of fieldFail) if (knownVariables.has(name) && !bad.has(name)) bad.set(name, issue);
  }

  // The tenure fallback is exempt from every checker (the verifier tends to
  // flag it as "not a real duration", which is exactly its point). Without this
  // a fallback lead loops forever: flagged -> regenerated -> fallback again.
  if (payload.variables.find((v) => v.name === "tenure")?.value === TENURE_FALLBACK) bad.delete("tenure");

  // Operator-pinned constants (constant_value columns, e.g. role_responsibility)
  // are exempt for the same reason: the value is deliberate fixed copy, not AI
  // output — it cannot be hallucinated, and "regenerating" it returns the same
  // constant, so a flag can only ever loop or stack pointless review items.
  for (const name of [...bad.keys()]) {
    if (colByKey.get(name)?.constantValue) bad.delete(name);
  }

  // Manual review mode: do NOT rewrite cells. Precompute a proposed fix per
  // flagged cell and open a review item for a human to accept/decline/chat. Only
  // when there is something to flag; a clean lead falls through to "Ready" below.
  const reviewMode = (await getEmailReviewConfig()).mode;
  if (reviewMode === "manual" && bad.size > 0) {
    return proposeReview({ column, leadId, campaign, payload, bad, colByKey, updatedBy, spend });
  }

  // Auto mode: repair loop - regenerate each bad AI-column variable (up to twice)
  // with the critique; overwrite the cell with the accepted value.
  const repairs: EmailQaRepair[] = [];
  for (const [name, reason] of bad) {
    const col = colByKey.get(name);
    const original = payload.variables.find((v) => v.name === name)?.value ?? "";
    if (!col) {
      repairs.push({ name, from: original, to: null, accepted: false, reason, note: "not a regenerable column - fix the source field" });
      continue;
    }
    let lastValue = original;
    let currentReason = reason;
    let accepted = false;
    for (let attempt = 1; attempt <= 2 && !accepted; attempt += 1) {
      const guidance = `The value produced for this field was: ${JSON.stringify(lastValue)}. The final email QA rejected it because: ${currentReason}. Regenerate a corrected value that fixes exactly that, following all the original rules.`;
      const regen = await runCustomColumn(col.id, leadId, updatedBy, guidance);
      if (!regen.ok) {
        repairs.push({ name, from: lastValue, to: null, accepted: false, reason: currentReason, note: regen.message });
        break;
      }
      // Ops tasks are accepted on the style rules; tenure/role_responsibility on the
      // sentence-fragment rules (both ignore hallucination and judge phrasing); every
      // other field on the hallucination/AI-error judge.
      const judged = name.startsWith("ops_task")
        ? await judgeOpsTaskStyle(regen.value, model, effort, spend)
        : (name === "role_responsibility" || name === "tenure")
          ? await judgeSentenceField(name, regen.value, payload.context, model, effort, spend)
          : await judgeVariable(name, regen.value, payload.context, model, effort, spend);
      repairs.push({ name, from: lastValue, to: regen.value, accepted: judged.ok, reason: currentReason, note: judged.ok ? "" : judged.issue });
      accepted = judged.ok;
      lastValue = regen.value;
      currentReason = judged.issue || currentReason;
    }
  }

  // Re-render with any regenerated cells, take the final verdict.
  if (repairs.some((r) => r.to)) payload = await buildEmailQaPayload(campaign.id, column.tableId, leadId);
  const finalVerdict = await verifyEmails(payload, model, effort, spend);
  if (finalVerdict.failed) {
    return { ok: false, message: `The email review could not complete its final check (${finalVerdict.failure ?? "runner error"}). Retry it, or switch the enrichment runner to an API provider under Settings.` };
  }
  const issues: string[] = [];
  const tenureIsFallback = payload.variables.find((v) => v.name === "tenure")?.value === TENURE_FALLBACK;
  for (const v of finalVerdict.variables) {
    if (v.name === "tenure" && tenureIsFallback) continue; // approved fallback, never an issue
    if (!v.ok && v.issue && knownVariables.has(v.name) && !v.name.startsWith("sl_")) issues.push(`${v.name}: ${v.issue}`);
  }
  // finalVerdict.notes are free-form commentary the model volunteers - usually
  // approving ("reads naturally", "variables properly filled", "strong
  // personalization") and often with NEGATED mentions of defects ("no
  // hallucinations detected", "no AI tells"). A keyword match on them holds clean
  // copy, so they are NOT a blocking signal and never hold a lead. The
  // authoritative signals are the per-variable flags (above), the deterministic
  // checks that seeded `bad` (blank / AI-error / render artifacts / ops-task
  // style / sentence fragments), and unrepaired repairs. A bare "needs_review"
  // verdict with nothing concrete flagged is the verifier hedging on good copy.
  // A genuinely unreadable verdict is handled as a runner failure above, not here.
  const unrepaired = repairs.filter((r) => !r.accepted);
  for (const r of unrepaired) issues.push(`${r.name}: ${r.note || r.reason}`);
  const ready = issues.length === 0;

  const details = {
    verdict: ready ? "ready" : ("needs_review" as const),
    campaignId: campaign.id,
    campaignName: campaign.name,
    emails: payload.emails,
    variables: payload.variables,
    context: payload.context,
    issues,
    repairs,
  };

  const admin = getAdminClient();
  const now = new Date().toISOString();
  const existing = await admin.from("enrichment_cell_values").select("revision").eq("column_id", qaColumnId).eq("lead_id", leadId).maybeSingle();
  const revision = (Number((existing.data as { revision?: number } | null)?.revision) || 0) + 1;
  const { error } = await admin.from("enrichment_cell_values").upsert({
    column_id: qaColumnId, lead_id: leadId, value: ready ? "Ready" : "Needs review", revision,
    generation_version: column.generationVersion, model: null, provider: spend.provider ?? "email-qa",
    input_tokens: spend.input || null, output_tokens: spend.output || null, duration_ms: spend.ms || null,
    details, updated_at: now, updated_by: updatedBy,
  }, { onConflict: "column_id,lead_id" });
  if (error) return { ok: false, message: error.message };
  await admin.from("lead_runs").insert({
    lead_id: leadId, action: "email_qa", provider: spend.provider ?? "email-qa", ok: true,
    message: `Email QA: ${ready ? "Ready" : "Needs review"}${repairs.length ? ` (${repairs.filter((r) => r.accepted).length}/${repairs.length} repaired)` : ""}`,
    details: { column_id: qaColumnId, table_id: column.tableId, verdict: details.verdict, repairs, input_tokens: spend.input || null, output_tokens: spend.output || null, duration_ms: spend.ms || null },
  });
  return { ok: true, verdict: ready ? "ready" : "needs_review", repaired: repairs.filter((r) => r.accepted).length };
}
