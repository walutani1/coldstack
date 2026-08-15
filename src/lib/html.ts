// Common named entities seen in real inbound mail (beyond the core five).
const NAMED_ENTITIES: Record<string, string> = {
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

// Email bodies are rendered as plain text (never as raw HTML), which keeps
// the inbox immune to HTML/script injection from inbound mail.
export function htmlToText(html: string) {
  return (
    html
      // Non-content regions first: comments (incl. Outlook MSO conditionals),
      // <head> (whose <title> is the subject — it must never leak into the
      // body text), and any stray title/style/script in the body.
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      .replace(/<title[\s\S]*?<\/title>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>(\s*)/gi, "\n")
      .replace(/<\/(div|p|tr|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      // Numeric entities (decimal + hex), e.g. &#43; &#8217; &#x27;
      .replace(/&#(\d+);/g, (_, code: string) => {
        const point = Number(code);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
        const point = Number.parseInt(code, 16);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      })
      .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
      .replace(/&amp;/gi, "&") // decode &amp; last so "&amp;lt;" doesn't double-decode
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Plain-text composer body -> minimal HTML for Smartlead's send API.
export function textToHtml(text: string) {
  return escapeHtml(text.trim()).replace(/\n/g, "<br />");
}
