"use client";

/* Compact API/CLI runner switch shown in the header area of the Enrichment
   landing and the table view. For the operator: API bills per-token credits
   through the vendor's API; CLI runs the local Claude or Codex CLI on its
   subscription plan. Toggling swaps the provider FAMILY while preserving the
   vendor (anthropic-api <-> cli-claude, openai-api <-> cli-codex) and persists
   through the same runner-config store the ProspectSettingsDialog edits.
   On Vercel the CLI side is disabled: CLI providers cannot run there.

   This switch sets the MODE only. Which model each column runs on lives on the
   column itself (its API choice and its CLI choice), so the table always shows
   what will actually run - there is no workspace-wide default model to
   contradict it. */

import { useState } from "react";
import { setEnrichmentRunnerProviderAction } from "./actions";

const SEGMENT_BASE = `flex h-6 items-center justify-center rounded px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50`;

export type RunnerToggleProvider = "anthropic-api" | "openai-api" | "gateway" | "cli-claude" | "cli-codex";

/* The minimal slice of the stored runner config the toggle needs. Threaded
   from the server pages (getEnrichmentRunnerConfig) so the control reflects
   the persisted state on first paint, without a client fetch. */
export type RunnerToggleConfig = {
  provider: RunnerToggleProvider;
};

type Family = "api" | "cli";

function familyOf(provider: RunnerToggleProvider): Family {
  return provider === "cli-claude" || provider === "cli-codex" ? "cli" : "api";
}

/* Same vendor, other family. The gateway is vendor-agnostic, so its CLI
   counterpart is the Claude CLI (toggling back lands on the Anthropic API).
   Both pickers here and in the settings dialog list the seeded catalog ids;
   any other gateway model is set with scripts/set-runner.ts. */
function siblingOf(provider: RunnerToggleProvider): RunnerToggleProvider {
  switch (provider) {
    case "anthropic-api":
      return "cli-claude";
    case "cli-claude":
      return "anthropic-api";
    case "openai-api":
      return "cli-codex";
    case "cli-codex":
      return "openai-api";
    case "gateway":
      return "cli-claude";
  }
}

export function RunnerToggle({
  config,
  isVercel,
  showToast,
  onSwitched,
}: {
  config: RunnerToggleConfig;
  isVercel: boolean;
  showToast: (ok: boolean, text: string) => void;
  onSwitched?: (provider: RunnerToggleProvider) => void;
}) {
  // Optimistic provider/model; the props stay the persisted truth between edits.
  const [provider, setProvider] = useState<RunnerToggleProvider>(config.provider);
  const [pending, setPending] = useState(false);
  // Adjust-during-render prop sync (host idiom, no effect): a fresh config
  // prop (dialog save, server refresh) re-seeds unless an edit is in flight.
  const [prevConfig, setPrevConfig] = useState<RunnerToggleConfig>(config);
  if (config !== prevConfig) {
    setPrevConfig(config);
    if (!pending) {
      setProvider(config.provider);
    }
  }

  const family = familyOf(provider);

  const switchFamily = async (next: Family) => {
    if (pending || next === family) return;
    const previous = provider;
    const target = siblingOf(previous);
    setProvider(target); // optimistic
    setPending(true);
    try {
      const result = await setEnrichmentRunnerProviderAction(target);
      if (result.ok) {
        onSwitched?.(target);
        showToast(true, result.message || "Runner switched.");
      } else {
        setProvider(previous);
        showToast(false, result.message || "Could not switch the runner.");
      }
    } catch (error) {
      setProvider(previous);
      showToast(
        false,
        error instanceof Error && error.message ? error.message : "Could not switch the runner.",
      );
    } finally {
      setPending(false);
    }
  };


  return (
    <div className="flex shrink-0 items-center gap-2">
      <div
        role="group"
        aria-label="Enrichment runner"
        data-tip="API bills per-token credits; CLI runs on your local CLI subscription plan."
        data-tip-down=""
        className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-xs has-[[data-tip]:hover]:after:hidden"
      >
        <button
          type="button"
          aria-pressed={family === "api"}
          disabled={pending}
          onClick={() => void switchFamily("api")}
          className={`${SEGMENT_BASE} ${
            family === "api" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          API
        </button>
        <button
          type="button"
          aria-pressed={family === "cli"}
          disabled={pending || isVercel}
          data-tip={isVercel ? "Only available locally." : undefined}
          data-tip-down={isVercel ? "" : undefined}
          onClick={() => void switchFamily("cli")}
          className={`${SEGMENT_BASE} ${
            family === "cli" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          CLI
        </button>
      </div>
    </div>
  );
}
