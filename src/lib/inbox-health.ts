import "server-only";

import type { InboxAccount, InboxWarmupStats } from "@/lib/smartlead";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type HealthCheck = {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix: string | null;
};
export type HealthCategory = {
  key: "connection" | "authentication" | "warmup" | "volume";
  label: string;
  checks: HealthCheck[];
};
export type HealthReport = {
  accountId: number;
  email: string;
  domain: string;
  score: number;
  grade: "healthy" | "attention" | "risk";
  categories: HealthCategory[];
  checkedAt: string;
};

export type DomainDnsResult = {
  available: boolean;
  spf: HealthCheck;
  dmarc: HealthCheck;
  dkim: HealthCheck;
  mx: HealthCheck;
  trackingDomain: HealthCheck;
};

type DnsAnswer = { data?: unknown; type?: unknown };

const DNS_TIMEOUT_MS = 5_000;

function dnsCheck(
  key: string,
  label: string,
  status: CheckStatus,
  detail: string,
  fix: string | null,
): HealthCheck {
  return { key, label, status, detail, fix };
}

function unavailableDnsResult(): DomainDnsResult {
  const skipped = (key: string, label: string) =>
    dnsCheck(key, label, "skip", "DNS lookup unavailable", null);
  return {
    available: false,
    spf: skipped("spf", "SPF"),
    dmarc: skipped("dmarc", "DMARC"),
    dkim: skipped("dkim", "DKIM"),
    mx: skipped("mx", "MX records"),
    trackingDomain: skipped("tracking_domain", "Tracking domain"),
  };
}

async function fetchDnsJson(url: string, headers?: HeadersInit): Promise<DnsAnswer[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, cache: "no-store" });
    if (!response.ok) return null;
    const json = (await response.json()) as { Answer?: unknown };
    return Array.isArray(json.Answer) ? (json.Answer as DnsAnswer[]) : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function lookup(name: string, type: string): Promise<DnsAnswer[] | null> {
  const params = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  const google = await fetchDnsJson(`https://dns.google/resolve?${params}`);
  if (google !== null) return google;
  return fetchDnsJson(`https://cloudflare-dns.com/dns-query?${params}`, {
    Accept: "application/dns-json",
  });
}

function txtValue(answer: DnsAnswer): string {
  const raw = String(answer.data ?? "").trim();
  const segments = [...raw.matchAll(/"((?:\\.|[^"\\])*)"/g)];
  if (segments.length === 0) return raw.replace(/^"|"$/g, "");
  return segments.map((match) => match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")).join("");
}

function truncate(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function hostname(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

export async function resolveDomainDns(
  domain: string,
  trackingDomain: string | null,
  provider: string | null,
): Promise<DomainDnsResult> {
  const sendingDomain = hostname(domain);
  const selectors = provider?.toUpperCase() === "GMAIL"
    ? ["google", "selector1", "selector2", "k1", "s1"]
    : ["selector1", "selector2", "k1", "s1"];
  const tracking = trackingDomain ? hostname(trackingDomain) : null;

  const [rootTxt, dmarcTxt, mxAnswers, selectorAnswers, trackingAnswers] = await Promise.all([
    lookup(sendingDomain, "TXT"),
    lookup(`_dmarc.${sendingDomain}`, "TXT"),
    lookup(sendingDomain, "MX"),
    Promise.all(
      selectors.map(async (selector) => ({
        selector,
        txt: await lookup(`${selector}._domainkey.${sendingDomain}`, "TXT"),
        cname: await lookup(`${selector}._domainkey.${sendingDomain}`, "CNAME"),
      })),
    ),
    tracking
      ? Promise.all([lookup(tracking, "CNAME"), lookup(tracking, "A")])
      : Promise.resolve([] as (DnsAnswer[] | null)[]),
  ]);

  // Each record's checks degrade to "skip" INDEPENDENTLY when its own lookup
  // failed on both resolvers. One flaky query must not discard the evidence
  // the other lookups produced (an all-or-nothing skip would let a domain
  // with no SPF score "healthy" through a resolver hiccup).
  if (rootTxt === null && dmarcTxt === null && mxAnswers === null) {
    return unavailableDnsResult();
  }

  let spf: HealthCheck;
  if (rootTxt === null) {
    spf = dnsCheck("spf", "SPF", "skip", "DNS lookup unavailable", null);
  } else {
    const spfRecords = rootTxt.map(txtValue).filter((record) => /\bv=spf1\b/i.test(record));
    spf = spfRecords.length === 0
      ? dnsCheck("spf", "SPF", "fail", "No SPF record was found.", "Publish one SPF record authorizing every service that sends mail for this domain.")
      : spfRecords.length > 1
        ? dnsCheck("spf", "SPF", "fail", `${spfRecords.length} SPF records were found; multiple SPF records are invalid.`, "Merge the authorized senders into a single SPF record at your DNS host.")
        : dnsCheck("spf", "SPF", "pass", truncate(spfRecords[0]), null);
  }

  const dmarcRecord = dmarcTxt?.map(txtValue).find((record) => /\bv=dmarc1\b/i.test(record));
  let dmarc: HealthCheck;
  if (dmarcTxt === null) {
    dmarc = dnsCheck("dmarc", "DMARC", "skip", "DNS lookup unavailable", null);
  } else if (!dmarcRecord) {
    dmarc = dnsCheck("dmarc", "DMARC", "fail", "No DMARC record was found.", "Publish a DMARC record starting with p=none and a rua reporting address.");
  } else if (/\bp\s*=\s*none\b/i.test(dmarcRecord)) {
    dmarc = dnsCheck("dmarc", "DMARC", "warn", `Monitoring-only policy: ${truncate(dmarcRecord)}`, "Move to p=quarantine or p=reject after reviewing DMARC reports.");
  } else if (/\bp\s*=\s*(quarantine|reject)\b/i.test(dmarcRecord)) {
    dmarc = dnsCheck("dmarc", "DMARC", "pass", truncate(dmarcRecord), null);
  } else {
    dmarc = dnsCheck("dmarc", "DMARC", "warn", `DMARC policy is not explicit: ${truncate(dmarcRecord)}`, "Set an explicit p=quarantine or p=reject policy after reviewing DMARC reports.");
  }

  const foundDkim = selectorAnswers.find(({ txt, cname }) =>
    (txt ?? []).map(txtValue).some((record) => /\b(v=dkim1|k=rsa)\b/i.test(record)) || (cname ?? []).length > 0,
  );
  const allSelectorLookupsFailed = selectorAnswers.every(({ txt, cname }) => txt === null && cname === null);
  const dkim = foundDkim
    ? dnsCheck("dkim", "DKIM", "pass", `DKIM was found at selector ${foundDkim.selector}.`, null)
    : allSelectorLookupsFailed
      ? dnsCheck("dkim", "DKIM", "skip", "DNS lookup unavailable", null)
      : dnsCheck("dkim", "DKIM", "warn", "No common DKIM selector was found; a custom selector may still be active.", "Verify that DKIM is enabled and passing in your email provider admin.");

  const mx = mxAnswers === null
    ? dnsCheck("mx", "MX records", "skip", "DNS lookup unavailable", null)
    : mxAnswers.length > 0
      ? dnsCheck("mx", "MX records", "pass", `${mxAnswers.length} MX record${mxAnswers.length === 1 ? "" : "s"} found.`, null)
      : dnsCheck("mx", "MX records", "fail", "No MX records were found.", "Publish MX records so the sending domain can receive replies and bounces.");

  let trackingDomainCheck: HealthCheck;
  if (!tracking) {
    trackingDomainCheck = dnsCheck("tracking_domain", "Tracking domain", "warn", "No custom tracking domain is configured.", "CNAME a dedicated tracking subdomain at your DNS host.");
  } else if (trackingAnswers.every((answers) => answers === null)) {
    trackingDomainCheck = dnsCheck("tracking_domain", "Tracking domain", "skip", "DNS lookup unavailable", null);
  } else if (trackingAnswers.some((answers) => (answers ?? []).length > 0)) {
    trackingDomainCheck = dnsCheck("tracking_domain", "Tracking domain", "pass", `${tracking} resolves successfully.`, null);
  } else {
    trackingDomainCheck = dnsCheck("tracking_domain", "Tracking domain", "fail", `${tracking} does not resolve by CNAME or A record.`, "Correct the tracking subdomain record at your DNS host before sending tracked links.");
  }

  return { available: true, spf, dmarc, dkim, mx, trackingDomain: trackingDomainCheck };
}

function connectionChecks(account: InboxAccount): HealthCheck[] {
  return [
    account.smtpOk
      ? dnsCheck("smtp", "SMTP connection", "pass", "SMTP authentication succeeded.", null)
      : dnsCheck("smtp", "SMTP connection", "fail", account.smtpError ?? "SMTP authentication failed.", "Reconnect SMTP credentials in your email provider and confirm sending access."),
    account.imapOk
      ? dnsCheck("imap", "IMAP connection", "pass", "IMAP authentication succeeded.", null)
      : dnsCheck("imap", "IMAP connection", "fail", account.imapError ?? "IMAP authentication failed.", "Reconnect IMAP credentials in your email provider and confirm mailbox access."),
    account.isSuspended
      ? dnsCheck("suspended", "Account status", "fail", "The email account is suspended.", "Unsuspend the account only after resolving the underlying provider or reputation issue.")
      : dnsCheck("suspended", "Account status", "pass", "The email account is not suspended.", null),
  ];
}

function warmupChecks(account: InboxAccount, stats: InboxWarmupStats | null): HealthCheck[] {
  const warmup = account.warmup;
  let enabled: HealthCheck;
  if (warmup?.isBlocked) {
    enabled = dnsCheck("enabled", "Warmup status", "fail", warmup.blockedReason ?? "Warmup is blocked.", "Resolve the warmup block reason before resuming campaign volume.");
  } else if (!warmup || warmup.status !== "ACTIVE") {
    enabled = dnsCheck("enabled", "Warmup status", "warn", warmup ? `Warmup status is ${warmup.status ?? "unknown"}.` : "Warmup is not configured.", "Enable warmup and let the mailbox establish a stable sending history.");
  } else {
    enabled = dnsCheck("enabled", "Warmup status", "pass", "Warmup is active.", null);
  }

  // A reputation is meaningful only after warmup traffic exists: Smartlead
  // reports a flat 0 for a freshly added account (zero warmup history), which
  // would read as a failing mailbox when it actually means "warmup has not
  // started yet". The health path has real per-account stats, so prefer those;
  // when stats are unavailable, a reputation of exactly 0 means no history
  // (live-verified: accounts with real history report 98-100, never a flat 0).
  const reputationValue = warmup?.reputation ?? null;
  const warmupStarted = stats ? stats.sentCount > 0 : reputationValue !== 0;
  const reputation = reputationValue !== null && !warmupStarted
    ? dnsCheck("reputation", "Warmup reputation", "skip", "Warmup has not started yet (no warmup emails sent). The score appears once traffic flows.", null)
    : reputationValue === null
    ? dnsCheck("reputation", "Warmup reputation", "skip", "Warmup reputation is unavailable.", null)
    : reputationValue >= 90
      ? dnsCheck("reputation", "Warmup reputation", "pass", `Warmup reputation is ${reputationValue}%.`, null)
      : reputationValue >= 75
        ? dnsCheck("reputation", "Warmup reputation", "warn", `Warmup reputation is ${reputationValue}%.`, "Reduce sending volume and keep warmup active until reputation returns above 90%.")
        : dnsCheck("reputation", "Warmup reputation", "fail", `Warmup reputation is ${reputationValue}%.`, "Pause campaign sending and rehabilitate the mailbox with low, consistent warmup volume.");

  let placement: HealthCheck;
  if (!stats || stats.sentCount < 10) {
    placement = dnsCheck("placement", "Warmup placement", "skip", "Not enough warmup volume to judge placement.", null);
  } else {
    const percent = (stats.inboxCount / stats.sentCount) * 100;
    const rescued = stats.byDate.reduce((sum, day) => sum + day.saveFromSpamCount, 0);
    const detail = `${stats.inboxCount} of ${stats.sentCount} warmup emails landed in inbox; ${rescued} rescued from spam.`;
    placement = percent >= 95
      ? dnsCheck("placement", "Warmup placement", "pass", detail, null)
      : percent >= 85
        ? dnsCheck("placement", "Warmup placement", "warn", detail, "Keep warmup active and reduce campaign volume until inbox placement exceeds 95%.")
        : dnsCheck("placement", "Warmup placement", "fail", detail, "Pause campaign sending and repair authentication and reputation before ramping again.");
  }

  let spamTrend: HealthCheck;
  if (!stats) {
    spamTrend = dnsCheck("spam_trend", "Spam trend", "skip", "Warmup trend data is unavailable.", null);
  } else {
    const days = [...stats.byDate].sort((a, b) => a.date.localeCompare(b.date));
    const recent = days.slice(-3).reduce((sum, day) => sum + day.saveFromSpamCount, 0);
    const prior = days.slice(-7, -3).reduce((sum, day) => sum + day.saveFromSpamCount, 0);
    spamTrend = recent > 0 && recent > prior
      ? dnsCheck("spam_trend", "Spam trend", "warn", `${recent} spam rescues in the last 3 days versus ${prior} in the prior 4 days.`, "Lower sending volume and investigate authentication or content changes driving the rising spam trend.")
      : dnsCheck("spam_trend", "Spam trend", "pass", `${recent} spam rescues in the last 3 days versus ${prior} in the prior 4 days.`, null);
  }
  return [enabled, reputation, placement, spamTrend];
}

function volumeChecks(account: InboxAccount): HealthCheck[] {
  const limit = account.messagePerDay;
  const dailyLimit = limit === null
    ? dnsCheck("daily_limit", "Daily limit", "skip", "The daily sending limit is unavailable.", null)
    : limit <= 50
      ? dnsCheck("daily_limit", "Daily limit", "pass", `Daily sending limit is ${limit}.`, null)
      : limit <= 100
        ? dnsCheck("daily_limit", "Daily limit", "warn", `Daily sending limit is ${limit}.`, "Lower the daily limit to 50 or fewer messages per inbox.")
        : dnsCheck("daily_limit", "Daily limit", "fail", `Daily sending limit is ${limit}.`, "Lower the daily limit to 50 or fewer messages per inbox before continuing campaigns.");
  const sentToday = limit === null
    ? dnsCheck("sent_today", "Sent today", "skip", "Daily usage cannot be compared without a sending limit.", null)
    : account.dailySentCount <= limit
      ? dnsCheck("sent_today", "Sent today", "pass", `${account.dailySentCount} of ${limit} messages sent today.`, null)
      : dnsCheck("sent_today", "Sent today", "warn", `${account.dailySentCount} messages sent today exceeds the ${limit} limit.`, "Stop additional sends today and verify that all sending sources share the same daily cap.");
  return [dailyLimit, sentToday];
}

export async function runInboxHealth(
  account: InboxAccount,
  stats: InboxWarmupStats | null,
  dns: DomainDnsResult,
): Promise<HealthReport> {
  const domain = account.fromEmail.includes("@") ? account.fromEmail.split("@").pop()!.toLowerCase() : "";
  const categories: HealthCategory[] = [
    { key: "connection", label: "Connection", checks: connectionChecks(account) },
    { key: "authentication", label: "Authentication", checks: [dns.spf, dns.dmarc, dns.dkim, dns.mx, dns.trackingDomain] },
    { key: "warmup", label: "Warmup", checks: warmupChecks(account, stats) },
    { key: "volume", label: "Volume", checks: volumeChecks(account) },
  ];
  const weights: Record<HealthCategory["key"], number> = {
    connection: 20,
    authentication: 30,
    warmup: 35,
    volume: 15,
  };
  const active = categories
    .map((category) => ({ category, checks: category.checks.filter((check) => check.status !== "skip") }))
    .filter((entry) => entry.checks.length > 0);
  const activeWeight = active.reduce((sum, entry) => sum + weights[entry.category.key], 0);
  const weighted = active.reduce((sum, entry) => {
    const earned = entry.checks.reduce((checkSum, check) => checkSum + (check.status === "pass" ? 1 : check.status === "warn" ? 0.5 : 0), 0);
    return sum + (earned / entry.checks.length) * weights[entry.category.key];
  }, 0);
  let score = activeWeight === 0 ? 0 : Math.round((weighted / activeWeight) * 100);
  // Unknown core authentication (SPF/DMARC lookups unavailable) must never
  // grade "healthy" — skip redistribution would otherwise inflate the score
  // exactly when the evidence is missing.
  if (dns.spf.status === "skip" || dns.dmarc.status === "skip") {
    score = Math.min(score, 84);
  }
  return {
    accountId: account.id,
    email: account.fromEmail,
    domain,
    score,
    grade: score >= 85 ? "healthy" : score >= 60 ? "attention" : "risk",
    categories,
    checkedAt: new Date().toISOString(),
  };
}
