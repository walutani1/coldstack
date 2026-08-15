// LinkedIn profile URL hygiene. Imported lead data stores URLs in assorted
// shapes ("http://www.linkedin.com/in/x", protocol-less, percent-encoded).
// Normalize server-side so the client only ever receives a safe https
// linkedin.com URL — anything else becomes null and the UI hides the module.
export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  let candidate = trimmed;
  if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  } else if (/^http:/i.test(candidate)) {
    candidate = candidate.replace(/^http:/i, "https:");
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // Exact host match or true subdomain — never endsWith("linkedin.com"),
  // which would admit evil-linkedin.com. The userinfo trick
  // ("linkedin.com@evil.com") parses with hostname evil.com and is rejected.
  const host = url.hostname.toLowerCase();
  const isLinkedIn = host === "linkedin.com" || host.endsWith(".linkedin.com");
  if (!isLinkedIn || url.protocol !== "https:") return null;

  return url.toString();
}
