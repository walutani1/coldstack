// Converting Smartlead sequence bodies between the stored HTML and a
// human-editable plain-text form, with EXACT fidelity guarantees:
//
// 1. Smartlead's editor emits a strict dialect -- `<div>line</div>` blocks
//    and bare `<br>` blank lines, text-only content, a handful of entities.
//    Only bodies that parse COMPLETELY into that dialect are text-editable
//    (`parseSimpleHtml`); anything else (links, styling, tables) must be
//    edited as raw HTML so nothing is ever silently destroyed.
// 2. Spintax braces `{a|b}` can span multiple HTML blocks, so they are opaque
//    text here -- never parsed during conversion, only by the preview
//    resolver (`resolveSpintax`), which understands `{{merge_tags}}` too.
// 3. Callers must send the ORIGINAL html for unedited bodies (compare the
//    editable text against its baseline) -- re-encoding is only for real
//    edits.
//
// Client-safe on purpose: the editor and preview run in the browser.

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

function decodeEntities(text: string): string {
  return (
    text
      // Smartlead pads line ends with &nbsp;; a plain space is what the
      // author meant, and edited bodies re-encode cleanly either way.
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_, code: string) => {
        const point = Number(code);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
        const point = Number.parseInt(code, 16);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      })
      .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
      // Decode &amp; LAST so "&amp;lt;" becomes the literal "&lt;", not "<".
      .replace(/&amp;/gi, "&")
  );
}

function encodeText(line: string): string {
  return line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Names decode+encode as true inverses only when we know them: the decodable
// set is nbsp/lt/gt/amp + NAMED_ENTITIES (all decoded to plain characters,
// re-encoded as raw UTF-8, which Smartlead stores fine). Anything else is
// unsafe and must push the body into raw mode.
const KNOWN_ENTITY_NAMES = new Set(["nbsp", "lt", "gt", "amp", ...Object.keys(NAMED_ENTITIES)]);

function findUnknownEntity(text: string): string | null {
  const pattern = /&([a-zA-Z]+);/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!KNOWN_ENTITY_NAMES.has(match[1].toLowerCase())) return match[1];
  }
  return null;
}

export type SimpleHtmlResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Parse a body into editable plain text IF it is entirely the simple
 * Smartlead dialect. `<div>X</div>` -> a line; `<br>` (or `<div></div>` /
 * `<div><br></div>`) -> a blank line. Anything unrecognized fails closed.
 */
export function parseSimpleHtml(html: string): SimpleHtmlResult {
  const lines: string[] = [];
  const token = /<div>([\s\S]*?)<\/div>|<br\s*\/?>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(html)) !== null) {
    const between = html.slice(lastIndex, match.index);
    if (between.trim() !== "") {
      // Bare text between blocks -- not the dialect Smartlead's editor emits.
      return { ok: false, reason: "Text outside <div>/<br> blocks." };
    }
    lastIndex = match.index + match[0].length;

    if (match[1] === undefined) {
      lines.push(""); // <br>
      continue;
    }
    const inner = match[1];
    if (/^\s*(<br\s*\/?>)?\s*$/i.test(inner)) {
      lines.push(""); // <div></div> or <div><br></div>
      continue;
    }
    if (inner.includes("<")) {
      return { ok: false, reason: "Line contains HTML tags (links or formatting)." };
    }
    // Any named entity we can't decode would be double-escaped on re-encode
    // (&eacute; -> &amp;eacute; -> the recipient sees literal text). Fail
    // CLOSED to raw mode instead of ever corrupting meaning.
    const unknownEntity = findUnknownEntity(inner);
    if (unknownEntity) {
      return { ok: false, reason: `Contains "&${unknownEntity};", which the text editor can't safely convert.` };
    }
    lines.push(decodeEntities(inner));
  }

  if (html.slice(lastIndex).trim() !== "") {
    return { ok: false, reason: "Trailing content outside <div>/<br> blocks." };
  }
  return { ok: true, text: lines.join("\n") };
}

/** Editable text -> the same dialect Smartlead's own editor writes. */
export function textToSequenceHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "<br>" : `<div>${encodeText(line)}</div>`))
    .join("");
}

/* -- Preview: spintax + merge tags ---------------------------------------
   Spintax groups `{a|b|c}` (nestable) resolve to a chosen option;
   `{{merge_tag}}` tokens are atomic and pass through untouched. Unbalanced
   braces fail open (returned verbatim) so a preview can never eat copy. */

type SpintaxPick = (options: string[]) => string;

// A merge tag is strictly "{{name}}" — "{{{" is a spintax brace followed by a
// merge tag, so only an anchored full-tag match counts.
const MERGE_TAG_AT = /^\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/;

function mergeTagEnd(text: string, index: number): number | null {
  const match = MERGE_TAG_AT.exec(text.slice(index));
  return match ? index + match[0].length : null;
}

function resolveSpintaxFrom(text: string, start: number, pick: SpintaxPick): { value: string; end: number } | null {
  // Called with text[start] === "{" (single). Returns the resolved group and
  // the index after the closing "}", or null when unbalanced.
  const options: string[] = [];
  let current = "";
  let i = start + 1;
  while (i < text.length) {
    const tagEnd = mergeTagEnd(text, i);
    if (tagEnd !== null) {
      current += text.slice(i, tagEnd);
      i = tagEnd;
      continue;
    }
    const char = text[i];
    if (char === "{") {
      const nested = resolveSpintaxFrom(text, i, pick);
      if (!nested) return null;
      current += nested.value;
      i = nested.end;
      continue;
    }
    if (char === "|") {
      options.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === "}") {
      options.push(current);
      return { value: pick(options), end: i + 1 };
    }
    current += char;
    i += 1;
  }
  return null;
}

export function resolveSpintax(text: string, mode: "first" | "random" = "first"): string {
  const pick: SpintaxPick =
    mode === "random"
      ? (options) => options[Math.floor(Math.random() * options.length)] ?? ""
      : (options) => options[0] ?? "";
  let result = "";
  let i = 0;
  while (i < text.length) {
    const tagEnd = mergeTagEnd(text, i);
    if (tagEnd !== null) {
      result += text.slice(i, tagEnd);
      i = tagEnd;
      continue;
    }
    if (text[i] === "{") {
      const group = resolveSpintaxFrom(text, i, pick);
      if (group) {
        result += group.value;
        i = group.end;
        continue;
      }
      // Unbalanced -- keep the raw brace and move on.
    }
    result += text[i];
    i += 1;
  }
  return result;
}

const MERGE_TAG = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Preview HTML for a body: spintax resolved, merge tags substituted with real
 * lead values when provided (like Smartlead's own preview) — tags without a
 * value render as highlighted variable chips. For text-editable bodies pass
 * the EDITABLE TEXT (it is re-encoded here); for raw bodies pass the HTML
 * with `isHtml: true`.
 */
export function buildPreviewHtml(
  source: string,
  options: { isHtml: boolean; spintax?: "first" | "random"; values?: Record<string, string> },
): string {
  const resolved = resolveSpintax(source, options.spintax ?? "first");
  const html = options.isHtml ? resolved : textToSequenceHtml(resolved);
  return html.replace(MERGE_TAG, (match, tag: string) => {
    const value = options.values?.[tag];
    if (value !== undefined && value !== "") {
      return encodeText(value);
    }
    return `<span style="background:#fef3c7;color:#92400e;border-radius:3px;padding:0 3px;font-size:0.92em;">${tag}</span>`;
  });
}

/** Plain-text merge-tag substitution (for preview SUBJECT lines). */
export function substituteMergeTags(text: string, values: Record<string, string> | undefined): string {
  if (!values) return text;
  return text.replace(MERGE_TAG, (match, tag: string) => {
    const value = values[tag];
    return value !== undefined && value !== "" ? value : match;
  });
}
