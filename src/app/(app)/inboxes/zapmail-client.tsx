"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  AtSign,
  Check,
  ChevronDown,
  ExternalLink,
  Globe,
  ImagePlus,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  ShoppingBag,
  Wallet,
  X,
} from "lucide-react";
import {
  addZapmailExportAccountAction,
  assignZapmailMailboxesAction,
  buyZapmailDomainsAction,
  checkZapmailDomainsAction,
  createZapmailAddonLinkAction,
  createZapmailProvisionAction,
  createZapmailSubscriptionLinkAction,
  createZapmailTopUpLinkAction,
  exportZapmailMailboxesAction,
  getZapmailExportAccountsAction,
  getZapmailExportStatusAction,
  getZapmailMailboxesAction,
  getZapmailOwnedDomainsAction,
  getZapmailStateAction,
  retryZapmailMailboxesAction,
  suggestZapmailDomainsAction,
  updateZapmailMailboxesAction,
  uploadZapmailAvatarAction,
} from "./zapmail-actions";
import { useToast } from "../toast";

/* ── Contract mirrors (declared locally so the client never imports a server
   module — same pattern as inboxes-client / settings-client). ───────────── */
type ZapmailWallet = { balance: number; autoRechargeEnabled: boolean };
type ZapmailDomainQuote = {
  domainName: string;
  available: boolean;
  premium: boolean;
  price: string | null;
  renewPrice: string | null;
};
type ZapmailOwnedDomain = {
  id: string;
  domain: string;
  status: string | null;
  nameServers: string[];
  assignedMailboxesCount: number;
  createdAt: string | null;
};
type ZapmailMailbox = {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  status: string | null;
  domain: string;
  domainId: string | null;
  isWarmedUp: boolean;
};
type ZapmailMailboxSummary = {
  purchased: number;
  assigned: number;
  active: number;
  available: number;
  scheduled: number;
};
type ZapmailSubscription = {
  id: string | null;
  planName: string | null;
  billingCycle: string | null;
  status: string | null;
  mailboxCount: number | null;
};
type ZapmailThirdPartyAccount = { id: string; app: string; email: string };

type Provider = "GOOGLE" | "MICROSOFT";
type SuggestKind = "exact" | "prefix" | "suffix";
type ZapmailSuggestion = ZapmailDomainQuote & { kind: SuggestKind | null };
type CartItem = {
  domainName: string;
  price: string | null;
  renewPrice: string | null;
  premium: boolean;
  kind: SuggestKind | null;
  unavailable: boolean;
};

/* ── Shared style constants (copied conventions, intentionally not shared) ── */
const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;
const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;

/* ── Money + name helpers ─────────────────────────────────────────────── */
function parsePrice(value: string | null | undefined): number {
  const n = parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function formatUSD(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${(Math.round(safe * 100) / 100).toFixed(2)}`;
}
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function domainKey(name: string): string {
  return name.trim().toLowerCase();
}
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{2,60}\.[a-z]{2,10}$/i;

// Username rules, mirrored from the server's assign schema: start/end
// alphanumeric, only . _ - between, no doubled separators, <= 32 chars.
function isValidUsername(value: string): boolean {
  const u = value.trim();
  if (!u || u.length > 32) return false;
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/i.test(u)) return false;
  if (/[._-]{2}/.test(u)) return false;
  return true;
}

/* ── Bulk-fill username patterns ──────────────────────────────────────── */
function joinHandle(a: string, b: string): string {
  return [a, b].filter(Boolean).join(".");
}
type UsernamePattern = { id: string; label: string; make: (first: string, last: string) => string };
const USERNAME_PATTERNS: UsernamePattern[] = [
  { id: "first", label: "first (alex)", make: (f) => slug(f) },
  { id: "first.l", label: "first.l (alex.s)", make: (f, l) => joinHandle(slug(f), slug(l).slice(0, 1)) },
  { id: "f.last", label: "f.last (a.smith)", make: (f, l) => joinHandle(slug(f).slice(0, 1), slug(l)) },
  { id: "first.last", label: "first.last (alex.smith)", make: (f, l) => joinHandle(slug(f), slug(l)) },
];

/* ── Mailbox row model ────────────────────────────────────────────────── */
type MailboxRow = { firstName: string; lastName: string; username: string };
const emptyRow = (): MailboxRow => ({ firstName: "", lastName: "", username: "" });

// Valid, de-duplicated rows for a single domain (trimmed + lowercased handle).
function validRows(rows: MailboxRow[]): MailboxRow[] {
  const seen = new Set<string>();
  const out: MailboxRow[] = [];
  for (const row of rows) {
    const firstName = row.firstName.trim();
    const lastName = row.lastName.trim();
    const username = row.username.trim().toLowerCase();
    if (!firstName || !lastName || !isValidUsername(username)) continue;
    if (seen.has(username)) continue;
    seen.add(username);
    out.push({ firstName, lastName, username });
  }
  return out;
}

// Every row present, filled, valid, and unique within the domain.
function allRowsComplete(rows: MailboxRow[]): boolean {
  if (rows.length < 1) return false;
  return validRows(rows).length === rows.length;
}

/* ── Provisioning status classification ───────────────────────────────── */
type MStatus = "pending" | "in_progress" | "active" | "failed";
function classifyStatus(status: string | null): MStatus {
  const s = (status ?? "").toLowerCase();
  if (!s) return "pending";
  if (/fail|error|reject|cancel|blocked/.test(s)) return "failed";
  if (/active|success|complete|ready|created|done/.test(s)) return "active";
  if (/pending|scheduled|queued/.test(s)) return "pending";
  if (/progress|process|creating|assign|warm/.test(s)) return "in_progress";
  return "pending";
}
const STATUS_CHIP: Record<MStatus, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-muted text-muted-foreground" },
  in_progress: { label: "In progress", cls: "bg-accent text-accent-foreground animate-pulse" },
  active: { label: "Active", cls: "bg-success-soft text-success" },
  failed: { label: "Failed", cls: "bg-destructive-soft text-destructive" },
};

type ProvisionBox = {
  domainName: string;
  domainId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
};

/* ── Purchase progress state machine ──────────────────────────────────── */
type PhaseKey = "buy" | "register" | "assign" | "image" | "done";
type PhaseStatus = "todo" | "active" | "done" | "error" | "info";
const INITIAL_PHASES: Record<PhaseKey, PhaseStatus> = {
  buy: "todo",
  register: "todo",
  assign: "todo",
  image: "todo",
  done: "todo",
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// A domain that has just registered needs a moment before Zapmail will accept
// mailbox creation on it; the first attempt otherwise fails and only a manual
// retry seconds later works. Settle, then retry with growing backoff.
const ASSIGN_SETTLE_MS = 8000;
const ASSIGN_ATTEMPTS = 4;
const ASSIGN_RETRY_MS = 6000;
const openLink = (url: string | null | undefined) => {
  if (url) window.open(url, "_blank", "noopener");
};

type WizardStep = 1 | 2 | 3 | 4 | 5;
const STEP_LABELS = ["Provider", "Domains", "Inboxes", "Image", "Review"] as const;

// Warmup window choices offered at purchase (server action + DB constraint
// carry the same set). Two weeks is the default.
type WarmupPeriodDays = 7 | 14 | 21 | 30 | 60 | 90;
const WARMUP_PERIOD_CHOICES: { days: WarmupPeriodDays; label: string }[] = [
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 21, label: "3 weeks" },
  { days: 30, label: "1 month" },
  { days: 60, label: "2 months" },
  { days: 90, label: "3 months" },
];

const PROVIDER_LABEL: Record<Provider, string> = {
  GOOGLE: "Google Workspace",
  MICROSOFT: "Microsoft 365",
};

/* ═══════════════════════════════════════════════════════════════════════
   Root: full-screen takeover (sequence-editor family)
   ══════════════════════════════════════════════════════════════════════ */
export function ZapmailFlow({ open, onClose }: { open: boolean; onClose: () => void }) {
  /* ── Boot + connection state ── */
  const [boot, setBoot] = useState<"loading" | "ready" | "error">("loading");
  const [bootMessage, setBootMessage] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [wallet, setWallet] = useState<ZapmailWallet | null>(null);
  const [ownedDomains, setOwnedDomains] = useState<ZapmailOwnedDomain[]>([]);
  const [summary, setSummary] = useState<ZapmailMailboxSummary | null>(null);
  const [subscriptions, setSubscriptions] = useState<ZapmailSubscription[]>([]);
  const [exportAccounts, setExportAccounts] = useState<ZapmailThirdPartyAccount[]>([]);
  const [mailboxes, setMailboxes] = useState<ZapmailMailbox[]>([]);

  /* ── Wizard position ── */
  const [view, setView] = useState<"wizard" | "inventory">("wizard");
  const [step, setStep] = useState<WizardStep>(1);
  const [backArmed, setBackArmed] = useState(false); // two-click close guard

  /* ── Step 1 · provider ── */
  const [provider, setProvider] = useState<Provider>("GOOGLE");

  /* ── Step 2 · domains ── */
  const [brandInput, setBrandInput] = useState("");
  const [suggestions, setSuggestions] = useState<ZapmailSuggestion[]>([]);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);

  /* ── Step 3 · inboxes ── */
  const [rows, setRows] = useState<Record<string, MailboxRow[]>>({});
  const [bulkFirst, setBulkFirst] = useState("");
  const [bulkLast, setBulkLast] = useState("");
  const [bulkPattern, setBulkPattern] = useState(USERNAME_PATTERNS[0].id);

  /* ── Step 4 · profile image ── */
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // Warmup window the batch commits to before it can join campaigns; the
  // watcher pings Slack when it elapses. Two weeks is the house default.
  const [warmupDays, setWarmupDays] = useState<WarmupPeriodDays>(14);

  /* ── Step 5 · purchase progress ── */
  const [started, setStarted] = useState(false); // purchase run began (locks back-nav)
  const [runBusy, setRunBusy] = useState(false);
  const [phases, setPhases] = useState<Record<PhaseKey, PhaseStatus>>(INITIAL_PHASES);
  const [phaseError, setPhaseError] = useState<{ phase: PhaseKey; message: string } | null>(null);
  const [awaitingPayment, setAwaitingPayment] = useState(false);
  const [foundCount, setFoundCount] = useState(0);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [provisionBoxes, setProvisionBoxes] = useState<ProvisionBox[]>([]);
  const idsRef = useRef<Record<string, string>>({});
  // Mailbox ids the profile image has already been applied to, so the
  // apply-on-active loop never pushes the same image twice.
  const imagedRef = useRef<Set<string>>(new Set());
  const runIdRef = useRef(0);
  useEffect(() => () => {
    runIdRef.current += 1; // cancel any in-flight polling loops on unmount
  }, []);

  /* ── Done · export to Smartlead ── */
  const [exportId, setExportId] = useState<number | null>(null);
  const [exportStatus, setExportStatus] = useState<{ status: string | null; failureReason: string | null } | null>(null);
  const [exportEmail, setExportEmail] = useState("");
  const [exportPassword, setExportPassword] = useState("");

  /* ── Generic secondary-action busy marker (link buttons, refresh, retries) ── */
  const [action, startAction] = useTransition();
  const [actionKey, setActionKey] = useState<string | null>(null);
  const runAction = (key: string, fn: () => Promise<void>) => {
    setActionKey(key);
    startAction(async () => {
      await fn();
      setActionKey((prev) => (prev === key ? null : prev));
    });
  };

  const showToast = useToast();

  /* ── Boot fetch (once, on mount) ── */
  const applyState = (result: Awaited<ReturnType<typeof getZapmailStateAction>>) => {
    setConnected(result.connected);
    if (result.wallet) setWallet(result.wallet);
    if (result.ownedDomains) setOwnedDomains(result.ownedDomains);
    if (result.summary) setSummary(result.summary);
    if (result.subscriptions) setSubscriptions(result.subscriptions);
    if (result.exportAccounts) setExportAccounts(result.exportAccounts);
    if (result.mailboxes) setMailboxes(result.mailboxes);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getZapmailStateAction();
      if (cancelled) return;
      if (!result.ok) {
        setBoot("error");
        setBootMessage(result.message);
        return;
      }
      applyState(result);
      // Seed the bulk-fill names from the first existing mailbox, if any.
      const sample = result.mailboxes?.find((m) => m.firstName || m.lastName);
      if (sample) {
        setBulkFirst(sample.firstName);
        setBulkLast(sample.lastName);
      }
      setBoot("ready");
      setBootMessage(result.message);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Lock body scroll while the takeover is open ── */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /* ── Derived: cart + money ── */
  // Unrounded — the server recomputes the same raw sum for its drift guard;
  // round only when displaying.
  const cartTotal = useMemo(() => cart.reduce((sum, item) => sum + parsePrice(item.price), 0), [cart]);
  const cartUnavailable = cart.some((item) => item.unavailable);
  const walletBalance = wallet?.balance ?? 0;
  const shortfall = round2(cartTotal - walletBalance);
  const walletShort = cart.length > 0 && shortfall > 0.005;

  /* ── Derived: inbox rows ── */
  const plannedCount = useMemo(
    () => cart.reduce((sum, item) => sum + (rows[domainKey(item.domainName)]?.length ?? 0), 0),
    [cart, rows],
  );
  const allRowsValid =
    cart.length > 0 && cart.every((item) => allRowsComplete(rows[domainKey(item.domainName)] ?? []));
  const available = summary?.available ?? 0;
  const slotsKnown = summary !== null;
  const slotsDeficit = Math.max(0, plannedCount - available);
  const slotsShort = slotsKnown && slotsDeficit > 0;

  const canContinue2 = cart.length > 0 && !cartUnavailable;
  const canBuy =
    !runBusy && !started && cart.length > 0 && !cartUnavailable && allRowsValid && !walletShort && !slotsShort;

  const doneReached = phases.done === "done";

  /* ── Step 2 · suggestions + manual check + cart ── */
  const runSuggest = () => {
    const base = brandInput.trim();
    if (base.length < 2) {
      setSuggestError("Enter your brand name first.");
      return;
    }
    setSuggestError(null);
    runAction("suggest", async () => {
      try {
        const result = await suggestZapmailDomainsAction(base);
        if (result.ok && result.suggestions) {
          setSuggestions(result.suggestions);
          if (result.suggestions.every((s) => !s.available)) {
            setSuggestError("No available variants found for that name. Try another base name.");
          }
        } else {
          setSuggestError(result.message);
        }
      } catch {
        setSuggestError("Could not load suggestions. Try again.");
      }
    });
  };

  const runManualCheck = () => {
    const name = manualInput.trim().toLowerCase();
    if (!DOMAIN_RE.test(name)) {
      setManualError("Enter a full domain, like brandhq.com.");
      return;
    }
    setManualError(null);
    runAction("manual", async () => {
      try {
        const result = await checkZapmailDomainsAction([name]);
        const quote = result.ok ? result.quotes?.[0] : undefined;
        if (quote) {
          setSuggestions((prev) => [
            { ...quote, kind: null },
            ...prev.filter((s) => domainKey(s.domainName) !== domainKey(quote.domainName)),
          ]);
          setManualInput("");
        } else {
          setManualError(result.message);
        }
      } catch {
        setManualError("Could not check that domain. Try again.");
      }
    });
  };

  const addToCart = (suggestion: ZapmailSuggestion) => {
    if (!suggestion.available) return;
    setCart((prev) => {
      const key = domainKey(suggestion.domainName);
      if (prev.length >= 10 || prev.some((item) => item.domainName === key)) return prev;
      return [
        ...prev,
        {
          domainName: key,
          price: suggestion.price,
          renewPrice: suggestion.renewPrice,
          premium: suggestion.premium,
          kind: suggestion.kind,
          unavailable: false,
        },
      ];
    });
  };
  const removeFromCart = (name: string) => setCart((prev) => prev.filter((item) => item.domainName !== name));

  const recheckCart = () => {
    if (cart.length === 0) return;
    runAction("recheck", async () => {
      try {
        const result = await checkZapmailDomainsAction(cart.map((item) => item.domainName));
        if (result.ok && result.quotes) {
          const byName = new Map(result.quotes.map((quote) => [domainKey(quote.domainName), quote]));
          const lost = cart.filter((item) => byName.get(item.domainName)?.available === false).length;
          setCart((prev) =>
            prev.map((item) => {
              const quote = byName.get(item.domainName);
              if (!quote) return item;
              return {
                ...item,
                price: quote.price,
                renewPrice: quote.renewPrice,
                premium: quote.premium,
                unavailable: !quote.available,
              };
            }),
          );
          showToast(
            lost === 0,
            lost === 0
              ? "Prices are current."
              : `${lost} ${lost === 1 ? "domain is" : "domains are"} no longer available. Remove ${lost === 1 ? "it" : "them"} to continue.`,
          );
        } else {
          showToast(false, result.message);
        }
      } catch {
        showToast(false, "Could not re-check prices.");
      }
    });
  };

  /* ── Step 3 · row editing ── */
  const seedRows = () =>
    setRows((prev) => {
      const next = { ...prev };
      for (const item of cart) {
        const key = domainKey(item.domainName);
        if (!next[key] || next[key].length === 0) next[key] = [emptyRow(), emptyRow()];
      }
      return next;
    });
  const updateRow = (key: string, index: number, field: keyof MailboxRow, value: string) =>
    setRows((prev) => {
      const list = prev[key] ? [...prev[key]] : [emptyRow()];
      list[index] = { ...list[index], [field]: value };
      return { ...prev, [key]: list };
    });
  const addRow = (key: string) =>
    setRows((prev) => {
      const list = prev[key] ? [...prev[key]] : [];
      if (list.length >= 5) return prev;
      return { ...prev, [key]: [...list, emptyRow()] };
    });
  const removeRow = (key: string, index: number) =>
    setRows((prev) => {
      const list = (prev[key] ?? []).filter((_, i) => i !== index);
      return { ...prev, [key]: list.length ? list : [emptyRow()] };
    });

  const applyBulkFill = () => {
    const first = bulkFirst.trim();
    const last = bulkLast.trim();
    if (!first || !last) {
      showToast(false, "Enter a first and last name to fill every row.");
      return;
    }
    const base = Math.max(
      0,
      USERNAME_PATTERNS.findIndex((pattern) => pattern.id === bulkPattern),
    );
    setRows((prev) => {
      const next = { ...prev };
      for (const item of cart) {
        const key = domainKey(item.domainName);
        const list = next[key] && next[key].length > 0 ? next[key] : [emptyRow(), emptyRow()];
        const used = new Set<string>();
        next[key] = list.map((_, index) => {
          // Row N gets the Nth pattern after the selected one, so the two
          // default rows differ; skip candidates that collide or fail rules.
          let username = "";
          for (let offset = 0; offset < USERNAME_PATTERNS.length; offset++) {
            const pattern = USERNAME_PATTERNS[(base + index + offset) % USERNAME_PATTERNS.length];
            const candidate = pattern.make(first, last).slice(0, 32);
            if (candidate && isValidUsername(candidate) && !used.has(candidate)) {
              username = candidate;
              break;
            }
          }
          if (!username) username = `${slug(first)}${index + 1}`.slice(0, 32);
          used.add(username);
          return { firstName: first, lastName: last, username };
        });
      }
      return next;
    });
    showToast(true, `Filled ${cart.length === 1 ? "1 domain" : `${cart.length} domains`}.`);
  };

  /* ── Payment-link helpers ── */
  const topUp = () => {
    const amount = Math.min(5000, Math.max(10, Math.ceil(Math.max(shortfall, 0))));
    runAction("topup", async () => {
      try {
        const result = await createZapmailTopUpLinkAction(amount);
        showToast(result.ok, result.ok ? "Top-up link opened in a new tab." : result.message);
        if (result.ok) openLink(result.paymentLink);
      } catch {
        showToast(false, "Could not create a top-up link.");
      }
    });
  };
  const buyAddon = (quantity: number) => {
    runAction("addon", async () => {
      try {
        const result = await createZapmailAddonLinkAction(quantity);
        showToast(result.ok, result.ok ? "Add-on link opened in a new tab." : result.message);
        if (result.ok) openLink(result.paymentLink);
      } catch {
        showToast(false, "Could not create an add-on link.");
      }
    });
  };
  const startSubscription = (plan: "Starter" | "Growth" | "Pro", cycle: string) => {
    runAction("subscribe", async () => {
      try {
        const result = await createZapmailSubscriptionLinkAction(plan, cycle);
        showToast(result.ok, result.ok ? "Subscription link opened in a new tab." : result.message);
        if (result.ok) openLink(result.paymentLink);
      } catch {
        showToast(false, "Could not create a subscription link.");
      }
    });
  };
  const refreshState = () =>
    runAction("refresh", async () => {
      try {
        const result = await getZapmailStateAction();
        if (result.ok) {
          applyState(result);
          showToast(true, "Zapmail data refreshed.");
        } else {
          showToast(false, result.message);
        }
      } catch {
        showToast(false, "Could not refresh Zapmail data.");
      }
    });

  /* ── Step 5 · purchase run (buy → register → assign → image → done) ── */
  const setPhaseStatus = (key: PhaseKey, status: PhaseStatus) =>
    setPhases((prev) => ({ ...prev, [key]: status }));
  const failPhase = (key: PhaseKey, message: string) => {
    setPhaseStatus(key, "error");
    setPhaseError({ phase: key, message });
  };
  const run = (fn: (id: number) => Promise<void>) => {
    const id = ++runIdRef.current;
    setRunBusy(true);
    void fn(id).finally(() => {
      if (runIdRef.current === id) setRunBusy(false);
    });
  };

  const doBuy = async (id: number): Promise<"ok" | "payment" | "fail"> => {
    setPhaseError(null);
    setPhaseStatus("buy", "active");
    try {
      const result = await buyZapmailDomainsAction({
        domains: cart.map((item) => ({ domainName: item.domainName, years: 1 })),
        expectedTotal: cartTotal,
        useWallet: true,
        provider,
      });
      if (runIdRef.current !== id) return "fail";
      if (!result.ok) {
        failPhase("buy", result.message);
        return "fail";
      }
      if (result.paymentLink) {
        openLink(result.paymentLink);
        setAwaitingPayment(true);
        return "payment";
      }
      setPhaseStatus("buy", "done");
      return "ok";
    } catch {
      if (runIdRef.current === id) failPhase("buy", "Could not reach Zapmail to buy domains. Retry in a moment.");
      return "fail";
    }
  };

  const doRegister = async (id: number): Promise<boolean> => {
    setPhaseError(null);
    setPhaseStatus("register", "active");
    const wanted = cart.map((item) => item.domainName);
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const result = await getZapmailOwnedDomainsAction();
        if (runIdRef.current !== id) return false;
        if (result.ok && result.ownedDomains) {
          setOwnedDomains(result.ownedDomains);
          for (const domain of result.ownedDomains) idsRef.current[domainKey(domain.domain)] = domain.id;
          const found = wanted.filter((key) => idsRef.current[key]).length;
          setFoundCount(found);
          if (found === wanted.length) {
            setProvisionBoxes((prev) =>
              prev.map((box) => ({ ...box, domainId: idsRef.current[domainKey(box.domainName)] ?? box.domainId })),
            );
            setPhaseStatus("register", "done");
            return true;
          }
        }
      } catch {
        // Transient fetch failure; keep polling.
      }
      await sleep(5000);
      if (runIdRef.current !== id) return false;
    }
    const found = wanted.filter((key) => idsRef.current[key]).length;
    failPhase(
      "register",
      `Only ${found} of ${wanted.length} ${wanted.length === 1 ? "domain has" : "domains have"} appeared in Zapmail so far. Registration can take a few minutes.`,
    );
    return false;
  };

  // Record the durable provisioning batch once inbox creation succeeds: the
  // server-side watcher then owns activation -> image -> Smartlead export ->
  // defaults -> review, so closing this tab loses nothing. Fire-and-forget; a
  // failure resets the guard so the retry paths try again.
  const provisionCreatedRef = useRef(false);
  const recordProvision = async () => {
    if (provisionCreatedRef.current) return;
    provisionCreatedRef.current = true;
    try {
      const items = cart.flatMap((item) =>
        validRows(rows[item.domainName] ?? []).map((row) => ({
          email: `${row.username}@${item.domainName}`,
          domainName: item.domainName,
        })),
      );
      if (items.length === 0) return;
      await createZapmailProvisionAction({
        provider,
        imageUrl: avatarUrl,
        exportAccountId: exportAccounts[0]?.id ?? null,
        notify: true,
        warmupDays,
        items,
      });
    } catch {
      provisionCreatedRef.current = false;
    }
  };

  const doAssign = async (id: number): Promise<boolean> => {
    setPhaseError(null);
    setPhaseStatus("assign", "active");
    if (
      cart.every((item) => !idsRef.current[item.domainName]) ||
      cart.every((item) => validRows(rows[item.domainName] ?? []).length === 0)
    ) {
      failPhase("assign", "The new domains have no Zapmail ids yet. Retry once they finish registering.");
      return false;
    }
    // Let the freshly-registered domains settle before the first attempt.
    await sleep(ASSIGN_SETTLE_MS);
    if (runIdRef.current !== id) return false;
    let lastMessage = "Could not reach Zapmail to create inboxes.";
    for (let attempt = 0; attempt < ASSIGN_ATTEMPTS; attempt += 1) {
      // Re-read existing mailboxes each attempt so a retry never re-creates
      // inboxes a prior partial attempt already made (no duplicates).
      let existing = new Set<string>();
      try {
        const list = await getZapmailMailboxesAction();
        if (runIdRef.current !== id) return false;
        if (list.ok && list.mailboxes) existing = new Set(list.mailboxes.map((m) => m.email.toLowerCase()));
      } catch {
        // A transient read failure just means no dedupe this attempt; safe to proceed.
      }
      const entries = cart
        .map((item) => ({
          domainId: idsRef.current[item.domainName] ?? "",
          domainName: item.domainName,
          boxes: validRows(rows[item.domainName] ?? []).filter(
            (box) => !existing.has(`${box.username}@${item.domainName}`.toLowerCase()),
          ),
        }))
        .filter((entry) => entry.domainId && entry.boxes.length > 0);
      if (entries.length === 0) {
        // Every planned inbox already exists (a prior attempt landed) - done.
        setPhaseStatus("assign", "done");
        void recordProvision();
        return true;
      }
      try {
        const result = await assignZapmailMailboxesAction(entries, provider);
        if (runIdRef.current !== id) return false;
        if (result.ok) {
          setPhaseStatus("assign", "done");
          void recordProvision();
          return true;
        }
        lastMessage = result.message;
      } catch {
        lastMessage = "Could not reach Zapmail to create inboxes.";
      }
      if (attempt < ASSIGN_ATTEMPTS - 1) {
        await sleep(ASSIGN_RETRY_MS * (attempt + 1));
        if (runIdRef.current !== id) return false;
      }
    }
    failPhase("assign", `${lastMessage} The domains may still be settling; retry in a moment.`);
    return false;
  };

  const doImage = async (id: number): Promise<boolean> => {
    if (!avatarUrl) return true;
    setPhaseError(null);
    setPhaseStatus("image", "active");
    const plannedEmails = new Set<string>();
    for (const item of cart) {
      for (const row of validRows(rows[item.domainName] ?? [])) {
        plannedEmails.add(`${row.username}@${item.domainName}`);
      }
    }
    const total = plannedEmails.size;
    // Zapmail rejects /v1/mailbox/update (500) on a mailbox that is not yet
    // ACTIVE - a freshly created mailbox is "pending" for a while. So only ever
    // image ACTIVE ones here; the done screen keeps applying to the rest as they
    // go active (apply-on-active effect below), which is the reliable path.
    let activeIds: string[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const result = await getZapmailMailboxesAction();
        if (runIdRef.current !== id) return false;
        if (result.ok) {
          if (result.mailboxes) {
            setMailboxes(result.mailboxes);
            activeIds = result.mailboxes
              .filter((m) => plannedEmails.has(m.email.toLowerCase()) && classifyStatus(m.status) === "active")
              .map((m) => m.id);
          }
          if (result.summary) setSummary(result.summary);
        }
      } catch {
        // Transient fetch failure; keep polling.
      }
      if (activeIds.length >= total) break;
      await sleep(5000);
      if (runIdRef.current !== id) return false;
    }
    if (activeIds.length > 0) {
      try {
        const update = await updateZapmailMailboxesAction(
          activeIds.map((mailboxId) => ({ mailboxId, profilePicture: avatarUrl })),
        );
        if (runIdRef.current !== id) return false;
        if (!update.ok) {
          failPhase("image", update.message);
          return false;
        }
        activeIds.forEach((mid) => imagedRef.current.add(mid));
      } catch {
        if (runIdRef.current === id) failPhase("image", "Could not reach Zapmail to apply the image. Retry in a moment.");
        return false;
      }
    }
    if (activeIds.length < total) {
      setImageNote(
        `${activeIds.length} of ${total} inboxes have the image. The rest apply automatically as each inbox becomes active (Zapmail creates them in the background) - or apply from the mailbox list any time.`,
      );
      setPhaseStatus("image", "info");
    } else {
      setPhaseStatus("image", "done");
    }
    return true;
  };

  const doDone = async (id: number): Promise<void> => {
    setPhaseStatus("done", "active");
    try {
      const result = await getZapmailStateAction();
      if (runIdRef.current !== id) return;
      if (result.ok) applyState(result);
    } catch {
      // The purchase itself already succeeded; a failed refresh is harmless.
    }
    setPhaseStatus("done", "done");
  };

  const continueFromRegister = async (id: number) => {
    if (!(await doRegister(id))) return;
    if (!(await doAssign(id))) return;
    if (!(await doImage(id))) return;
    await doDone(id);
  };

  const startPurchase = () => {
    if (!canBuy) return;
    const boxes: ProvisionBox[] = [];
    for (const item of cart) {
      for (const row of validRows(rows[item.domainName] ?? [])) {
        boxes.push({
          domainName: item.domainName,
          domainId: null,
          email: `${row.username}@${item.domainName}`,
          firstName: row.firstName,
          lastName: row.lastName,
          username: row.username,
        });
      }
    }
    setProvisionBoxes(boxes);
    setStarted(true);
    setBackArmed(false);
    provisionCreatedRef.current = false; // a fresh purchase records its own batch
    setPhases(INITIAL_PHASES);
    setPhaseError(null);
    setAwaitingPayment(false);
    setFoundCount(0);
    setImageNote(null);
    run(async (id) => {
      if ((await doBuy(id)) !== "ok") return;
      await continueFromRegister(id);
    });
  };

  const retryBuy = () => {
    setPhaseError(null);
    run(async (id) => {
      if ((await doBuy(id)) !== "ok") return;
      await continueFromRegister(id);
    });
  };
  // The register poll is the real re-check: it only proceeds once every cart
  // domain shows up as owned, which cannot happen without a completed payment.
  const continueAfterPayment = () => {
    setAwaitingPayment(false);
    setPhaseStatus("buy", "done");
    run(continueFromRegister);
  };
  const retryRegister = () => {
    setPhaseError(null);
    run(continueFromRegister);
  };
  const retryAssign = () => {
    setPhaseError(null);
    run(async (id) => {
      if (!(await doAssign(id))) return;
      if (!(await doImage(id))) return;
      await doDone(id);
    });
  };
  const retryAssignViaZapmail = () => {
    setPhaseError(null);
    run(async (id) => {
      const domainIds = cart
        .map((item) => idsRef.current[item.domainName])
        .filter((value): value is string => Boolean(value));
      if (domainIds.length === 0) {
        failPhase("assign", "No Zapmail domain ids to retry against yet.");
        return;
      }
      setPhaseStatus("assign", "active");
      try {
        const result = await retryZapmailMailboxesAction(domainIds);
        if (runIdRef.current !== id) return;
        if (!result.ok) {
          failPhase("assign", result.message);
          return;
        }
      } catch {
        if (runIdRef.current === id) failPhase("assign", "Could not reach Zapmail to retry. Try again in a moment.");
        return;
      }
      setPhaseStatus("assign", "done");
      if (!(await doImage(id))) return;
      await doDone(id);
    });
  };
  const retryImage = () => {
    setPhaseError(null);
    run(async (id) => {
      if (!(await doImage(id))) return;
      await doDone(id);
    });
  };
  const backToDomains = () => {
    // Only offered while the buy call itself failed, i.e. no money has moved.
    setStarted(false);
    setPhases(INITIAL_PHASES);
    setPhaseError(null);
    setAwaitingPayment(false);
    setProvisionBoxes([]);
    setStep(2);
  };

  /* ── Done · mailbox status polling (every 8s until all active) ── */
  const provisionEmails = useMemo(
    () => new Set(provisionBoxes.map((box) => box.email.toLowerCase())),
    [provisionBoxes],
  );
  const matchedByEmail = useMemo(() => {
    const map = new Map<string, ZapmailMailbox>();
    for (const m of mailboxes) {
      const email = m.email.toLowerCase();
      if (provisionEmails.has(email)) map.set(email, m);
    }
    return map;
  }, [mailboxes, provisionEmails]);

  const allActive =
    provisionBoxes.length > 0 &&
    provisionBoxes.every((box) => classifyStatus(matchedByEmail.get(box.email.toLowerCase())?.status ?? null) === "active");
  const failedDomainIds = useMemo(() => {
    const ids = new Set<string>();
    for (const box of provisionBoxes) {
      const matched = matchedByEmail.get(box.email.toLowerCase());
      if (matched && classifyStatus(matched.status) === "failed") {
        const domainId = matched.domainId ?? box.domainId;
        if (domainId) ids.add(domainId);
      }
    }
    return [...ids];
  }, [provisionBoxes, matchedByEmail]);

  useEffect(() => {
    if (!doneReached || allActive) return;
    let cancelled = false;
    let inFlight = false; // a slow page of results must not stack polls
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await getZapmailMailboxesAction();
        if (cancelled) return;
        if (result.ok) {
          if (result.mailboxes) setMailboxes(result.mailboxes);
          if (result.summary) setSummary(result.summary);
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [doneReached, allActive]);

  // Apply-on-active: the image can only be set once a mailbox is ACTIVE, and
  // creation is async, so we push the chosen image to each provisioned inbox as
  // soon as it goes active (the done-screen poll refreshes `mailboxes`). Each id
  // is imaged at most once (imagedRef); a failed push is rolled back so the next
  // poll retries it. This is the reliable path - the wizard's up-front attempt
  // only catches inboxes that happen to be active already.
  useEffect(() => {
    if (!avatarUrl || !doneReached) return;
    const pending = mailboxes.filter(
      (m) =>
        provisionEmails.has(m.email.toLowerCase()) &&
        classifyStatus(m.status) === "active" &&
        !imagedRef.current.has(m.id),
    );
    if (pending.length === 0) return;
    const ids = pending.map((m) => m.id);
    ids.forEach((mid) => imagedRef.current.add(mid)); // claim now so a re-render mid-flight does not double-fire
    void (async () => {
      try {
        const update = await updateZapmailMailboxesAction(ids.map((mailboxId) => ({ mailboxId, profilePicture: avatarUrl })));
        if (!update.ok) ids.forEach((mid) => imagedRef.current.delete(mid)); // let the next poll retry
      } catch {
        ids.forEach((mid) => imagedRef.current.delete(mid));
      }
    })();
  }, [mailboxes, avatarUrl, doneReached, provisionEmails]);

  const retryFailed = () =>
    runAction("retry-failed", async () => {
      if (failedDomainIds.length === 0) return;
      try {
        const result = await retryZapmailMailboxesAction(failedDomainIds);
        showToast(result.ok, result.message);
      } catch {
        showToast(false, "Could not retry the failed mailboxes.");
      }
    });

  /* ── Done · export to Smartlead ── */
  const activeIds = useMemo(
    () =>
      provisionBoxes
        .map((box) => matchedByEmail.get(box.email.toLowerCase()))
        .filter((m): m is ZapmailMailbox => Boolean(m) && classifyStatus(m!.status) === "active")
        .map((m) => m.id),
    [provisionBoxes, matchedByEmail],
  );

  const runExport = (thirdPartyAccountId?: string) =>
    runAction("export", async () => {
      if (activeIds.length === 0) {
        showToast(false, "No active mailboxes to export yet.");
        return;
      }
      try {
        const result = await exportZapmailMailboxesAction({ ids: activeIds, thirdPartyAccountId });
        if (result.ok && typeof result.exportId === "number") {
          setExportId(result.exportId);
          setExportStatus(null);
          showToast(true, "Smartlead export queued.");
        } else {
          showToast(false, result.message);
        }
      } catch {
        showToast(false, "Could not export mailboxes to Smartlead.");
      }
    });

  const addAccountAndExport = () =>
    runAction("add-account", async () => {
      try {
        const added = await addZapmailExportAccountAction({ email: exportEmail.trim(), password: exportPassword });
        if (!added.ok) {
          showToast(false, added.message);
          return;
        }
        setExportPassword("");
        const accounts = await getZapmailExportAccountsAction();
        if (accounts.ok && accounts.exportAccounts) setExportAccounts(accounts.exportAccounts);
        if (activeIds.length === 0) {
          showToast(true, "Smartlead login added. Export once mailboxes are active.");
          return;
        }
        const result = await exportZapmailMailboxesAction({ ids: activeIds });
        if (result.ok && typeof result.exportId === "number") {
          setExportId(result.exportId);
          setExportStatus(null);
          showToast(true, "Smartlead login added and export queued.");
        } else {
          showToast(false, result.message);
        }
      } catch {
        showToast(false, "Could not add the Smartlead account.");
      }
    });

  /* ── Export status polling (every 8s until completed/failed) ── */
  const exportPhase = classifyExport(exportStatus?.status ?? null);
  useEffect(() => {
    if (exportId === null || exportPhase === "completed" || exportPhase === "failed") return;
    let cancelled = false;
    const poll = async () => {
      const result = await getZapmailExportStatusAction(exportId);
      if (cancelled) return;
      if (result.ok) setExportStatus({ status: result.export.status, failureReason: result.export.failureReason });
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [exportId, exportPhase]);

  /* ── Navigation ── */
  const goStep = (target: WizardStep) => {
    if (started) return;
    setBackArmed(false);
    if (target < step) setStep(target);
  };
  const continueTo = (target: WizardStep) => {
    if (target === 3) seedRows();
    setBackArmed(false);
    setStep(target);
  };
  const requestClose = () => {
    if (started && !doneReached) return; // no closing mid-purchase
    if (doneReached) {
      onClose();
      return;
    }
    if (cart.length > 0 && !backArmed) {
      setBackArmed(true);
      return;
    }
    onClose();
  };
  const handleBack = () => {
    setBackArmed(false);
    if (view === "inventory") {
      setView("wizard");
      return;
    }
    if (runBusy || (started && !doneReached)) return;
    if (doneReached) {
      requestClose();
      return;
    }
    if (step > 1) setStep((prev) => (prev - 1) as WizardStep);
    else requestClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (runBusy || (started && !doneReached)) return;
      handleBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, step, started, doneReached, runBusy, backArmed, cart]);

  if (!open) return null;

  const backLabel =
    view === "inventory"
      ? "Back"
      : backArmed
        ? "Discard and close?"
        : doneReached
          ? "Close"
          : step > 1 && !started
            ? "Back"
            : "Close";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      {/* ── Header bar ── */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button
          type="button"
          onClick={handleBack}
          disabled={runBusy || (started && !doneReached && view === "wizard")}
          className={`${
            backArmed ? `${BTN_BASE} bg-destructive-soft text-destructive hover:opacity-90` : BTN_OUTLINE
          } h-8 px-3 text-[12px]`}
        >
          <ArrowLeft className="size-3.5" />
          {backLabel}
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <ShoppingBag className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 truncate font-semibold tracking-tight">
            {view === "inventory" ? "Your Zapmail inboxes" : "Buy sending inboxes"}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {boot === "ready" && connected ? (
            <button
              type="button"
              disabled={runBusy || (started && !doneReached)}
              onClick={() => setView((prev) => (prev === "wizard" ? "inventory" : "wizard"))}
              className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
            >
              {view === "inventory" ? "Back to purchase" : `Your inboxes (${mailboxes.length})`}
            </button>
          ) : null}
          {wallet ? (
            <span
              data-tip={wallet.autoRechargeEnabled ? "Auto-recharge on" : "Zapmail wallet balance"}
              data-tip-down=""
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-medium tabular-nums shadow-xs"
            >
              <Wallet className="size-3.5 text-muted-foreground" />
              Wallet {formatUSD(wallet.balance)}
            </span>
          ) : null}
        </div>
      </header>

      {/* ── Body ── */}
      {boot === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : boot === "error" ? (
        <BootError message={bootMessage} onRetry={() => window.location.reload()} />
      ) : !connected ? (
        <ConnectPrompt onClose={onClose} />
      ) : view === "inventory" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[900px] px-5 pb-16 pt-6">
            <InventoryView
              ownedDomains={ownedDomains}
              mailboxes={mailboxes}
              onToast={showToast}
              onRefresh={refreshState}
              refreshing={action && actionKey === "refresh"}
            />
          </div>
        </div>
      ) : (
        <>
          <StepBar step={step} locked={started} onStep={goStep} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[900px] px-5 pb-28 pt-6">
              {step === 1 ? <ProviderStep provider={provider} onProvider={setProvider} /> : null}

              {step === 2 ? (
                <DomainsStep
                  brandInput={brandInput}
                  onBrandInput={setBrandInput}
                  onSuggest={runSuggest}
                  suggesting={action && actionKey === "suggest"}
                  suggestError={suggestError}
                  suggestions={suggestions}
                  manualInput={manualInput}
                  onManualInput={setManualInput}
                  onManualCheck={runManualCheck}
                  manualChecking={action && actionKey === "manual"}
                  manualError={manualError}
                  cart={cart}
                  cartTotal={cartTotal}
                  onAdd={addToCart}
                  onRemove={removeFromCart}
                  onRecheck={recheckCart}
                  rechecking={action && actionKey === "recheck"}
                  actionBusy={action}
                />
              ) : null}

              {step === 3 ? (
                <InboxesStep
                  cart={cart}
                  rows={rows}
                  bulkFirst={bulkFirst}
                  bulkLast={bulkLast}
                  bulkPattern={bulkPattern}
                  onBulkFirst={setBulkFirst}
                  onBulkLast={setBulkLast}
                  onBulkPattern={setBulkPattern}
                  onApplyBulk={applyBulkFill}
                  onUpdateRow={updateRow}
                  onAddRow={addRow}
                  onRemoveRow={removeRow}
                />
              ) : null}

              {step === 4 ? <ImageStep avatarUrl={avatarUrl} onAvatarUrl={setAvatarUrl} /> : null}

              {step === 5 ? (
                <div className="flex flex-col gap-5">
                  <ReviewStep
                    provider={provider}
                    cart={cart}
                    cartTotal={cartTotal}
                    rows={rows}
                    plannedCount={plannedCount}
                    avatarUrl={avatarUrl}
                    warmupDays={warmupDays}
                    onWarmupDays={setWarmupDays}
                    walletBalance={walletBalance}
                    walletShort={walletShort}
                    shortfall={shortfall}
                    summary={summary}
                    slotsShort={slotsShort}
                    slotsDeficit={slotsDeficit}
                    subscriptions={subscriptions}
                    started={started}
                    actionBusy={action}
                    actionKey={actionKey}
                    onTopUp={topUp}
                    onRefresh={refreshState}
                    onBuyAddon={() => buyAddon(slotsDeficit)}
                    onStartSubscription={startSubscription}
                  />

                  {started ? (
                    <ProgressChecklist
                      phases={phases}
                      phaseError={phaseError}
                      awaitingPayment={awaitingPayment}
                      foundCount={foundCount}
                      domainCount={cart.length}
                      hasImage={Boolean(avatarUrl)}
                      imageNote={imageNote}
                      runBusy={runBusy}
                      onRetryBuy={retryBuy}
                      onBackToDomains={backToDomains}
                      onContinueAfterPayment={continueAfterPayment}
                      onRetryRegister={retryRegister}
                      onRetryAssign={retryAssign}
                      onRetryAssignViaZapmail={retryAssignViaZapmail}
                      onRetryImage={retryImage}
                    />
                  ) : null}

                  {doneReached ? (
                    <DoneSection
                      provider={provider}
                      cart={cart}
                      provisionBoxes={provisionBoxes}
                      matchedByEmail={matchedByEmail}
                      imageNote={imageNote}
                      onOpenInventory={() => setView("inventory")}
                      hasFailed={failedDomainIds.length > 0}
                      onRetryFailed={retryFailed}
                      retrying={action && actionKey === "retry-failed"}
                      activeCount={activeIds.length}
                      exportAccounts={exportAccounts}
                      onExport={runExport}
                      exporting={action && actionKey === "export"}
                      exportEmail={exportEmail}
                      exportPassword={exportPassword}
                      onExportEmail={setExportEmail}
                      onExportPassword={setExportPassword}
                      onAddAccountAndExport={addAccountAndExport}
                      addingAccount={action && actionKey === "add-account"}
                      exportId={exportId}
                      exportPhase={exportPhase}
                      exportStatus={exportStatus}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* ── Sticky footer ── */}
          {step === 1 ? (
            <StickyFooter>
              <span className="text-[12.5px] font-medium">{PROVIDER_LABEL[provider]}</span>
              <span className="text-[11px] text-muted-foreground">You can pick per purchase; nothing is saved globally.</span>
              <button type="button" onClick={() => continueTo(2)} className={`${BTN_PRIMARY} ml-auto h-8 px-4 text-[12px]`}>
                Continue
                <ArrowRight className="size-3.5" />
              </button>
            </StickyFooter>
          ) : null}

          {step === 2 ? (
            <StickyFooter>
              <div className="flex min-w-0 flex-col">
                <span className="text-[12.5px] font-medium tabular-nums">
                  {cart.length} of 10 {cart.length === 1 ? "domain" : "domains"} · {formatUSD(cartTotal)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {cartUnavailable ? (
                    <span className="text-destructive">Remove the unavailable domains to continue.</span>
                  ) : (
                    "Nothing is charged yet. New domains register for 1 year."
                  )}
                </span>
              </div>
              <button
                type="button"
                disabled={!canContinue2}
                onClick={() => continueTo(3)}
                className={`${BTN_PRIMARY} ml-auto h-8 px-4 text-[12px]`}
              >
                Continue
                <ArrowRight className="size-3.5" />
              </button>
            </StickyFooter>
          ) : null}

          {step === 3 ? (
            <StickyFooter>
              <span className="text-[12.5px] font-medium tabular-nums">
                {plannedCount} {plannedCount === 1 ? "inbox" : "inboxes"} across {cart.length}{" "}
                {cart.length === 1 ? "domain" : "domains"}
              </span>
              {!allRowsValid ? (
                <span className="text-[11px] text-muted-foreground">Every row needs a name and a valid, unique username.</span>
              ) : null}
              <button
                type="button"
                disabled={!allRowsValid}
                onClick={() => continueTo(4)}
                className={`${BTN_PRIMARY} ml-auto h-8 px-4 text-[12px]`}
              >
                Continue
                <ArrowRight className="size-3.5" />
              </button>
            </StickyFooter>
          ) : null}

          {step === 4 ? (
            <StickyFooter>
              <span className="text-[11px] text-muted-foreground">
                {avatarUrl ? "Image ready. It applies to every inbox in this purchase." : "Optional. You can skip this step."}
              </span>
              <button type="button" onClick={() => continueTo(5)} className={`${BTN_PRIMARY} ml-auto h-8 px-4 text-[12px]`}>
                Continue
                <ArrowRight className="size-3.5" />
              </button>
            </StickyFooter>
          ) : null}

          {step === 5 && !started ? (
            <StickyFooter>
              <div className="flex min-w-0 flex-col">
                <span className="text-[12.5px] font-medium tabular-nums">
                  Wallet {formatUSD(walletBalance)} · Total {formatUSD(cartTotal)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  This is the only step that spends money. Everything before is free.
                </span>
              </div>
              <button
                type="button"
                disabled={!canBuy}
                onClick={startPurchase}
                className={`${BTN_PRIMARY} ml-auto h-8 px-4 text-[12px]`}
              >
                Buy {cart.length} {cart.length === 1 ? "domain" : "domains"} for {formatUSD(cartTotal)}
              </button>
            </StickyFooter>
          ) : null}

          {step === 5 && doneReached ? (
            <StickyFooter>
              <span className="text-[11px] text-muted-foreground">
                Inbox creation continues at Zapmail; check back from the mailbox list.
              </span>
              <button type="button" onClick={onClose} className={`${BTN_PRIMARY} ml-auto h-8 px-4 text-[12px]`}>
                Close
              </button>
            </StickyFooter>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ── Export status classification ─────────────────────────────────────── */
type ExportPhase = "idle" | "in_progress" | "completed" | "failed";
function classifyExport(status: string | null): ExportPhase {
  const s = (status ?? "").toLowerCase();
  if (!s) return "idle";
  if (/fail|error|reject/.test(s)) return "failed";
  if (/complete|success|done|finish/.test(s)) return "completed";
  return "in_progress";
}

/* ═══════════════════════════════════════════════════════════════════════
   Shared chrome
   ══════════════════════════════════════════════════════════════════════ */
function StepBar({ step, locked, onStep }: { step: number; locked: boolean; onStep: (target: WizardStep) => void }) {
  return (
    <div className="shrink-0 border-b border-border px-5 py-3">
      <div className="mx-auto flex w-full max-w-[900px] items-center gap-2">
        {STEP_LABELS.map((label, index) => {
          const n = (index + 1) as WizardStep;
          const state = n === step ? "current" : n < step ? "done" : "upcoming";
          const clickable = !locked && n < step;
          return (
            <div key={label} className="flex min-w-0 flex-1 items-center gap-2">
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onStep(n)}
                className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition ${
                  clickable ? "hover:bg-muted/60" : "cursor-default"
                }`}
              >
                <span
                  className={`flex size-4.5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ${
                    state === "current"
                      ? "bg-primary text-primary-foreground"
                      : state === "done"
                        ? "bg-success-soft text-success"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {state === "done" ? <Check className="size-2.5" /> : n}
                </span>
                <span
                  className={`min-w-0 truncate text-[11px] font-medium ${
                    state === "current" ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </span>
              </button>
              {index < STEP_LABELS.length - 1 ? <span className="h-px flex-1 bg-border" /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StickyFooter({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-x-0 bottom-0 border-t border-border bg-surface/95 px-5 py-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[900px] flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function BootError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive-soft">
          <AlertTriangle className="size-5 text-destructive" strokeWidth={1.75} />
        </span>
        <p className="mt-3 text-[13px] font-medium">Couldn&rsquo;t reach Zapmail</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{message}</p>
        <button type="button" onClick={onRetry} className={`${BTN_OUTLINE} mt-4 h-8 px-3 text-[12px]`}>
          Retry
        </button>
      </div>
    </div>
  );
}

function ConnectPrompt({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center rounded-xl bg-surface p-8 text-center shadow-xs">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted/60">
          <AtSign className="size-6 text-muted-foreground" strokeWidth={1.5} />
        </span>
        <p className="mt-4 text-[14px] font-semibold tracking-tight">Connect Zapmail to buy sending domains and mailboxes</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          Add your Zapmail API key in settings to register domains and provision mailboxes without leaving this app.
        </p>
        <Link
          href="/settings?section=integrations"
          onClick={onClose}
          className={`${BTN_PRIMARY} mt-5 h-8 px-4 text-[12px]`}
        >
          Open integration settings
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function BareSelect({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <span className="relative">
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        className={`h-7 appearance-none rounded-md border border-border bg-surface pl-2 pr-6 text-[11.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring`}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

function SubscriptionInline({
  onStart,
  busy,
  disabled,
}: {
  onStart: (plan: "Starter" | "Growth" | "Pro", cycle: string) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [plan, setPlan] = useState<"Starter" | "Growth" | "Pro">("Starter");
  const [cycle, setCycle] = useState("monthly");
  return (
    <div className="flex items-center gap-1.5">
      <BareSelect value={plan} onChange={(value) => setPlan(value as "Starter" | "Growth" | "Pro")} ariaLabel="Subscription plan">
        <option value="Starter">Starter</option>
        <option value="Growth">Growth</option>
        <option value="Pro">Pro</option>
      </BareSelect>
      <BareSelect value={cycle} onChange={setCycle} ariaLabel="Billing cycle">
        <option value="monthly">Monthly</option>
        <option value="quarterly">Quarterly</option>
        <option value="yearly">Yearly</option>
      </BareSelect>
      <button type="button" disabled={disabled} onClick={() => onStart(plan, cycle)} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : null}
        Start subscription
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Step 1 · Provider
   ══════════════════════════════════════════════════════════════════════ */
function ProviderStep({ provider, onProvider }: { provider: Provider; onProvider: (value: Provider) => void }) {
  const options: { value: Provider; title: string; copy: string }[] = [
    { value: "GOOGLE", title: "Google Workspace", copy: "Gmail-based sending inboxes. The most common choice." },
    { value: "MICROSOFT", title: "Microsoft 365", copy: "Outlook-based sending inboxes." },
  ];
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle title="Where should the inboxes live?" hint="Applies to this purchase only" />
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const selected = provider === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onProvider(option.value)}
              className={`flex flex-col gap-1.5 rounded-xl border p-4 text-left shadow-xs transition ${
                selected ? "border-ring bg-surface" : "border-border bg-surface hover:border-border-strong hover:bg-muted/40"
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                    selected ? "border-primary bg-primary" : "border-border-strong"
                  }`}
                >
                  {selected ? <Check className="size-2.5 text-primary-foreground" /> : null}
                </span>
                <span className="text-[13px] font-semibold tracking-tight">{option.title}</span>
              </span>
              <span className="pl-6 text-[11px] leading-relaxed text-muted-foreground">{option.copy}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Step 2 · Domains
   ══════════════════════════════════════════════════════════════════════ */
const KIND_LABEL: Record<SuggestKind, string> = { exact: "Exact", prefix: "Prefix", suffix: "Suffix" };

function DomainsStep({
  brandInput,
  onBrandInput,
  onSuggest,
  suggesting,
  suggestError,
  suggestions,
  manualInput,
  onManualInput,
  onManualCheck,
  manualChecking,
  manualError,
  cart,
  cartTotal,
  onAdd,
  onRemove,
  onRecheck,
  rechecking,
  actionBusy,
}: {
  brandInput: string;
  onBrandInput: (value: string) => void;
  onSuggest: () => void;
  suggesting: boolean;
  suggestError: string | null;
  suggestions: ZapmailSuggestion[];
  manualInput: string;
  onManualInput: (value: string) => void;
  onManualCheck: () => void;
  manualChecking: boolean;
  manualError: string | null;
  cart: CartItem[];
  cartTotal: number;
  onAdd: (suggestion: ZapmailSuggestion) => void;
  onRemove: (name: string) => void;
  onRecheck: () => void;
  rechecking: boolean;
  actionBusy: boolean;
}) {
  const inCart = new Set(cart.map((item) => item.domainName));
  const cartFull = cart.length >= 10;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* Left: search + results */}
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <SectionTitle title="Find sending domains" hint="Variants of your brand, priced live" />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={brandInput}
              onChange={(event) => onBrandInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSuggest();
              }}
              placeholder="Your brand, like acmeindustries"
              spellCheck={false}
              className={`${INPUT_CLASS} max-w-[280px]`}
            />
            <button type="button" disabled={actionBusy} onClick={onSuggest} className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}>
              {suggesting ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
              {suggesting ? "Checking…" : "Suggest domains"}
            </button>
          </div>
          {suggestError ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[11.5px] leading-relaxed text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{suggestError}</span>
            </div>
          ) : null}
        </div>

        {suggestions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <SectionTitle title="Suggestions" hint={`${suggestions.filter((s) => s.available).length} available`} />
            <div className="overflow-hidden rounded-xl bg-surface shadow-xs">
              {suggestions.map((suggestion, index) => (
                <SuggestionRow
                  key={suggestion.domainName}
                  suggestion={suggestion}
                  first={index === 0}
                  added={inCart.has(domainKey(suggestion.domainName))}
                  cartFull={cartFull}
                  onAdd={() => onAdd(suggestion)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-muted-foreground">Add a specific domain</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={manualInput}
              onChange={(event) => onManualInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onManualCheck();
              }}
              placeholder="brandhq.com"
              spellCheck={false}
              className={`${MONO_INPUT_CLASS} max-w-[240px]`}
            />
            <button type="button" disabled={actionBusy || !manualInput.trim()} onClick={onManualCheck} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
              {manualChecking ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Check
            </button>
          </div>
          {manualError ? <span className="text-[11px] text-destructive">{manualError}</span> : null}
        </div>
      </div>

      {/* Right: cart */}
      <div className="flex flex-col gap-2 rounded-xl bg-surface p-3.5 shadow-xs lg:sticky lg:top-4">
        <SectionTitle title="Your domains" hint={`${cart.length} of 10`} />
        {cart.length === 0 ? (
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Nothing added yet. Suggestions you add appear here with a running total.
          </p>
        ) : (
          <>
            <div className="flex flex-col">
              {cart.map((item, index) => (
                <div
                  key={item.domainName}
                  className={`flex items-center gap-2 py-2 ${index === 0 ? "" : "border-t border-border"}`}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate text-[12.5px] font-medium ${item.unavailable ? "text-destructive line-through" : ""}`}>
                      {item.domainName}
                    </span>
                    {item.unavailable ? (
                      <span className="text-[10.5px] font-medium text-destructive">No longer available</span>
                    ) : (
                      <span className="text-[10.5px] tabular-nums text-muted-foreground">
                        {item.price === null ? "Price unavailable" : formatUSD(parsePrice(item.price))}
                        {item.renewPrice !== null ? ` · renews ${formatUSD(parsePrice(item.renewPrice))}` : ""}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(item.domainName)}
                    aria-label={`Remove ${item.domainName}`}
                    data-tip="Remove"
                    className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t border-border pt-2 text-[12px] font-medium">
              <span>Total today</span>
              <span className="tabular-nums">{formatUSD(cartTotal)}</span>
            </div>
            <button type="button" disabled={actionBusy} onClick={onRecheck} className={`${BTN_SUBTLE} h-7 self-start px-2 text-[11.5px]`}>
              {rechecking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Re-check prices
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SuggestionRow({
  suggestion,
  first,
  added,
  cartFull,
  onAdd,
}: {
  suggestion: ZapmailSuggestion;
  first: boolean;
  added: boolean;
  cartFull: boolean;
  onAdd: () => void;
}) {
  const kindTag =
    suggestion.kind !== null ? (
      <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
        {KIND_LABEL[suggestion.kind]}
      </span>
    ) : null;

  if (!suggestion.available) {
    return (
      <div className={`flex items-center gap-3 px-3 py-2.5 opacity-60 ${first ? "" : "border-t border-border"}`}>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-foreground">{suggestion.domainName}</span>
        {kindTag}
        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">Taken</span>
      </div>
    );
  }
  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40 ${first ? "" : "border-t border-border"}`}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium">{suggestion.domainName}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {suggestion.price === null ? "Price unavailable" : formatUSD(parsePrice(suggestion.price))}
          {suggestion.renewPrice !== null ? ` · renews ${formatUSD(parsePrice(suggestion.renewPrice))}` : ""}
        </span>
      </div>
      {kindTag}
      {suggestion.premium ? (
        <span className="shrink-0 rounded bg-warning-soft px-1.5 py-px text-[10px] font-semibold text-warning">Premium</span>
      ) : null}
      {added ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-success">
          <Check className="size-3" />
          Added
        </span>
      ) : (
        <button type="button" disabled={cartFull} onClick={onAdd} className={`${BTN_OUTLINE} h-7 shrink-0 px-2.5 text-[11.5px]`}>
          <Plus className="size-3" />
          Add
        </button>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Step 3 · Inboxes
   ══════════════════════════════════════════════════════════════════════ */
function InboxesStep({
  cart,
  rows,
  bulkFirst,
  bulkLast,
  bulkPattern,
  onBulkFirst,
  onBulkLast,
  onBulkPattern,
  onApplyBulk,
  onUpdateRow,
  onAddRow,
  onRemoveRow,
}: {
  cart: CartItem[];
  rows: Record<string, MailboxRow[]>;
  bulkFirst: string;
  bulkLast: string;
  bulkPattern: string;
  onBulkFirst: (value: string) => void;
  onBulkLast: (value: string) => void;
  onBulkPattern: (value: string) => void;
  onApplyBulk: () => void;
  onUpdateRow: (key: string, index: number, field: keyof MailboxRow, value: string) => void;
  onAddRow: (key: string) => void;
  onRemoveRow: (key: string, index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {/* Bulk fill */}
      <div className="flex flex-col gap-3 rounded-xl bg-surface p-3.5 shadow-xs">
        <SectionTitle title="Fill every inbox at once" hint="Rows rotate patterns so they differ" />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">First name</span>
            <input
              value={bulkFirst}
              onChange={(event) => onBulkFirst(event.target.value)}
              placeholder="Alex"
              className={`${INPUT_CLASS} w-36`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Last name</span>
            <input
              value={bulkLast}
              onChange={(event) => onBulkLast(event.target.value)}
              placeholder="Smith"
              className={`${INPUT_CLASS} w-36`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Username pattern</span>
            <BareSelect value={bulkPattern} onChange={onBulkPattern} ariaLabel="Username pattern">
              {USERNAME_PATTERNS.map((pattern) => (
                <option key={pattern.id} value={pattern.id}>
                  {pattern.label}
                </option>
              ))}
            </BareSelect>
          </label>
          <button type="button" onClick={onApplyBulk} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Apply to all
          </button>
        </div>
      </div>

      {/* Per-domain cards */}
      <div className="flex flex-col gap-4">
        {cart.map((item) => (
          <MailboxDomainCard
            key={item.domainName}
            domainName={item.domainName}
            rows={rows[domainKey(item.domainName)] ?? [emptyRow()]}
            onUpdateRow={(index, field, value) => onUpdateRow(domainKey(item.domainName), index, field, value)}
            onAddRow={() => onAddRow(domainKey(item.domainName))}
            onRemoveRow={(index) => onRemoveRow(domainKey(item.domainName), index)}
          />
        ))}
      </div>
    </div>
  );
}

function MailboxDomainCard({
  domainName,
  rows,
  onUpdateRow,
  onAddRow,
  onRemoveRow,
}: {
  domainName: string;
  rows: MailboxRow[];
  onUpdateRow: (index: number, field: keyof MailboxRow, value: string) => void;
  onAddRow: () => void;
  onRemoveRow: (index: number) => void;
}) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const u = row.username.trim().toLowerCase();
    if (u) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  const validCount = validRows(rows).length;

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-surface p-3.5 shadow-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{domainName}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {validCount} of {rows.length} {rows.length === 1 ? "row" : "rows"} ready
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const username = row.username.trim().toLowerCase();
          const duplicate = username.length > 0 && (counts.get(username) ?? 0) > 1;
          const badUsername = row.username.trim().length > 0 && !isValidUsername(username);
          const error = duplicate ? "Duplicate username on this domain" : badUsername ? "Start and end alphanumeric, no doubled . _ -" : null;
          return (
            <div key={index} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={row.firstName}
                  onChange={(event) => onUpdateRow(index, "firstName", event.target.value)}
                  placeholder="First"
                  aria-label="First name"
                  className={`${INPUT_CLASS} w-28`}
                />
                <input
                  value={row.lastName}
                  onChange={(event) => onUpdateRow(index, "lastName", event.target.value)}
                  placeholder="Last"
                  aria-label="Last name"
                  className={`${INPUT_CLASS} w-28`}
                />
                <input
                  value={row.username}
                  onChange={(event) => onUpdateRow(index, "username", event.target.value)}
                  placeholder="username"
                  aria-label="Username"
                  className={`${MONO_INPUT_CLASS} w-36 ${error ? "border-destructive/60" : ""}`}
                />
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
                  {username || "username"}@{domainName}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveRow(index)}
                  aria-label="Remove inbox row"
                  data-tip="Remove row"
                  className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {error ? <span className="pl-1 text-[11px] text-destructive">{error}</span> : null}
            </div>
          );
        })}
      </div>
      {rows.length < 5 ? (
        <button type="button" onClick={onAddRow} className={`${BTN_SUBTLE} h-7 self-start px-2 text-[11.5px]`}>
          <Plus className="size-3" />
          Add inbox
        </button>
      ) : (
        <span className="text-[10.5px] text-muted-foreground">Up to 5 inboxes per domain</span>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Step 4 · Profile image (optional)
   ══════════════════════════════════════════════════════════════════════ */
const AVATAR_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

function ImagePicker({
  url,
  onChange,
  compact = false,
}: {
  url: string | null;
  onChange: (url: string | null) => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = compact ? "size-14" : "size-28";

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!AVATAR_MIME.has(file.type)) {
      setError("Use a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Keep the image under 2 MB.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const data = new FormData();
      data.append("file", file);
      const result = await uploadZapmailAvatarAction(data);
      if (result.ok && result.url) onChange(result.url);
      else setError(result.ok ? "The upload did not return an image URL." : result.message);
    } catch {
      setError("Could not upload the image.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Choose a profile image"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      {url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Profile image preview" className={`${box} shrink-0 rounded-full border border-border object-cover`} />
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={uploading} onClick={() => inputRef.current?.click()} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
              {uploading ? <Loader2 className="size-3 animate-spin" /> : null}
              Replace
            </button>
            <button type="button" onClick={() => onChange(null)} className={`${BTN_SUBTLE} h-7 px-2.5 text-[11.5px]`}>
              Remove
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          aria-label="Upload a profile image"
          data-tip={compact ? "Upload image" : undefined}
          className={`${box} flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          {!compact ? <span className="text-[10.5px] font-medium">{uploading ? "Uploading…" : "Upload image"}</span> : null}
        </button>
      )}
      {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
    </div>
  );
}

function ImageStep({ avatarUrl, onAvatarUrl }: { avatarUrl: string | null; onAvatarUrl: (url: string | null) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle title="Profile image" hint="Optional" />
      <div className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-xs">
        <ImagePicker url={avatarUrl} onChange={onAvatarUrl} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Applied to every inbox in this purchase. You can change pictures later. PNG, JPEG, or WebP, up to 2 MB.
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Step 5 · Review and buy
   ══════════════════════════════════════════════════════════════════════ */
function ReviewStep({
  provider,
  cart,
  cartTotal,
  rows,
  plannedCount,
  avatarUrl,
  warmupDays,
  onWarmupDays,
  walletBalance,
  walletShort,
  shortfall,
  summary,
  slotsShort,
  slotsDeficit,
  subscriptions,
  started,
  actionBusy,
  actionKey,
  onTopUp,
  onRefresh,
  onBuyAddon,
  onStartSubscription,
}: {
  provider: Provider;
  cart: CartItem[];
  cartTotal: number;
  rows: Record<string, MailboxRow[]>;
  plannedCount: number;
  avatarUrl: string | null;
  warmupDays: WarmupPeriodDays;
  onWarmupDays: (days: WarmupPeriodDays) => void;
  walletBalance: number;
  walletShort: boolean;
  shortfall: number;
  summary: ZapmailMailboxSummary | null;
  slotsShort: boolean;
  slotsDeficit: number;
  subscriptions: ZapmailSubscription[];
  started: boolean;
  actionBusy: boolean;
  actionKey: string | null;
  onTopUp: () => void;
  onRefresh: () => void;
  onBuyAddon: () => void;
  onStartSubscription: (plan: "Starter" | "Growth" | "Pro", cycle: string) => void;
}) {
  const available = summary?.available ?? 0;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 xl:grid-cols-2">
        {/* Domains + total */}
        <div className="flex flex-col gap-2 rounded-xl bg-surface p-3.5 shadow-xs">
          <SectionTitle title="Domains" hint={PROVIDER_LABEL[provider]} />
          <div className="flex flex-col gap-1.5">
            {cart.map((item) => (
              <div key={item.domainName} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-medium">{item.domainName}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatUSD(parsePrice(item.price))}/yr</span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-border pt-2 text-[12px] font-semibold">
              <span>Total today</span>
              <span className="tabular-nums">{formatUSD(cartTotal)}</span>
            </div>
          </div>
        </div>

        {/* Inboxes + image */}
        <div className="flex flex-col gap-2 rounded-xl bg-surface p-3.5 shadow-xs">
          <SectionTitle title="Inboxes" hint={`${plannedCount} total`} />
          <div className="flex flex-col gap-1.5">
            {cart.map((item) => {
              const n = validRows(rows[domainKey(item.domainName)] ?? []).length;
              return (
                <div key={item.domainName} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-medium">{item.domainName}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {n} {n === 1 ? "inbox" : "inboxes"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex items-center gap-2 border-t border-border pt-2 text-[12px]">
            <span className="text-muted-foreground">Profile image</span>
            {avatarUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={avatarUrl} alt="Profile image thumbnail" className="size-6 rounded-full border border-border object-cover" />
                <span className="text-[11px] text-muted-foreground">applied to every inbox</span>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">None</span>
            )}
          </div>
        </div>
      </div>

      {/* Warmup window */}
      <div className="flex flex-col gap-2 rounded-xl bg-surface p-3.5 shadow-xs">
        <SectionTitle title="Warmup period" hint="before campaign use" />
        <div className="flex flex-wrap gap-1.5">
          {WARMUP_PERIOD_CHOICES.map((choice) => (
            <button
              key={choice.days}
              type="button"
              disabled={started}
              aria-pressed={warmupDays === choice.days}
              onClick={() => onWarmupDays(choice.days)}
              className={`h-7 rounded-md border px-2.5 text-[11.5px] font-medium transition-colors ${
                warmupDays === choice.days
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-surface text-foreground hover:bg-muted/60"
              }`}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          After the inboxes land in Smartlead they keep warming for this long before counting as campaign-ready.
          You&apos;ll get a Slack ping when the batch finishes its window.
        </p>
      </div>

      {/* Money + slot facts */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-subtle/60 px-4 py-3">
        <p className="text-[13px] font-medium">
          Wallet: <span className="tabular-nums">{formatUSD(walletBalance)}</span>
          <span className="font-normal text-muted-foreground"> against a total of </span>
          <span className="tabular-nums">{formatUSD(cartTotal)}</span>
        </p>
        <p className="text-[11.5px] text-muted-foreground">
          {summary
            ? `${plannedCount} ${plannedCount === 1 ? "inbox" : "inboxes"} requested · ${available} mailbox ${available === 1 ? "slot" : "slots"} free`
            : "Mailbox quota unavailable right now."}
        </p>
      </div>

      {!started && walletShort ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5">
          <p className="text-[11.5px] leading-relaxed text-warning">
            Your wallet is short by {formatUSD(shortfall)}. Top up, then re-check the balance to unlock the purchase.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={actionBusy} onClick={onTopUp} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
              {actionBusy && actionKey === "topup" ? <Loader2 className="size-3 animate-spin" /> : <Wallet className="size-3" />}
              Top up
            </button>
            <button type="button" disabled={actionBusy} onClick={onRefresh} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
              {actionBusy && actionKey === "refresh" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Re-check balance
            </button>
          </div>
        </div>
      ) : null}

      {!started && slotsShort ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5">
          <p className="text-[11.5px] leading-relaxed text-warning">
            This purchase needs {plannedCount} mailbox {plannedCount === 1 ? "slot" : "slots"} but only {available}{" "}
            {available === 1 ? "is" : "are"} free. Buy add-on slots or remove inbox rows, then refresh.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={actionBusy} onClick={onBuyAddon} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
              {actionBusy && actionKey === "addon" ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              Buy {slotsDeficit} add-on {slotsDeficit === 1 ? "mailbox" : "mailboxes"}
            </button>
            {subscriptions.length === 0 ? (
              <SubscriptionInline onStart={onStartSubscription} busy={actionBusy && actionKey === "subscribe"} disabled={actionBusy} />
            ) : null}
            <button type="button" disabled={actionBusy} onClick={onRefresh} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
              {actionBusy && actionKey === "refresh" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Refresh
            </button>
          </div>
          <p className="text-[10.5px] text-muted-foreground">After paying in the Zapmail tab, come back and refresh.</p>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Step 5 · Progress checklist (replaces the footer once buying starts)
   ══════════════════════════════════════════════════════════════════════ */
function ChecklistRow({
  status,
  label,
  children,
}: {
  status: PhaseStatus;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {status === "active" ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : status === "done" ? (
            <span className="size-2 rounded-full bg-success" />
          ) : status === "error" ? (
            <span className="size-2 rounded-full bg-destructive" />
          ) : status === "info" ? (
            <Info className="size-3.5 text-warning" />
          ) : (
            <span className="size-2 rounded-full bg-border" />
          )}
        </span>
        <span className={`text-[12px] font-medium ${status === "todo" ? "text-muted-foreground" : "text-foreground"}`}>
          {label}
        </span>
      </div>
      {children ? <div className="flex flex-col gap-1.5 pl-[26px]">{children}</div> : null}
    </div>
  );
}

function ProgressChecklist({
  phases,
  phaseError,
  awaitingPayment,
  foundCount,
  domainCount,
  hasImage,
  imageNote,
  runBusy,
  onRetryBuy,
  onBackToDomains,
  onContinueAfterPayment,
  onRetryRegister,
  onRetryAssign,
  onRetryAssignViaZapmail,
  onRetryImage,
}: {
  phases: Record<PhaseKey, PhaseStatus>;
  phaseError: { phase: PhaseKey; message: string } | null;
  awaitingPayment: boolean;
  foundCount: number;
  domainCount: number;
  hasImage: boolean;
  imageNote: string | null;
  runBusy: boolean;
  onRetryBuy: () => void;
  onBackToDomains: () => void;
  onContinueAfterPayment: () => void;
  onRetryRegister: () => void;
  onRetryAssign: () => void;
  onRetryAssignViaZapmail: () => void;
  onRetryImage: () => void;
}) {
  const errorFor = (phase: PhaseKey) => (phaseError?.phase === phase ? phaseError.message : null);
  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-xs">
      <div className="divide-y divide-border">
        <ChecklistRow status={awaitingPayment ? "active" : phases.buy} label="Buying domains">
          {awaitingPayment ? (
            <>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                Complete payment in the Zapmail tab, then continue.
              </span>
              <button type="button" disabled={runBusy} onClick={onContinueAfterPayment} className={`${BTN_OUTLINE} h-7 self-start px-2.5 text-[11.5px]`}>
                Continue after payment
              </button>
            </>
          ) : null}
          {errorFor("buy") ? (
            <>
              <span className="text-[11px] leading-relaxed text-destructive">{errorFor("buy")}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" disabled={runBusy} onClick={onRetryBuy} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
                  <RefreshCw className="size-3" />
                  Retry
                </button>
                <button type="button" disabled={runBusy} onClick={onBackToDomains} className={`${BTN_SUBTLE} h-7 px-2.5 text-[11.5px]`}>
                  Back to domains
                </button>
              </div>
            </>
          ) : null}
        </ChecklistRow>

        <ChecklistRow status={phases.register} label="Waiting for domains to register">
          {phases.register === "active" || phases.register === "error" ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {foundCount} of {domainCount} found
            </span>
          ) : null}
          {errorFor("register") ? (
            <>
              <span className="text-[11px] leading-relaxed text-destructive">{errorFor("register")}</span>
              <button type="button" disabled={runBusy} onClick={onRetryRegister} className={`${BTN_OUTLINE} h-7 self-start px-2.5 text-[11.5px]`}>
                <RefreshCw className="size-3" />
                Retry
              </button>
            </>
          ) : null}
        </ChecklistRow>

        <ChecklistRow status={phases.assign} label="Creating inboxes">
          {errorFor("assign") ? (
            <>
              <span className="text-[11px] leading-relaxed text-destructive">{errorFor("assign")}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" disabled={runBusy} onClick={onRetryAssign} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
                  <RefreshCw className="size-3" />
                  Retry
                </button>
                <button type="button" disabled={runBusy} onClick={onRetryAssignViaZapmail} className={`${BTN_SUBTLE} h-7 px-2.5 text-[11.5px]`}>
                  Retry failed at Zapmail
                </button>
              </div>
            </>
          ) : null}
        </ChecklistRow>

        {hasImage ? (
          <ChecklistRow status={phases.image} label="Applying profile image">
            {imageNote && phases.image === "info" ? (
              <span className="text-[11px] leading-relaxed text-muted-foreground">{imageNote}</span>
            ) : null}
            {errorFor("image") ? (
              <>
                <span className="text-[11px] leading-relaxed text-destructive">{errorFor("image")}</span>
                <button type="button" disabled={runBusy} onClick={onRetryImage} className={`${BTN_OUTLINE} h-7 self-start px-2.5 text-[11.5px]`}>
                  <RefreshCw className="size-3" />
                  Retry
                </button>
              </>
            ) : null}
          </ChecklistRow>
        ) : null}

        <ChecklistRow status={phases.done} label="Done" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Step 5 · Done: provisioning status + Smartlead export
   ══════════════════════════════════════════════════════════════════════ */
function DoneSection({
  provider,
  cart,
  provisionBoxes,
  matchedByEmail,
  imageNote,
  onOpenInventory,
  hasFailed,
  onRetryFailed,
  retrying,
  activeCount,
  exportAccounts,
  onExport,
  exporting,
  exportEmail,
  exportPassword,
  onExportEmail,
  onExportPassword,
  onAddAccountAndExport,
  addingAccount,
  exportId,
  exportPhase,
  exportStatus,
}: {
  provider: Provider;
  cart: CartItem[];
  provisionBoxes: ProvisionBox[];
  matchedByEmail: Map<string, ZapmailMailbox>;
  imageNote: string | null;
  onOpenInventory: () => void;
  hasFailed: boolean;
  onRetryFailed: () => void;
  retrying: boolean;
  activeCount: number;
  exportAccounts: ZapmailThirdPartyAccount[];
  onExport: (thirdPartyAccountId?: string) => void;
  exporting: boolean;
  exportEmail: string;
  exportPassword: string;
  onExportEmail: (value: string) => void;
  onExportPassword: (value: string) => void;
  onAddAccountAndExport: () => void;
  addingAccount: boolean;
  exportId: number | null;
  exportPhase: ExportPhase;
  exportStatus: { status: string | null; failureReason: string | null } | null;
}) {
  // Derived default: the first account wins until the user explicitly picks;
  // no effect needed when accounts stream in after mount.
  const [pickedAccount, setPickedAccount] = useState("");
  const selectedAccount = pickedAccount || (exportAccounts[0]?.id ?? "");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success-soft px-3 py-2.5 text-[11.5px] leading-relaxed text-success">
        <Check className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Bought {cart.length} {cart.length === 1 ? "domain" : "domains"} and scheduled {provisionBoxes.length}{" "}
          {provisionBoxes.length === 1 ? "inbox" : "inboxes"} on {PROVIDER_LABEL[provider]}.
        </span>
      </div>

      {imageNote ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-subtle/60 px-3 py-2.5 text-[11.5px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{imageNote}</span>
          <button type="button" onClick={onOpenInventory} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
            Open mailbox list
          </button>
        </div>
      ) : null}

      {/* Provisioning table */}
      <div className="flex flex-col gap-2 rounded-xl bg-surface p-3.5 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle title="Provisioning" hint={`${activeCount} of ${provisionBoxes.length} active`} />
          {hasFailed ? (
            <button type="button" disabled={retrying} onClick={onRetryFailed} className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}>
              {retrying ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Retry failed
            </button>
          ) : null}
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          {provisionBoxes.map((box, index) => {
            const matched = matchedByEmail.get(box.email.toLowerCase());
            const status = classifyStatus(matched?.status ?? null);
            const chip = matched ? STATUS_CHIP[status] : { label: "Waiting", cls: "bg-muted text-muted-foreground" };
            return (
              <div key={box.email} className={`flex items-center gap-3 px-3 py-2 ${index === 0 ? "" : "border-t border-border"}`}>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{box.email}</span>
                <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${chip.cls}`}>{chip.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Export card */}
      <div className="flex flex-col gap-3 rounded-xl bg-surface p-3.5 shadow-xs">
        <SectionTitle title="Send to Smartlead" hint={`${activeCount} active ready`} />

        {exportPhase === "completed" ? (
          <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success-soft px-3 py-2.5 text-[11.5px] leading-relaxed text-success">
            <Check className="mt-0.5 size-3.5 shrink-0" />
            <span>Mailboxes are on their way to Smartlead. They&rsquo;ll appear in Inboxes here once connected.</span>
          </div>
        ) : exportId !== null ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-subtle/60 px-3 py-2.5 text-[11.5px]">
            {exportPhase === "failed" ? (
              <>
                <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                <span className="text-destructive">
                  Export failed{exportStatus?.failureReason ? `: ${exportStatus.failureReason}` : ""}.
                </span>
              </>
            ) : (
              <>
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">
                  Export in progress{exportStatus?.status ? ` (${exportStatus.status.toLowerCase()})` : ""}…
                </span>
              </>
            )}
          </div>
        ) : exportAccounts.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Smartlead account</span>
              <BareSelect value={selectedAccount} onChange={setPickedAccount} ariaLabel="Smartlead account">
                {exportAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.email}
                  </option>
                ))}
              </BareSelect>
            </label>
            <button
              type="button"
              disabled={exporting || activeCount === 0}
              onClick={() => onExport(selectedAccount || undefined)}
              className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
              Export {activeCount} {activeCount === 1 ? "mailbox" : "mailboxes"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <input
                type="email"
                value={exportEmail}
                onChange={(event) => onExportEmail(event.target.value)}
                placeholder="you@smartlead-login.com"
                autoComplete="off"
                className={`${INPUT_CLASS} max-w-[240px]`}
              />
              <input
                type="password"
                value={exportPassword}
                onChange={(event) => onExportPassword(event.target.value)}
                placeholder="Smartlead password"
                autoComplete="off"
                className={`${INPUT_CLASS} max-w-[200px]`}
              />
              <button
                type="button"
                disabled={addingAccount || !exportEmail.trim() || !exportPassword}
                onClick={onAddAccountAndExport}
                className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
              >
                {addingAccount ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Add & export
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Your Smartlead login is sent to Zapmail to authorize the export. This app never stores it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Inventory: owned domains + mailbox list with an Apply-image bulk action
   ══════════════════════════════════════════════════════════════════════ */
function InventoryView({
  ownedDomains,
  mailboxes,
  onToast,
  onRefresh,
  refreshing,
}: {
  ownedDomains: ZapmailOwnedDomain[];
  mailboxes: ZapmailMailbox[];
  onToast: (ok: boolean, text: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const tooMany = selected.size > 100;
  const allSelected = mailboxes.length > 0 && selected.size === mailboxes.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(mailboxes.map((m) => m.id)));

  const applyImage = async () => {
    if (!imageUrl || selected.size === 0 || tooMany || applying) return;
    // Zapmail 500s on an image update to a non-active mailbox, so only send the
    // active ones and tell the operator how many were skipped.
    const activeIds = mailboxes.filter((m) => selected.has(m.id) && classifyStatus(m.status) === "active").map((m) => m.id);
    const skipped = selected.size - activeIds.length;
    if (activeIds.length === 0) {
      onToast(false, "Those inboxes are not active yet - Zapmail can only set the image once an inbox is active.");
      return;
    }
    setApplying(true);
    try {
      const result = await updateZapmailMailboxesAction(activeIds.map((mailboxId) => ({ mailboxId, profilePicture: imageUrl })));
      onToast(
        result.ok,
        result.ok
          ? `Image queued for ${activeIds.length} ${activeIds.length === 1 ? "inbox" : "inboxes"}.${skipped ? ` ${skipped} skipped (not active yet).` : ""} Zapmail applies it shortly.`
          : result.message,
      );
      if (result.ok) setSelected(new Set());
    } catch {
      onToast(false, "Could not update the selected mailboxes.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Apply-image bulk action */}
      <div className="flex flex-col gap-3 rounded-xl bg-surface p-3.5 shadow-xs">
        <SectionTitle title="Apply a profile image" hint="Select inboxes below, then apply" />
        <div className="flex flex-wrap items-center gap-3">
          <ImagePicker url={imageUrl} onChange={setImageUrl} compact />
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {selected.size} {selected.size === 1 ? "inbox" : "inboxes"} selected
          </span>
          <button
            type="button"
            disabled={!imageUrl || selected.size === 0 || tooMany || applying}
            onClick={() => void applyImage()}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {applying ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Apply image
          </button>
        </div>
        {tooMany ? <span className="text-[11px] text-destructive">Select up to 100 inboxes at a time.</span> : null}
        <p className="text-[10.5px] text-muted-foreground">
          Zapmail rehosts the image and applies it in the background; it can take a little while to show.
        </p>
      </div>

      {/* Mailbox list */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle title="Mailboxes" hint={`${mailboxes.length} total`} />
          <div className="flex items-center gap-1.5">
            {mailboxes.length > 0 ? (
              <button type="button" onClick={toggleAll} className={`${BTN_SUBTLE} h-7 px-2 text-[11.5px]`}>
                {allSelected ? "Clear selection" : "Select all"}
              </button>
            ) : null}
            <button type="button" disabled={refreshing} onClick={onRefresh} className={`${BTN_SUBTLE} h-7 px-2 text-[11.5px]`}>
              {refreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Refresh
            </button>
          </div>
        </div>
        {mailboxes.length === 0 ? (
          <p className="rounded-xl bg-surface px-3 py-4 text-[12px] text-muted-foreground shadow-xs">
            No mailboxes in Zapmail yet. They appear here once a purchase finishes provisioning.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl bg-surface shadow-xs">
            {mailboxes.map((mailbox, index) => {
              const status = classifyStatus(mailbox.status);
              const chip = STATUS_CHIP[status];
              return (
                <label
                  key={mailbox.id}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40 ${
                    index === 0 ? "" : "border-t border-border"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(mailbox.id)}
                    onChange={() => toggle(mailbox.id)}
                    className={`size-4 shrink-0 accent-[var(--primary)]`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{mailbox.email}</span>
                  <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                    {[mailbox.firstName, mailbox.lastName].filter(Boolean).join(" ")}
                  </span>
                  <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${chip.cls}`}>{chip.label}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Owned domains */}
      {ownedDomains.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionTitle title="Domains" hint={`${ownedDomains.length} owned`} />
          <div className="overflow-hidden rounded-xl bg-surface shadow-xs">
            {ownedDomains.map((domain, index) => (
              <div key={domain.id} className={`flex items-center gap-3 px-3 py-2 ${index === 0 ? "" : "border-t border-border"}`}>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{domain.domain}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {domain.assignedMailboxesCount} {domain.assignedMailboxesCount === 1 ? "mailbox" : "mailboxes"}
                </span>
                {domain.status ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium capitalize text-muted-foreground">
                    {domain.status.toLowerCase()}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
