"use client";

/* Settings → Usage: where AI spend comes from. Two classes of number, never
   mixed: the gateway's own billed meter (exact) and recorded-token estimates
   at list price. CLI runs show their tokens but cost no API money. */

import type { AiUsageOverview, UsageRow } from "@/lib/usage";

function usd(value: number | null, precise = false): string {
  if (value === null) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01 && !precise) return "<$0.01";
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function providerLabel(row: UsageRow): { text: string; tone: string } {
  if (row.isCli) return { text: "CLI · free", tone: "bg-muted text-muted-foreground" };
  if (row.provider === "gateway" || row.model.includes("/")) return { text: "Gateway", tone: "bg-accent text-accent-foreground" };
  return { text: "Direct API", tone: "bg-warning-soft text-warning" };
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface px-4 py-3.5 shadow-xs">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-[22px] font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="text-[11.5px] text-muted-foreground">{hint}</span>
    </div>
  );
}

function BreakdownTable({ rows }: { rows: UsageRow[] }) {
  if (rows.length === 0) {
    return <p className="px-1 py-3 text-[12.5px] text-muted-foreground">No recorded AI calls in this window.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl bg-surface shadow-xs">
      <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</th>
            <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Model</th>
            <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Route</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Calls</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tokens in</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tokens out</th>
            <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const badge = providerLabel(row);
            return (
              <tr key={index} className="border-b border-border/60 last:border-b-0">
                <td className="px-4 py-2">{row.source}</td>
                <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{row.model}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${badge.tone}`}>{badge.text}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{row.calls}</td>
                <td className="px-3 py-2 text-right tabular-nums">{tokens(row.inputTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{tokens(row.outputTokens)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">{row.isCli ? "free" : usd(row.estUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function UsageSection({ usage }: { usage: AiUsageOverview | null }) {
  if (!usage) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Usage</h2>
        <p className="text-[12.5px] text-muted-foreground">Usage data could not be loaded. Reload the page to retry.</p>
      </div>
    );
  }

  const { gateway, window: win, allTime, windowDays, unmetered } = usage;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold tracking-tight">Usage</h2>
        <p className="max-w-2xl text-[12.5px] leading-relaxed text-muted-foreground">
          Where AI spend comes from. Gateway figures are exact, straight from Vercel&rsquo;s billing meter. Everything
          else is recorded tokens priced at the provider&rsquo;s current list rate, so treat those as close estimates.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Gateway balance"
          value={gateway ? usd(gateway.balanceUsd) : "—"}
          hint={gateway ? "Exact, live from Vercel" : "Gateway unreachable"}
        />
        <Tile
          label="Gateway spent"
          value={gateway ? usd(gateway.totalUsedUsd, true) : "—"}
          hint={gateway ? "Exact, all time" : "Gateway unreachable"}
        />
        <Tile label={`Est. spend, ${windowDays}d`} value={usd(win.estUsd)} hint="Recorded tokens × list price" />
        <Tile label={`CLI tokens, ${windowDays}d`} value={tokens(win.cliTokens)} hint="Local runs, no API cost" />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight">Last {windowDays} days</h3>
        <BreakdownTable rows={win.rows} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight">All time</h3>
        <BreakdownTable rows={allTime.rows} />
        <p className="text-[11.5px] text-muted-foreground">
          All-time estimate: <span className="font-medium tabular-nums text-foreground">{usd(allTime.estUsd)}</span> across{" "}
          <span className="tabular-nums">{tokens(allTime.inputTokens + allTime.outputTokens)}</span> tokens.
          {win.unpricedCalls > 0 || allTime.unpricedCalls > 0
            ? " Rows showing — have no known list price and are excluded from totals."
            : ""}
        </p>
      </div>

      {unmetered.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Not metered yet</span>
          {unmetered.map((item) => (
            <p key={item} className="text-[12px] text-muted-foreground">{item}</p>
          ))}
          <p className="text-[11.5px] text-muted-foreground/80">
            These call sites spend tokens that are not recorded per call, so they appear in the gateway&rsquo;s exact
            totals (once routed there) but not in the estimates above.
          </p>
        </div>
      ) : null}
    </div>
  );
}
