"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AtSign, ChartNoAxesColumn, LogOut, Megaphone, MessagesSquare, Moon, PanelLeftClose, PanelLeftOpen, Radar, Settings, Sun, Table2, Users } from "lucide-react";
import { signOutAction } from "@/app/login/actions";
import { Avatar } from "./avatar";

/**
 * Collapse/expand the sidebar by toggling `si-rail` on <html> (applied
 * pre-paint by the root-layout script; all visuals are CSS-driven). The
 * "collapse" variant is visible only expanded, "expand" only collapsed —
 * the collapse instance also owns the global Ctrl/Cmd+B shortcut.
 */
export function SidebarToggle({ variant }: { variant: "collapse" | "expand" }) {
  const toggle = useCallback(() => {
    const collapsed = document.documentElement.classList.toggle("si-rail");
    try {
      localStorage.setItem("si-sidebar", collapsed ? "collapsed" : "expanded");
    } catch {
      // localStorage unavailable — state just won't persist
    }
  }, []);

  useEffect(() => {
    if (variant !== "collapse") return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, toggle]);

  const Icon = variant === "collapse" ? PanelLeftClose : PanelLeftOpen;
  return (
    <button
      type="button"
      onClick={toggle}
      data-tip={`${variant === "collapse" ? "Collapse" : "Expand"} sidebar (Ctrl+B)`}
      data-tip-down=""
      aria-label={`${variant === "collapse" ? "Collapse" : "Expand"} sidebar`}
      className={`${variant === "collapse" ? "rail-hide" : ""} flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
}

/**
 * Collapsed-rail expand affordance. Instead of a bare icon in the nav column
 * (which reads as just another tab), the brand tile itself becomes the expand
 * control: hovering or focusing the tile reveals a bordered PanelLeftOpen
 * button over the logo. The parent brand row must be `group relative`.
 * Ctrl/Cmd+B (owned by the collapse-variant SidebarToggle, which stays
 * mounted while hidden) keeps working in both states.
 */
export function RailExpandOverlay() {
  const expand = useCallback(() => {
    document.documentElement.classList.remove("si-rail");
    try {
      localStorage.setItem("si-sidebar", "expanded");
    } catch {
      // localStorage unavailable — state just won't persist
    }
  }, []);

  return (
    <button
      type="button"
      onClick={expand}
      aria-label="Expand sidebar"
      className="rail-only absolute inset-0 z-10 items-center justify-center opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
    >
      <span data-tip="Expand sidebar (Ctrl+B)" data-tip-down="" className="flex size-8 items-center justify-center rounded-md border border-border bg-surface text-foreground shadow-xs">
        <PanelLeftOpen className="size-4" strokeWidth={1.75} />
      </span>
    </button>
  );
}

/**
 * Rail tooltips. The app's designed bubble lives in globals.css as [data-tip],
 * but the nav scrolls (overflow clips pseudo-tooltips) and a sidebar wants the
 * label to the *right* of the icon — so we reuse the same visual as a portalled
 * `.rail-tip` on <body>, escaping the clip. It only fires when the rail is
 * collapsed to icons; expanded, the label is already visible (mirrors the
 * data-tip convention of labelling only icon-only controls).
 */
function useRailTip() {
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);

  const show = (label: string, el: HTMLElement) => {
    clear();
    if (!document.documentElement.classList.contains("si-rail")) return;
    timer.current = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      setTip({ label, x: rect.right + 8, y: rect.top + rect.height / 2 });
    }, 300);
  };
  const hide = () => {
    clear();
    setTip(null);
  };

  const bind = (label: string) => ({
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => show(label, event.currentTarget),
    onMouseLeave: hide,
    onFocus: (event: React.FocusEvent<HTMLElement>) => show(label, event.currentTarget),
    onBlur: hide,
  });

  // Same inverse bubble as the app's [data-tip] tooltips, but portalled to
  // <body> and fixed-positioned so it escapes the scrolling nav's overflow clip
  // and flows to the right of the collapsed icon rail. Styles are inline (not a
  // globals.css class) so the bubble is fully self-contained.
  const tipNode =
    tip && typeof document !== "undefined"
      ? createPortal(
          <div
            role="tooltip"
            style={{
              position: "fixed",
              left: tip.x,
              top: tip.y,
              transform: "translateY(-50%)",
              zIndex: 60,
              padding: "4px 8px",
              borderRadius: 6,
              background: "var(--foreground)",
              color: "var(--background)",
              fontSize: 11,
              fontWeight: 500,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              boxShadow: "0 2px 8px rgb(0 0 0 / 0.12)",
            }}
          >
            {tip.label}
          </div>,
          document.body,
        )
      : null;

  return { bind, tipNode };
}

export function NavLinks({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  const { bind, tipNode } = useRailTip();

  const isInbox = pathname.startsWith("/inbox") && !pathname.startsWith("/inboxes");
  const isAnalytics = pathname.startsWith("/analytics");
  const isCampaigns = pathname.startsWith("/campaigns");
  const isEnrichment = pathname.startsWith("/enrichment");
  const isSignals = pathname.startsWith("/signals");
  const isLeads = pathname.startsWith("/leads");
  const isInboxes = pathname.startsWith("/inboxes");
  const isSettings = pathname.startsWith("/settings");

  const itemClass = (active: boolean) =>
    `rail-item relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${
      active
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    }`;

  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1.5">
      <div className="rail-hide px-2.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Workspace
      </div>

      <Link href="/inbox" aria-label="Inbox" {...bind("Inbox")} className={itemClass(isInbox)}>
        <MessagesSquare className="size-4 shrink-0" strokeWidth={isInbox ? 2.25 : 1.75} />
        <span className="rail-hide">Inbox</span>
        {pendingCount > 0 ? (
          <span className="rail-badge ml-auto rounded-full bg-muted px-1.5 text-[10px] font-semibold leading-[14px] text-foreground">
            {pendingCount}
          </span>
        ) : null}
      </Link>

      <Link href="/analytics" aria-label="Analytics" {...bind("Analytics")} className={itemClass(isAnalytics)}>
        <ChartNoAxesColumn className="size-4 shrink-0" strokeWidth={isAnalytics ? 2.25 : 1.75} />
        <span className="rail-hide">Analytics</span>
      </Link>

      <Link href="/campaigns" aria-label="Campaigns" {...bind("Campaigns")} className={itemClass(isCampaigns)}>
        <Megaphone className="size-4 shrink-0" strokeWidth={isCampaigns ? 2.25 : 1.75} />
        <span className="rail-hide">Campaigns</span>
      </Link>

      <Link href="/enrichment" aria-label="Enrichment" {...bind("Enrichment")} className={itemClass(isEnrichment)}>
        <Table2 className="size-4 shrink-0" strokeWidth={isEnrichment ? 2.25 : 1.75} />
        <span className="rail-hide">Enrichment</span>
      </Link>

      <Link href="/signals" aria-label="Signals" {...bind("Signals")} className={itemClass(isSignals)}>
        <Radar className="size-4 shrink-0" strokeWidth={isSignals ? 2.25 : 1.75} />
        <span className="rail-hide">Signals</span>
      </Link>

      <Link href="/leads" aria-label="Leads" {...bind("Leads")} className={itemClass(isLeads)}>
        <Users className="size-4 shrink-0" strokeWidth={isLeads ? 2.25 : 1.75} />
        <span className="rail-hide">Leads</span>
      </Link>

      <Link href="/inboxes" aria-label="Inboxes" {...bind("Inboxes")} className={itemClass(isInboxes)}>
        <AtSign className="size-4 shrink-0" strokeWidth={isInboxes ? 2.25 : 1.75} />
        <span className="rail-hide">Inboxes</span>
      </Link>

      <Link href="/settings" aria-label="Settings" {...bind("Settings")} className={itemClass(isSettings)}>
        <Settings className="size-4 shrink-0" strokeWidth={isSettings ? 2.25 : 1.75} />
        <span className="rail-hide">Settings</span>
      </Link>

      {tipNode}
    </nav>
  );
}

function subscribeTheme(onChange: () => void) {
  window.addEventListener("si-theme-change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener("si-theme-change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function ShellControls({ email, name }: { email: string; name: string | null }) {
  const [pending, startTransition] = useTransition();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  // Reflect the theme applied to <html> (set pre-paint) without setState-in-effect.
  const isDark = useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );

  const setTheme = (dark: boolean) => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("si-theme", dark ? "dark" : "light");
    } catch {
      // localStorage unavailable — theme just won't persist
    }
    window.dispatchEvent(new Event("si-theme-change"));
  };

  const initials =
    (name || email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";

  const displayName = name || email.split("@")[0];

  const segClass = (active: boolean) =>
    `flex h-[26px] flex-1 items-center justify-center rounded transition-colors ${
      active ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex flex-col gap-2.5 border-t border-border px-3 py-2.5">
      <div role="group" aria-label="Theme" className="theme-seg flex gap-0.5 rounded-md bg-muted/60 p-0.5">
        <button type="button" onClick={() => setTheme(false)} data-tip="Light" aria-label="Light" aria-pressed={!isDark} className={segClass(!isDark)}>
          <Sun className="size-3.5" />
        </button>
        <button type="button" onClick={() => setTheme(true)} data-tip="Dark" aria-label="Dark" aria-pressed={isDark} className={segClass(isDark)}>
          <Moon className="size-3.5" />
        </button>
      </div>

      <div className="user-row relative flex items-center gap-2">
        {confirmingSignOut ? (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 flex flex-col gap-2 rounded-lg border border-border bg-surface p-2.5 shadow-pop">
            <p className="text-[12px] font-medium leading-snug">Sign out?</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmingSignOut(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setConfirmingSignOut(false);
                }}
                className="flex h-7 flex-1 items-center justify-center rounded-md border border-border bg-surface text-[11.5px] font-medium text-foreground transition hover:bg-muted/60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => signOutAction())}
                className="flex h-7 flex-1 items-center justify-center rounded-md bg-destructive-soft text-[11.5px] font-medium text-destructive transition hover:opacity-85 disabled:opacity-50"
              >
                {pending ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        ) : null}
        <Avatar email={email} initials={initials} title={email} />
        <div className="rail-hide min-w-0 flex-1">
          <div className="truncate text-xs font-semibold tracking-tight">{displayName}</div>
          <div className="truncate text-[11px] text-muted-foreground">{email}</div>
        </div>
        <button
          type="button"
          data-tip="Sign out"
          aria-label="Sign out"
          disabled={pending}
          aria-expanded={confirmingSignOut}
          onClick={() => setConfirmingSignOut((prev) => !prev)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );
}
