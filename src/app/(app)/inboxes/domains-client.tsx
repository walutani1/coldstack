"use client";

/*
 * Domains — a READ-ONLY dashboard for Zapmail sending domains.
 *
 * Self-contained by design: it owns local copies of the shared style tokens and
 * the `useExit` modal driver (both module-private where they originate), and it
 * re-declares the server-action contract structurally so it never reaches into a
 * server module. It calls two async server actions from ./zapmail-actions and
 * renders their data — nothing here writes or mutates.
 */

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Forward,
  Globe,
  Loader2,
  Mail,
  MinusCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { getZapmailDomainsOverviewAction, getDomainDnsRecordsAction } from "./zapmail-actions";
import { SkeletonTable } from "../skeletons";

/* ── Server-action contract (redeclared locally; never import the server module) ── */
type DomainHealth = {
  checked: boolean;
  spf: boolean | null;
  dkim: boolean | null;
  dmarc: boolean | null;
  mx: boolean | null;
  nameserversOk: boolean;
  authenticationIdle: boolean;
  // true = healthy, false = issues, null = unknown (DNS check unavailable)
  healthy: boolean | null;
};
type DomainMailboxLite = {
  id: string;
  username: string;
  domain: string;
  firstName: string;
  lastName: string;
  status: string | null;
  createdAt: string | null;
};
type EnrichedDomain = {
  id: string;
  domain: string;
  status: string | null;
  forwardTo: string | null;
  maskForwarding: boolean;
  dmarcEmail: string | null;
  forwardingEmail: string | null;
  catchAllEmail: string | null;
  nameServers: string[];
  expectedNameServers: string[] | null;
  dnsShieldEnabled: boolean;
  isWarmedUp: boolean;
  autoRenew: boolean;
  registeredOn: string | null;
  expireOn: string | null;
  assignedMailboxesCount: number;
  mailboxes: DomainMailboxLite[];
  tags: string[];
  health: DomainHealth;
  // server-derived: expiry within 30d AND !autoRenew AND not already expired
  expiringSoon: boolean;
};
type DnsRecord = {
  id: string;
  type: string;
  host: string;
  value: string;
  ttl: number | null;
  priority: number | null;
};
type DomainsOverviewResult = {
  ok: boolean;
  message?: string;
  connected: boolean;
  domains: EnrichedDomain[];
  checkedAt: string | null;
};
type DnsRecordsResult = {
  ok: boolean;
  message?: string;
  records: DnsRecord[];
};

/* ── Shared style constants (copied conventions, intentionally not shared) ── */
const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;

/* Shared modal exit driver: a close intent flips `closing`, which swaps the
   backdrop/panel enter classes for the matching exit classes; the real unmount
   fires after the 150ms exit runs. Guards double-close, clears on unmount. */
function useExit() {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const playExit = (done: () => void) => {
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(done, 150);
  };
  return { closing, playExit };
}

/* ── Formatting + classification helpers ──────────────────────────────── */

// Workspace-pinned date so server and client agree; date-only for registration/expiry.
function formatDate(iso: string | null, timeZone: string, timeLocale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(timeLocale, { year: "numeric", month: "short", day: "numeric", timeZone });
}

// Coarse past-tense recency for the "checked …" label ("just now", "5m ago", …).
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function expiryTime(domain: EnrichedDomain): number {
  if (!domain.expireOn) return Number.POSITIVE_INFINITY;
  const t = new Date(domain.expireOn).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function capitalize(value: string): string {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value;
}

function isActiveStatus(status: string | null): boolean {
  return /active|live|ready|verified|connected/i.test(status ?? "");
}

// Status chip tone, reused for domains and their mailboxes.
function statusChip(status: string | null): { label: string; cls: string } {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return { label: "Unknown", cls: "bg-muted text-muted-foreground" };
  if (/active|live|ready|verified|connected/.test(s)) return { label: capitalize(s), cls: "bg-success-soft text-success" };
  if (/pending|progress|process|warm|setup|config|queue/.test(s)) return { label: capitalize(s), cls: "bg-accent text-accent-foreground" };
  if (/fail|error|expired|suspend|reject|cancel|blocked/.test(s)) return { label: capitalize(s), cls: "bg-destructive-soft text-destructive" };
  return { label: capitalize(s), cls: "bg-muted text-muted-foreground" };
}

// The failing checks behind an "Issues" health state (native-title copy).
function failedChecks(h: DomainHealth): string[] {
  const out: string[] = [];
  if (h.spf === false) out.push("SPF");
  if (h.dkim === false) out.push("DKIM");
  if (h.dmarc === false) out.push("DMARC");
  if (h.mx === false) out.push("MX");
  if (!h.nameserversOk) out.push("Nameservers");
  return out;
}

// Canonicalize a record host for *matching only*: lowercase, strip one trailing
// dot, strip the domain suffix. The original host is kept for display and copy.
function canonHost(host: string, domain: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (h === d || h === "") return "@";
  if (d && h.endsWith(`.${d}`)) h = h.slice(0, h.length - d.length - 1);
  return h || "@";
}

/* ── DNS record grouping ──────────────────────────────────────────────── */
const GROUP_ORDER = [
  { id: "auth", label: "Email authentication" },
  { id: "mail", label: "Mail routing" },
  { id: "ns", label: "Nameservers" },
  { id: "verify", label: "Verification & tracking" },
  { id: "web", label: "Web & forwarding" },
  { id: "other", label: "Other" },
] as const;
type GroupId = (typeof GROUP_ORDER)[number]["id"];

const TRACK_LABELS = new Set(["track", "tracking", "emailtracking", "link", "click"]);

// First matching group wins; do NOT lump every TXT into auth.
function classifyRecord(record: DnsRecord, domain: string): GroupId {
  const type = record.type.toUpperCase();
  const value = record.value.trim();
  const vlow = value.toLowerCase();
  const hc = canonHost(record.host, domain);

  if (type === "TXT") {
    if (vlow.startsWith("v=spf1")) return "auth";
    if (hc.includes("_domainkey") || /v=dkim1/i.test(value)) return "auth";
    if (hc.startsWith("_dmarc") || /v=dmarc1/i.test(value)) return "auth";
  }
  if (type === "MX") return "mail";
  if (type === "NS" || type === "SOA") return "ns";
  if (type === "CNAME" && TRACK_LABELS.has(hc.split(".")[0])) return "verify";
  if (type === "TXT" && /google-site-verification/i.test(value)) return "verify";
  if (type === "A" || type === "AAAA" || type === "CNAME") return "web";
  return "other";
}

function sortRecords(a: DnsRecord, b: DnsRecord): number {
  const t = a.type.toUpperCase().localeCompare(b.type.toUpperCase());
  if (t) return t;
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const h = a.host.localeCompare(b.host);
  if (h) return h;
  return a.value.localeCompare(b.value);
}

type GroupedRecords = { id: GroupId; label: string; records: DnsRecord[] }[];

function groupRecords(records: DnsRecord[], domain: string): GroupedRecords {
  const buckets: Record<GroupId, DnsRecord[]> = { auth: [], mail: [], ns: [], verify: [], web: [], other: [] };
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) continue; // dedupe ONLY by duplicate id
    seen.add(record.id);
    buckets[classifyRecord(record, domain)].push(record);
  }
  return GROUP_ORDER.map((g) => ({ id: g.id, label: g.label, records: buckets[g.id].slice().sort(sortRecords) })).filter(
    (g) => g.records.length > 0,
  );
}

// Pull the DMARC policy word (p=reject|quarantine|none) from loaded records.
function dmarcPolicy(records: DnsRecord[] | undefined, domain: string): string | null {
  if (!records) return null;
  const rec = records.find(
    (r) => r.type.toUpperCase() === "TXT" && (canonHost(r.host, domain).startsWith("_dmarc") || /v=dmarc1/i.test(r.value)),
  );
  if (!rec) return null;
  const match = /p=([a-z]+)/i.exec(rec.value);
  return match ? match[1].toLowerCase() : null;
}

/* ── Small shared primitives ──────────────────────────────────────────── */

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function StatTile({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface px-3 py-2.5 shadow-xs">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[20px] font-semibold leading-none font-mono tabular-nums tracking-tight">{children}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
}

// Icon-only copy affordance (Copy → Check for 1.2s). Native title (not data-tip)
// because it is used inside scroll-clipped containers where a styled tip crops.
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    // clipboard is undefined on non-secure origins; no-op there instead of throwing.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={copied ? "Copied" : "Copy"}
      onClick={copy}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  );
}

/* ── Charts (semantic CSS-var tokens only — no categorical palette) ─────── */

// Single-hue coverage meter: success fill on a muted track, rounded ends.
function AuthMeter({ label, passed, total }: { label: string; passed: number; total: number }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, minWidth: passed > 0 ? "0.5rem" : 0, background: "var(--success)" }}
        />
      </div>
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {passed}/{total}
      </span>
    </div>
  );
}

type DonutSegment = { key: string; label: string; count: number; color: string };

// Health composition ring. Rendered only when there is something to draw
// attention to (issues or unknown > 0); homogeneous/healthy data shows a calm
// line instead of a flat chart.
function HealthDonut({ segments, total, healthy }: { segments: DonutSegment[]; total: number; healthy: number }) {
  const size = 132;
  const stroke = 15;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const drawable = segments.filter((s) => s.count > 0);
  const gap = drawable.length > 1 ? 2 : 0;
  // Precompute each arc's cumulative offset so the render map stays pure — the
  // React compiler forbids reassigning a variable while rendering.
  const arcLen = (count: number) => (total > 0 ? (count / total) * c : 0);
  const arcs = drawable.map((seg, index) => ({
    seg,
    startLen: drawable.slice(0, index).reduce((sum, s) => sum + arcLen(s.count), 0),
    drawLen: Math.max(arcLen(seg.count) - gap, 0),
  }));
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {arcs.map(({ seg, startLen, drawLen }) => (
            <circle
              key={seg.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={`${drawLen} ${c - drawLen}`}
              strokeDashoffset={-startLen}
              style={{ stroke: seg.color }}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[22px] font-semibold leading-none font-mono tabular-nums tracking-tight">{healthy}</span>
          <span className="mt-1 text-[10px] text-muted-foreground">of {total} healthy</span>
        </div>
      </div>
      <div className="flex w-full flex-col gap-1">
        {drawable.map((seg) => (
          <div key={seg.key} className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 shrink-0 rounded-full" style={{ background: seg.color }} />
              {seg.label}
            </span>
            <span className="tabular-nums text-foreground">{seg.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Health indicators ────────────────────────────────────────────────── */

// Tri-state: true → success, false → warning, null → muted "Unknown".
function healthIcon(value: boolean | null) {
  if (value === true) return <Check className="size-3.5 text-success" strokeWidth={2} />;
  if (value === false) return <AlertTriangle className="size-3.5 text-warning" strokeWidth={2} />;
  return <MinusCircle className="size-3.5 text-muted-foreground" strokeWidth={1.75} />;
}
function healthWord(value: boolean | null): string {
  if (value === true) return "Passing";
  if (value === false) return "Needs attention";
  return "Unknown";
}

// Compact table pill summarizing a domain's overall health tri-state.
function HealthPill({ health }: { health: DomainHealth }) {
  if (health.healthy === true) {
    return <span className="rounded-full bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success">Healthy</span>;
  }
  if (health.healthy === false) {
    const failed = failedChecks(health);
    return (
      <span
        title={failed.length ? `Needs attention: ${failed.join(", ")}` : "Needs attention"}
        className="rounded-full bg-warning-soft px-2 py-0.5 text-[10.5px] font-semibold text-warning"
      >
        Issues
      </span>
    );
  }
  return (
    <span
      title="DNS health not checked"
      className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground"
    >
      Unknown
    </span>
  );
}

/* ── Boot / empty states ──────────────────────────────────────────────── */

function BootError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive-soft">
          <AlertTriangle className="size-5 text-destructive" strokeWidth={1.75} />
        </span>
        <p className="mt-3 text-[13px] font-medium">Couldn&rsquo;t load domains</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{message}</p>
        <button type="button" onClick={onRetry} className={`${BTN_OUTLINE} mt-4 h-8 px-3 text-[12px]`}>
          Retry
        </button>
      </div>
    </div>
  );
}

function ConnectPrompt() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center rounded-xl bg-surface p-8 text-center shadow-xs">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted/60">
          <Globe className="size-6 text-muted-foreground" strokeWidth={1.5} />
        </span>
        <p className="mt-4 text-[14px] font-semibold tracking-tight">Connect Zapmail to see your domains</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          Add your Zapmail API key in <span className="font-medium text-foreground">Settings → Integrations</span> to review
          domain health, forwarding, and DNS here.
        </p>
        <Link href="/settings?section=integrations" className={`${BTN_PRIMARY} mt-5 h-8 px-4 text-[12px]`}>
          Open integration settings
          <ChevronRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

function EmptyDomains() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted/60">
          <Globe className="size-5 text-muted-foreground" strokeWidth={1.5} />
        </span>
        <p className="mt-3 text-[13px] font-medium">No domains yet</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          Zapmail is connected, but no sending domains are registered. They appear here once a purchase finishes
          provisioning.
        </p>
      </div>
    </div>
  );
}

/* ── Main view ────────────────────────────────────────────────────────── */
export function DomainsView({ timeZone, timeLocale }: { timeZone: string; timeLocale: string }) {
  const [boot, setBoot] = useState<"loading" | "ready" | "error" | "not-connected">("loading");
  const [bootMessage, setBootMessage] = useState<string>("");
  const [domains, setDomains] = useState<EnrichedDomain[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<"domain" | "mailboxes" | "expires">("domain");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [openId, setOpenId] = useState<string | null>(null);

  // DNS records cached per domain id for the session — fetched once per drawer
  // open; request() has no client throttle and throws on 429, so never refetch.
  const [dnsCache, setDnsCache] = useState<Record<string, DnsRecord[]>>({});
  const [dnsLoading, setDnsLoading] = useState<Record<string, boolean>>({});
  const [dnsError, setDnsError] = useState<Record<string, string>>({});

  const [refreshing, startRefresh] = useTransition();

  const applyOverview = (result: DomainsOverviewResult) => {
    setDomains(result.domains);
    setCheckedAt(result.checkedAt);
  };

  // Boot fetch (once, on mount).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result: DomainsOverviewResult = await getZapmailDomainsOverviewAction();
      if (cancelled) return;
      if (!result.ok) {
        setBootMessage(result.message ?? "Something went wrong while loading domains.");
        setBoot("error");
        return;
      }
      if (!result.connected) {
        setBoot("not-connected");
        return;
      }
      applyOverview(result);
      setBoot("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const retryBoot = () => {
    setBoot("loading");
    void (async () => {
      const result: DomainsOverviewResult = await getZapmailDomainsOverviewAction();
      if (!result.ok) {
        setBootMessage(result.message ?? "Something went wrong while loading domains.");
        setBoot("error");
        return;
      }
      if (!result.connected) {
        setBoot("not-connected");
        return;
      }
      applyOverview(result);
      setBoot("ready");
    })();
  };

  // Refresh re-runs the overview; ignored while a request is already in flight.
  const refresh = () => {
    if (refreshing) return;
    startRefresh(async () => {
      const result: DomainsOverviewResult = await getZapmailDomainsOverviewAction();
      if (result.ok && result.connected) applyOverview(result);
    });
  };

  // Fetch DNS records for a domain once, then serve from cache forever.
  const ensureDnsRecords = (domainId: string) => {
    if (dnsCache[domainId] || dnsLoading[domainId]) return;
    setDnsLoading((prev) => ({ ...prev, [domainId]: true }));
    setDnsError((prev) => {
      const next = { ...prev };
      delete next[domainId];
      return next;
    });
    void (async () => {
      try {
        const result: DnsRecordsResult = await getDomainDnsRecordsAction(domainId);
        if (result.ok) {
          setDnsCache((prev) => ({ ...prev, [domainId]: result.records }));
        } else {
          setDnsError((prev) => ({ ...prev, [domainId]: result.message ?? "Could not load DNS records." }));
        }
      } catch {
        setDnsError((prev) => ({ ...prev, [domainId]: "Could not load DNS records." }));
      } finally {
        setDnsLoading((prev) => {
          const next = { ...prev };
          delete next[domainId];
          return next;
        });
      }
    })();
  };

  const summary = useMemo(() => {
    let active = 0;
    let healthy = 0;
    let issues = 0;
    let unknown = 0;
    let mailboxes = 0;
    let forwarding = 0;
    let expiring = 0;
    let spf = 0;
    let dkim = 0;
    let dmarc = 0;
    let mx = 0;
    for (const d of domains) {
      if (isActiveStatus(d.status)) active += 1;
      if (d.health.healthy === true) healthy += 1;
      else if (d.health.healthy === false) issues += 1;
      else unknown += 1;
      mailboxes += d.assignedMailboxesCount;
      if (d.forwardTo) forwarding += 1;
      if (d.expiringSoon) expiring += 1;
      if (d.health.spf === true) spf += 1;
      if (d.health.dkim === true) dkim += 1;
      if (d.health.dmarc === true) dmarc += 1;
      if (d.health.mx === true) mx += 1;
    }
    return { total: domains.length, active, healthy, issues, unknown, mailboxes, forwarding, expiring, spf, dkim, dmarc, mx };
  }, [domains]);

  const sortedDomains = useMemo(() => {
    const arr = domains.slice();
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "domain") cmp = a.domain.localeCompare(b.domain);
      else if (sortKey === "mailboxes") cmp = a.assignedMailboxesCount - b.assignedMailboxesCount;
      else cmp = expiryTime(a) - expiryTime(b);
      if (cmp === 0) cmp = a.domain.localeCompare(b.domain);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [domains, sortKey, sortDir]);

  const toggleSort = (key: "domain" | "mailboxes" | "expires") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const selected = openId ? domains.find((d) => d.id === openId) ?? null : null;

  if (boot === "loading") {
    return (
      <div className="flex-1 p-8" role="status" aria-busy="true">
        <span className="sr-only">Loading</span>
        <SkeletonTable rows={8} cols={5} />
      </div>
    );
  }
  if (boot === "error") {
    return <BootError message={bootMessage} onRetry={retryBoot} />;
  }
  if (boot === "not-connected") {
    return <ConnectPrompt />;
  }

  const checkedLabel = checkedAt ? `DNS health checked ${relativeTime(checkedAt)}` : "DNS health unavailable";
  const attention = summary.issues + summary.unknown;
  const donutSegments: DonutSegment[] = [
    { key: "healthy", label: "Healthy", count: summary.healthy, color: "var(--success)" },
    { key: "issues", label: "Needs attention", count: summary.issues, color: "var(--warning)" },
    { key: "unknown", label: "Unknown", count: summary.unknown, color: "var(--muted-foreground)" },
  ];

  return (
    <div className="mx-auto w-full max-w-[1080px] px-5 py-5">
      {domains.length === 0 ? (
        <EmptyDomains />
      ) : (
        <div className="flex flex-col gap-5">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Clock className="size-3.5" />
                {checkedLabel}
              </span>
              <span
                data-tip="This view is read-only"
                data-tip-down
                className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Read-only
              </span>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              data-tip="Re-check domains and DNS health"
              data-tip-down
              className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
            >
              {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Refresh
            </button>
          </div>

          {/* Summary band */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Domains">{summary.total}</StatTile>
            <StatTile label="Active">{summary.active}</StatTile>
            <StatTile label="DNS healthy" hint={summary.unknown > 0 ? `· ${summary.unknown} unknown` : undefined}>
              <span>
                {summary.healthy}
                <span className="text-muted-foreground">/{summary.total}</span>
              </span>
            </StatTile>
            <StatTile label="Mailboxes">{summary.mailboxes}</StatTile>
            <StatTile label="Forwarding set">{summary.forwarding}</StatTile>
            <StatTile label="Expiring ≤30d">{summary.expiring}</StatTile>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-xl bg-surface p-3.5 shadow-xs">
              <SectionTitle title="Health composition" />
              {attention > 0 ? (
                <HealthDonut segments={donutSegments} total={summary.total} healthy={summary.healthy} />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4 text-center">
                  <span className="flex size-9 items-center justify-center rounded-full bg-success-soft">
                    <ShieldCheck className="size-4.5 text-success" strokeWidth={1.75} />
                  </span>
                  <p className="text-[12.5px] font-medium">
                    All {summary.total} {summary.total === 1 ? "domain" : "domains"} healthy
                  </p>
                  <p className="text-[11px] text-muted-foreground">Every domain passes its DNS authentication checks.</p>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-3 rounded-xl bg-surface p-3.5 shadow-xs">
              <SectionTitle title="Auth coverage" hint="domains passing" />
              <div className="flex flex-1 flex-col justify-center gap-2.5">
                <AuthMeter label="SPF" passed={summary.spf} total={summary.total} />
                <AuthMeter label="DKIM" passed={summary.dkim} total={summary.total} />
                <AuthMeter label="DMARC" passed={summary.dmarc} total={summary.total} />
                <AuthMeter label="MX" passed={summary.mx} total={summary.total} />
              </div>
            </div>
          </div>

          {/* Domains table */}
          <div className="flex flex-col gap-2">
            <SectionTitle title="Domains" hint={`${summary.total} total`} />
            <div className="overflow-hidden rounded-xl bg-surface shadow-xs">
              <div className="overflow-x-auto">
                <div className="min-w-[880px]">
                  <DomainsTableHeader sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  {sortedDomains.map((domain, index) => (
                    <DomainRow
                      key={domain.id}
                      domain={domain}
                      first={index === 0}
                      timeZone={timeZone}
                      timeLocale={timeLocale}
                      onOpen={() => setOpenId(domain.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {selected ? (
        <DomainDrawer
          key={selected.id}
          domain={selected}
          records={dnsCache[selected.id]}
          loading={Boolean(dnsLoading[selected.id])}
          error={dnsError[selected.id] ?? null}
          timeZone={timeZone}
          timeLocale={timeLocale}
          onEnsure={ensureDnsRecords}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

/* ── Domains table ────────────────────────────────────────────────────── */
const ROW_TEMPLATE =
  "minmax(0,1.7fr) 104px minmax(0,0.9fr) 76px minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.15fr) 24px";

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 text-left transition-colors hover:text-foreground ${
        active ? "text-foreground" : ""
      } rounded ${className ?? ""}`}
    >
      {label}
      <span className={`text-[9px] leading-none ${active ? "opacity-100" : "opacity-0"}`}>{dir === "asc" ? "▲" : "▼"}</span>
    </button>
  );
}

function DomainsTableHeader({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: "domain" | "mailboxes" | "expires";
  sortDir: "asc" | "desc";
  onSort: (key: "domain" | "mailboxes" | "expires") => void;
}) {
  return (
    <div
      className="grid items-center gap-3 border-b border-border bg-surface-muted/60 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-foreground-subtle"
      style={{ gridTemplateColumns: ROW_TEMPLATE }}
    >
      <SortHeader label="Domain" active={sortKey === "domain"} dir={sortDir} onClick={() => onSort("domain")} />
      <span>Status</span>
      <span>Health</span>
      <SortHeader
        label="Inboxes"
        active={sortKey === "mailboxes"}
        dir={sortDir}
        onClick={() => onSort("mailboxes")}
        className="justify-self-end"
      />
      <span>Forwarding</span>
      <span>Nameservers</span>
      <SortHeader label="Expires" active={sortKey === "expires"} dir={sortDir} onClick={() => onSort("expires")} />
      <span />
    </div>
  );
}

function DomainRow({
  domain,
  first,
  timeZone,
  timeLocale,
  onOpen,
}: {
  domain: EnrichedDomain;
  first: boolean;
  timeZone: string;
  timeLocale: string;
  onOpen: () => void;
}) {
  const status = statusChip(domain.status);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open details for ${domain.domain}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group grid cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40 focus-visible:ring-inset ${
        first ? "" : "border-t border-border"
      }`}
      style={{ gridTemplateColumns: ROW_TEMPLATE }}
    >
      <span className="min-w-0 truncate font-mono text-[12.5px] font-medium">{domain.domain}</span>
      <span className={`w-fit rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ${status.cls}`}>{status.label}</span>
      <span>
        <HealthPill health={domain.health} />
      </span>
      <span className="justify-self-end text-[12px] tabular-nums text-muted-foreground">{domain.assignedMailboxesCount}</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground" title={domain.forwardTo ?? undefined}>
        {domain.forwardTo ?? "—"}
      </span>
      <span>
        {domain.health.nameserversOk ? (
          <span className="text-[11.5px] text-muted-foreground">OK</span>
        ) : (
          <span className="w-fit rounded-md bg-warning-soft px-1.5 py-0.5 text-[10.5px] font-medium text-warning">
            Mismatch
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`truncate text-[11.5px] tabular-nums ${domain.expiringSoon ? "text-warning" : "text-muted-foreground"}`}>
          {formatDate(domain.expireOn, timeZone, timeLocale)}
        </span>
        {domain.autoRenew ? (
          <span className="shrink-0 rounded bg-success-soft px-1 py-px text-[9px] font-semibold text-success">Auto</span>
        ) : (
          <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-semibold text-muted-foreground">Manual</span>
        )}
      </span>
      <ChevronRight className="size-4 justify-self-end text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}

/* ── Detail drawer ────────────────────────────────────────────────────── */

function DrawerCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl bg-surface p-3.5 shadow-xs">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function InfoLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </span>
    </div>
  );
}

// One value + copy affordance (used for forwarding + DMARC addresses).
function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle">{label}</span>
        <span className="min-w-0 truncate font-mono text-[12px]" title={value}>
          {value}
        </span>
      </div>
      <CopyButton value={value} label={label.toLowerCase()} />
    </div>
  );
}

function DomainDrawer({
  domain,
  records,
  loading,
  error,
  timeZone,
  timeLocale,
  onEnsure,
  onClose,
}: {
  domain: EnrichedDomain;
  records: DnsRecord[] | undefined;
  loading: boolean;
  error: string | null;
  timeZone: string;
  timeLocale: string;
  onEnsure: (domainId: string) => void;
  onClose: () => void;
}) {
  const exit = useExit();
  const requestClose = () => exit.playExit(onClose);

  // Fetch DNS records once when the drawer opens (cached upstream).
  useEffect(() => {
    onEnsure(domain.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain.id]);

  // Escape closes; body scroll locked while open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = statusChip(domain.status);
  const grouped = useMemo(() => (records ? groupRecords(records, domain.domain) : null), [records, domain.domain]);
  const policy = dmarcPolicy(records, domain.domain);
  const email = (mb: DomainMailboxLite) => `${mb.username}@${mb.domain}`;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        aria-hidden="true"
        onClick={requestClose}
        className={`absolute inset-0 bg-black/40 ${exit.closing ? "anim-overlay-out" : "anim-overlay-in"}`}
      />
      <div
        role="dialog"
        aria-label={`Domain details: ${domain.domain}`}
        className={`relative ml-auto flex h-full w-full max-w-[560px] flex-col border-l border-border bg-surface shadow-pop ${
          exit.closing ? "anim-drawer-out" : "anim-drawer-in"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <Globe className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <h2 className="truncate font-mono text-[14px] font-semibold tracking-tight">{domain.domain}</h2>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ${status.cls}`}>{status.label}</span>
              {domain.dnsShieldEnabled ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-info-soft px-1.5 py-0.5 text-[10.5px] font-medium text-info">
                  <ShieldCheck className="size-3" />
                  DNS Shield
                </span>
              ) : null}
              {domain.isWarmedUp ? (
                <span className="rounded-md bg-success-soft px-1.5 py-0.5 text-[10.5px] font-medium text-success">
                  Warmed up
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close domain details"
            onClick={requestClose}
            className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-4">
          {/* Health checklist */}
          <DrawerCard title="DNS health" icon={<ShieldCheck className="size-3.5" />}>
            {domain.health.checked ? null : (
              <p className="text-[11px] text-muted-foreground">
                A DNS health check was not available for this domain — items below show as Unknown.
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              {[
                { key: "SPF", value: domain.health.spf },
                { key: "DKIM", value: domain.health.dkim },
                { key: "DMARC", value: domain.health.dmarc },
                { key: "MX", value: domain.health.mx },
                { key: "Nameservers", value: domain.health.nameserversOk },
              ].map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-[12px]">
                    {healthIcon(row.value)}
                    {row.key}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{healthWord(row.value)}</span>
                </div>
              ))}
            </div>
          </DrawerCard>

          {/* Forwarding */}
          <DrawerCard title="Forwarding" icon={<Forward className="size-3.5" />}>
            {domain.forwardTo ? (
              <>
                <CopyLine label="Forwards to" value={domain.forwardTo} />
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">Masked forwarding</span>
                  <span
                    className={`rounded px-1.5 py-px text-[10px] font-semibold ${
                      domain.maskForwarding ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {domain.maskForwarding ? "On" : "Off"}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-[12px] text-muted-foreground">—</p>
            )}
          </DrawerCard>

          {/* DMARC */}
          <DrawerCard title="DMARC" icon={<ShieldCheck className="size-3.5" />}>
            {domain.dmarcEmail ? (
              <CopyLine label="Report address" value={domain.dmarcEmail} />
            ) : (
              <InfoLine label="Report address" value="—" />
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">Policy</span>
              {policy ? (
                <span
                  className={`rounded px-1.5 py-px font-mono text-[10.5px] font-semibold ${
                    policy === "reject"
                      ? "bg-success-soft text-success"
                      : policy === "quarantine"
                        ? "bg-info-soft text-info"
                        : "bg-warning-soft text-warning"
                  }`}
                >
                  p={policy}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">{records ? "Not found" : error ? "Unavailable" : "Loading…"}</span>
              )}
            </div>
          </DrawerCard>

          {/* Nameservers */}
          <DrawerCard title="Nameservers" icon={<Server className="size-3.5" />}>
            <div className="flex items-center gap-1.5">
              <span
                className={`rounded px-1.5 py-px text-[10px] font-semibold ${
                  domain.health.nameserversOk ? "bg-success-soft text-success" : "bg-warning-soft text-warning"
                }`}
              >
                {domain.health.nameserversOk ? "Matches expected" : "Mismatch"}
              </span>
            </div>
            {domain.nameServers.length ? (
              <ul className="flex flex-col gap-1">
                {domain.nameServers.map((ns, i) => (
                  <li key={`${ns}-${i}`} className="truncate font-mono text-[11.5px] text-muted-foreground" title={ns}>
                    {ns}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-muted-foreground">No nameservers reported.</p>
            )}
          </DrawerCard>

          {/* Registration */}
          <DrawerCard title="Registration" icon={<Clock className="size-3.5" />}>
            <InfoLine label="Registered" value={formatDate(domain.registeredOn, timeZone, timeLocale)} />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">Expires</span>
              <span className={`text-[12px] tabular-nums ${domain.expiringSoon ? "text-warning" : ""}`}>
                {formatDate(domain.expireOn, timeZone, timeLocale)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">Auto-renew</span>
              <span
                className={`rounded px-1.5 py-px text-[10px] font-semibold ${
                  domain.autoRenew ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"
                }`}
              >
                {domain.autoRenew ? "On" : "Off"}
              </span>
            </div>
          </DrawerCard>

          {/* Mailboxes */}
          <DrawerCard title={`Mailboxes (${domain.assignedMailboxesCount})`} icon={<Mail className="size-3.5" />}>
            {domain.mailboxes.length ? (
              <div className="flex flex-col gap-1.5">
                {domain.mailboxes.map((mb) => {
                  const chip = statusChip(mb.status);
                  const name = [mb.firstName, mb.lastName].filter(Boolean).join(" ");
                  return (
                    <div key={mb.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={email(mb)}>
                        {email(mb)}
                      </span>
                      {name ? (
                        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{name}</span>
                      ) : null}
                      <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${chip.cls}`}>{chip.label}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground">No mailboxes assigned to this domain.</p>
            )}
          </DrawerCard>

          {/* DNS records */}
          <section className="flex flex-col gap-2.5 rounded-xl bg-surface p-3.5 shadow-xs">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
              <Server className="size-3.5" />
              DNS records
            </div>
            {loading ? (
              <div className="flex items-center gap-2 py-3 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading DNS records…
              </div>
            ) : error !== null ? (
              <div className="flex items-center gap-2 py-3 text-[12px] text-muted-foreground">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => onEnsure(domain.id)}
                  className={`font-medium text-primary transition-colors hover:opacity-80 rounded`}
                >
                  Retry
                </button>
              </div>
            ) : grouped && grouped.length ? (
              <div className="flex flex-col gap-3">
                {grouped.map((group) => (
                  <DnsGroupTable key={group.id} label={group.label} records={group.records} domain={domain.domain} />
                ))}
              </div>
            ) : (
              <p className="py-2 text-[12px] text-muted-foreground">No DNS records found for this domain.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const DNS_TEMPLATE = "64px minmax(0,1fr) minmax(0,1.6fr) 52px 48px";
const DNS_TEMPLATE_NO_PRIORITY = "64px minmax(0,1fr) minmax(0,1.6fr) 52px";

function DnsGroupTable({ label, records, domain }: { label: string; records: DnsRecord[]; domain: string }) {
  const showPriority = records.some((r) => r.priority !== null);
  const template = showPriority ? DNS_TEMPLATE : DNS_TEMPLATE_NO_PRIORITY;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-foreground">{label}</span>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="overflow-x-auto">
          <div className="min-w-[420px]">
            <div
              className="grid items-center gap-2 border-b border-border bg-surface-muted/50 px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-foreground-subtle"
              style={{ gridTemplateColumns: template }}
            >
              <span>Type</span>
              <span>Host</span>
              <span>Value</span>
              <span className="justify-self-end">TTL</span>
              {showPriority ? <span className="justify-self-end">Prio</span> : null}
            </div>
            {records.map((record, index) => (
              <div
                key={record.id}
                className={`grid items-center gap-2 px-2.5 py-1.5 ${index === 0 ? "" : "border-t border-border"}`}
                style={{ gridTemplateColumns: template }}
              >
                <span className="w-fit rounded bg-muted px-1.5 py-px font-mono text-[10px] font-semibold text-muted-foreground">
                  {record.type.toUpperCase()}
                </span>
                <span className="min-w-0 truncate font-mono text-[11px]" title={record.host}>
                  {canonHost(record.host, domain)}
                </span>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={record.value}>
                    {record.value}
                  </span>
                  <CopyButton value={record.value} label={`${record.type.toUpperCase()} value`} />
                </span>
                <span className="justify-self-end text-[11px] tabular-nums text-muted-foreground">{record.ttl ?? "—"}</span>
                {showPriority ? (
                  <span className="justify-self-end text-[11px] tabular-nums text-muted-foreground">
                    {record.priority ?? "—"}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
