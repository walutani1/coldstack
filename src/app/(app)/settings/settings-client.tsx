"use client";

import { useEffect, useRef, useState, useTransition, type ChangeEvent, type ReactNode } from "react";
import Image from "next/image";
import {
  Bell,
  Bot,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronUp,
  Flame,
  Image as ImageIcon,
  Loader2,
  Lock,
  Magnet,
  Mail,
  MailCheck,
  Plug,
  Plus,
  PenLine,
  Rocket,
  Settings as SettingsIcon,
  ShieldAlert,
  Tags,
  Trash2,
  Users,
  Workflow,
  X,
} from "lucide-react";
import type { ReplyCategory, ReplySentimentType } from "@/lib/taxonomy";
import type { NotificationChannel, NotificationDelivery } from "@/lib/types";
import type { AiUsageOverview } from "@/lib/usage";
import { UsageSection } from "./usage-section";
import { NotificationsClient } from "../notifications/notifications-client";
import { Avatar } from "../avatar";
import { AnthropicMark, OpenAiMark } from "../brand-marks";
import {
  createCategoryAction,
  deleteCategoryAction,
  reorderCategoriesAction,
  updateAiSettingsAction,
  updateCategoryAction,
  updateIntegrationSettingsAction,
  setIntegrationSecretAction,
  clearIntegrationSecretAction,
  testSmartleadConnectionAction,
  listSmartleadCampaignsAction,
  registerSmartleadWebhookAction,
  updateWorkspaceSettingsAction,
  inviteMemberAction,
  setMemberActiveAction,
  uploadWorkspaceLogoAction,
  removeWorkspaceLogoAction,
  getInboxProvisioningAction,
  saveInboxProvisioningAction,
  applyForwardingToAllDomainsAction,
} from "./actions";
import { useToast } from "../toast";

/* A single paired writing sample: what the lead said (optional) + the reply
   you sent. The AI mimics the voice of these examples when drafting. */
export type StyleExample = { id: string; leadMessage: string; reply: string };

/* AI & Automation settings shape (mirrors the server-only `@/lib/settings-store`
   contract; declared locally so the client never imports the server module). */
export type AiSettings = {
  campaignContext: string;
  model: string | null;
  draftingEnabled: boolean;
  senderName: string;
  senderTitle: string;
  senderCompany: string;
  draftContext: string;
  styleExamples: StyleExample[];
  extraVoiceRules: string;
  signature: string;
  autoHandleOoo: boolean;
  autoHandleDeadMailbox: boolean;
  resumeBusinessDaysAfterReturn: number;
  resumeDefaultWaitDays: number;
  colleagueResearchEnabled: boolean;
  colleagueRolesHint: string;
};

/* Integrations settings + status shapes (mirror the server-only
   `@/lib/settings-store` / `@/lib/integration-status` contracts; declared
   locally so the client never imports a server module — same pattern as
   `AiSettings` above). */
type SecretName =
  | "smartlead_api_key"
  | "zapmail_api_key"
  | "resend_api_key"
  | "smtp_password"
  | "enrichment_anthropic_api_key"
  | "openai_api_key"
  | "apify_api_key"
  | "leadmagic_api_key"
  | "zerobounce_api_key"
  | "apollo_api_key"
  | "firecrawl_api_key"
  | "ai_gateway_api_key";
export type IntegrationSettings = {
  smartleadApiBaseUrl: string | null; // null = use server env default
  zapmailWorkspaceId: string; // "" = default workspace
  zapmailServiceProvider: "GOOGLE" | "MICROSOFT";
  emailProvider: "resend" | "smtp" | null; // null = auto-detect
  emailFrom: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean | null;
};
type EmailTransportStatus =
  | { configured: true; provider: "resend" | "smtp"; from: string; source: "app" | "env" | "mixed" }
  | { configured: false; reason: string; source: "app" | "env" | "mixed" };
export type IntegrationStatus = {
  encryptionAvailable: boolean;
  secrets: Record<SecretName, boolean>; // which secrets are set
  smartlead: { configured: boolean; source: "app" | "env" | "none"; baseUrl: string };
  zapmail: { configured: boolean; workspaceId: string | null; serviceProvider: "GOOGLE" | "MICROSOFT" };
  email: EmailTransportStatus;
};

/* Workspace + team shapes (mirror the server-only `@/lib/settings-store` /
   `@/lib/team` contracts; declared locally so the client never imports a
   server module — same pattern as `AiSettings` above). */
export type WorkspaceSettings = {
  workspaceName: string;
  tagline: string;
  timeZone: string;
  timeLocale: string;
};
export type TeamMember = {
  id: string;
  email: string;
  fullName: string | null;
  isActive: boolean;
  isSelf: boolean;
};

/* ── Shared style constants (copied conventions, intentionally not shared) ── */

const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const BTN_SUBTLE = `${BTN_BASE} bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground`;

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";
const SELECT_CLASS =
  "h-8 w-full appearance-none rounded-md border border-border bg-surface pl-2.5 pr-7 text-[12.5px] font-medium text-foreground shadow-xs outline-none transition focus:border-ring";

/* ── Taxonomy presentation ────────────────────────────────────────────── */
type ActionResult = { ok: boolean; message: string };

const COLOR_SLUGS = ["gray", "blue", "green", "amber", "red", "violet", "teal", "rose"] as const;
type ColorSlug = (typeof COLOR_SLUGS)[number];

// Static class literals so Tailwind's scanner emits these arbitrary values.
const COLOR_DOT: Record<ColorSlug, string> = {
  gray: "bg-[#9ca3af]",
  blue: "bg-[#3b82f6]",
  green: "bg-[#22c55e]",
  amber: "bg-[#f59e0b]",
  red: "bg-[#ef4444]",
  violet: "bg-[#8b5cf6]",
  teal: "bg-[#14b8a6]",
  rose: "bg-[#f43f5e]",
};

const SENTIMENT_TO_COLOR: Record<ReplySentimentType, ColorSlug> = {
  positive: "green",
  negative: "red",
  neutral: "gray",
};

function dotClass(color: string | null, sentiment: ReplySentimentType): string {
  const slug = (color && (COLOR_SLUGS as readonly string[]).includes(color)
    ? (color as ColorSlug)
    : SENTIMENT_TO_COLOR[sentiment]);
  return COLOR_DOT[slug];
}

const SENTIMENT_LABELS: Record<ReplySentimentType, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
};

const SENTIMENT_BADGE: Record<ReplySentimentType, string> = {
  positive: "bg-success-soft text-success",
  negative: "bg-destructive-soft text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

/* ── Left-rail section list (this phase ships only "categories") ───────── */
type SectionKey = "categories" | "ai" | "integrations" | "usage" | "workspace" | "notifications";

const SECTIONS: { key: SectionKey; label: string; icon: typeof Tags; ready: boolean }[] = [
  { key: "categories", label: "Reply categories", icon: Tags, ready: true },
  { key: "ai", label: "Reply defaults", icon: Bot, ready: true },
  { key: "integrations", label: "Integrations", icon: Plug, ready: true },
  { key: "usage", label: "Usage", icon: ChartNoAxesColumn, ready: true },
  { key: "notifications", label: "Notifications", icon: Bell, ready: true },
  { key: "workspace", label: "Workspace", icon: Users, ready: true },
];

type FormValues = {
  label: string;
  description: string;
  sentimentType: ReplySentimentType;
  color: string | null;
  suppress: boolean;
  dnc: boolean;
  draftReply: boolean;
  draftGuidance: string;
};

function emptyForm(): FormValues {
  return {
    label: "",
    description: "",
    sentimentType: "neutral",
    color: null,
    suppress: false,
    dnc: false,
    draftReply: false,
    draftGuidance: "",
  };
}

function formFrom(category: ReplyCategory): FormValues {
  return {
    label: category.label,
    description: category.description ?? "",
    sentimentType: category.sentimentType,
    color: category.color,
    suppress: category.suppress,
    dnc: category.dnc,
    draftReply: category.draftReply,
    draftGuidance: category.draftGuidance ?? "",
  };
}

/* ── Small toggle switch (notifications-client convention) ─────────────── */
function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full bg-surface shadow-xs transition-all ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

export function SettingsClient({
  categories,
  aiSettings,
  integrationSettings,
  integrationStatus,
  workspaceSettings,
  teamMembers,
  logoVersion,
  initialSection,
  notificationChannels,
  notificationDeliveries,
  notificationEmailStatus,
  notificationCategories,
  notificationCampaigns,
  aiUsage,
}: {
  categories: ReplyCategory[];
  aiSettings: AiSettings;
  integrationSettings: IntegrationSettings;
  integrationStatus: IntegrationStatus;
  workspaceSettings: WorkspaceSettings;
  teamMembers: TeamMember[];
  logoVersion: string | null;
  initialSection?: string;
  /* Notifications section data — threaded straight through to the unmodified
     <NotificationsClient>, which now lives inside the Notifications section. */
  notificationChannels: NotificationChannel[];
  notificationDeliveries: NotificationDelivery[];
  notificationEmailStatus: EmailTransportStatus;
  notificationCategories: ReplyCategory[];
  notificationCampaigns: { id: string; name: string }[];
  aiUsage: AiUsageOverview | null;
}) {
  const isSectionKey = (value: string | undefined): value is SectionKey =>
    value !== undefined && SECTIONS.some((s) => s.key === value);
  const [section, setSection] = useState<SectionKey>(
    isSectionKey(initialSection) ? initialSection : "categories",
  );

  // Optimistic local order; re-seeds whenever the server sends fresh data.
  const [items, setItems] = useState<ReplyCategory[]>(categories);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setItems(categories), [categories]);

  // null = no form open, "new" = create form, otherwise the id being edited.
  const [openForm, setOpenForm] = useState<string | "new" | null>(null);

  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const showToast = useToast();

  const run = (id: string | null, action: () => Promise<ActionResult>) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      showToast(result.ok, result.message);
      setBusyId(null);
    });
  };

  const buildInput = (values: FormValues) => ({
    label: values.label.trim(),
    description: values.description.trim() ? values.description.trim() : null,
    sentimentType: values.sentimentType,
    suppress: values.suppress,
    dnc: values.dnc,
    draftReply: values.draftReply,
    draftGuidance: values.draftReply && values.draftGuidance.trim() ? values.draftGuidance.trim() : null,
    color: values.color,
  });

  const submitForm = (mode: "new" | string, values: FormValues) => {
    const input = buildInput(values);
    run(mode === "new" ? "new" : mode, async () => {
      const result =
        mode === "new"
          ? await createCategoryAction(input)
          : await updateCategoryAction(mode, input);
      if (result.ok) setOpenForm(null);
      return result;
    });
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const prev = items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next); // optimistic
    run(next[index].id, async () => {
      const result = await reorderCategoriesAction(next.map((c) => c.id));
      // A failed reorder never revalidates, so roll the optimistic swap back.
      if (!result.ok) setItems(prev);
      return result;
    });
  };

  const toggleActive = (category: ReplyCategory) => {
    run(category.id, () => updateCategoryAction(category.id, { active: !category.active }));
  };

  const remove = (category: ReplyCategory) => {
    run(category.id, () => deleteCategoryAction(category.id));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <SettingsIcon className="size-4 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-[15px] font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1680px] gap-6 px-5 py-6 xl:gap-8 xl:px-8">
          {/* Section list — grows as later phases add sections */}
          <nav className="hidden w-48 shrink-0 flex-col gap-0.5 sm:flex" aria-label="Settings sections">
            {SECTIONS.map((item) => {
              const Icon = item.icon;
              const active = section === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={!item.ready}
                  onClick={() => item.ready && setSection(item.key)}
                  className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed ${
                    active
                      ? "bg-accent text-accent-foreground shadow-xs"
                      : item.ready
                        ? "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        : "text-muted-foreground/50"
                  }`}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
                  <span className="truncate">{item.label}</span>
                  {!item.ready ? (
                    <span className="ml-auto rounded bg-muted px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Soon
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1">
            {section === "categories" ? (
              <CategoriesSection
                items={items}
                openForm={openForm}
                setOpenForm={setOpenForm}
                pending={pending}
                busyId={busyId}
                onSubmit={submitForm}
                onMove={move}
                onToggleActive={toggleActive}
                onDelete={remove}
              />
            ) : section === "ai" ? (
              <AiSection
                settings={aiSettings}
                run={run}
                pending={pending}
                busyId={busyId}
              />
            ) : section === "integrations" ? (
              <IntegrationsSection
                settings={integrationSettings}
                status={integrationStatus}
                run={run}
                pending={pending}
                busyId={busyId}
              />
            ) : section === "usage" ? (
              <UsageSection usage={aiUsage} />
            ) : section === "notifications" ? (
              <section className="flex flex-col gap-4">
                {/* Heading lives here so NotificationsClient stays reusable;
                    same grammar as the other section headings. */}
                <h2 className="text-[14px] font-semibold tracking-tight">Notifications</h2>
                <NotificationsClient
                  channels={notificationChannels}
                  deliveries={notificationDeliveries}
                  emailStatus={notificationEmailStatus}
                  categories={notificationCategories}
                  campaigns={notificationCampaigns}
                  timeZone={workspaceSettings.timeZone}
                  timeLocale={workspaceSettings.timeLocale}
                />
              </section>
            ) : section === "workspace" ? (
              <>
                <WorkspaceSection
                  settings={workspaceSettings}
                  members={teamMembers}
                  logoVersion={logoVersion}
                  run={run}
                  pending={pending}
                  busyId={busyId}
                />
                <InboxProvisioningCard />
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-[12.5px] text-muted-foreground">
                This section is coming in a later phase.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Reply categories section ─────────────────────────────────────────── */
function CategoriesSection({
  items,
  openForm,
  setOpenForm,
  pending,
  busyId,
  onSubmit,
  onMove,
  onToggleActive,
  onDelete,
}: {
  items: ReplyCategory[];
  openForm: string | "new" | null;
  setOpenForm: (next: string | "new" | null) => void;
  pending: boolean;
  busyId: string | null;
  onSubmit: (mode: "new" | string, values: FormValues) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onToggleActive: (category: ReplyCategory) => void;
  onDelete: (category: ReplyCategory) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[14px] font-semibold tracking-tight">Reply categories</h2>
          <p className="max-w-4xl text-[12px] leading-relaxed text-muted-foreground">
            How Claude classifies each reply. Reorder to set priority, tune the guidance it reads, and
            control what happens to a sender when a category is chosen.
          </p>
        </div>
        <button
          type="button"
          disabled={pending || openForm === "new"}
          onClick={() => setOpenForm("new")}
          className={`${BTN_PRIMARY} h-8 shrink-0 px-3 text-[12px]`}
        >
          <Plus className="size-3.5" />
          Add category
        </button>
      </div>

      {openForm === "new" ? (
        <CategoryForm
          key="new"
          mode="new"
          initial={emptyForm()}
          pending={pending && busyId === "new"}
          disabled={pending}
          onCancel={() => setOpenForm(null)}
          onSubmit={(values) => onSubmit("new", values)}
        />
      ) : null}

      <div className="flex flex-col gap-2">
        {items.map((category, index) => {
          const busy = pending && busyId === category.id;
          const isEditing = openForm === category.id;
          return (
            <div
              key={category.id}
              className={`rounded-lg bg-surface ${category.active ? "" : "opacity-60"}`}
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                {/* Reorder chevrons */}
                <div className="flex flex-col">
                  <button
                    type="button"
                    data-tip="Move up"
                    aria-label={`Move ${category.label} up`}
                    disabled={pending || index === 0}
                    onClick={() => onMove(index, -1)}
                    className="flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    data-tip="Move down"
                    aria-label={`Move ${category.label} down`}
                    disabled={pending || index === items.length - 1}
                    onClick={() => onMove(index, 1)}
                    className="flex size-4 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                </div>

                <span
                  className={`size-2.5 shrink-0 rounded-full ${dotClass(category.color, category.sentimentType)}`}
                  aria-hidden
                />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12.5px] font-medium">{category.label}</span>
                    <span className="font-mono text-[10.5px] text-muted-foreground">{category.value}</span>
                    {category.systemRole ? (
                      <span
                        data-tip="System category that cannot be deleted"
                        className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
                      >
                        <Lock className="size-3" />
                        System
                      </span>
                    ) : null}
                    {!category.active ? (
                      <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                        Inactive
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={`rounded px-1.5 py-px text-[10px] font-medium ${SENTIMENT_BADGE[category.sentimentType]}`}>
                      {SENTIMENT_LABELS[category.sentimentType]}
                    </span>
                    {category.suppress ? <Chip>Suppress</Chip> : null}
                    {category.dnc ? <Chip>Block list</Chip> : null}
                    {category.draftReply ? <Chip>Drafts</Chip> : null}
                  </div>
                </div>

                {category.description ? (
                  <p className="hidden min-w-0 max-w-md shrink truncate self-center text-[11.5px] text-muted-foreground xl:block">
                    {category.description}
                  </p>
                ) : null}

                {/* Row controls */}
                <button
                  type="button"
                  data-tip="Edit"
                  aria-label="Edit"
                  disabled={busy}
                  onClick={() => setOpenForm(isEditing ? null : category.id)}
                  className={`${BTN_SUBTLE} size-7 rounded-md`}
                >
                  <PenLine className="size-3.5" />
                </button>
                <Toggle
                  checked={category.active}
                  disabled={pending || category.systemRole !== null}
                  onChange={() => onToggleActive(category)}
                  label={category.active ? "Deactivate category" : "Reactivate category"}
                />
                <DeleteButton
                  disabled={busy}
                  system={category.systemRole !== null}
                  onConfirm={() => onDelete(category)}
                />
              </div>

              {isEditing ? (
                <div className="border-t border-border px-3 py-3">
                  <CategoryForm
                    key={category.id}
                    mode={category.id}
                    initial={formFrom(category)}
                    system={category.systemRole !== null}
                    pending={busy}
                    disabled={pending}
                    onCancel={() => setOpenForm(null)}
                    onSubmit={(values) => onSubmit(category.id, values)}
                  />
                </div>
              ) : null}
            </div>
          );
        })}

        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">
            No categories yet. Add one to start classifying replies.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-border bg-surface px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}

/* Two-click delete confirm; system rows are blocked with an explanation. */
function DeleteButton({
  disabled,
  system,
  onConfirm,
}: {
  disabled?: boolean;
  system: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (system) {
    return (
      <button
        type="button"
        disabled
        data-tip="System category that cannot be deleted"
        aria-label="System category that cannot be deleted"
        className="flex size-7 shrink-0 cursor-not-allowed items-center justify-center rounded-md text-muted-foreground/40"
      >
        <Trash2 className="size-3.5" />
      </button>
    );
  }

  if (armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        className={`${BTN_BASE} h-7 shrink-0 rounded-md bg-destructive-soft px-2 text-[11px] text-destructive hover:opacity-90`}
      >
        Confirm?
      </button>
    );
  }

  return (
    <button
      type="button"
      data-tip="Delete category"
      aria-label="Delete category"
      disabled={disabled}
      onClick={() => {
        setArmed(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setArmed(false), 3000);
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:opacity-50"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}

/* ── Add / edit form ──────────────────────────────────────────────────── */
function CategoryForm({
  mode,
  initial,
  system = false,
  pending,
  disabled,
  onCancel,
  onSubmit,
}: {
  mode: "new" | string;
  initial: FormValues;
  system?: boolean;
  pending: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (values: FormValues) => void;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const isNew = mode === "new";
  const canSubmit = values.label.trim().length > 0 && !disabled;

  return (
    <div
      className={
        isNew
          ? "flex flex-col gap-3 rounded-lg bg-surface p-3.5"
          : "flex flex-col gap-3"
      }
    >
      {isNew ? (
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-semibold tracking-tight">New category</div>
          <button type="button" onClick={onCancel} className={`${BTN_SUBTLE} size-6 rounded-md`} data-tip="Cancel" aria-label="Cancel">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {system ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span>System category. You can edit its guidance and actions, but it can&rsquo;t be deleted.</span>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label className="text-[11.5px] font-medium">Label</label>
        <input
          value={values.label}
          onChange={(event) => set("label", event.target.value)}
          placeholder="e.g. Interested"
          maxLength={60}
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11.5px] font-medium">Description</label>
        <textarea
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          placeholder="When should the AI pick this category?"
          rows={2}
          className={TEXTAREA_CLASS}
        />
        <p className="text-[11px] text-muted-foreground">Tells the AI when to pick this category.</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-1 flex-col gap-1.5">
          <label className="text-[11.5px] font-medium">Sentiment</label>
          <div className="relative">
            <select
              value={values.sentimentType}
              onChange={(event) => set("sentimentType", event.target.value as ReplySentimentType)}
              className={SELECT_CLASS}
            >
              {(Object.keys(SENTIMENT_LABELS) as ReplySentimentType[]).map((value) => (
                <option key={value} value={value}>
                  {SENTIMENT_LABELS[value]}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-1.5">
          <label className="text-[11.5px] font-medium">Color</label>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => set("color", null)}
              data-tip="Auto (from sentiment)"
              className={`flex h-6 items-center rounded-md border px-2 text-[11px] font-medium transition ${
                values.color === null
                  ? "border-transparent bg-accent text-accent-foreground"
                  : "border-border bg-surface text-muted-foreground hover:text-foreground"
              }`}
            >
              Auto
            </button>
            {COLOR_SLUGS.map((slug) => (
              <button
                key={slug}
                type="button"
                data-tip={slug}
                aria-label={slug}
                aria-pressed={values.color === slug}
                onClick={() => set("color", slug)}
                className={`flex size-6 items-center justify-center rounded-full transition ${
                  values.color === slug ? "ring-2 ring-ring ring-offset-1 ring-offset-surface" : ""
                }`}
              >
                <span className={`size-3.5 rounded-full ${COLOR_DOT[slug]}`} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Action toggles */}
      <div className="flex flex-col gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <ToggleRow
          label="Add sender to suppression list"
          checked={values.suppress}
          onChange={(next) => set("suppress", next)}
          disabled={disabled}
        />
        <ToggleRow
          label="Add to Smartlead block list"
          checked={values.dnc}
          onChange={(next) => set("dnc", next)}
          disabled={disabled}
        />
        <ToggleRow
          label="Pre-draft a suggested reply"
          checked={values.draftReply}
          onChange={(next) => set("draftReply", next)}
          disabled={disabled}
        />
        {values.draftReply ? (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <textarea
              value={values.draftGuidance}
              onChange={(event) => set("draftGuidance", event.target.value)}
              placeholder="How should the AI draft replies here?"
              rows={2}
              className={TEXTAREA_CLASS}
            />
            <p className="text-[11px] text-muted-foreground">
              Instructions for the AI when drafting replies in this category.
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={pending} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit || pending}
          onClick={() => onSubmit(values)}
          className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
        >
          {isNew ? (
            <>
              <Plus className="size-3.5" />
              Create category
            </>
          ) : (
            <>
              <Check className="size-3.5" />
              Save changes
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-foreground">{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

/* ── AI & Automation section ──────────────────────────────────────────── */
const TEXTAREA_MULTI =
  "w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring resize-y";

const MODEL_PRESETS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"] as const;
const MODEL_DEFAULT = "__default__";
const MODEL_CUSTOM = "__custom__";

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11.5px] font-medium">{label}</label>
      {children}
      {helper ? <p className="text-[11px] text-muted-foreground">{helper}</p> : null}
    </div>
  );
}

function AiCard({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface p-3.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {icon ? (
            <span aria-hidden className="flex shrink-0 items-center text-muted-foreground">
              {icon}
            </span>
          ) : null}
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
        </div>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/* ── Integration service marks ────────────────────────────────────────────
   Anthropic's and OpenAI's marks now live in ../brand-marks, shared with the
   enrichment column headers so one glyph has one definition. Smartlead and
   Zapmail stay here: they are integration-specific raster assets from our
   public dir, with no second consumer. No external image URLs at runtime. */
/* Real brand marks for Smartlead and Zapmail, operator-provided raster
   assets in public/logos. Smartlead's tile carries its own violet ground;
   Zapmail's black mark sits on an explicit white chip so it stays legible
   on dark surfaces. */
function SmartleadMark({ className = "size-4" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logos/smartlead.png" alt="" aria-hidden className={`${className} shrink-0 rounded-[4px]`} />;
}

function ZapmailMark({ className = "size-4" }: { className?: string }) {
  return (
    <span aria-hidden className={`${className} flex shrink-0 items-center justify-center rounded-[4px] bg-white`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logos/zapmail.png" alt="" className="size-full object-contain p-px" />
    </span>
  );
}

/* Prospect-enrichment provider marks. These render the official brand logo the
   moment its raster is dropped into public/logos (same as Smartlead/Zapmail); a
   brand-coloured tile with a thematic glyph shows until then, so nothing is ever
   a broken image. */
function BrandMark({
  src,
  tileClass,
  glyph,
  className = "size-4",
}: {
  src: string;
  tileClass: string;
  glyph: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span aria-hidden className={`${className} flex shrink-0 items-center justify-center rounded-[4px] text-white ${tileClass}`}>
        {glyph}
      </span>
    );
  }
  return (
    <span aria-hidden className={`${className} flex shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-white`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="size-full object-contain p-px" onError={() => setFailed(true)} />
    </span>
  );
}

function ApifyMark({ className = "size-4" }: { className?: string }) {
  return <BrandMark src="/logos/apify.png" tileClass="bg-[#0b8a3e]" glyph={<Workflow className="size-[68%]" />} className={className} />;
}

function LeadMagicMark({ className = "size-4" }: { className?: string }) {
  return <BrandMark src="/logos/leadmagic.png" tileClass="bg-[#6d28d9]" glyph={<Magnet className="size-[68%]" />} className={className} />;
}

function ZeroBounceMark({ className = "size-4" }: { className?: string }) {
  return <BrandMark src="/logos/zerobounce.png" tileClass="bg-[#0a86d8]" glyph={<MailCheck className="size-[68%]" />} className={className} />;
}

function ApolloMark({ className = "size-4" }: { className?: string }) {
  return <BrandMark src="/logos/apollo.png" tileClass="bg-[#3b23c4]" glyph={<Rocket className="size-[68%]" />} className={className} />;
}

function FirecrawlMark({ className = "size-4" }: { className?: string }) {
  return <BrandMark src="/logos/firecrawl.png" tileClass="bg-[#ea580c]" glyph={<Flame className="size-[68%]" />} className={className} />;
}

/* ── Reply defaults: master-detail field model ─────────────────────────
   The section renders as a compact list of settings on the left (label +
   truncated value preview + a dirty dot) and one roomy editor on the right.
   Purely presentational: the form state, normalization, diffing, and save
   semantics are unchanged. */
type AiFieldKey =
  | "campaignContext"
  | "drafting"
  | "draftContext"
  | "styleExamples"
  | "extraVoiceRules"
  | "signature"
  | "autoHandling";

type AiFieldDef = {
  key: AiFieldKey;
  label: string;
  description: string;
  /* Which AiSettings keys this editor covers; drives the dirty dot. */
  settings: (keyof AiSettings)[];
};

const AI_FIELD_GROUPS: { title: string; fields: AiFieldDef[] }[] = [
  {
    title: "How replies are read",
    fields: [
      {
        key: "campaignContext",
        label: "Campaign context",
        description:
          "Describes your outreach to the AI, and which Claude model reads it. Used every time a reply is categorized.",
        settings: ["campaignContext", "model"],
      },
    ],
  },
  {
    title: "How drafts are written",
    fields: [
      {
        key: "drafting",
        label: "Drafting and identity",
        description: "Whether Claude pre-writes replies, and who they are signed as.",
        settings: ["draftingEnabled", "senderName", "senderTitle", "senderCompany"],
      },
      {
        key: "draftContext",
        label: "Draft context",
        description: "Who you are plus proof points the AI may cite when it replies.",
        settings: ["draftContext"],
      },
      {
        key: "styleExamples",
        label: "Style examples",
        description:
          "Add a few real replies you've sent. The AI mimics their voice. Pair each with the lead's message when it helps.",
        settings: ["styleExamples"],
      },
      {
        key: "extraVoiceRules",
        label: "Extra voice rules",
        description: "Rules the AI follows in every draft. One rule per line.",
        settings: ["extraVoiceRules"],
      },
      {
        key: "signature",
        label: "Signature",
        description: "The exact sign-off block appended to every draft.",
        settings: ["signature"],
      },
    ],
  },
  {
    title: "What happens automatically",
    fields: [
      {
        key: "autoHandling",
        label: "Automatic handling",
        description: "Which routine replies Claude resolves on its own, and resume timing.",
        settings: [
          "autoHandleOoo",
          "autoHandleDeadMailbox",
          "resumeBusinessDaysAfterReturn",
          "resumeDefaultWaitDays",
        ],
      },
    ],
  },
];
/* Colleague research deliberately has no workspace editor: which titles
   matter is a per-campaign question, so it lives on each campaign's Reply
   handling tab. The workspace values remain the silent inherit default. */

const AI_FIELDS: AiFieldDef[] = AI_FIELD_GROUPS.flatMap((group) => group.fields);

/* Fields that only exist while their master toggle is on (mirrors the old
   layout, where these rows were hidden entirely). The combined "drafting"
   item stays visible always — it holds the master toggle itself. */
function aiFieldVisible(key: AiFieldKey, form: AiSettings): boolean {
  if (
    key === "draftContext" ||
    key === "styleExamples" ||
    key === "extraVoiceRules" ||
    key === "signature"
  ) {
    return form.draftingEnabled;
  }
  return true;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim().length > 0);
  return line ? line.trim() : "";
}

function aiFieldPreview(key: AiFieldKey, form: AiSettings): string {
  switch (key) {
    case "campaignContext":
      return firstLine(form.campaignContext) || "Not set";
    case "drafting":
      return `${form.draftingEnabled ? "On" : "Off"} · ${form.senderName.trim() || "No identity"}`;
    case "draftContext":
      return firstLine(form.draftContext) || "Not set";
    case "styleExamples":
      return form.styleExamples.length === 0
        ? "None yet"
        : `${form.styleExamples.length} ${form.styleExamples.length === 1 ? "example" : "examples"}`;
    case "extraVoiceRules":
      return firstLine(form.extraVoiceRules) || "Not set";
    case "signature":
      return firstLine(form.signature) || "Not set";
    case "autoHandling":
      return `OOO ${form.autoHandleOoo ? "on" : "off"} · Dead mailboxes ${
        form.autoHandleDeadMailbox ? "on" : "off"
      }`;
  }
}

/* A single row in the master list: label + one-line value preview, plus a
   small dot when the field has unsaved edits. */
function AiFieldListItem({
  field,
  active,
  dirty,
  preview,
  onSelect,
}: {
  field: AiFieldDef;
  active: boolean;
  dirty: boolean;
  preview: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ${
        active ? "bg-accent shadow-xs" : "hover:bg-muted/60"
      }`}
    >
      <span className="flex w-full items-center gap-1.5">
        <span
          className={`min-w-0 flex-1 truncate text-[12px] font-medium ${
            active ? "text-accent-foreground" : "text-foreground"
          }`}
        >
          {field.label}
        </span>
        {dirty ? (
          <span
            data-tip="Unsaved change"
            aria-label="Unsaved change"
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        ) : null}
      </span>
      <span
        className={`w-full truncate text-[11px] ${
          active ? "text-accent-foreground/75" : "text-muted-foreground"
        }`}
      >
        {preview}
      </span>
    </button>
  );
}

/* Detail-pane toggle: the field's on/off control as a quiet bordered row. */
function ToggleBlock({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 px-3.5 py-3">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

/* Slim save bar that sticks to the bottom of the content column and slides in
   only while there are unsaved changes. Cancel reverts the form to baseline. */
function SaveBar({
  saving,
  onCancel,
  onSave,
}: {
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-10 pt-2">
      <div className="anim-savebar-in flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur">
        <span className="text-[12px] font-medium text-muted-foreground">Unsaved changes</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Check className="size-3.5" />
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Style examples module ────────────────────────────────────────────────
   A list of paired writing samples (lead message + your reply). Reused as-is
   in the campaigns override panel. Caps at 6 examples; each field maxLength
   2000; ids generated with crypto.randomUUID(). Part of the parent's
   dirty-tracked form — the parent compares by JSON.stringify. */
const STYLE_EXAMPLES_CAP = 6;

export function StyleExamplesEditor({
  value,
  onChange,
  disabled,
}: {
  value: StyleExample[];
  onChange: (next: StyleExample[]) => void;
  disabled?: boolean;
}) {
  const atCap = value.length >= STYLE_EXAMPLES_CAP;

  const add = () => {
    if (atCap) return;
    onChange([...value, { id: crypto.randomUUID(), leadMessage: "", reply: "" }]);
  };
  const update = (id: string, patch: Partial<StyleExample>) =>
    onChange(value.map((example) => (example.id === id ? { ...example, ...patch } : example)));
  const remove = (id: string) => onChange(value.filter((example) => example.id !== id));

  return (
    <div className="flex flex-col gap-2.5">
      {value.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[11.5px] text-muted-foreground">
          No examples yet. Add one to teach the AI your voice.
        </div>
      ) : (
        value.map((example, index) => (
          <div
            key={example.id}
            className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/20 p-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Example {index + 1}
              </span>
              <button
                type="button"
                data-tip="Remove example"
                aria-label="Remove example"
                disabled={disabled}
                onClick={() => remove(example.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-muted-foreground">
                What the lead said (optional)
              </label>
              <textarea
                value={example.leadMessage}
                onChange={(event) => update(example.id, { leadMessage: event.target.value })}
                placeholder="Paste the message you were replying to…"
                maxLength={2000}
                rows={2}
                disabled={disabled}
                className={`${TEXTAREA_MULTI} disabled:opacity-50`}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium">The reply you sent</label>
              <textarea
                value={example.reply}
                onChange={(event) => update(example.id, { reply: event.target.value })}
                placeholder="Paste the reply exactly as you wrote it…"
                maxLength={2000}
                rows={4}
                disabled={disabled}
                className={`${TEXTAREA_MULTI} disabled:opacity-50`}
              />
            </div>
          </div>
        ))
      )}
      <button
        type="button"
        disabled={disabled || atCap}
        onClick={add}
        className={`${BTN_OUTLINE} h-8 self-start px-3 text-[12px]`}
      >
        <Plus className="size-3.5" />
        {atCap ? `Maximum ${STYLE_EXAMPLES_CAP} examples` : "Add example"}
      </button>
    </div>
  );
}

function AiSection({
  settings,
  run,
  pending,
  busyId,
}: {
  settings: AiSettings;
  run: (id: string | null, action: () => Promise<ActionResult>) => void;
  pending: boolean;
  busyId: string | null;
}) {
  // Server value is the dirty-tracking baseline; re-seeds on fresh server data.
  const [baseline, setBaseline] = useState<AiSettings>(settings);
  const [form, setForm] = useState<AiSettings>(settings);
  // UI-only: whether the model picker is in "Custom…" (free-text) mode.
  const [customModel, setCustomModel] = useState<boolean>(
    settings.model !== null && !(MODEL_PRESETS as readonly string[]).includes(settings.model),
  );
  // UI-only: which field the master list has selected for the detail editor.
  const [selectedField, setSelectedField] = useState<AiFieldKey>("campaignContext");

  /* eslint-disable react-hooks/set-state-in-effect -- re-seed the editable
     form whenever the server sends fresh settings (same pattern as the
     category list above). */
  useEffect(() => {
    setBaseline(settings);
    setForm(settings);
    setCustomModel(
      settings.model !== null && !(MODEL_PRESETS as readonly string[]).includes(settings.model),
    );
  }, [settings]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const set = <K extends keyof AiSettings>(key: K, value: AiSettings[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Normalized snapshot: empty custom model collapses to null (App default).
  const normalized: AiSettings = {
    ...form,
    model: customModel
      ? (form.model && form.model.trim() ? form.model.trim().toLowerCase().replace(/\s+/g, "") : null)
      : form.model,
    resumeBusinessDaysAfterReturn: clampInt(String(form.resumeBusinessDaysAfterReturn), 0, 30),
    resumeDefaultWaitDays: clampInt(String(form.resumeDefaultWaitDays), 1, 60),
    // A module whose reply is still empty isn't a usable example — drop it at
    // save time instead of letting the server reject the whole patch.
    styleExamples: form.styleExamples.filter((example) => example.reply.trim().length > 0),
  };

  const patch: Partial<AiSettings> = {};
  (Object.keys(normalized) as (keyof AiSettings)[]).forEach((key) => {
    // styleExamples is an array — compare structurally, everything else by value.
    const changed =
      key === "styleExamples"
        ? JSON.stringify(normalized[key]) !== JSON.stringify(baseline[key])
        : normalized[key] !== baseline[key];
    if (changed) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (patch as any)[key] = normalized[key];
    }
  });
  const dirty = Object.keys(patch).length > 0;
  const saving = pending && busyId === "ai";

  const save = () => {
    if (!dirty) return;
    run("ai", async () => {
      const result = await updateAiSettingsAction(patch);
      if (result.ok) {
        setBaseline(normalized);
        setForm(normalized);
      }
      return result;
    });
  };

  // Cancel = discard edits: reset the editable form (and the model picker mode)
  // back to the last-saved baseline.
  const cancel = () => {
    setForm(baseline);
    setCustomModel(
      baseline.model !== null && !(MODEL_PRESETS as readonly string[]).includes(baseline.model),
    );
  };

  const modelSelectValue = customModel
    ? MODEL_CUSTOM
    : form.model === null
      ? MODEL_DEFAULT
      : (MODEL_PRESETS as readonly string[]).includes(form.model)
        ? form.model
        : MODEL_CUSTOM;

  const onModelSelect = (value: string) => {
    if (value === MODEL_DEFAULT) {
      setCustomModel(false);
      set("model", null);
    } else if (value === MODEL_CUSTOM) {
      setCustomModel(true);
      set("model", "");
    } else {
      setCustomModel(false);
      set("model", value);
    }
  };

  /* Master list: hidden fields drop out (mirrors the old hidden rows); the
     selection falls back to the first visible field when its field hides. */
  const visibleGroups = AI_FIELD_GROUPS.map((group) => ({
    title: group.title,
    fields: group.fields.filter((field) => aiFieldVisible(field.key, form)),
  })).filter((group) => group.fields.length > 0);
  const visibleKeys = visibleGroups.flatMap((group) => group.fields.map((field) => field.key));
  const activeKey = visibleKeys.includes(selectedField) ? selectedField : visibleKeys[0];
  const activeField = AI_FIELDS.find((field) => field.key === activeKey) ?? AI_FIELDS[0];

  /* The roomy detail editor for the selected field. Same inputs, handlers,
     limits, and clamping as the old stacked layout; only enlarged. */
  const editorFor = (key: AiFieldKey): ReactNode => {
    switch (key) {
      case "campaignContext":
        return (
          <div className="flex flex-col gap-4">
            <textarea
              value={form.campaignContext}
              onChange={(event) => set("campaignContext", event.target.value)}
              placeholder="What you're offering, who you target, and how replies tend to sound…"
              maxLength={4000}
              rows={12}
              className={TEXTAREA_MULTI}
            />
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Model
              </span>
              <div className="flex max-w-md flex-col gap-2">
                <div className="relative">
                  <select
                    value={modelSelectValue}
                    onChange={(event) => onModelSelect(event.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value={MODEL_DEFAULT}>App default</option>
                    {MODEL_PRESETS.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                    <option value={MODEL_CUSTOM}>Custom…</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
                {customModel ? (
                  <input
                    value={form.model ?? ""}
                    onChange={(event) => set("model", event.target.value)}
                    placeholder="e.g. claude-sonnet-5-20260101"
                    maxLength={64}
                    className={`${INPUT_CLASS} font-mono`}
                  />
                ) : null}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Which Claude model reads and classifies replies. App default is recommended.
              </p>
            </div>
          </div>
        );
      case "drafting":
        return (
          <div className="flex max-w-3xl flex-col gap-3">
            <div className="flex max-w-2xl flex-col gap-2">
              <ToggleBlock
                label="Draft replies automatically"
                checked={form.draftingEnabled}
                onChange={(next) => set("draftingEnabled", next)}
                disabled={saving}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Turning this on reveals the context, voice, and signature settings drafts are built
                from.
              </p>
            </div>
            <div
              className={`grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-3 ${
                form.draftingEnabled ? "" : "opacity-50"
              }`}
            >
              <Field label="Name">
                <input
                  value={form.senderName}
                  onChange={(event) => set("senderName", event.target.value)}
                  placeholder="Jane Doe"
                  maxLength={120}
                  disabled={!form.draftingEnabled}
                  className={`${INPUT_CLASS} disabled:opacity-50`}
                />
              </Field>
              <Field label="Title">
                <input
                  value={form.senderTitle}
                  onChange={(event) => set("senderTitle", event.target.value)}
                  placeholder="Head of Growth"
                  maxLength={120}
                  disabled={!form.draftingEnabled}
                  className={`${INPUT_CLASS} disabled:opacity-50`}
                />
              </Field>
              <Field label="Company">
                <input
                  value={form.senderCompany}
                  onChange={(event) => set("senderCompany", event.target.value)}
                  placeholder="Acme Inc."
                  maxLength={120}
                  disabled={!form.draftingEnabled}
                  className={`${INPUT_CLASS} disabled:opacity-50`}
                />
              </Field>
            </div>
            {!form.draftingEnabled ? (
              <p className="text-[11px] text-muted-foreground">
                Turn on drafting to change the identity.
              </p>
            ) : null}
          </div>
        );
      case "draftContext":
        return (
          <textarea
            value={form.draftContext}
            onChange={(event) => set("draftContext", event.target.value)}
            placeholder="Background, offers, case studies, and facts the AI can lean on…"
            maxLength={4000}
            rows={12}
            className={TEXTAREA_MULTI}
          />
        );
      case "styleExamples":
        return (
          <StyleExamplesEditor
            value={form.styleExamples}
            onChange={(next) => set("styleExamples", next)}
            disabled={saving}
          />
        );
      case "extraVoiceRules":
        return (
          <textarea
            value={form.extraVoiceRules}
            onChange={(event) => set("extraVoiceRules", event.target.value)}
            placeholder={"Never use exclamation marks\nKeep it under 90 words\nNo em dashes"}
            maxLength={1000}
            rows={8}
            className={TEXTAREA_MULTI}
          />
        );
      case "signature":
        return (
          <textarea
            value={form.signature}
            onChange={(event) => set("signature", event.target.value)}
            placeholder={"Best,\nJane\nHead of Growth, Acme Inc."}
            maxLength={1000}
            rows={8}
            className={TEXTAREA_MULTI}
          />
        );
      case "autoHandling":
        return (
          <div className="flex max-w-2xl flex-col gap-4">
            <div className="flex flex-col gap-2">
              <ToggleBlock
                label="Auto-handle out-of-office replies"
                checked={form.autoHandleOoo}
                onChange={(next) => set("autoHandleOoo", next)}
                disabled={saving}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                The resume timing settings apply only while this is on.
              </p>
            </div>
            <div className="flex flex-col gap-3 border-l border-border pl-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Resume after stated return
                </label>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={String(form.resumeBusinessDaysAfterReturn)}
                  disabled={!form.autoHandleOoo}
                  onChange={(event) =>
                    set("resumeBusinessDaysAfterReturn", clampInt(event.target.value, 0, 30))
                  }
                  className={`${INPUT_CLASS} w-28 disabled:opacity-50`}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Resume when no date given
                </label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={String(form.resumeDefaultWaitDays)}
                  disabled={!form.autoHandleOoo}
                  onChange={(event) =>
                    set("resumeDefaultWaitDays", clampInt(event.target.value, 1, 60))
                  }
                  className={`${INPUT_CLASS} w-28 disabled:opacity-50`}
                />
              </div>
              {!form.autoHandleOoo ? (
                <p className="text-[11px] text-muted-foreground">
                  Turn on out-of-office auto-handling to change these.
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <ToggleBlock
                label="Auto-handle dead mailboxes"
                checked={form.autoHandleDeadMailbox}
                onChange={(next) => set("autoHandleDeadMailbox", next)}
                disabled={saving}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Applies only to automated notices that an address no longer exists. A human telling
                you someone left still waits for review.
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold tracking-tight">Reply defaults</h2>
        <p className="max-w-4xl text-[12px] leading-relaxed text-muted-foreground">
          The workspace defaults for how replies are read, how drafts are written, and what Claude
          handles on its own. Campaigns use these defaults unless you customize them in the Campaigns
          tab.
        </p>
      </div>

      {/* Master-detail: compact settings list on the left, one roomy editor
          on the right. Stacks vertically below lg. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        <nav
          aria-label="Reply default settings"
          className="flex w-full shrink-0 flex-col gap-4 lg:w-72"
        >
          {visibleGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              <div className="px-2.5 text-[11px] font-semibold tracking-tight text-muted-foreground">
                {group.title}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.fields.map((field) => (
                  <AiFieldListItem
                    key={field.key}
                    field={field}
                    active={field.key === activeKey}
                    dirty={field.settings.some((settingKey) => settingKey in patch)}
                    preview={aiFieldPreview(field.key, form)}
                    onSelect={() => setSelectedField(field.key)}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <div className="flex min-h-[440px] flex-col gap-4 rounded-xl bg-surface p-5 shadow-xs">
            <div className="flex flex-col gap-1">
              <h3 className="text-[13px] font-semibold tracking-tight">{activeField.label}</h3>
              <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
                {activeField.description}
              </p>
            </div>
            {editorFor(activeField.key)}
          </div>
          {dirty ? <SaveBar saving={saving} onCancel={cancel} onSave={save} /> : null}
        </div>
      </div>
    </section>
  );
}

/* ── Integrations section ─────────────────────────────────────────────── */
const EMAIL_PROVIDER_AUTO = "__auto__";

/* Editable mirror of IntegrationSettings — text fields and port are held as
   strings so partial/empty input is representable; normalized back before
   diffing (empty string → null, matching how AiSection diffs). */
type IntegrationFormValues = {
  smartleadApiBaseUrl: string;
  zapmailWorkspaceId: string;
  zapmailServiceProvider: "GOOGLE" | "MICROSOFT";
  emailProvider: "resend" | "smtp" | null;
  emailFrom: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpSecure: boolean | null;
};

function formFromIntegration(s: IntegrationSettings): IntegrationFormValues {
  return {
    smartleadApiBaseUrl: s.smartleadApiBaseUrl ?? "",
    zapmailWorkspaceId: s.zapmailWorkspaceId ?? "",
    zapmailServiceProvider: s.zapmailServiceProvider,
    emailProvider: s.emailProvider,
    emailFrom: s.emailFrom ?? "",
    smtpHost: s.smtpHost ?? "",
    smtpPort: s.smtpPort !== null ? String(s.smtpPort) : "",
    smtpUser: s.smtpUser ?? "",
    smtpSecure: s.smtpSecure,
  };
}

function normalizeIntegration(f: IntegrationFormValues): IntegrationSettings {
  const portTrimmed = f.smtpPort.trim();
  return {
    smartleadApiBaseUrl: f.smartleadApiBaseUrl.trim() || null,
    zapmailWorkspaceId: f.zapmailWorkspaceId.trim(),
    zapmailServiceProvider: f.zapmailServiceProvider,
    emailProvider: f.emailProvider,
    emailFrom: f.emailFrom.trim() || null,
    smtpHost: f.smtpHost.trim() || null,
    smtpPort: portTrimmed ? clampInt(portTrimmed, 1, 65535) : null,
    smtpUser: f.smtpUser.trim() || null,
    smtpSecure: f.smtpSecure,
  };
}

const SMARTLEAD_SETTING_KEYS = ["smartleadApiBaseUrl"] as const;
const ZAPMAIL_SETTING_KEYS = ["zapmailWorkspaceId", "zapmailServiceProvider"] as const;
const EMAIL_SETTING_KEYS = [
  "emailProvider",
  "emailFrom",
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "smtpSecure",
] as const;

function StatusBadge({ tone, children }: { tone: "success" | "info" | "muted"; children: ReactNode }) {
  const cls =
    tone === "success"
      ? "bg-success-soft text-success"
      : tone === "info"
        ? "bg-accent text-accent-foreground"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-px text-[10.5px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

/* A single secret credential input: password field + Save, plus Clear when the
   secret is already stored. Disabled wholesale when encryption is unavailable. */
function SecretField({
  label,
  helper,
  isSet,
  encryptionDisabled,
  placeholderUnset,
  value,
  onChange,
  onSave,
  onClear,
  savingSet,
  savingClear,
  pending,
}: {
  label: string;
  helper?: string;
  isSet: boolean;
  encryptionDisabled: boolean;
  placeholderUnset: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onClear: () => void;
  savingSet: boolean;
  savingClear: boolean;
  pending: boolean;
}) {
  return (
    <Field label={label} helper={helper}>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={encryptionDisabled || pending}
          placeholder={isSet ? "••••••••  (set)" : placeholderUnset}
          maxLength={500}
          autoComplete="off"
          className={`${INPUT_CLASS} flex-1 disabled:opacity-50`}
        />
        <button
          type="button"
          disabled={encryptionDisabled || pending || !value.trim()}
          onClick={onSave}
          className={`${BTN_PRIMARY} h-8 shrink-0 px-3 text-[12px]`}
        >
          <Check className="size-3.5" />
          {savingSet ? "Saving…" : "Save"}
        </button>
        {isSet ? (
          <button
            type="button"
            disabled={encryptionDisabled || pending}
            onClick={onClear}
            className={`${BTN_OUTLINE} h-8 shrink-0 px-3 text-[12px]`}
          >
            {savingClear ? "Clearing…" : "Clear"}
          </button>
        ) : null}
      </div>
    </Field>
  );
}

function IntegrationsSection({
  settings,
  status,
  run,
  pending,
  busyId,
}: {
  settings: IntegrationSettings;
  status: IntegrationStatus;
  run: (id: string | null, action: () => Promise<ActionResult>) => void;
  pending: boolean;
  busyId: string | null;
}) {
  // Server value is the dirty-tracking baseline; re-seeds on fresh server data.
  const [baseline, setBaseline] = useState<IntegrationSettings>(settings);
  const [form, setForm] = useState<IntegrationFormValues>(formFromIntegration(settings));

  // Per-secret password drafts (never part of the settings diff).
  const [secretDraft, setSecretDraft] = useState<Record<SecretName, string>>({
    smartlead_api_key: "",
    zapmail_api_key: "",
    resend_api_key: "",
    smtp_password: "",
    enrichment_anthropic_api_key: "",
    openai_api_key: "",
    apify_api_key: "",
    leadmagic_api_key: "",
    zerobounce_api_key: "",
    apollo_api_key: "",
    firecrawl_api_key: "",
    ai_gateway_api_key: "",
  });

  // Loaded lazily from Smartlead; null = not loaded yet.
  const [campaigns, setCampaigns] = useState<
    { id: string; name: string; status: string | null }[] | null
  >(null);

  /* eslint-disable react-hooks/set-state-in-effect -- re-seed the editable form
     whenever the server sends fresh settings (same pattern as AiSection). */
  useEffect(() => {
    setBaseline(settings);
    setForm(formFromIntegration(settings));
  }, [settings]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const set = <K extends keyof IntegrationFormValues>(key: K, value: IntegrationFormValues[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const normalized = normalizeIntegration(form);
  const patchFor = (
    keys: readonly (keyof IntegrationSettings)[],
  ): Partial<IntegrationSettings> => {
    const patch: Partial<IntegrationSettings> = {};
    keys.forEach((key) => {
      if (normalized[key] !== baseline[key]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (patch as any)[key] = normalized[key];
      }
    });
    return patch;
  };

  const smartleadPatch = patchFor(SMARTLEAD_SETTING_KEYS);
  const zapmailPatch = patchFor(ZAPMAIL_SETTING_KEYS);
  const emailPatch = patchFor(EMAIL_SETTING_KEYS);
  const smartleadDirty = Object.keys(smartleadPatch).length > 0;
  const zapmailDirty = Object.keys(zapmailPatch).length > 0;
  const emailDirty = Object.keys(emailPatch).length > 0;

  const encDisabled = !status.encryptionAvailable;

  const saveSettings = (id: string, patch: Partial<IntegrationSettings>) => {
    if (Object.keys(patch).length === 0) return;
    run(id, async () => {
      const result = await updateIntegrationSettingsAction(patch);
      if (result.ok) {
        // Re-seed the affected keys optimistically; a revalidate also refreshes props.
        setBaseline((prev) => ({ ...prev, ...patch }));
      }
      return result;
    });
  };

  const saveSecret = (name: SecretName) => {
    const value = secretDraft[name].trim();
    if (!value) return;
    run(`secret-set:${name}`, async () => {
      const result = await setIntegrationSecretAction(name, value);
      if (result.ok) setSecretDraft((prev) => ({ ...prev, [name]: "" }));
      return result;
    });
  };

  const clearSecret = (name: SecretName) => {
    run(`secret-clear:${name}`, async () => {
      const result = await clearIntegrationSecretAction(name);
      if (result.ok) setSecretDraft((prev) => ({ ...prev, [name]: "" }));
      return result;
    });
  };

  const loadCampaigns = () => {
    run("smartlead-campaigns", async () => {
      const result = await listSmartleadCampaignsAction();
      if (result.ok && result.campaigns) setCampaigns(result.campaigns);
      return result;
    });
  };

  const smartleadSource = status.smartlead.source;
  const emailProviderValue = form.emailProvider === null ? EMAIL_PROVIDER_AUTO : form.emailProvider;
  const showResendSecret = form.emailProvider === "resend" || form.emailProvider === null;
  const showSmtpFields = form.emailProvider === "smtp" || form.emailProvider === null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold tracking-tight">Integrations</h2>
        <p className="max-w-4xl text-[12px] leading-relaxed text-muted-foreground">
          Connect Smartlead and configure how this deployment sends email. Credentials are stored
          encrypted in the database; environment-variable configuration also keeps working.
        </p>
      </div>

      {encDisabled ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-[12px] leading-relaxed text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            In-app credentials are locked. Set APP_ENCRYPTION_KEY on the server to store API keys
            securely in the database. Environment-variable configuration keeps working without it.
          </span>
        </div>
      ) : null}

      {/* Card grid: two columns as soon as the width allows so the section
          uses the viewport instead of stacking into a narrow column. */}
      <div className="grid gap-3 lg:grid-cols-2 lg:items-stretch [&>*]:h-full">
      {/* Smartlead */}
      <AiCard
        title="Smartlead"
        icon={<SmartleadMark />}
        description="Classify and act on replies, and register this deployment's reply webhook on your campaigns."
      >
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-medium">Status</span>
          {smartleadSource === "app" ? (
            <StatusBadge tone="success">Connected via app</StatusBadge>
          ) : smartleadSource === "env" ? (
            <StatusBadge tone="info">Connected via env</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not configured</StatusBadge>
          )}
        </div>

        <SecretField
          label="API key"
          helper="Your Smartlead API key. Stored encrypted; used for classification actions and webhook registration."
          isSet={status.secrets.smartlead_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your Smartlead API key"
          value={secretDraft.smartlead_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, smartlead_api_key: next }))}
          onSave={() => saveSecret("smartlead_api_key")}
          onClear={() => clearSecret("smartlead_api_key")}
          savingSet={pending && busyId === "secret-set:smartlead_api_key"}
          savingClear={pending && busyId === "secret-clear:smartlead_api_key"}
          pending={pending}
        />

        <Field
          label="API base URL"
          helper="Leave empty to use the server default. Override only for a proxy or a non-standard region."
        >
          <input
            value={form.smartleadApiBaseUrl}
            onChange={(event) => set("smartleadApiBaseUrl", event.target.value)}
            placeholder={status.smartlead.baseUrl}
            maxLength={200}
            className={`${INPUT_CLASS} font-mono`}
          />
        </Field>

        <div className="flex items-center justify-end gap-3">
          {smartleadDirty ? (
            <span className="text-[11px] text-muted-foreground">Unsaved changes</span>
          ) : null}
          <button
            type="button"
            disabled={!smartleadDirty || pending}
            onClick={() => saveSettings("integ:smartlead-settings", smartleadPatch)}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Check className="size-3.5" />
            Save changes
          </button>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => run("smartlead-test", () => testSmartleadConnectionAction())}
            className={`${BTN_OUTLINE} h-8 self-start px-3 text-[12px]`}
          >
            {pending && busyId === "smartlead-test" ? "Testing…" : "Test connection"}
          </button>
        </div>

        {/* Webhooks */}
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11.5px] font-medium">Webhooks</span>
            <p className="text-[11px] text-muted-foreground">
              Registers this deployment&rsquo;s reply webhook on the campaign (uses the server&rsquo;s
              APP_BASE_URL and webhook secret).
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={loadCampaigns}
            className={`${BTN_OUTLINE} h-8 self-start px-3 text-[12px]`}
          >
            {pending && busyId === "smartlead-campaigns" ? "Loading…" : "Load campaigns"}
          </button>

          {campaigns !== null ? (
            campaigns.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {campaigns.map((campaign) => {
                  const busy = pending && busyId === `webhook:${campaign.id}`;
                  return (
                    <div
                      key={campaign.id}
                      className="flex items-center gap-3 rounded-md bg-surface px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium">{campaign.name}</div>
                        <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                          <span className="font-mono">{campaign.id}</span>
                          {campaign.status ? <span>· {campaign.status}</span> : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(`webhook:${campaign.id}`, () =>
                            registerSmartleadWebhookAction(campaign.id),
                          )
                        }
                        className={`${BTN_OUTLINE} h-7 shrink-0 px-2.5 text-[11.5px]`}
                      >
                        {busy ? "Registering…" : "Register webhook"}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11.5px] text-muted-foreground">
                No campaigns found.
              </div>
            )
          ) : null}
        </div>
      </AiCard>

      {/* Email transport */}
      <AiCard
        title="Email transport"
        icon={<Mail className="size-4" strokeWidth={1.75} />}
        description="How outbound mail (replies, notifications) is sent. Auto-detect picks a provider from what's configured."
      >
        <div className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium">Status</span>
          {status.email.configured ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <StatusBadge tone="success">Configured</StatusBadge>
              <span className="text-muted-foreground">
                {status.email.provider} · {status.email.from} · {status.email.source}
              </span>
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">{status.email.reason}</p>
          )}
        </div>

        <Field label="Provider">
          <div className="relative">
            <select
              value={emailProviderValue}
              onChange={(event) =>
                set(
                  "emailProvider",
                  event.target.value === EMAIL_PROVIDER_AUTO
                    ? null
                    : (event.target.value as "resend" | "smtp"),
                )
              }
              className={SELECT_CLASS}
            >
              <option value={EMAIL_PROVIDER_AUTO}>Auto-detect</option>
              <option value="resend">Resend</option>
              <option value="smtp">SMTP</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </Field>

        <Field label="From address" helper="The address outbound mail is sent from.">
          <input
            value={form.emailFrom}
            onChange={(event) => set("emailFrom", event.target.value)}
            placeholder="Inbox <inbox@example.com>"
            maxLength={200}
            className={INPUT_CLASS}
          />
        </Field>

        {showResendSecret ? (
          <SecretField
            label="Resend API key"
            helper="Used when the Resend provider is active."
            isSet={status.secrets.resend_api_key}
            encryptionDisabled={encDisabled}
            placeholderUnset="Paste your Resend API key"
            value={secretDraft.resend_api_key}
            onChange={(next) => setSecretDraft((prev) => ({ ...prev, resend_api_key: next }))}
            onSave={() => saveSecret("resend_api_key")}
            onClear={() => clearSecret("resend_api_key")}
            savingSet={pending && busyId === "secret-set:resend_api_key"}
            savingClear={pending && busyId === "secret-clear:resend_api_key"}
            pending={pending}
          />
        ) : null}

        {showSmtpFields ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="SMTP host">
                <input
                  value={form.smtpHost}
                  onChange={(event) => set("smtpHost", event.target.value)}
                  placeholder="smtp.example.com"
                  maxLength={200}
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="SMTP port">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.smtpPort}
                  onChange={(event) => set("smtpPort", event.target.value)}
                  placeholder="587"
                  className={INPUT_CLASS}
                />
              </Field>
            </div>
            <Field label="SMTP user">
              <input
                value={form.smtpUser}
                onChange={(event) => set("smtpUser", event.target.value)}
                placeholder="inbox@example.com"
                maxLength={200}
                className={INPUT_CLASS}
              />
            </Field>
            <ToggleRow
              label="Use TLS/SSL (secure)"
              checked={form.smtpSecure ?? false}
              onChange={(next) => set("smtpSecure", next)}
              disabled={pending}
            />
            <SecretField
              label="SMTP password"
              helper="Used when the SMTP provider is active."
              isSet={status.secrets.smtp_password}
              encryptionDisabled={encDisabled}
              placeholderUnset="Paste your SMTP password"
              value={secretDraft.smtp_password}
              onChange={(next) => setSecretDraft((prev) => ({ ...prev, smtp_password: next }))}
              onSave={() => saveSecret("smtp_password")}
              onClear={() => clearSecret("smtp_password")}
              savingSet={pending && busyId === "secret-set:smtp_password"}
              savingClear={pending && busyId === "secret-clear:smtp_password"}
              pending={pending}
            />
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-3">
          {emailDirty ? (
            <span className="text-[11px] text-muted-foreground">Unsaved changes</span>
          ) : null}
          <button
            type="button"
            disabled={!emailDirty || pending}
            onClick={() => saveSettings("integ:email-settings", emailPatch)}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Check className="size-3.5" />
            Save changes
          </button>
        </div>
      </AiCard>

      {/* Zapmail */}
      <AiCard
        title="Zapmail"
        icon={<ZapmailMark />}
        description="Buy sending domains and mailboxes from the Inboxes page."
      >
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-medium">Status</span>
          {status.zapmail.configured ? (
            <StatusBadge tone="success">Connected</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not configured</StatusBadge>
          )}
        </div>

        <SecretField
          label="API key"
          helper="Your Zapmail API key. Stored encrypted; used to buy sending domains and mailboxes."
          isSet={status.secrets.zapmail_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your Zapmail API key"
          value={secretDraft.zapmail_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, zapmail_api_key: next }))}
          onSave={() => saveSecret("zapmail_api_key")}
          onClear={() => clearSecret("zapmail_api_key")}
          savingSet={pending && busyId === "secret-set:zapmail_api_key"}
          savingClear={pending && busyId === "secret-clear:zapmail_api_key"}
          pending={pending}
        />

        <Field
          label="Workspace ID"
          helper="Optional. Leave empty for your default Zapmail workspace."
        >
          <input
            value={form.zapmailWorkspaceId}
            onChange={(event) => set("zapmailWorkspaceId", event.target.value)}
            placeholder="Default workspace"
            maxLength={100}
            className={`${INPUT_CLASS} font-mono`}
          />
        </Field>

        {/* The Google/Microsoft choice moved into the buy-inboxes flow on the
            Inboxes page: it is a per-purchase decision, not workspace state.
            The stored value remains the silent default for list reads. */}

        <div className="flex items-center justify-end gap-3">
          {zapmailDirty ? (
            <span className="text-[11px] text-muted-foreground">Unsaved changes</span>
          ) : null}
          <button
            type="button"
            disabled={!zapmailDirty || pending}
            onClick={() => saveSettings("integ:zapmail-settings", zapmailPatch)}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Check className="size-3.5" />
            Save changes
          </button>
        </div>
      </AiCard>

      {/* AI providers: API keys for prospect table prompts */}
      <AiCard
        title="AI providers"
        icon={
          <span className="flex items-center gap-1.5">
            <AnthropicMark className="size-4" />
            <OpenAiMark className="size-4" />
          </span>
        }
        description="API keys for the models that run prospect table prompts. Environment-variable configuration also keeps working."
      >
        <div className="flex items-center gap-2">
          <AnthropicMark className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[11.5px] font-medium">Anthropic</span>
          {status.secrets.enrichment_anthropic_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="Anthropic API key"
          helper="Runs prospect table prompts through the Anthropic API. The ANTHROPIC_API_KEY environment variable also works."
          isSet={status.secrets.enrichment_anthropic_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your Anthropic API key"
          value={secretDraft.enrichment_anthropic_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, enrichment_anthropic_api_key: next }))}
          onSave={() => saveSecret("enrichment_anthropic_api_key")}
          onClear={() => clearSecret("enrichment_anthropic_api_key")}
          savingSet={pending && busyId === "secret-set:enrichment_anthropic_api_key"}
          savingClear={pending && busyId === "secret-clear:enrichment_anthropic_api_key"}
          pending={pending}
        />

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <OpenAiMark className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[11.5px] font-medium">OpenAI</span>
          {status.secrets.openai_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="OpenAI API key"
          helper="Runs prospect table prompts through the OpenAI API. The OPENAI_API_KEY environment variable also works."
          isSet={status.secrets.openai_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your OpenAI API key"
          value={secretDraft.openai_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, openai_api_key: next }))}
          onSave={() => saveSecret("openai_api_key")}
          onClear={() => clearSecret("openai_api_key")}
          savingSet={pending && busyId === "secret-set:openai_api_key"}
          savingClear={pending && busyId === "secret-clear:openai_api_key"}
          pending={pending}
        />

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Workflow className="size-3.5 text-muted-foreground" />
          <span className="text-[11.5px] font-medium">Vercel AI Gateway</span>
          {status.secrets.ai_gateway_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="AI Gateway API key"
          helper="Routes vendor-prefixed models (openai/gpt-5.6-luna and friends) for the signals funnel, research briefs, and enrichment. This is the primary model route going forward. The AI_GATEWAY_API_KEY environment variable also works."
          isSet={status.secrets.ai_gateway_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your AI Gateway API key"
          value={secretDraft.ai_gateway_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, ai_gateway_api_key: next }))}
          onSave={() => saveSecret("ai_gateway_api_key")}
          onClear={() => clearSecret("ai_gateway_api_key")}
          savingSet={pending && busyId === "secret-set:ai_gateway_api_key"}
          savingClear={pending && busyId === "secret-clear:ai_gateway_api_key"}
          pending={pending}
        />
      </AiCard>

      {/* Prospect enrichment: API keys for the prospect table enrichment steps */}
      <AiCard
        title="Prospect enrichment"
        icon={
          <span className="flex items-center gap-1.5">
            <ApifyMark className="size-4" />
            <LeadMagicMark className="size-4" />
            <ZeroBounceMark className="size-4" />
          </span>
        }
        description="API keys for the enrichment steps on the prospect table. Stored encrypted; the matching environment variables also keep working."
      >
        <div className="flex items-center gap-2">
          <ApifyMark className="size-3.5" />
          <span className="text-[11.5px] font-medium">Apify</span>
          {status.secrets.apify_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="Apify API token"
          helper="Runs the LinkedIn employment check (At company?) that gates the prospect table. The APIFY_TOKEN environment variable also works."
          isSet={status.secrets.apify_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your Apify API token"
          value={secretDraft.apify_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, apify_api_key: next }))}
          onSave={() => saveSecret("apify_api_key")}
          onClear={() => clearSecret("apify_api_key")}
          savingSet={pending && busyId === "secret-set:apify_api_key"}
          savingClear={pending && busyId === "secret-clear:apify_api_key"}
          pending={pending}
        />

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <LeadMagicMark className="size-3.5" />
          <span className="text-[11.5px] font-medium">LeadMagic</span>
          {status.secrets.leadmagic_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="LeadMagic API key"
          helper="Finds missing emails on the prospect table (Find Email). The LEADMAGIC_API_KEY environment variable also works."
          isSet={status.secrets.leadmagic_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your LeadMagic API key"
          value={secretDraft.leadmagic_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, leadmagic_api_key: next }))}
          onSave={() => saveSecret("leadmagic_api_key")}
          onClear={() => clearSecret("leadmagic_api_key")}
          savingSet={pending && busyId === "secret-set:leadmagic_api_key"}
          savingClear={pending && busyId === "secret-clear:leadmagic_api_key"}
          pending={pending}
        />

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <ZeroBounceMark className="size-3.5" />
          <span className="text-[11.5px] font-medium">ZeroBounce</span>
          {status.secrets.zerobounce_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="ZeroBounce API key"
          helper="Validates email deliverability on the prospect table (Validate Email). The ZEROBOUNCE_API_KEY environment variable also works."
          isSet={status.secrets.zerobounce_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your ZeroBounce API key"
          value={secretDraft.zerobounce_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, zerobounce_api_key: next }))}
          onSave={() => saveSecret("zerobounce_api_key")}
          onClear={() => clearSecret("zerobounce_api_key")}
          savingSet={pending && busyId === "secret-set:zerobounce_api_key"}
          savingClear={pending && busyId === "secret-clear:zerobounce_api_key"}
          pending={pending}
        />
      </AiCard>

      {/* Signals: the hiring-signal funnel's own providers — company research
          and the contact emails found before a lead is pushed to Enrichment. */}
      <AiCard
        title="Signals"
        icon={
          <span className="flex items-center gap-1.5">
            <ApolloMark className="size-4" />
            <FirecrawlMark className="size-4" />
          </span>
        }
        description="Providers behind the hiring-signal funnel: company research and contact emails. Stored encrypted; the matching environment variables also keep working."
      >
        <div className="flex items-center gap-2">
          <ApolloMark className="size-3.5" />
          <span className="text-[11.5px] font-medium">Apollo</span>
          {status.secrets.apollo_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="Apollo API key"
          helper="Finds the work email for a picked contact before the lead list is pushed to Enrichment (LeadMagic runs next if Apollo misses). Create a master API key under Settings → Integrations → API in Apollo. The APOLLO_API_KEY environment variable also works."
          isSet={status.secrets.apollo_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your Apollo API key"
          value={secretDraft.apollo_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, apollo_api_key: next }))}
          onSave={() => saveSecret("apollo_api_key")}
          onClear={() => clearSecret("apollo_api_key")}
          savingSet={pending && busyId === "secret-set:apollo_api_key"}
          savingClear={pending && busyId === "secret-clear:apollo_api_key"}
          pending={pending}
        />

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <FirecrawlMark className="size-3.5" />
          <span className="text-[11.5px] font-medium">Firecrawl</span>
          {status.secrets.firecrawl_api_key ? (
            <StatusBadge tone="success">Configured</StatusBadge>
          ) : (
            <StatusBadge tone="muted">Not set</StatusBadge>
          )}
        </div>

        <SecretField
          label="Firecrawl API key"
          helper="Researches each surviving company (finds and reads its website) before scoring. The FIRECRAWL_API_KEY environment variable also works."
          isSet={status.secrets.firecrawl_api_key}
          encryptionDisabled={encDisabled}
          placeholderUnset="Paste your Firecrawl API key"
          value={secretDraft.firecrawl_api_key}
          onChange={(next) => setSecretDraft((prev) => ({ ...prev, firecrawl_api_key: next }))}
          onSave={() => saveSecret("firecrawl_api_key")}
          onClear={() => clearSecret("firecrawl_api_key")}
          savingSet={pending && busyId === "secret-set:firecrawl_api_key"}
          savingClear={pending && busyId === "secret-clear:firecrawl_api_key"}
          pending={pending}
        />

        <p className="border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Signals also uses the Apify token above (job scraping and LinkedIn rosters) and LeadMagic as the
          second email provider.
        </p>
      </AiCard>
      </div>
    </section>
  );
}

/* ── Workspace section ────────────────────────────────────────────────── */
/* Common IANA zones offered in the picker; any other id is entered via the
   "Custom…" free-text field (same pattern as the AI model picker). */
const TZ_PRESETS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
] as const;
const TZ_CUSTOM = "__custom__";

/* Same initials logic as shell-controls.tsx ShellControls. */
function memberInitials(seed: string): string {
  return (
    seed
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function WorkspaceSection({
  settings,
  members,
  logoVersion,
  run,
  pending,
  busyId,
}: {
  settings: WorkspaceSettings;
  members: TeamMember[];
  logoVersion: string | null;
  run: (id: string | null, action: () => Promise<ActionResult>) => void;
  pending: boolean;
  busyId: string | null;
}) {
  // Server value is the dirty-tracking baseline; re-seeds on fresh server data.
  const [baseline, setBaseline] = useState<WorkspaceSettings>(settings);
  const [form, setForm] = useState<WorkspaceSettings>(settings);
  // UI-only: whether the timezone picker is in "Custom…" (free-text) mode.
  const [customZone, setCustomZone] = useState<boolean>(
    !(TZ_PRESETS as readonly string[]).includes(settings.timeZone),
  );

  // Invite form (never part of the settings diff).
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");

  /* eslint-disable react-hooks/set-state-in-effect -- re-seed the editable
     form whenever the server sends fresh settings (same pattern as AiSection). */
  useEffect(() => {
    setBaseline(settings);
    setForm(settings);
    setCustomZone(!(TZ_PRESETS as readonly string[]).includes(settings.timeZone));
  }, [settings]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const set = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Normalized snapshot: trim text, collapse empty required fields to defaults.
  const normalized: WorkspaceSettings = {
    workspaceName: form.workspaceName.trim(),
    tagline: form.tagline.trim(),
    timeZone: (customZone ? form.timeZone.trim() : form.timeZone) || "UTC",
    timeLocale: form.timeLocale.trim() || "en-US",
  };

  const patch: Partial<WorkspaceSettings> = {};
  (Object.keys(normalized) as (keyof WorkspaceSettings)[]).forEach((key) => {
    if (normalized[key] !== baseline[key]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (patch as any)[key] = normalized[key];
    }
  });
  const dirty = Object.keys(patch).length > 0;
  const canSave = dirty && normalized.workspaceName.length > 0;
  const saving = pending && busyId === "workspace-settings";

  const save = () => {
    if (!canSave) return;
    run("workspace-settings", async () => {
      const result = await updateWorkspaceSettingsAction(patch);
      if (result.ok) {
        setBaseline(normalized);
        setForm(normalized);
        setCustomZone(!(TZ_PRESETS as readonly string[]).includes(normalized.timeZone));
      }
      return result;
    });
  };

  const zoneSelectValue = customZone
    ? TZ_CUSTOM
    : (TZ_PRESETS as readonly string[]).includes(form.timeZone)
      ? form.timeZone
      : TZ_CUSTOM;

  const onZoneSelect = (value: string) => {
    if (value === TZ_CUSTOM) {
      setCustomZone(true);
      set("timeZone", "");
    } else {
      setCustomZone(false);
      set("timeZone", value);
    }
  };

  const invite = () => {
    const email = inviteEmail.trim();
    if (!email) return;
    run("invite", async () => {
      const result = await inviteMemberAction(email, inviteName.trim() || null);
      if (result.ok) {
        setInviteEmail("");
        setInviteName("");
      }
      return result;
    });
  };

  const setMemberActive = (member: TeamMember, active: boolean) => {
    run(`member:${member.id}`, () => setMemberActiveAction(member.id, active));
  };

  // Logo upload/remove (never part of the settings diff — applies immediately).
  const logoInputRef = useRef<HTMLInputElement>(null);
  const logoBusy = pending && (busyId === "logo-upload" || busyId === "logo-remove");

  const onLogoFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file after an error
    if (!file) return;
    const data = new FormData();
    data.append("logo", file);
    run("logo-upload", () => uploadWorkspaceLogoAction(data));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold tracking-tight">Workspace</h2>
        <p className="max-w-4xl text-[12px] leading-relaxed text-muted-foreground">
          Name this deployment, choose how dates and times are displayed, and manage who can sign in.
        </p>
      </div>

      {/* Workspace + Team sit side by side as soon as the width allows */}
      <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
      {/* Workspace */}
      <AiCard
        title="Workspace"
        description="Branding and formatting for everyone who uses this deployment."
      >
        <Field label="Workspace name" helper="Shown in the sidebar, login page, and browser tab">
          <input
            value={form.workspaceName}
            onChange={(event) => set("workspaceName", event.target.value)}
            placeholder="Coldstack"
            maxLength={60}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="Tagline">
          <input
            value={form.tagline}
            onChange={(event) => set("tagline", event.target.value)}
            placeholder="Reply review portal"
            maxLength={120}
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          label="Logo"
          helper="PNG, JPEG, WebP, or SVG up to 256 KB. Replaces the icon in the top-left of the sidebar."
        >
          <div className="flex items-center gap-2.5">
            <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
              {logoVersion ? (
                <Image
                  src={`/api/branding/logo?v=${encodeURIComponent(logoVersion)}`}
                  alt="Workspace logo"
                  width={40}
                  height={40}
                  unoptimized
                  className="size-full object-contain"
                />
              ) : (
                <ImageIcon className="size-4 text-muted-foreground" strokeWidth={1.75} />
              )}
            </span>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={onLogoFile}
              className="hidden"
            />
            <button
              type="button"
              disabled={logoBusy}
              onClick={() => logoInputRef.current?.click()}
              className={`${BTN_OUTLINE} h-7 px-2.5 text-[11.5px]`}
            >
              {logoVersion ? "Replace logo" : "Upload logo"}
            </button>
            {logoVersion ? (
              <button
                type="button"
                disabled={logoBusy}
                onClick={() => run("logo-remove", () => removeWorkspaceLogoAction())}
                className={`${BTN_SUBTLE} h-7 px-2 text-[11.5px] hover:text-destructive`}
              >
                Remove
              </button>
            ) : null}
          </div>
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Display timezone">
            <div className="relative">
              <select
                value={zoneSelectValue}
                onChange={(event) => onZoneSelect(event.target.value)}
                className={SELECT_CLASS}
              >
                {TZ_PRESETS.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
                <option value={TZ_CUSTOM}>Custom…</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
            {customZone ? (
              <input
                value={form.timeZone}
                onChange={(event) => set("timeZone", event.target.value)}
                placeholder="e.g. America/Toronto"
                maxLength={64}
                className={`${INPUT_CLASS} mt-1.5 font-mono`}
              />
            ) : null}
          </Field>

          <Field label="Locale" helper="Formats dates and times">
            <input
              value={form.timeLocale}
              onChange={(event) => set("timeLocale", event.target.value)}
              placeholder="en-US"
              maxLength={20}
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-3">
          {dirty ? (
            <span className="text-[11px] text-muted-foreground">Unsaved changes</span>
          ) : null}
          <button
            type="button"
            disabled={!canSave || saving}
            onClick={save}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Check className="size-3.5" />
            Save changes
          </button>
        </div>
      </AiCard>

      {/* Team */}
      <AiCard
        title="Team"
        description="People who can sign in to this workspace."
      >
        <div className="flex flex-col gap-1.5">
          {members.map((member) => {
            const busy = pending && busyId === `member:${member.id}`;
            const displayName = member.fullName || member.email.split("@")[0];
            return (
              <div
                key={member.id}
                className={`flex items-center gap-3 rounded-md bg-surface px-3 py-2 ${
                  member.isActive ? "" : "opacity-60"
                }`}
              >
                <Avatar
                  email={member.email}
                  initials={memberInitials(member.fullName || member.email)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium">{displayName}</span>
                    {member.isSelf ? (
                      <span className="rounded bg-accent px-1.5 py-px text-[10px] font-semibold text-accent-foreground">
                        You
                      </span>
                    ) : null}
                    {!member.isActive ? (
                      <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                        Inactive
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-[10.5px] text-muted-foreground">{member.email}</div>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {member.isActive ? "Active" : "Inactive"}
                </span>
                <Toggle
                  checked={member.isActive}
                  disabled={busy || member.isSelf}
                  onChange={(next) => setMemberActive(member, next)}
                  label={member.isActive ? `Deactivate ${displayName}` : `Reactivate ${displayName}`}
                />
              </div>
            );
          })}

          {members.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">
              No members yet.
            </div>
          ) : null}
        </div>

        {/* Invite */}
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <span className="text-[11.5px] font-medium">Invite a member</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="name@example.com"
              maxLength={200}
              autoComplete="off"
              className={`${INPUT_CLASS} flex-1`}
            />
            <input
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="Full name (optional)"
              maxLength={120}
              className={`${INPUT_CLASS} flex-1`}
            />
            <button
              type="button"
              disabled={pending || !inviteEmail.trim()}
              onClick={invite}
              className={`${BTN_PRIMARY} h-8 shrink-0 px-3 text-[12px]`}
            >
              <Plus className="size-3.5" />
              {pending && busyId === "invite" ? "Inviting…" : "Invite"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Members sign in with a magic link. Auth accounts are shared across apps on the same
            Supabase project.
          </p>
        </div>
      </AiCard>
      </div>
    </section>
  );
}


/* ── Inbox provisioning defaults ─────────────────────────────────────────
   Workspace-wide forwarding domain: the provisioning watcher points every new
   batch's sending domains here automatically, and "apply to all" re-points the
   whole Zapmail inventory on demand (explicit click, never automatic). */
function InboxProvisioningCard() {
  const [forwarding, setForwarding] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"save" | "apply" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await getInboxProvisioningAction();
        if (result.ok && result.config) setForwarding(result.config.forwardingDomain);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const act = async (kind: "save" | "apply", fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(kind);
    setNote(null);
    try {
      const result = await fn();
      setNote({ ok: result.ok, text: result.message });
    } catch {
      setNote({ ok: false, text: "The action failed. Try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-4 rounded-xl bg-surface p-4 shadow-xs">
      <h3 className="text-[13px] font-semibold">Inbox provisioning</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
        Every sending domain's website redirect points here. New batches from the buy wizard get it
        automatically; "Apply to all" re-points every active Zapmail domain now.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={forwarding}
          onChange={(event) => setForwarding(event.target.value)}
          disabled={!loaded}
          placeholder="example.com"
          aria-label="Forwarding domain"
          className={`${INPUT_CLASS} h-8 w-64 text-[12.5px]`}
        />
        <button
          type="button"
          disabled={busy !== null || !loaded}
          onClick={() => void act("save", () => saveInboxProvisioningAction(forwarding))}
          className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
        >
          {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save
        </button>
        <button
          type="button"
          disabled={busy !== null || !loaded || !forwarding.trim()}
          onClick={() => void act("apply", applyForwardingToAllDomainsAction)}
          className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
        >
          {busy === "apply" ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Apply to all domains
        </button>
        {note ? (
          <span className={`text-[12px] ${note.ok ? "text-success" : "text-destructive"}`}>{note.text}</span>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Warmup tags stay automatic: each new inbox gets a random two-word five-letter tag, rotated on the existing schedule.
      </p>
    </section>
  );
}
