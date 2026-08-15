"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Mail, MessageSquare, Plus, Send, Trash2 } from "lucide-react";
import type { ReplyCategory } from "@/lib/taxonomy";
import type {
  ActionResult,
  EmailTransportStatus,
  NotificationChannel,
  NotificationDelivery,
} from "@/lib/types";
import {
  createNotificationChannelAction,
  deleteChannelAction,
  sendTestNotificationAction,
  setChannelEnabledAction,
} from "./actions";
import { useToast } from "../toast";

const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";

/* 10px uppercase sub-label over a chip group (settings form grammar). */
const SUBLABEL_CLASS = "text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

// Displayed times use the workspace timezone/locale (threaded from settings),
// pinned so server and client render identical strings (no hydration mismatch).
function deliveryTime(iso: string, timeZone: string, timeLocale: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(timeLocale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

function categoriesSummary(categories: string[] | null, labelByValue: Map<string, string>) {
  if (!categories || categories.length === 0) return "All replies";
  const labels = categories.map((value) => labelByValue.get(value) ?? value);
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

function campaignsSummary(campaignIds: string[] | null | undefined) {
  if (!campaignIds || campaignIds.length === 0) return "All campaigns";
  return campaignIds.length === 1 ? "1 campaign" : `${campaignIds.length} campaigns`;
}

// Rows may carry a per-channel campaign scope (backend adds `campaign_ids`);
// modelled locally as an optional field so it reads cleanly before/after the
// column lands.
type ScopedChannel = NotificationChannel & { campaign_ids?: string[] | null };

type Props = {
  channels: ScopedChannel[];
  deliveries: NotificationDelivery[];
  emailStatus: EmailTransportStatus;
  categories: ReplyCategory[];
  campaigns: { id: string; name: string }[];
  timeZone: string;
  timeLocale: string;
};

export function NotificationsClient({
  channels,
  deliveries,
  emailStatus,
  categories,
  campaigns,
  timeZone,
  timeLocale,
}: Props) {
  const [pending, startTransition] = useTransition();

  const categoryLabels = useMemo(
    () => new Map(categories.map((category) => [category.value, category.label])),
    [categories],
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  // Add-channel form
  const [channelType, setChannelType] = useState<"email" | "slack">("email");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [allCategories, setAllCategories] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allCampaigns, setAllCampaigns] = useState(true);
  const [selectedCampaigns, setSelectedCampaigns] = useState<Set<string>>(new Set());

  const showToast = useToast();

  const run = (id: string | null, action: () => Promise<ActionResult>) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      showToast(result.ok, result.message);
      setBusyId(null);
    });
  };

  const toggleCategory = (value: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const toggleCampaign = (id: string) => {
    setSelectedCampaigns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitAdd = () => {
    run(null, async () => {
      const result = await createNotificationChannelAction({
        channelType,
        target,
        label,
        categories: allCategories ? null : [...selected],
        campaignIds: allCampaigns ? null : [...selectedCampaigns],
      });
      if (result.ok) {
        setTarget("");
        setLabel("");
        setAllCategories(true);
        setSelected(new Set());
        setAllCampaigns(true);
        setSelectedCampaigns(new Set());
      }
      return result;
    });
  };

  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const emailChannelWanted = channelType === "email" || channels.some((c) => c.channel_type === "email");

  /* Selection chips (app chip idiom: h-6, rounded-md border, aria-pressed). */
  const chipClass = (active: boolean) =>
    `flex h-6 items-center rounded-md border px-2 text-[11px] font-medium transition ${
      active
        ? "border-transparent bg-accent text-accent-foreground"
        : "border-border bg-surface text-muted-foreground hover:text-foreground"
    }`;

  return (
    <section className="flex max-w-3xl flex-col gap-5">
      {/* The settings nav already names the section; a single muted line is
          all the framing this pane needs. One readable column: the channel
          list, then the add-channel form, so it never looks lopsided. */}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Send an email or a Slack message when a reply is categorized, scoped to the categories and
        campaigns you choose.
      </p>

      {!emailStatus.configured && emailChannelWanted ? (
        <div className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0">
            Email notifications are not configured on the server yet: {emailStatus.reason} Slack
            channels work without this.
          </span>
        </div>
      ) : null}

      {/* ── Channels ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight">Channels</h3>

            {channels.length > 0 ? (
              <div className="flex flex-col gap-2">
                {channels.map((channel) => {
                  const Icon = channel.channel_type === "email" ? Mail : MessageSquare;
                  const busy = pending && busyId === channel.id;
                  return (
                    <div
                      key={channel.id}
                      className={`flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5 shadow-xs ${
                        channel.enabled ? "" : "opacity-60"
                      }`}
                    >
                      <span
                        aria-hidden
                        data-tip={channel.channel_type === "email" ? "Email" : "Slack"}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground"
                      >
                        <Icon className="size-4" strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="min-w-0 truncate text-[12px] font-medium">{channel.target}</span>
                          {channel.label ? (
                            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                              {channel.label}
                            </span>
                          ) : null}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {categoriesSummary(channel.categories, categoryLabels)}
                          {" · "}
                          {campaignsSummary(channel.campaign_ids)}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(channel.id, () => sendTestNotificationAction(channel.id))}
                        className={`${BTN_OUTLINE} h-7 px-2 text-[11.5px]`}
                      >
                        <Send className="size-3" />
                        Test
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={channel.enabled}
                        data-tip={channel.enabled ? "Pause channel" : "Enable channel"}
                        aria-label={channel.enabled ? "Pause channel" : "Enable channel"}
                        disabled={busy}
                        onClick={() => run(channel.id, () => setChannelEnabledAction(channel.id, !channel.enabled))}
                        className={`relative h-[18px] w-8 shrink-0 rounded-full transition disabled:opacity-50 ${
                          channel.enabled ? "bg-primary" : "bg-muted"
                        }`}
                      >
                        <span
                          className={`absolute top-[2px] size-[14px] rounded-full bg-surface shadow-xs transition-all ${
                            channel.enabled ? "left-[16px]" : "left-[2px]"
                          }`}
                        />
                      </button>
                      <button
                        type="button"
                        data-tip="Remove channel"
                        aria-label="Remove channel"
                        disabled={busy}
                        onClick={() => run(channel.id, () => deleteChannelAction(channel.id))}
                        className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:opacity-50`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-[11.5px] text-muted-foreground">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                No channels yet. Add your first one below.
              </div>
            )}
          </div>

          {deliveries.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-semibold tracking-tight">Recent deliveries</h3>
              <div className="overflow-hidden rounded-xl border border-border shadow-xs">
                {deliveries.map((delivery, index) => {
                  const channel = channelById.get(delivery.channel_id);
                  return (
                    <div
                      key={delivery.id}
                      className={`flex items-center gap-2.5 bg-surface px-3 py-2 text-[11.5px] ${
                        index > 0 ? "border-t border-border" : ""
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          delivery.status === "sent" ? "bg-success" : "bg-destructive"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">
                          {channel ? channel.label || channel.target : "Removed channel"}
                        </span>
                        {delivery.kind === "test" ? (
                          <span className="ml-1.5 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">test</span>
                        ) : null}
                        {delivery.error ? (
                          <span className="ml-1.5 text-destructive">{delivery.error}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{deliveryTime(delivery.created_at, timeZone, timeLocale)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

      {/* ── Add a channel ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-xs">
        <h3 className="text-[13px] font-semibold tracking-tight">Add a channel</h3>

          <div
            role="group"
            aria-label="Channel type"
            className="inline-flex items-center gap-0.5 self-start rounded-md border border-border bg-muted/40 p-0.5"
          >
            {(["email", "slack"] as const).map((type) => {
              const active = channelType === type;
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setChannelType(type)}
                  className={`inline-flex h-7 min-w-[88px] items-center justify-center gap-1.5 rounded px-3 text-[11.5px] font-medium transition ${
                    active ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {type === "email" ? (
                    <Mail className="size-3.5" strokeWidth={1.75} />
                  ) : (
                    <MessageSquare className="size-3.5" strokeWidth={1.75} />
                  )}
                  {type === "email" ? "Email" : "Slack"}
                </button>
              );
            })}
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px]">
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={channelType === "email" ? "name@example.com" : "https://hooks.slack.com/services/…"}
              aria-label={channelType === "email" ? "Email address" : "Slack webhook URL"}
              className={INPUT_CLASS}
            />
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Label (optional)"
              aria-label="Channel label"
              maxLength={80}
              className={INPUT_CLASS}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={SUBLABEL_CLASS}>Categories</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-pressed={allCategories}
                onClick={() => setAllCategories(true)}
                className={chipClass(allCategories)}
              >
                All replies
              </button>
              {categories.map((category) => (
                <button
                  key={category.value}
                  type="button"
                  aria-pressed={!allCategories && selected.has(category.value)}
                  onClick={() => {
                    setAllCategories(false);
                    toggleCategory(category.value);
                  }}
                  className={chipClass(!allCategories && selected.has(category.value))}
                >
                  {category.label}
                </button>
              ))}
            </div>
          </div>

          {campaigns.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className={SUBLABEL_CLASS}>Campaigns</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={allCampaigns}
                  onClick={() => setAllCampaigns(true)}
                  className={chipClass(allCampaigns)}
                >
                  All campaigns
                </button>
                {campaigns.map((campaign) => (
                  <button
                    key={campaign.id}
                    type="button"
                    aria-pressed={!allCampaigns && selectedCampaigns.has(campaign.id)}
                    onClick={() => {
                      setAllCampaigns(false);
                      toggleCampaign(campaign.id);
                    }}
                    className={chipClass(!allCampaigns && selectedCampaigns.has(campaign.id))}
                  >
                    {campaign.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            disabled={
              pending ||
              !target.trim() ||
              (!allCategories && selected.size === 0) ||
              (!allCampaigns && selectedCampaigns.size === 0)
            }
            onClick={submitAdd}
            className={`${BTN_PRIMARY} h-8 self-end px-3 text-[12px]`}
          >
            <Plus className="size-3.5" />
            Add channel
          </button>
        </div>
    </section>
  );
}
