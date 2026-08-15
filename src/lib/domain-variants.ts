/* Deterministic alt-domain variants for cold-email sending domains: the
   base brand plus the prefixes/suffixes operators actually register
   (getacme.com, tryacme.com, acmehq.com...). Pure string work; availability
   and pricing come from Zapmail's bulk check afterwards. */

const PREFIXES = ["get", "try", "use", "go", "meet", "with", "join", "hey", "book", "talk"];
const SUFFIXES = ["hq", "app", "team", "mail", "now", "labs", "work", "pro"];

export type DomainVariant = { domainName: string; kind: "exact" | "prefix" | "suffix" };

/** "Acme Industries", "acmeindustries.com", "https://acmeindustries.com/x"
    all normalize to the bare brand token "acmeindustries". */
export function normalizeBaseName(input: string): string | null {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  value = value.split("/")[0] ?? value;
  // Drop a trailing TLD if one was pasted (keeps "acme.industries" safe by
  // only stripping known-short final labels after a dot).
  const parts = value.split(".");
  if (parts.length > 1 && (parts[parts.length - 1] ?? "").length <= 6) {
    value = parts.slice(0, -1).join(".");
  }
  value = value.replace(/[^a-z0-9-]/g, "");
  value = value.replace(/^-+|-+$/g, "");
  if (value.length < 2 || value.length > 55) return null;
  return value;
}

export function generateDomainVariants(base: string, tld = "com", limit = 20): DomainVariant[] {
  const name = normalizeBaseName(base);
  if (!name) return [];
  const seen = new Set<string>();
  const variants: DomainVariant[] = [];
  const push = (domainName: string, kind: DomainVariant["kind"]) => {
    if (domainName.length > 63 + tld.length + 1) return;
    if (seen.has(domainName)) return;
    seen.add(domainName);
    variants.push({ domainName, kind });
  };
  push(`${name}.${tld}`, "exact");
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) continue; // "getacme" must not become "getgetacme"
    push(`${prefix}${name}.${tld}`, "prefix");
  }
  for (const suffix of SUFFIXES) {
    if (name.endsWith(suffix)) continue;
    push(`${name}${suffix}.${tld}`, "suffix");
  }
  return variants.slice(0, Math.max(1, limit));
}
