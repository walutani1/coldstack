// Quote-folding for thread display. Splits a plain-text email body into the
// sender's new content and the quoted history below it, so the UI can fold the
// history behind a "Show quoted text" toggle (Gmail-style).
//
// Accuracy contract: this module never deletes, reorders, or rewrites content.
// `visible + quoted` is always the full original text (modulo whitespace
// normalization: NBSP → space, trailing spaces stripped, 3+ blank lines
// collapsed to one). Detection is deliberately conservative and fails open —
// when no unambiguous marker is found, everything stays visible.
//
// Markers are tuned against real bodies in reply_events (Gmail "On … wrote:",
// Apple Mail "On …, at …, X wrote:", Outlook "From:/Sent:/To:/Subject:"
// header blocks with blank lines injected by HTML→text conversion,
// "-----Original Message-----", "____…" separators, and ">" quote runs).

const INVISIBLES = /[ ​﻿]/g;

/** NBSP → space, strip trailing whitespace, collapse 3+ blank lines, trim. */
export function normalizeWhitespace(text: string): string {
  const lines = text.replace(INVISIBLES, " ").split(/\r?\n/);
  const out: string[] = [];
  let blanks = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      blanks += 1;
      if (blanks <= 1) out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

// "On Wed, Jul 8, 2026 at 10:05 AM Alex Smith <a@b.com> wrote:" — may be
// wrapped across up to three physical lines. To avoid folding prose that
// merely ends in "wrote:" (e.g. "On Monday you wrote:"), the joined candidate
// must also contain strong evidence: a year, a month name, or an email
// address. Real client markers (Gmail/Apple/Outlook) always carry these; a
// bare weekday is deliberately NOT enough.
const ON_WROTE_END = /\bwrote:\s*$/i;
const ON_WROTE_EVIDENCE = /(\b(19|20)\d{2}\b|@|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b)/i;

const ORIGINAL_MESSAGE = /^-{2,}\s*(Original|Forwarded)? ?Message\s*-{2,}\s*$/i;
const UNDERSCORE_RULE = /^_{8,}\s*$/;
const HEADER_LINE = /^(From|Sent|Date|To|Cc|Subject):\s?/i;

function isOnWroteMarker(lines: string[], index: number): boolean {
  const first = lines[index];
  if (!/^On\b/.test(first.trim())) return false;
  let joined = first.trim();
  for (let extra = 0; extra <= 2; extra += 1) {
    if (extra > 0) {
      const next = lines[index + extra];
      if (next === undefined || next.trim() === "") break;
      joined += ` ${next.trim()}`;
    }
    if (joined.length <= 320 && ON_WROTE_END.test(joined) && ON_WROTE_EVIDENCE.test(joined)) return true;
  }
  return false;
}

// Outlook header block: a "From:" line followed (skipping blanks) by at least
// two more header lines, one of which is Sent:/Date:.
function isHeaderBlockMarker(lines: string[], index: number): boolean {
  if (!/^From:\s?/i.test(lines[index].trim())) return false;
  let found = 0;
  let hasSentOrDate = false;
  let seen = 0;
  for (let i = index + 1; i < lines.length && seen < 8; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    seen += 1;
    if (HEADER_LINE.test(line)) {
      found += 1;
      if (/^(Sent|Date):/i.test(line)) hasSentOrDate = true;
    } else {
      break;
    }
  }
  return found >= 2 && hasSentOrDate;
}

// A ">" line counts only when the next non-blank line is also quoted, so a
// lone rhetorical ">" in prose never folds anything.
//
// Known limitation (accepted): interleaved replies — where the sender writes
// new content BELOW a ">" quote run — fold that trailing content along with
// the quote. It stays one click away behind "Show quoted text" (never lost),
// and interleaved quoting is rare in this traffic; detecting it reliably
// would require heuristics that risk false positives elsewhere.
function isQuoteRunMarker(lines: string[], index: number): boolean {
  if (!lines[index].startsWith(">")) return false;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    return line.startsWith(">");
  }
  return false;
}

export type SplitBody = {
  /** The sender's new content (whitespace-normalized). */
  visible: string;
  /** Quoted history from the first unambiguous marker onward, or null. */
  quoted: string | null;
};

export function splitQuotedText(text: string): SplitBody {
  const normalized = normalizeWhitespace(text);
  if (normalized === "") return { visible: "", quoted: null };
  const lines = normalized.split("\n");

  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (
      ORIGINAL_MESSAGE.test(trimmed) ||
      UNDERSCORE_RULE.test(trimmed) ||
      isOnWroteMarker(lines, i) ||
      isHeaderBlockMarker(lines, i) ||
      isQuoteRunMarker(lines, i)
    ) {
      cut = i;
      break;
    }
  }

  if (cut === -1) return { visible: normalized, quoted: null };
  const visible = lines.slice(0, cut).join("\n").replace(/\n+$/, "");
  const quoted = lines.slice(cut).join("\n");
  return { visible, quoted: quoted === "" ? null : quoted };
}
