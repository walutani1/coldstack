"use client";

/* The Enrichment worktable: a server-paginated, virtualized lead grid ported
   from the Clay prototype onto this app's design grammar and the frozen
   enrichment action contracts.

   Consensus-locked semantics honored here:
   - every run (single cell or bulk) carries a run_id; bulk runs share one
   - writeback outcomes: written patches locally, stale refetches the row,
     duplicate counts as success, not_found surfaces an error
   - auth failures stop a whole bulk run with a single toast
   - bulk concurrency follows the per-provider runner config, with a global
     per-provider pause plus jittered resume when a provider rate limits
   - CSV export is assembled client-side against the current filters with
     formula-injection guards
   - browser storage is namespaced enrichment:<table-uuid>:v1:* (with a
     one-time copy from the legacy slug-based prefix)
   - Smartlead exports go to the table's server-side campaign tag; a
     campaign-changed rejection stops a bulk run like an auth failure */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Ban,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronDown,
  Coins,
  Download,
  ExternalLink,
  FolderInput,
  GripVertical,
  History,
  Loader2,
  ClipboardCheck,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Tag,
  Trash2,
  UserMinus,
  X,
} from "lucide-react";
import {
  addSuppressionAction,
  cancelRunJobAction,
  createCustomColumnAction,
  createRunJobAction,
  createTableAction,
  deleteCustomColumnAction,
  deleteTableAction,
  deleteViewAction,
  exportLeadToSmartleadAction,
  getEmailReviewModeAction,
  getTableSpendAction,
  getLatestRunJobForTableAction,
  getReviewQueueAction,
  getRunJobAction,
  getRunJobActiveLeadIdsAction,
  setEmailReviewModeAction,
  getEnrichmentLeadsPageAction,
  getEnrichmentMetaAction,
  getEnrichmentSettingsAction,
  getModelOptionsAction,
  setColumnModelsAction,
  getLeadDetailAction,
  getLeadRunsAction,
  listViewsAction,
  moveTableAction,
  previewCustomColumnPromptAction,
  renameTableAction,
  reorderTableAction,
  createEmailReviewColumnAction,
  createTitleCheckColumnAction,
  getEmailQaDetailsAction,
  removeLeadFromCampaignAction,
  reorderColumnsAction,
  runCustomColumnAction,
  runEmailQaAction,
  runFindEmailAction,
  runTitleCheckAction,
  runLinkedinVerifyAction,
  runPersonalizationAction,
  runValidateEmailAction,
  saveEnrichmentSettingsAction,
  saveViewAction,
  setTableCampaignAction,
  updateCustomColumnAction,
} from "./actions";
import {
  CampaignTagDialog,
  CustomColumnEditorDialog,
  type ModelOption,
  EmailQaDialog,
  ExportSettingsDialog,
  LeadDetailDialog,
  MoveToWorkbookDialog,
  NewTableDialog,
  Pill,
  ColumnModelDialog,
  PromptEditorDialog,
  ProspectSettingsDialog,
  RenameTableDialog,
  RunDetailsDialog,
  RunHistoryDialog,
  SaveViewDialog,
  SuppressionsDialog,
  runModesFor,
  type LeadDetailState,
  type RunDetails,
  type RunHistoryState,
} from "./enrichment-dialogs";
import { EmailReviewModal } from "./email-review-modal";
import {
  ACTION_LABELS,
  BTN_OUTLINE,
  BTN_SUBTLE,
  CSV_COLUMNS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_FILTERS,
  INPUT_CLASS,
  PAGE_SIZE,
  ROW_HEIGHT_ESTIMATE,
  ROW_OVERSCAN,
  RUN_MODE_LABELS,
  SELECT_CLASS,
  TABLE_COLUMNS,
  contactMeta,
  csvField,
  decodeViewConfig,
  emailStatusLabel,
  emailStatusTone,
  linkedinStatusPill,
  readCompanySummary,
  AUTORUN_ORDER,
  AI_MODEL_OPTIONS,
  autorunEligible,
  BUILTIN_RUN_ACTION,
  encodeCanonicalFilter,
  encodeViewConfig,
  errorMessage,
  getQualification,
  isAiPromptColumn,
  MODEL_VENDOR_LABEL,
  modelVendor,
  shortModelName,
  isCellStale,
  isAuthFailure,
  isCampaignChangedFailure,
  leadName,
  makeStorageKeys,
  migrateLegacyStorage,
  normalizeRunResult,
  promptVariablesFor,
  type AiPromptColumn,
  type CampaignTag,
  type CellResult,
  type ColumnDef,
  type ColumnId,
  type CustomColumn,
  type EmailQaDetails,
  type EnrichmentLead,
  type NormalizationExample,
  type EnrichmentView,
  type FilterOptions,
  type Filters,
  type RunStateFilter,
  type LayoutVersion,
  type NormalizedResult,
  type Qualification,
  type RunMode,
  type RunnableAction,
  type RunnerSettings,
  type SegmentStats,
  type SheetTab,
  type SmartleadCampaignOption,
  type SortKey,
  type SortState,
  type SuppressionKind,
  type WorkbookOption,
  type WorkbookRef,
} from "./enrichment-model";
import { RunnerToggle, type RunnerToggleConfig } from "./runner-toggle";
import { VendorMark } from "../brand-marks";
import { useToast } from "../toast";

const COLUMN_MIN_WIDTHS = Object.fromEntries(
  TABLE_COLUMNS.map((column) => [column.id, column.minWidth]),
) as Record<ColumnId, number>;
const COLUMN_MAX_WIDTH = 640;

const MENU_ITEM = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/60`;

/* ── v2 layout: dynamic per-table columns ──────────────────────────────
   A v2 table's "builtin" columns reuse the exact same runnable-action cells
   as v1 (the TABLE_COLUMNS defs already carry sortKey/runAction per id); a
   v2 column just picks which of these ids to show, in its own order. */
const TABLE_COLUMNS_BY_ID = Object.fromEntries(TABLE_COLUMNS.map((column) => [column.id, column])) as Record<
  ColumnId,
  ColumnDef
>;
const V2_BUILTIN_KEYS = new Set<string>([
  "contact",
  "company",
  "email",
  "linkedin",
  "validate_email",
  "email_status",
  "find_email",
  "final_first_name",
  "final_company_name",
  "smartlead_export",
]);
function isV2BuiltinKey(key: string): key is ColumnId {
  return V2_BUILTIN_KEYS.has(key);
}

/* Token + time accounting (mirror of the server TableSpend shape). */
type SpendRoute = { tokens: number; inputTokens: number; outputTokens: number; durationMs: number; cells: number };
type SpendColumn = { key: string; label: string; tokens: number; durationMs: number; cells: number };
type TableSpend = { total: SpendRoute; api: SpendRoute; cli: SpendRoute; columns: SpendColumn[] };

/* Compact number formatting for the spend chip: 486, 12.3k, 1.2M. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}
/* Human duration: 8s, 4m 10s, 1h 3m. */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/* One step of the autorun chain: either a built-in runnable action or a custom
   column (AI / title check / email review). For v2 the chain is derived from the
   table's visible columns in their left-to-right order, so reordering columns
   reorders the flow. */
type AutorunStep = { key: string; action?: RunnableAction; column?: CustomColumn };
/* What a custom-column run applied: the customCells delta plus the generation of
   each written cell, so a just-run cell is not mistaken for stale before refetch. */
/* Mirrors the server orchestrator's StepStatus so a manual single-cell chain and
   a bulk waterfall make the SAME call about whether to keep going:
   - applied: the step wrote something (real progress).
   - noop:    it ran and correctly had nothing to write, or it is blocked waiting
              on a dependency. Not a failure - the chain moves on and the
              fixpoint retries a blocked step once its dependency fills.
   - failed:  a genuine error. Only this stops the row. */
type StepRunStatus = "applied" | "noop" | "failed";

type CustomStepOutcome = { status: StepRunStatus; patch: Record<string, string | null>; gens: Record<string, number> };

const V2_DEFAULT_WIDTH: Record<string, number> = {
  contact: 220,
  company: 200,
  company_summary: 260,
  email: 210,
  linkedin: 170,
  linkedin_url: 190,
  validate_email: 190,
  email_status: 130,
  find_email: 190,
  final_first_name: 170,
  final_company_name: 200,
  smartlead_export: 210,
};
const V2_AI_COLUMN_WIDTH = 240;
const V2_COLUMN_MIN_WIDTH = 90;
function v2ColumnWidth(column: CustomColumn): number {
  if (column.kind === "ai") return V2_AI_COLUMN_WIDTH;
  return V2_DEFAULT_WIDTH[column.key] ?? 200;
}

type RunJobStatus = "materializing" | "pending" | "running" | "done" | "canceled" | "failed";
type RunJobView = {
  id: string;
  label: string;
  kind: "column" | "waterfall";
  total: number;
  done: number;
  failed: number;
  status: RunJobStatus;
};

// `up` records that the menu was flipped above its anchor, so the open
// animation can grow from the corner it is actually attached to.
type AnchoredMenu = { left: number; top: number; up?: boolean };
type RunMenuState = AnchoredMenu & { action: RunnableAction };

function formatExportTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* "Run a specific number of rows" prompt: how many rows, and an optional 1-based
   starting row (blank = top). Runs in the current filtered/sorted order. */
function CountRunDialog({ label, onCancel, onRun }: { label: string; onCancel: () => void; onRun: (count: number, offset: number) => void }) {
  const [count, setCount] = useState("");
  const [startRow, setStartRow] = useState("");
  const parsedCount = Math.floor(Number(count));
  const validCount = count.trim() !== "" && Number.isFinite(parsedCount) && parsedCount >= 1;
  const parsedStart = startRow.trim() === "" ? 1 : Math.floor(Number(startRow));
  const validStart = Number.isFinite(parsedStart) && parsedStart >= 1;
  const canRun = validCount && validStart;
  const submit = () => { if (canRun) onRun(parsedCount, parsedStart - 1); };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Run a specific number of rows"
        className="anim-menu-in w-full max-w-sm rounded-lg border border-border bg-surface p-4 shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-[13px] font-semibold text-foreground">Run a specific number of rows</h3>
        <p className="mt-1 text-[11.5px] leading-4 text-muted-foreground">
          {label}. Runs in the current filtered order. Leave the starting row blank to begin at the top.
        </p>
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">How many rows</span>
            <input
              autoFocus type="number" min={1} inputMode="numeric" value={count}
              onChange={(event) => setCount(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              placeholder="e.g. 50" className={`${INPUT_CLASS} h-8 text-[12.5px]`}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Start at row (optional)</span>
            <input
              type="number" min={1} inputMode="numeric" value={startRow}
              onChange={(event) => setStartRow(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              placeholder="Top of the list" className={`${INPUT_CLASS} h-8 text-[12.5px]`}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>Cancel</button>
          <button
            type="button" disabled={!canRun} onClick={submit}
            className={`inline-flex h-8 items-center rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50`}
          >
            Run{validCount ? ` ${parsedCount.toLocaleString("en-US")}` : ""} rows
          </button>
        </div>
      </div>
    </div>
  );
}

/* Anchor a menu to the control that opened it, flipping above when there is not
   room below. The flip is not cosmetic: the sheet tabs sit at the bottom of the
   window, so their actions menu opens against the viewport edge and would be
   clipped without it.

   `panelHeight` is the caller's estimate, since the panel has not rendered yet.
   Overestimating is the safe direction - it flips a menu that would have just
   fit, rather than leaving one clipped. */
function menuPosition(event: ReactMouseEvent<HTMLButtonElement>, panelWidth: number, panelHeight = 0): AnchoredMenu {
  const rect = event.currentTarget.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 8;
  const flip = panelHeight > 0 && below < panelHeight && rect.top - 8 > below;
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8)),
    top: flip ? Math.max(8, rect.top - panelHeight - 4) : rect.bottom + 4,
    up: flip,
  };
}

const EXPORT_TAG_CAPTION = "Exports go to this list's campaign. Tag one first.";

function campaignTagKey(tag: CampaignTag | null): string {
  // source participates: clearing a table override that falls back to the
  // workbook's tag keeps the same id but must still reconcile the chip.
  return tag ? `${tag.id}:${tag.name}:${tag.source ?? "table"}` : "";
}

export function EnrichmentTable({
  tableId,
  tableSlug,
  tableName,
  workbook,
  siblings,
  campaignTag: serverCampaignTag,
  initialRows,
  initialTotal,
  initialStats,
  initialFilterOptions,
  campaigns,
  smartleadError,
  runnerConfig,
  isVercel,
  layoutVersion,
  columns,
}: {
  tableId: string;
  tableSlug: string;
  tableName: string;
  workbook: WorkbookRef;
  siblings: SheetTab[];
  campaignTag: CampaignTag | null;
  initialRows: EnrichmentLead[];
  initialTotal: number;
  initialStats: SegmentStats;
  initialFilterOptions: FilterOptions;
  campaigns: SmartleadCampaignOption[];
  smartleadError: boolean;
  /* Persisted enrichment runner config for the header's API/CLI toggle; null
     when the server could not load it (the toggle then does not render). */
  runnerConfig: RunnerToggleConfig | null;
  isVercel: boolean;
  /* "v1" (default, every table today) keeps the hardcoded grid below
     completely untouched. "v2" renders the dynamic per-table column layout
     from `columns` instead - see the layoutVersion branch in the Grid
     section. */
  layoutVersion: LayoutVersion;
  columns: CustomColumn[];
}) {
  const router = useRouter();
  const storageKeys = useMemo(() => makeStorageKeys(tableId), [tableId]);

  /* ── Data ── */
  const [leads, setLeads] = useState<EnrichmentLead[]>(initialRows);
  const [totalRows, setTotalRows] = useState(initialTotal);
  const [stats, setStats] = useState<SegmentStats>(initialStats);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(initialFilterOptions);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  /* ── Filters + sort ── */
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortState>(null);
  const filtersRestoredRef = useRef(false);
  const filtersInitializedRef = useRef(false);

  /* ── Column widths ── */
  const [columnWidths, setColumnWidths] = useState<Record<ColumnId, number>>(DEFAULT_COLUMN_WIDTHS);
  // Per-column width overrides for the v2 grid (keyed by column id).
  const [v2ColumnWidths, setV2ColumnWidths] = useState<Record<string, number>>({});
  const widthsRestoredRef = useRef(false);
  const resizeRafRef = useRef<number | null>(null);

  /* ── Per-cell run state (persisted to sessionStorage for the session) ── */
  const [cellResults, setCellResults] = useState<Record<string, CellResult>>({});
  const [lastRowResults, setLastRowResults] = useState<Record<string, CellResult>>({});
  const [rowPatches, setRowPatches] = useState<Record<string, Partial<EnrichmentLead>>>({});
  // Autorun: after a manual cell run, chain the row's remaining eligible steps.
  // On by default (matches the previous app); the preference is remembered.
  const [autorun, setAutorun] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("prospects:autorun");
      if (stored != null) setAutorun(stored === "1");
    } catch {
      /* private mode / storage disabled: keep the default */
    }
  }, []);
  const toggleAutorun = () =>
    setAutorun((current) => {
      const next = !current;
      try {
        window.localStorage.setItem("prospects:autorun", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  // Auto-export: when the autorun chain reaches the export step and the email
  // review passed, push to Smartlead automatically. Off by default; remembered.
  const [autoExport, setAutoExport] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("prospects:autoExport");
      if (stored != null) setAutoExport(stored === "1");
    } catch { /* ignore */ }
  }, []);
  const toggleAutoExport = () =>
    setAutoExport((current) => {
      const next = !current;
      try { window.localStorage.setItem("prospects:autoExport", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  const runStateRestoredRef = useRef(false);
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());

  /* ── Durable run jobs (server-side concurrency; survives refresh) ── */
  const [runJob, setRunJob] = useState<RunJobView | null>(null);
  const runJobIdRef = useRef<string | null>(null);
  const runJobPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The job id the "Errored (last run)" filter reads (latest run for this table).
  const runStateErroredJobIdRef = useRef<string | null>(null);
  // The job id the "Queued (current run)" filter reads (re-resolved on each pick).
  const runStateQueuedJobIdRef = useRef<string | null>(null);
  // The active run's start column, and the pendingCells keys the run poller added
  // for in-flight rows (only these are swapped each poll, so interactive
  // single-cell runs keep their own spinners untouched).
  const runJobStartKeyRef = useRef<string | null>(null);
  const runPendingKeysRef = useRef<Set<string>>(new Set());
  // Lead ids the run had in flight on the previous poll; rows that leave this
  // set just finished and get refreshed in place.
  const runActiveLeadsRef = useRef<Set<string>>(new Set());
  // The step each in-flight row was on last poll: a change means the previous
  // cell finished writing, so that row is refreshed mid-run.
  const runActiveStepsRef = useRef<Map<string, string | null>>(new Map());
  // "Run a specific number of rows" dialog (count + starting row) for a column.
  const [countRunDialog, setCountRunDialog] = useState<{ columnKey: string; label: string } | null>(null);
  // Email review (manual approval before export): queue count + modal + mode toggle.
  const [reviewCount, setReviewCount] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [emailReviewMode, setEmailReviewMode] = useState<"manual" | "auto" | null>(null);
  // Token + time spend: footer preview + click-through API/CLI breakdown.
  const [spend, setSpend] = useState<TableSpend | null>(null);
  const [spendOpen, setSpendOpen] = useState(false);
  // Email-health breakdown, opened from the same status bar as spend.
  const [healthOpen, setHealthOpen] = useState(false);
  // The QA gate's model editor. Its own column, since the gate has no prompt to
  // edit alongside it (those are assembled in code per lead).
  const [qaModelColumn, setQaModelColumn] = useState<CustomColumn | null>(null);
  const [qaModelPending, setQaModelPending] = useState(false);

  /* ── Custom AI columns (v2 layout only; unused and inert on v1 tables) ── */
  const [customColumns, setCustomColumns] = useState<CustomColumn[]>(columns);
  // Latest columns for buildPageArgs' run-state lookup, read without making it a
  // reload dependency.
  const customColumnsRef = useRef(customColumns);
  useEffect(() => { customColumnsRef.current = customColumns; }, [customColumns]);
  const [columnEditor, setColumnEditor] = useState<{ mode: "create" } | { mode: "edit"; column: CustomColumn } | null>(
    null,
  );
  const [columnEditorPending, setColumnEditorPending] = useState(false);
  /* Models offered by the column editor. Fetched lazily when the editor opens
     (an event, not an effect) and kept for the life of the view: the gateway's
     served list changes on the order of days, not clicks. */
  const [modelChoices, setModelChoices] = useState<{
    apiModels: ModelOption[];
    cliModels: ModelOption[];
    cliMode: boolean;
    source: "gateway" | "catalog";
    loading: boolean;
  }>({
    apiModels: AI_MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label, group: m.provider })),
    cliModels: [],
    cliMode: false,
    source: "catalog",
    loading: false,
  });
  const loadModelChoices = async () => {
    if (modelChoices.source === "gateway" || modelChoices.loading) return;
    setModelChoices((prev) => ({ ...prev, loading: true }));
    try {
      const result = await getModelOptionsAction();
      setModelChoices(
        result.ok && result.apiModels && result.cliModels
          ? {
              apiModels: result.apiModels,
              cliModels: result.cliModels,
              cliMode: Boolean(result.cliMode),
              source: result.source === "gateway" ? "gateway" : "catalog",
              loading: false,
            }
          : (prev) => ({ ...prev, loading: false }),
      );
    } catch {
      setModelChoices((prev) => ({ ...prev, loading: false }));
    }
  };
  const [columnDeletePending, setColumnDeletePending] = useState(false);
  const [columnRunMenu, setColumnRunMenu] = useState<(AnchoredMenu & { column: CustomColumn }) | null>(null);
  const [summaryPopover, setSummaryPopover] = useState<(AnchoredMenu & { whatTheyMake: string; markets: string; summary: string }) | null>(
    null,
  );
  // Click-to-read popover for an AI cell's full value (no need to widen the column).
  const [valuePopover, setValuePopover] = useState<(AnchoredMenu & { label: string; value: string }) | null>(null);

  /* ── Settings (runner config + prompts), fetched lazily and cached ── */
  const [settings, setSettings] = useState<RunnerSettings | null>(null);
  const settingsRef = useRef<RunnerSettings | null>(null);
  // Header API/CLI toggle state: seeded from the server prop, kept in sync
  // with the settings dialog's saves; re-seeds when the server sends a fresh
  // prop (adjust-during-render, same idiom as the campaign tag below).
  const [runner, setRunner] = useState<RunnerToggleConfig | null>(runnerConfig);
  const [syncedRunner, setSyncedRunner] = useState<RunnerToggleConfig | null>(runnerConfig);
  if (runnerConfig !== syncedRunner) {
    setSyncedRunner(runnerConfig);
    setRunner(runnerConfig);
  }
  const [promptColumn, setPromptColumn] = useState<AiPromptColumn | null>(null);
  const [promptSavePending, setPromptSavePending] = useState(false);

  /* ── Campaign tag (per-list Smartlead target, server-side source of truth) ── */
  const [campaignTag, setCampaignTag] = useState<CampaignTag | null>(serverCampaignTag);
  const [tagDialog, setTagDialog] = useState<{ caption?: string } | null>(null);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [tagPending, setTagPending] = useState(false);
  // Adjust-during-render (the sanctioned "state from props" pattern, no
  // effect involved): after router.refresh() the server prop is truth again.
  const [prevServerTagKey, setPrevServerTagKey] = useState(campaignTagKey(serverCampaignTag));
  const serverTagKey = campaignTagKey(serverCampaignTag);
  if (serverTagKey !== prevServerTagKey) {
    setPrevServerTagKey(serverTagKey);
    setCampaignTag(serverCampaignTag);
  }

  /* ── Sheet tabs (workbook tables) ── */
  const [tabMenu, setTabMenu] = useState<AnchoredMenu | null>(null);
  const [tabDeleteArmed, setTabDeleteArmed] = useState(false);
  const [newTableOpen, setNewTableOpen] = useState(false);
  const [renameTableOpen, setRenameTableOpen] = useState(false);
  const [moveTableOpen, setMoveTableOpen] = useState(false);
  const [tablePending, setTablePending] = useState(false);

  /* ── Views ── */
  const [views, setViews] = useState<EnrichmentView[]>([]);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewSavePending, setViewSavePending] = useState(false);

  /* ── Dialogs + menus ── */
  const [runDetails, setRunDetails] = useState<RunDetails | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryState | null>(null);
  const runHistoryTokenRef = useRef(0);
  const [leadDetail, setLeadDetail] = useState<LeadDetailState | null>(null);
  const leadDetailTokenRef = useRef(0);
  const [suppressPending, setSuppressPending] = useState(false);
  const [suppressionsOpen, setSuppressionsOpen] = useState(false);
  const [prospectSettingsOpen, setProspectSettingsOpen] = useState(false);
  const [csvPending, setCsvPending] = useState(false);
  const [runMenu, setRunMenu] = useState<RunMenuState | null>(null);
  const [viewsMenu, setViewsMenu] = useState<AnchoredMenu | null>(null);

  /* ── Virtualization ── */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);

  const showToast = useToast();

  /* ── Storage restore (deferred a tick so no setState runs synchronously
        inside the effect body, and SSR markup stays deterministic) ── */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        // Idempotent one-time copy from the legacy slug-based prefix.
        migrateLegacyStorage(storageKeys, tableSlug, workbook.slug);
        const raw = window.sessionStorage.getItem(storageKeys.runState);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            cellResults?: Record<string, CellResult>;
            lastRowResults?: Record<string, CellResult>;
            rowPatches?: Record<string, Partial<EnrichmentLead>>;
          };
          setCellResults(parsed.cellResults ?? {});
          setLastRowResults(parsed.lastRowResults ?? {});
          setRowPatches(parsed.rowPatches ?? {});
        }
      } catch {
        window.sessionStorage.removeItem(storageKeys.runState);
      } finally {
        runStateRestoredRef.current = true;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKeys, tableSlug, workbook.slug]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        migrateLegacyStorage(storageKeys, tableSlug, workbook.slug);
        const raw = window.localStorage.getItem(storageKeys.columnWidths);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<Record<ColumnId, number>>;
          setColumnWidths((current) => {
            const next = { ...current };
            for (const column of TABLE_COLUMNS) {
              const stored = parsed[column.id];
              if (typeof stored === "number" && Number.isFinite(stored)) {
                next[column.id] = Math.round(Math.min(COLUMN_MAX_WIDTH, Math.max(column.minWidth, stored)));
              }
            }
            return next;
          });
        }
      } catch {
        window.localStorage.removeItem(storageKeys.columnWidths);
      } finally {
        widthsRestoredRef.current = true;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKeys, tableSlug, workbook.slug]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        migrateLegacyStorage(storageKeys, tableSlug, workbook.slug);
        const raw = window.localStorage.getItem(storageKeys.filters);
        if (raw) {
          const decoded = decodeViewConfig(JSON.parse(raw) as Record<string, unknown>);
          setFilters(decoded.filters);
          setSort(decoded.sort);
        }
      } catch {
        window.localStorage.removeItem(storageKeys.filters);
      } finally {
        filtersRestoredRef.current = true;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKeys, tableSlug, workbook.slug]);

  /* ── Storage persistence (guarded so the restore is never clobbered) ── */
  useEffect(() => {
    if (!runStateRestoredRef.current) return;
    try {
      window.sessionStorage.setItem(storageKeys.runState, JSON.stringify({ cellResults, lastRowResults, rowPatches }));
    } catch {
      // Quota exceeded after a large bulk run: drop persistence rather than crash.
      window.sessionStorage.removeItem(storageKeys.runState);
    }
  }, [cellResults, lastRowResults, rowPatches, storageKeys]);

  useEffect(() => {
    if (!widthsRestoredRef.current) return;
    window.localStorage.setItem(storageKeys.columnWidths, JSON.stringify(columnWidths));
  }, [columnWidths, storageKeys]);

  useEffect(() => {
    if (!filtersRestoredRef.current) return;
    window.localStorage.setItem(storageKeys.filters, JSON.stringify(encodeViewConfig(filters, sort)));
  }, [filters, sort, storageKeys]);

  /* ── Saved views (scoped to this table) ── */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listViewsAction(tableId);
      const loadedViews = result.ok ? result.views : undefined;
      if (!cancelled && loadedViews) setViews(loadedViews);
    })();
    return () => {
      cancelled = true;
    };
  }, [tableId]);

  /* ── Paging ── */
  const buildPageArgs = useCallback(
    (offset: number) => {
      const cellState = filters.runState === "not_run" || filters.runState === "done" || filters.runState === "outdated" ? filters.runState : null;
      // Read columns via ref so column edits do not force a page reload (only a
      // filter change should); the resolved id/generation is captured at load time.
      const runStateColumn = cellState ? customColumnsRef.current.find((c) => c.key === filters.runStateColumnKey) : undefined;
      return {
        tableId,
        limit: PAGE_SIZE,
        offset,
        search: filters.search.trim() || null,
        roleLevels: filters.roleLevel === "all" ? [] : [filters.roleLevel],
        emailStatuses: filters.emailStatus === "all" ? [] : [filters.emailStatus],
        countries: filters.country === "all" ? [] : [filters.country],
        hasEmail: filters.hasEmail === "all" ? null : filters.hasEmail === "has",
        qualifiedOnly: filters.qualifiedOnly,
        sort: sort?.key ?? null,
        sortDir: sort?.dir ?? ("asc" as const),
        cellColumnId: runStateColumn?.id ?? null,
        cellState: runStateColumn ? cellState : null,
        cellGeneration: runStateColumn?.generationVersion ?? null,
        erroredJobId: filters.runState === "errored" ? runStateErroredJobIdRef.current : null,
        queuedJobId: filters.runState === "queued" ? runStateQueuedJobIdRef.current : null,
      };
    },
    [filters, sort, tableId],
  );

  const loadPage = useCallback(
    async ({ offset, replace = false }: { offset: number; replace?: boolean }) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setIsLoadingRows(true);
      setLoadError(null);
      try {
        const result = await getEnrichmentLeadsPageAction(buildPageArgs(offset));
        const page = result.ok ? result.page : undefined;
        if (!page) throw new Error(result.message || "Could not load rows.");
        setTotalRows(page.totalCount);
        setLeads((current) => {
          if (replace) return page.rows;
          const seen = new Set(current.map((lead) => lead.id));
          return [...current, ...page.rows.filter((lead) => !seen.has(lead.id))];
        });
        if (replace) {
          setScrollTop(0);
          if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
        }
      } catch (error) {
        setLoadError(errorMessage(error, "Could not load rows."));
      } finally {
        loadingRef.current = false;
        setIsLoadingRows(false);
      }
    },
    [buildPageArgs],
  );

  // Debounced reload whenever filters or sort change (skipping the initial
  // server-rendered page).
  useEffect(() => {
    if (!filtersInitializedRef.current) {
      filtersInitializedRef.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      void loadPage({ offset: 0, replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadPage]);

  const refreshMeta = useCallback(async () => {
    const result = await getEnrichmentMetaAction(tableId);
    if (result.ok && result.segmentStats && result.filterOptions) {
      setStats(result.segmentStats);
      setFilterOptions(result.filterOptions);
    }
  }, [tableId]);

  const refreshRow = useCallback(async (leadId: string) => {
    const result = await getLeadDetailAction(leadId);
    const fresh = result.ok ? result.lead : undefined;
    if (!fresh) return;
    setLeads((current) => current.map((lead) => (lead.id === leadId ? fresh : lead)));
    setRowPatches((current) => {
      if (!(leadId in current)) return current;
      const next = { ...current };
      delete next[leadId];
      return next;
    });
  }, []);

  /* ── Derived rows + virtual window ── */
  const effectiveLeads = useMemo(
    () =>
      leads.map((lead) => {
        const patch = rowPatches[lead.id];
        if (!patch) return lead;
        // customCells patches are a partial overlay (one AI column at a time,
        // from a v2-only run path); merge instead of replacing so an
        // off-screen custom-column run never blanks a row's other AI columns
        // once it scrolls into view. v1 never sets patch.customCells, so this
        // branch is always false for v1 tables.
        if (patch.customCells) {
          return { ...lead, ...patch, customCells: { ...lead.customCells, ...patch.customCells } };
        }
        return { ...lead, ...patch };
      }),
    [leads, rowPatches],
  );

  const totalTableWidth = useMemo(
    () => TABLE_COLUMNS.reduce((sum, column) => sum + columnWidths[column.id], 0),
    [columnWidths],
  );

  /* v2 layout only: visible custom columns, in sort order. */
  const visibleColumns = useMemo(
    () => customColumns.filter((column) => column.visible).sort((a, b) => a.sortOrder - b.sortOrder),
    [customColumns],
  );
  const v2TotalWidth = useMemo(
    () => visibleColumns.reduce((sum, column) => sum + (v2ColumnWidths[column.id] ?? v2ColumnWidth(column)), 0) + 40,
    [visibleColumns, v2ColumnWidths],
  );
  // The autorun chain in order: v2 derives it from the visible columns (so the
  // column order IS the flow); v1 uses the fixed built-in waterfall.
  const autorunSteps = useMemo<AutorunStep[]>(() => {
    if (layoutVersion !== "v2") return AUTORUN_ORDER.map((action) => ({ key: action, action }));
    const steps: AutorunStep[] = [];
    for (const column of visibleColumns) {
      if (column.kind === "ai" || column.kind === "email_qa") steps.push({ key: column.key, column });
      else if (column.kind === "builtin") {
        const def = isV2BuiltinKey(column.key) ? TABLE_COLUMNS_BY_ID[column.key] : undefined;
        if (def?.runAction) steps.push({ key: column.key, action: def.runAction });
      }
    }
    return steps;
  }, [layoutVersion, visibleColumns]);

  const virtualRange = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_ESTIMATE) - ROW_OVERSCAN);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT_ESTIMATE) + ROW_OVERSCAN * 2;
    const endIndex = Math.min(effectiveLeads.length, startIndex + visibleCount);
    return {
      startIndex,
      endIndex,
      topSpacerHeight: startIndex * ROW_HEIGHT_ESTIMATE,
      bottomSpacerHeight: Math.max(0, (effectiveLeads.length - endIndex) * ROW_HEIGHT_ESTIMATE),
      rows: effectiveLeads.slice(startIndex, endIndex),
    };
  }, [effectiveLeads, scrollTop, viewportHeight]);

  // Track the scroller's height without setting state synchronously in an
  // effect body (ResizeObserver callbacks fire outside the effect).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => setViewportHeight(scroller.clientHeight));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    setScrollTop(scroller.scrollTop);
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining < ROW_HEIGHT_ESTIMATE * 12 && leads.length < totalRows && !loadingRef.current) {
      void loadPage({ offset: leads.length });
    }
  };

  /* ── Column resize (one committed state update per animation frame) ── */
  const startColumnResize = (columnId: ColumnId, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidths[columnId];
    const minWidth = COLUMN_MIN_WIDTHS[columnId];
    let nextWidth = startWidth;

    const commit = () => {
      resizeRafRef.current = null;
      setColumnWidths((current) => (current[columnId] === nextWidth ? current : { ...current, [columnId]: nextWidth }));
    };
    const handleMouseMove = (moveEvent: MouseEvent) => {
      nextWidth = Math.round(Math.min(COLUMN_MAX_WIDTH, Math.max(minWidth, startWidth + moveEvent.clientX - startX)));
      if (resizeRafRef.current === null) {
        resizeRafRef.current = window.requestAnimationFrame(commit);
      }
    };
    const handleMouseUp = () => {
      if (resizeRafRef.current !== null) window.cancelAnimationFrame(resizeRafRef.current);
      commit();
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // Same resize behavior for the v2 dynamic columns (keyed by column id string).
  const startV2ColumnResize = (columnId: string, startWidth: number, event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    let nextWidth = startWidth;
    const commit = () => {
      resizeRafRef.current = null;
      setV2ColumnWidths((current) => (current[columnId] === nextWidth ? current : { ...current, [columnId]: nextWidth }));
    };
    const handleMouseMove = (moveEvent: MouseEvent) => {
      nextWidth = Math.round(Math.min(COLUMN_MAX_WIDTH, Math.max(V2_COLUMN_MIN_WIDTH, startWidth + moveEvent.clientX - startX)));
      if (resizeRafRef.current === null) resizeRafRef.current = window.requestAnimationFrame(commit);
    };
    const handleMouseUp = () => {
      if (resizeRafRef.current !== null) window.cancelAnimationFrame(resizeRafRef.current);
      commit();
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };
  const v2Width = (column: CustomColumn): number => v2ColumnWidths[column.id] ?? v2ColumnWidth(column);

  const resetColumnWidth = (columnId: ColumnId) => {
    setColumnWidths((current) => ({ ...current, [columnId]: DEFAULT_COLUMN_WIDTHS[columnId] }));
  };

  /* ── Sorting ── */
  const toggleSort = (key: SortKey) => {
    setSort((current) => {
      if (current?.key !== key) return { key, dir: "asc" };
      if (current.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  /* ── Cell + bulk plumbing ── */
  const setCellPending = (key: string, pending: boolean) => {
    setPendingCells((current) => {
      const next = new Set(current);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const callAction = async (
    action: RunnableAction,
    leadId: string,
    runId: string,
    // Captured once when a run starts, so every export in that run carries
    // the same expectedCampaignId (the server rejects if the tag moved).
    exportTag: CampaignTag | null,
  ): Promise<NormalizedResult> => {
    let raw: unknown;
    if (action === "linkedin_verify") raw = await runLinkedinVerifyAction(leadId, runId);
    else if (action === "find_email") raw = await runFindEmailAction(leadId, runId);
    else if (action === "validate_email") raw = await runValidateEmailAction(leadId, runId);
    else if (action === "smartlead_export") {
      if (!exportTag) return { ok: false, message: "Tag this list with a Smartlead campaign before exporting." };
      raw = await exportLeadToSmartleadAction(leadId, tableId, runId, exportTag.id);
    } else raw = await runPersonalizationAction(leadId, action, runId, tableId);
    return normalizeRunResult(raw);
  };

  const patchForAction = (action: RunnableAction, value: string | null): Partial<EnrichmentLead> | null => {
    switch (action) {
      case "linkedin_verify":
        // value is the status string (working | not_working | uncertain).
        return { linkedinEmploymentStatus: value, linkedinCheckedAt: new Date().toISOString() };
      case "find_email":
        // The server resets email_status after a successful discovery.
        return value ? { email: value, emailStatus: null } : null;
      case "validate_email":
        return { emailStatus: value };
      case "final_first_name":
        return { finalFirstName: value };
      case "final_title":
        return { finalTitle: value };
      case "final_company_name":
        return { finalCompanyName: value };
      case "operations_task":
        return { operationsTask: value };
      case "ops_candidate":
        return { opsCandidate: value };
      case "smartlead_export":
        // Per-list export state; the server also stamps the lead's global
        // last-export fields, which a row refetch picks up.
        return {
          tableExportStatus: "exported",
          tableExportError: null,
          tableExportedAt: new Date().toISOString(),
        };
    }
  };

  const recordCell = (
    action: RunnableAction,
    leadId: string,
    result: NormalizedResult,
    options?: { staleToast?: boolean },
  ) => {
    // Slim copy: full payloads across thousands of rows would blow the
    // sessionStorage persistence budget.
    const slim: CellResult = {
      ok: result.ok,
      message: result.message,
      ...(result.outcome ? { outcome: result.outcome } : {}),
      ...(result.fallback ? { fallback: true } : {}),
    };
    setCellResults((current) => ({ ...current, [`${leadId}:${action}`]: slim }));
    setLastRowResults((current) => ({ ...current, [leadId]: slim }));
    if (result.outcome === "written" || (result.outcome === "duplicate" && result.value !== undefined)) {
      const patch = patchForAction(action, result.value ?? null);
      if (patch) setRowPatches((current) => ({ ...current, [leadId]: { ...(current[leadId] ?? {}), ...patch } }));
    }
    if (result.outcome === "stale") {
      // The row changed under this run: pull server truth back in.
      void refreshRow(leadId);
      if (options?.staleToast) showToast(true, "This row changed elsewhere. It was refreshed with the latest values.");
    }
  };

  // Run one cell and return its result (used by both a manual run and the
  // autorun waterfall). No campaign-tag dialog here: the waterfall skips export
  // when untagged via autorunEligible instead of interrupting with a prompt.
  const runOneCell = async (
    action: RunnableAction,
    leadId: string,
    exportTag: CampaignTag | null,
  ): Promise<NormalizedResult | null> => {
    const key = `${leadId}:${action}`;
    setCellPending(key, true);
    try {
      const result = await callAction(action, leadId, crypto.randomUUID(), exportTag);
      recordCell(action, leadId, result, { staleToast: true });
      if (isAuthFailure(result) || isCampaignChangedFailure(result)) showToast(false, result.message);
      return result;
    } catch (error) {
      const failed: NormalizedResult = { ok: false, message: errorMessage(error, "Run failed.") };
      recordCell(action, leadId, failed);
      return failed;
    } finally {
      setCellPending(key, false);
    }
  };

  const wasApplied = (result: NormalizedResult) =>
    result.outcome === "written" || (result.outcome === "duplicate" && result.value !== undefined);

  // Whether a chain step should run now for this row. Hard halts (LinkedIn
  // departure, a "no" title check) stop everything; export is gated on the email
  // review passing and the auto-export toggle.
  const stepEligible = (step: AutorunStep, lead: EnrichmentLead): boolean => {
    if (lead.linkedinEmploymentStatus === "not_working") return false;
    if ((lead.customCells?.title_fit ?? "").trim().toLowerCase() === "no") return false;
    if (step.action === "smartlead_export") {
      if (!autoExportRef.current || !campaignTag) return false;
      if (lead.emailStatus !== "deliverable" || lead.suppressionReason || lead.tableExportStatus === "exported") return false;
      // Gate on the ACTUAL email-review column's key (it may not be "email_review").
      if (emailQaColumnKey && (lead.customCells?.[emailQaColumnKey] ?? "") !== "Ready") return false;
      return true;
    }
    // In the v2 flow LinkedIn is a chain step (still per-row, only from a manual
    // click); v1 keeps it manual-only via autorunEligible.
    if (step.action === "linkedin_verify" && layoutVersion === "v2") return lead.linkedinEmploymentStatus == null;
    if (step.action) return autorunEligible(step.action, lead, Boolean(campaignTag));
    const column = step.column!;
    // Filled AND current => nothing to do. A stale cell (prompt changed since it
    // ran) is treated as not-run so it regenerates.
    const filled = (lead.customCells?.[column.key] ?? "").trim() !== "";
    if (filled && !isCellStale(lead, column)) return false;
    if (column.key === "title_fit") return true;
    if (column.kind === "email_qa") return lead.emailStatus === "deliverable" && Boolean(campaignTag);
    return lead.emailStatus === "deliverable";
  };

  // Run one chain step (built-in or custom); returns whether it applied plus the
  // local lead patch to merge for the next step's eligibility.
  const runStepInternal = async (step: AutorunStep, lead: EnrichmentLead): Promise<{ status: StepRunStatus; patch: Partial<EnrichmentLead> }> => {
    if (step.action) {
      const result = await runOneCell(step.action, lead.id, campaignTag);
      if (!result) return { status: "failed", patch: {} };
      if (wasApplied(result)) {
        return { status: "applied", patch: patchForAction(step.action, result.value ?? null) || {} };
      }
      // Ran without writing. A soft precondition miss ("only runs when email is
      // missing") or a blocked dependency is a skip, not a failure - the row
      // keeps going, exactly as the server-side waterfall does.
      return { status: result.blocked || result.ok ? "noop" : "failed", patch: {} };
    }
    const column = step.column!;
    const outcome = column.key === "title_fit"
      ? await runTitleCheckCell(column, lead)
      : column.kind === "email_qa"
        ? await runEmailQaCell(column, lead)
        : await runCustomCell(column, lead);
    return {
      status: outcome.status,
      patch: {
        customCells: { ...(lead.customCells ?? {}), ...outcome.patch },
        customCellGens: { ...(lead.customCellGens ?? {}), ...outcome.gens },
      },
    };
  };

  // Chain the remaining steps after startIndex until none are eligible. Re-scans
  // to a fixpoint so an out-of-order dependency still runs (e.g. find-email sitting
  // after validate-email: once it fills the email, the next pass validates it).
  // Guarded against overlapping chains, unmount, and Autorun being turned off.
  const continueAutorun = async (startIndex: number, lead: EnrichmentLead): Promise<void> => {
    if (!autorunRef.current || startIndex < 0 || autorunActiveRef.current) return;
    autorunActiveRef.current = true;
    try {
      let merged = lead;
      let progressed = true;
      let guard = 0;
      while (progressed && guard < autorunSteps.length * 2) {
        guard += 1;
        progressed = false;
        for (let i = startIndex + 1; i < autorunSteps.length; i += 1) {
          if (!mountedRef.current || !autorunRef.current) return;
          const step = autorunSteps[i];
          if (!stepEligible(step, merged)) continue;
          const { status, patch } = await runStepInternal(step, merged);
          // Only a genuine failure stops the row. A step that ran without
          // writing (nothing to do, or waiting on a dependency) is skipped and
          // the row continues - matching runLeadChain, which used to be the
          // ONLY path that got this right. Before, one empty step killed the
          // rest of the chain, so a manual click rarely reached export.
          if (status === "failed") return;
          if (status === "applied") {
            merged = { ...merged, ...patch };
            progressed = true;
          }
        }
      }
    } finally {
      autorunActiveRef.current = false;
    }
  };

  const runSingleCell = async (action: RunnableAction, lead: EnrichmentLead) => {
    if (action === "smartlead_export" && !campaignTag) {
      setTagDialog({ caption: EXPORT_TAG_CAPTION });
      return;
    }
    const result = await runOneCell(action, lead.id, campaignTag);
    // Cascade unless the click genuinely FAILED. A cell that was already filled
    // (or had nothing to write) still carries the row forward, the same way a
    // bulk waterfall runs the downstream steps even when its start cell was
    // already done. Requiring a fresh write here meant re-clicking a finished
    // cell silently did nothing.
    if (!result || !autorun || (!wasApplied(result) && !result.ok && !result.blocked)) return;
    const merged: EnrichmentLead = { ...lead, ...(patchForAction(action, result.value ?? null) ?? {}) };
    await continueAutorun(autorunSteps.findIndex((s) => s.action === action), merged);
  };

  // Manual click on a custom cell: run it, then continue the chain from it.
  const runCustomStepManual = async (column: CustomColumn, lead: EnrichmentLead): Promise<void> => {
    const { status, patch } = await runStepInternal({ key: column.key, column }, lead);
    // Same rule as runSingleCell: only a real failure stops the chain from
    // starting. Clicking Title check on a row whose title was already checked
    // now still runs LinkedIn -> email -> personalization behind it.
    if (autorun && status !== "failed") {
      await continueAutorun(autorunSteps.findIndex((s) => s.column?.id === column.id), { ...lead, ...patch });
    }
    // A manual AI-cell run spends tokens; refresh the footer preview.
    if (status === "applied") refreshSpendRef.current();
  };

  const ensureSettings = async (): Promise<RunnerSettings | null> => {
    if (settingsRef.current) return settingsRef.current;
    const result = await getEnrichmentSettingsAction();
    if (!result.ok || !result.config || !result.prompts) {
      showToast(false, result.message || "Could not load prospect settings.");
      return null;
    }
    const value: RunnerSettings = { config: result.config, prompts: result.prompts };
    settingsRef.current = value;
    setSettings(value);
    return value;
  };


  /* ── Suppression (per row + from the detail dialog) ── */
  const applySuppressionPatch = (leadId: string, kind: SuppressionKind) => {
    const reason = `Suppressed (${kind})`;
    setRowPatches((current) => ({ ...current, [leadId]: { ...(current[leadId] ?? {}), suppressionReason: reason } }));
    setLeadDetail((current) =>
      current && current.leadId === leadId && current.lead
        ? { ...current, lead: { ...current.lead, suppressionReason: reason } }
        : current,
    );
  };

  const suppressRow = async (lead: EnrichmentLead) => {
    const kind: SuppressionKind = lead.email ? "email" : "domain";
    const value = lead.email ?? lead.domain;
    if (!value) {
      showToast(false, "This lead has no email or domain to suppress.");
      return;
    }
    const key = `${lead.id}:suppress`;
    setCellPending(key, true);
    try {
      const result = await addSuppressionAction({ kind, value, reason: null });
      showToast(result.ok, result.message);
      if (result.ok) applySuppressionPatch(lead.id, kind);
    } catch (error) {
      showToast(false, errorMessage(error, "Could not suppress this lead."));
    } finally {
      setCellPending(key, false);
    }
  };

  const removeFromCampaign = async (lead: EnrichmentLead) => {
    const key = `${lead.id}:remove`;
    if (pendingCells.has(key)) return;
    setCellPending(key, true);
    try {
      const result = await removeLeadFromCampaignAction(lead.id, tableId);
      showToast(result.ok, result.message);
      if (result.ok) {
        setRowPatches((current) => ({
          ...current,
          [lead.id]: { ...(current[lead.id] ?? {}), tableExportStatus: "removed", tableExportError: null },
        }));
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not remove the lead from Smartlead."));
    } finally {
      setCellPending(key, false);
    }
  };

  const suppressFromDetail = async (kind: SuppressionKind) => {
    const lead = leadDetail?.lead;
    if (!lead || suppressPending) return;
    const value = kind === "email" ? lead.email : lead.domain;
    if (!value) return;
    setSuppressPending(true);
    try {
      const result = await addSuppressionAction({ kind, value, reason: null });
      showToast(result.ok, result.message);
      if (result.ok) applySuppressionPatch(lead.id, kind);
    } finally {
      setSuppressPending(false);
    }
  };

  /* ── Lead detail + run history ── */
  const openLeadDetail = (lead: EnrichmentLead) => {
    const token = ++leadDetailTokenRef.current;
    setLeadDetail({ leadId: lead.id, leadName: leadName(lead), lead, loading: true });
    void (async () => {
      const result = await getLeadDetailAction(lead.id);
      if (leadDetailTokenRef.current !== token) return;
      const fresh = result.ok ? result.lead : undefined;
      setLeadDetail((current) =>
        current ? { ...current, lead: fresh ?? current.lead, loading: false } : current,
      );
    })();
  };

  const openRunHistory = (lead: EnrichmentLead) => {
    const token = ++runHistoryTokenRef.current;
    setRunHistory({ leadName: leadName(lead), entries: [], loading: true });
    void (async () => {
      const result = await getLeadRunsAction(lead.id);
      if (runHistoryTokenRef.current !== token) return;
      const entries = (result.ok ? result.runs : undefined) ?? [];
      setRunHistory((current) => (current ? { ...current, entries, loading: false } : current));
    })();
  };

  /* ── Prompt editor ── */
  const openPromptDialog = async (column: AiPromptColumn) => {
    void loadModelChoices();
    const loaded = await ensureSettings();
    if (loaded) setPromptColumn(column);
  };

  const savePrompt = async (column: AiPromptColumn, prompt: string, examples: NormalizationExample[], model: string, cliModel: string) => {
    const current = settingsRef.current;
    const trimmed = prompt.trim();
    if (!current || !trimmed || promptSavePending) return;
    const cleanExamples = examples
      .map((e) => ({ original: e.original.trim(), normalized: e.normalized.trim() }))
      .filter((e) => e.original && e.normalized);
    const prevExamples = current.prompts.examples?.[column] ?? [];
    const changed = trimmed !== current.prompts.prompts[column] || JSON.stringify(cleanExamples) !== JSON.stringify(prevExamples);
    const nextPrompts = {
      ...current.prompts,
      prompts: { ...current.prompts.prompts, [column]: trimmed },
      examples: { ...(current.prompts.examples ?? {}), [column]: cleanExamples },
      // The per-column timestamp is what the "outdated" run mode keys on.
      updatedAtByColumn: changed
        ? { ...current.prompts.updatedAtByColumn, [column]: new Date().toISOString() }
        : current.prompts.updatedAtByColumn,
    };
    setPromptSavePending(true);
    try {
      // The prompt lives in workspace settings; the models live on this column's
      // own row, so both are written before the dialog closes.
      const [result, modelResult] = await Promise.all([
        saveEnrichmentSettingsAction({ config: current.config, prompts: nextPrompts }),
        setColumnModelsAction(tableId, column, { model, cliModel }),
      ]);
      if (!modelResult.ok) showToast(false, modelResult.message || "Could not update the model.");
      else setCustomColumns((cols) => cols.map((c) => (c.key === column ? { ...c, model: model || null, cliModel: cliModel || null } : c)));
      if (result.ok && result.config && result.prompts) {
        const value: RunnerSettings = { config: result.config, prompts: result.prompts };
        settingsRef.current = value;
        setSettings(value);
        setPromptColumn(null);
        showToast(
          true,
          changed ? "Prompt saved. Existing cells for this column now count as outdated." : "Prompt saved.",
        );
      } else {
        showToast(false, result.message || "Could not save the prompt.");
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not save the prompt."));
    } finally {
      setPromptSavePending(false);
    }
  };

  /* ── Custom AI columns (v2 layout) ──────────────────────────────────── */
  const runCustomCell = async (column: CustomColumn, lead: EnrichmentLead): Promise<CustomStepOutcome> => {
    const key = `${lead.id}:custom:${column.key}`;
    setCellPending(key, true);
    try {
      const result = normalizeRunResult(await runCustomColumnAction(column.id, lead.id));
      const slim: CellResult = { ok: result.ok, message: result.message, ...(result.outcome ? { outcome: result.outcome } : {}) };
      setCellResults((current) => ({ ...current, [key]: slim }));
      setLastRowResults((current) => ({ ...current, [lead.id]: slim }));
      if (result.ok && result.value !== undefined) {
        setRowPatches((current) => ({
          ...current,
          [lead.id]: {
            ...(current[lead.id] ?? {}),
            customCells: { ...(current[lead.id]?.customCells ?? {}), [column.key]: result.value ?? null },
            customCellGens: { ...(current[lead.id]?.customCellGens ?? {}), [column.key]: column.generationVersion },
          },
        }));
        return { status: "applied", patch: { [column.key]: result.value ?? null }, gens: { [column.key]: column.generationVersion } };
      }
      // "Waiting on <column>" is not an error: the chain skips it and the
      // fixpoint comes back once the dependency has run.
      if (result.blocked) return { status: "noop", patch: {}, gens: {} };
      if (!result.ok) {
        showToast(false, result.message);
        return { status: "failed", patch: {}, gens: {} };
      }
      return { status: "noop", patch: {}, gens: {} };
    } catch (error) {
      const message = errorMessage(error, "Run failed.");
      setCellResults((current) => ({ ...current, [key]: { ok: false, message } }));
      showToast(false, message);
      return { status: "failed", patch: {}, gens: {} };
    } finally {
      setCellPending(key, false);
    }
  };

  /* ── Email review (QA) column ──────────────────────────────────────── */
  const [emailQaDialog, setEmailQaDialog] = useState<{ leadName: string; loading: boolean; details: EmailQaDetails | null } | null>(null);
  const [addEmailQaPending, setAddEmailQaPending] = useState(false);
  const [addColumnMenu, setAddColumnMenu] = useState<AnchoredMenu | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<AnchoredMenu | null>(null);
  const emailQaColumnKey = customColumns.find((c) => c.kind === "email_qa")?.key ?? null;
  const hasEmailQaColumn = emailQaColumnKey !== null;
  // Autorun chain guards: one chain at a time, and stop on unmount. Current
  // toggle/tag values are read via refs so mid-chain changes take effect.
  const autorunActiveRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const autorunRef = useRef(autorun);
  useEffect(() => { autorunRef.current = autorun; }, [autorun]);
  const autoExportRef = useRef(autoExport);
  useEffect(() => { autoExportRef.current = autoExport; }, [autoExport]);

  /* Durable run job: create on the server, then poll. Real per-provider
     concurrency and the whole waterfall run server-side (client-invoked Server
     Functions are serialized in this Next.js), and progress survives a refresh
     because the job lives in the database, not this tab. When Autorun is on a
     run is a waterfall (each row cascades the eligible downstream steps); off,
     it is a single-column fill. */
  // Keep the latest loadPage/refreshMeta in refs so the self-rescheduling poll
  // loop below can be a STABLE callback. If its identity changed on every
  // filter/sort edit, the resume effect (keyed on it) would tear down and
  // duplicate the poll mid-run.
  const loadPageRef = useRef(loadPage);
  const refreshMetaRef = useRef(refreshMeta);
  const refreshSpendRef = useRef<() => void>(() => {});
  useEffect(() => { loadPageRef.current = loadPage; refreshMetaRef.current = refreshMeta; }, [loadPage, refreshMeta]);

  // Swap the pendingCells entries the run poller owns: in-flight rows show the
  // same per-cell spinner a single-cell run shows, on the cell each row is
  // ACTUALLY on. The server reports that step per row, so a waterfall visibly
  // walks left to right; without it the spinner sat on the start column for the
  // whole run and a moving row looked frozen. Rows with no step reported yet
  // (claimed, first step not started) fall back to the start column.
  const setRunPendingCells = useCallback((rows: { leadId: string; step: string | null }[]) => {
    const startKey = runJobStartKeyRef.current;
    const cellKey = (leadId: string, stepKey: string) => {
      const action = BUILTIN_RUN_ACTION[stepKey];
      return action ? `${leadId}:${action}` : `${leadId}:custom:${stepKey}`;
    };
    const next = new Set<string>();
    for (const row of rows) {
      const stepKey = row.step ?? startKey;
      if (stepKey) next.add(cellKey(row.leadId, stepKey));
    }
    setPendingCells((current) => {
      const merged = new Set([...current].filter((k) => !runPendingKeysRef.current.has(k)));
      for (const k of next) merged.add(k);
      return merged;
    });
    runPendingKeysRef.current = next;
  }, []);

  const pollRunJob = useCallback((jobId: string) => {
    // Hoisted declaration so the recursive reschedule refers to itself cleanly.
    async function tick() {
      if (runJobIdRef.current !== jobId) return;
      let res;
      let active: Awaited<ReturnType<typeof getRunJobActiveLeadIdsAction>> | null = null;
      try { [res, active] = await Promise.all([getRunJobAction(jobId), getRunJobActiveLeadIdsAction(jobId).catch(() => null)]); }
      catch { runJobPollRef.current = setTimeout(tick, 3000); return; }
      if (runJobIdRef.current !== jobId) return;
      if (!res.ok || !res.job) { runJobPollRef.current = setTimeout(tick, 3000); return; }
      const job = res.job;
      setRunJob((current) => (current && current.id === jobId
        ? { ...current, total: job.total, done: job.done, failed: job.failed, status: job.status }
        : current));
      if (job.status === "done" || job.status === "failed" || job.status === "canceled") {
        setRunPendingCells([]);
        runActiveLeadsRef.current = new Set();
        runActiveStepsRef.current = new Map();
        runJobIdRef.current = null;
        void loadPageRef.current({ offset: 0, replace: true });
        void refreshMetaRef.current();
        refreshSpendRef.current();
        return;
      }
      // A failed spinner refresh keeps the previous set rather than flickering.
      if (active && active.ok && "leadIds" in active) {
        const ids = active.leadIds ?? [];
        const next = new Set(ids);
        // Rows that just left the in-flight set finished (done or failed):
        // refresh them in place so their new values appear mid-run instead of
        // only when the whole run ends. The spend chip moves with them.
        const finished = [...runActiveLeadsRef.current].filter((id) => !next.has(id)).slice(0, 30);
        if (finished.length > 0) {
          void Promise.all(finished.map((id) => refreshRow(id))).then(() => refreshSpendRef.current());
        }
        runActiveLeadsRef.current = next;
        // Prefer the per-row step (spinner follows the row); an older server
        // without it still yields the start-column behaviour via step: null.
        const activeRows = "active" in active && active.active
          ? active.active
          : ids.map((id) => ({ leadId: id, step: null as string | null }));
        // A row whose step ADVANCED just finished the previous cell. Refresh it
        // so that value lands immediately instead of at the end of the row - a
        // waterfall row is in flight for minutes, so without this the table
        // looks stalled even though cells are being written.
        const advanced = activeRows
          .filter((row) => row.step != null && runActiveStepsRef.current.get(row.leadId) !== row.step)
          .filter((row) => runActiveStepsRef.current.has(row.leadId))
          .map((row) => row.leadId)
          .slice(0, 30);
        if (advanced.length > 0) {
          void Promise.all(advanced.map((id) => refreshRow(id))).then(() => refreshSpendRef.current());
        }
        runActiveStepsRef.current = new Map(activeRows.map((row) => [row.leadId, row.step]));
        setRunPendingCells(activeRows);
      }
      runJobPollRef.current = setTimeout(tick, 2500);
    }
    void tick();
  }, [setRunPendingCells, refreshRow]);

  const startRunJob = async (startColumnKey: string, label: string, mode: RunMode, slice?: { count: number; offset: number }) => {
    if (runJob && (runJob.status === "running" || runJob.status === "pending" || runJob.status === "materializing")) {
      showToast(false, "A run is already in progress. Let it finish or stop it first.");
      return;
    }
    const kind: "column" | "waterfall" = autorunRef.current ? "waterfall" : "column";
    // Export from an untagged list is impossible: prompt for the tag instead of
    // starting a run that would stop at the export step.
    if (startColumnKey === "smartlead_export" && !campaignTag) {
      setTagDialog({ caption: EXPORT_TAG_CAPTION });
      return;
    }
    // Scope the run to exactly what's on screen: the same filters + sort the view
    // uses (paging + tableId are set by the server, so they are omitted here).
    const p = buildPageArgs(0);
    const filterArgs = {
      search: p.search, roleLevels: p.roleLevels, emailStatuses: p.emailStatuses, countries: p.countries,
      hasEmail: p.hasEmail, qualifiedOnly: p.qualifiedOnly, sort: p.sort, sortDir: p.sortDir,
      cellColumnId: p.cellColumnId, cellState: p.cellState, cellGeneration: p.cellGeneration, erroredJobId: p.erroredJobId, queuedJobId: p.queuedJobId,
    };
    // "Run N rows from row X" means the rows the operator is LOOKING AT. Send
    // those exact ids when the on-screen list already covers the slice, so the
    // run cannot drift from the view (a run-state filter's membership changes
    // as cells fill, which made an offset re-query land on different rows).
    // Only a slice reaching past what has been loaded falls back to the offset.
    let sliceLeadIds: string[] | undefined;
    if (slice && slice.count > 0) {
      const windowRows = effectiveLeads.slice(slice.offset, slice.offset + slice.count);
      if (windowRows.length === slice.count) sliceLeadIds = windowRows.map((row) => row.id);
    }
    let res;
    try { res = await createRunJobAction(tableId, startColumnKey, mode, kind, autoExportRef.current, filterArgs, slice?.count, slice?.offset, sliceLeadIds); }
    catch (error) { showToast(false, errorMessage(error, "Could not start the run.")); return; }
    if (!res.ok) { showToast(false, res.message); return; }
    if (!res.total) { showToast(true, "Nothing to run for this column."); return; }
    if (runJobPollRef.current) clearTimeout(runJobPollRef.current);
    runJobIdRef.current = res.jobId;
    runJobStartKeyRef.current = startColumnKey;
    runStateErroredJobIdRef.current = res.jobId;
    runStateQueuedJobIdRef.current = res.jobId;
    setRunJob({ id: res.jobId, label, kind, total: res.total, done: 0, failed: 0, status: "running" });
    runJobPollRef.current = setTimeout(() => void pollRunJob(res.jobId), 1500);
  };

  // Set the run-state filter. Picking "Errored" ensures the latest run job id is
  // known (fetched once if this session has not started one) so the server can
  // filter to that run's failed rows. "Queued" re-resolves the current run every
  // pick, so it always tracks the run in progress (or the most recent one).
  const applyRunStateFilter = async (runState: RunStateFilter) => {
    if (runState === "errored" && !runStateErroredJobIdRef.current) {
      try {
        const res = await getLatestRunJobForTableAction(tableId);
        if (res.ok && res.job) runStateErroredJobIdRef.current = res.job.id;
      } catch { /* best effort; filter becomes a no-op with no run */ }
      if (!runStateErroredJobIdRef.current) { showToast(false, "No run has completed for this list yet."); return; }
    }
    if (runState === "queued") {
      runStateQueuedJobIdRef.current = runJobIdRef.current;
      if (!runStateQueuedJobIdRef.current) {
        try {
          const res = await getLatestRunJobForTableAction(tableId);
          if (res.ok && res.job) runStateQueuedJobIdRef.current = res.job.id;
        } catch { /* best effort; filter becomes a no-op with no run */ }
      }
      if (!runStateQueuedJobIdRef.current) { showToast(false, "No run has started for this list yet."); return; }
    }
    setFilters((current) => ({
      ...current,
      runState,
      runStateColumnKey: current.runStateColumnKey ?? (customColumns.find((c) => c.kind === "ai" || c.kind === "email_qa")?.key ?? null),
    }));
  };

  const stopRunJob = async () => {
    const id = runJobIdRef.current;
    if (!id) return;
    setRunJob((current) => (current ? { ...current, status: "canceled" } : current));
    try { await cancelRunJobAction(id); } catch { /* the poll and cron reconcile */ }
  };

  // Human label for a run that we re-attach to (the job stores only the column
  // key). Built-in columns map through their run action; custom columns use their
  // own label. Keeps the banner + header spinner from showing a raw key.
  const runJobLabelForKey = (key: string): string => {
    const action = BUILTIN_RUN_ACTION[key];
    if (action) return ACTION_LABELS[action];
    return customColumns.find((c) => c.key === key)?.label ?? key;
  };

  // Resume the progress view for an in-flight run after a refresh/navigation.
  // Runs once per table (pollRunJob is stable); the guard prevents double-attach
  // when a run was already started in this session.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (runJobIdRef.current) return;
        const res = await getLatestRunJobForTableAction(tableId);
        if (!active || runJobIdRef.current || !res.ok || !res.job) return;
        const job = res.job;
        if (job.status !== "running" && job.status !== "pending") return;
        runJobIdRef.current = job.id;
        runJobStartKeyRef.current = job.startColumnKey;
        runStateErroredJobIdRef.current = job.id;
        runStateQueuedJobIdRef.current = job.id;
        setRunJob({ id: job.id, label: runJobLabelForKey(job.startColumnKey), kind: job.kind, total: job.total, done: job.done, failed: job.failed, status: job.status });
        runJobPollRef.current = setTimeout(() => void pollRunJob(job.id), 1500);
      } catch { /* best effort */ }
    })();
    // Stop and forget the poll on unmount / table switch so an in-flight tick
    // cannot reschedule onto an orphaned timer or setState after unmount.
    return () => { active = false; runJobIdRef.current = null; if (runJobPollRef.current) clearTimeout(runJobPollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pollRunJob is stable; customColumns intentionally read at attach time only
  }, [tableId, pollRunJob]);

  // Email-review queue count + current mode, refreshed on mount, after a resolve,
  // and when the modal closes.
  const refreshReviewState = useCallback(async () => {
    try {
      const [q, m] = await Promise.all([getReviewQueueAction(tableId), getEmailReviewModeAction()]);
      if (q.ok && "items" in q) setReviewCount(q.items?.length ?? 0);
      if (m.ok && "mode" in m && (m.mode === "manual" || m.mode === "auto")) setEmailReviewMode(m.mode);
    } catch { /* best effort */ }
  }, [tableId]);
  useEffect(() => { void refreshReviewState(); }, [refreshReviewState]);

  const refreshSpend = useCallback(async () => {
    try {
      const res = await getTableSpendAction(tableId);
      if (res.ok && "spend" in res) setSpend(res.spend as TableSpend);
    } catch { /* best effort */ }
  }, [tableId]);
  useEffect(() => { refreshSpendRef.current = () => void refreshSpend(); void refreshSpend(); }, [refreshSpend]);

  const toggleEmailReviewMode = async () => {
    const next = emailReviewMode === "auto" ? "manual" : "auto";
    setEmailReviewMode(next);
    const res = await setEmailReviewModeAction(next);
    if (!res.ok) { showToast(false, res.message); void refreshReviewState(); return; }
    showToast(true, next === "manual" ? "Email review set to manual. Flagged leads wait for your approval." : "Email review set to automatic. The reviewer applies its own fixes.");
  };

  const hasTitleCheckColumn = customColumns.some((c) => c.key === "title_fit");
  const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);

  const moveColumn = async (draggedId: string, targetId: string) => {
    setDraggedColumnId(null);
    setDragOverColumnId(null);
    if (draggedId === targetId) return;
    const ordered = [...customColumns].sort((a, b) => a.sortOrder - b.sortOrder);
    const fromIdx = ordered.findIndex((c) => c.id === draggedId);
    const toIdx = ordered.findIndex((c) => c.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = ordered.splice(fromIdx, 1);
    const targetIdx = ordered.findIndex((c) => c.id === targetId);
    ordered.splice(fromIdx < toIdx ? targetIdx + 1 : targetIdx, 0, moved);
    const resequenced = ordered.map((c, i) => ({ ...c, sortOrder: (i + 1) * 10 }));
    const previous = customColumns;
    setCustomColumns(resequenced);
    try {
      const result = await reorderColumnsAction(tableId, resequenced.map((c) => c.id));
      if (!result.ok) { setCustomColumns(previous); showToast(false, result.message); }
    } catch (error) {
      setCustomColumns(previous);
      showToast(false, errorMessage(error, "Could not reorder columns."));
    }
  };

  const runEmailQaCell = async (column: CustomColumn, lead: EnrichmentLead): Promise<CustomStepOutcome> => {
    const key = `${lead.id}:custom:${column.key}`;
    setCellPending(key, true);
    try {
      const result = normalizeRunResult(await runEmailQaAction(column.id, lead.id));
      const slim: CellResult = { ok: result.ok, message: result.message, ...(result.outcome ? { outcome: result.outcome } : {}) };
      setCellResults((current) => ({ ...current, [key]: slim }));
      if (result.ok && result.value !== undefined) {
        setRowPatches((current) => ({
          ...current,
          [lead.id]: {
            ...(current[lead.id] ?? {}),
            customCells: { ...(current[lead.id]?.customCells ?? {}), [column.key]: result.value ?? null },
            customCellGens: { ...(current[lead.id]?.customCellGens ?? {}), [column.key]: column.generationVersion },
          },
        }));
        return { status: "applied", patch: { [column.key]: result.value ?? null }, gens: { [column.key]: column.generationVersion } };
      }
      if (result.blocked) return { status: "noop", patch: {}, gens: {} };
      if (!result.ok) {
        showToast(false, result.message);
        return { status: "failed", patch: {}, gens: {} };
      }
      return { status: "noop", patch: {}, gens: {} };
    } catch (error) {
      const msg = errorMessage(error, "Email review failed.");
      setCellResults((current) => ({ ...current, [key]: { ok: false, message: msg } }));
      showToast(false, msg);
      return { status: "failed", patch: {}, gens: {} };
    } finally {
      setCellPending(key, false);
    }
  };

  const runTitleCheckCell = async (column: CustomColumn, lead: EnrichmentLead): Promise<CustomStepOutcome> => {
    const key = `${lead.id}:custom:${column.key}`;
    setCellPending(key, true);
    try {
      const result = await runTitleCheckAction(column.id, lead.id);
      const slim: CellResult = { ok: Boolean(result.ok), message: result.message ?? "", ...(result.ok ? { outcome: "written" as const } : {}) };
      setCellResults((current) => ({ ...current, [key]: slim }));
      if (result.ok) {
        setRowPatches((current) => ({
          ...current,
          [lead.id]: {
            ...(current[lead.id] ?? {}),
            customCells: { ...(current[lead.id]?.customCells ?? {}), title_fit: result.answer ?? null, title_fit_reason: result.reason ?? null },
            customCellGens: { ...(current[lead.id]?.customCellGens ?? {}), title_fit: column.generationVersion },
          },
        }));
        return { status: "applied", patch: { title_fit: result.answer ?? null, title_fit_reason: result.reason ?? null }, gens: { title_fit: column.generationVersion } };
      }
      showToast(false, result.message);
      return { status: "failed", patch: {}, gens: {} };
    } catch (error) {
      const msg = errorMessage(error, "Title check failed.");
      setCellResults((current) => ({ ...current, [key]: { ok: false, message: msg } }));
      showToast(false, msg);
      return { status: "failed", patch: {}, gens: {} };
    } finally {
      setCellPending(key, false);
    }
  };

  const openEmailQaDialog = async (column: CustomColumn, lead: EnrichmentLead) => {
    setEmailQaDialog({ leadName: leadName(lead), loading: true, details: null });
    try {
      const result = await getEmailQaDetailsAction(column.id, lead.id);
      const details = result.ok ? ((result.details as EmailQaDetails | null) ?? null) : null;
      setEmailQaDialog({ leadName: leadName(lead), loading: false, details });
      if (!result.ok) showToast(false, result.message);
    } catch (error) {
      setEmailQaDialog({ leadName: leadName(lead), loading: false, details: null });
      showToast(false, errorMessage(error, "Could not load the email review."));
    }
  };

  const addEmailReviewColumn = async () => {
    if (addEmailQaPending) return;
    setAddEmailQaPending(true);
    try {
      const result = await createEmailReviewColumnAction(tableId);
      showToast(result.ok, result.message);
      if (result.ok && result.column) {
        const created = result.column;
        setCustomColumns((current) => [...current, created]);
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not add the email review column."));
    } finally {
      setAddEmailQaPending(false);
    }
  };

  const addTitleCheckColumn = async () => {
    if (addEmailQaPending) return;
    setAddEmailQaPending(true);
    try {
      const result = await createTitleCheckColumnAction(tableId);
      showToast(result.ok, result.message);
      if (result.ok && result.column) {
        const created = result.column;
        setCustomColumns((current) => [...current, created]);
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not add the title check column."));
    } finally {
      setAddEmailQaPending(false);
    }
  };

  const reorderProps = (column: CustomColumn) => ({
    columnId: column.id,
    onReorderStart: setDraggedColumnId,
    onReorderEnter: (id: string) => setDragOverColumnId((current) => (current === id ? current : id)),
    onReorderDrop: (id: string) => { if (draggedColumnId) void moveColumn(draggedColumnId, id); },
    onReorderEnd: () => { setDraggedColumnId(null); setDragOverColumnId(null); },
    dropTarget: dragOverColumnId === column.id && draggedColumnId !== null && draggedColumnId !== column.id,
  });


  const saveColumnEditor = async (label: string, prompt: string, model: string, cliModel: string, examples: string[], reasoningEffort: string) => {
    if (!columnEditor || columnEditorPending) return;
    setColumnEditorPending(true);
    try {
      if (columnEditor.mode === "create") {
        const result = await createCustomColumnAction(tableId, label, prompt, model, examples, cliModel, reasoningEffort);
        showToast(result.ok, result.message);
        if (result.ok && result.column) {
          const created = result.column;
          setCustomColumns((current) => [...current, created]);
          setColumnEditor(null);
        }
      } else {
        const result = await updateCustomColumnAction(columnEditor.column.id, { label, prompt, model, cliModel, examples, reasoningEffort });
        showToast(result.ok, result.message);
        if (result.ok && result.column) {
          const updated = result.column;
          setCustomColumns((current) => current.map((column) => (column.id === updated.id ? updated : column)));
          setColumnEditor(null);
        }
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not save the column."));
    } finally {
      setColumnEditorPending(false);
    }
  };

  const deleteColumnEditor = async () => {
    if (!columnEditor || columnEditor.mode !== "edit" || columnDeletePending) return;
    const columnId = columnEditor.column.id;
    setColumnDeletePending(true);
    try {
      const result = await deleteCustomColumnAction(columnId);
      showToast(result.ok, result.message);
      if (result.ok) {
        setCustomColumns((current) => current.filter((column) => column.id !== columnId));
        setColumnEditor(null);
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not delete the column."));
    } finally {
      setColumnDeletePending(false);
    }
  };

  /* ── Campaign tag ── */
  const applyCampaignTag = async (tag: CampaignTag | null) => {
    if (tagPending) return;
    const previous = campaignTag;
    setTagPending(true);
    setCampaignTag(tag ? { ...tag, source: "table" } : null);
    try {
      const result = await setTableCampaignAction(tableId, tag ? { id: tag.id, name: tag.name } : null);
      showToast(result.ok, result.message);
      if (result.ok) {
        setTagDialog(null);
        // Clearing a table override may fall back to a workbook or folder
        // tag; the server recomputes the effective tag on refresh.
        if (!tag) router.refresh();
      } else setCampaignTag(previous);
    } catch (error) {
      setCampaignTag(previous);
      showToast(false, errorMessage(error, "Could not update the campaign tag."));
    } finally {
      setTagPending(false);
    }
  };

  /* ── Sheet tabs (table CRUD; navigation follows the mutation) ── */
  const activeTabIndex = siblings.findIndex((tab) => tab.id === tableId);

  const createTable = async (name: string, description: string, snapshotFilters: boolean) => {
    if (tablePending) return;
    setTablePending(true);
    try {
      const config = snapshotFilters ? encodeCanonicalFilter(filters) : undefined;
      const result = await createTableAction(workbook.id, name, description, config);
      showToast(result.ok, result.message);
      if (result.ok && "table" in result && result.table) {
        setNewTableOpen(false);
        router.push(`/enrichment/${workbook.slug}/${result.table.slug}`);
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not create the table."));
    } finally {
      setTablePending(false);
    }
  };

  const renameTable = async (name: string) => {
    if (tablePending) return;
    setTablePending(true);
    try {
      const result = await renameTableAction(tableId, name);
      showToast(result.ok, result.message);
      if (result.ok) {
        setRenameTableOpen(false);
        router.refresh();
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not rename the table."));
    } finally {
      setTablePending(false);
    }
  };

  const reorderActiveTable = async (direction: "left" | "right") => {
    if (tablePending) return;
    setTablePending(true);
    try {
      const result = await reorderTableAction(tableId, direction);
      if (!result.ok) showToast(false, result.message);
      else {
        setTabMenu(null);
        router.refresh();
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not reorder the table."));
    } finally {
      setTablePending(false);
    }
  };

  const moveActiveTable = async (target: WorkbookOption) => {
    if (tablePending) return;
    setTablePending(true);
    try {
      const result = await moveTableAction(tableId, target.id);
      showToast(result.ok, result.message);
      if (result.ok && "table" in result && result.table) {
        setMoveTableOpen(false);
        router.push(`/enrichment/${target.slug}/${result.table.slug}`);
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not move the table."));
    } finally {
      setTablePending(false);
    }
  };

  const deleteActiveTable = async () => {
    if (tablePending) return;
    // Client-side guard; the tab menu also disables the item.
    const remaining = siblings.filter((tab) => tab.id !== tableId);
    if (remaining.length === 0) {
      showToast(false, "A workbook needs at least one table, so its last table cannot be deleted.");
      return;
    }
    setTablePending(true);
    try {
      const result = await deleteTableAction(tableId);
      showToast(result.ok, result.message);
      if (result.ok) {
        setTabMenu(null);
        router.push(`/enrichment/${workbook.slug}/${remaining[0].slug}`);
      }
    } catch (error) {
      showToast(false, errorMessage(error, "Could not delete the table."));
    } finally {
      setTablePending(false);
    }
  };

  /* ── Views ── */
  const applyView = (view: EnrichmentView) => {
    const decoded = decodeViewConfig(view.config);
    setFilters(decoded.filters);
    setSort(decoded.sort);
  };

  const saveCurrentView = async (name: string) => {
    if (viewSavePending) return;
    setViewSavePending(true);
    try {
      const result = await saveViewAction({ tableId, name: name.trim(), config: encodeViewConfig(filters, sort) });
      showToast(result.ok, result.message);
      const view = result.ok ? result.view : undefined;
      if (view) {
        setViews((current) => [
          ...current.filter((existing) => existing.id !== view.id && existing.name !== view.name),
          view,
        ]);
        setSaveViewOpen(false);
      }
    } finally {
      setViewSavePending(false);
    }
  };

  const deleteView = async (view: EnrichmentView) => {
    const result = await deleteViewAction(view.id, tableId);
    showToast(result.ok, result.message);
    if (result.ok) setViews((current) => current.filter((existing) => existing.id !== view.id));
  };

  /* ── CSV export (client-assembled, current filters, 500/page) ── */
  const exportCsv = async () => {
    if (csvPending) return;
    setCsvPending(true);
    try {
      const rows: EnrichmentLead[] = [];
      // Concurrent writes can shift server offsets between pages; dedupe by
      // id so a shifted row is never exported twice.
      const seenIds = new Set<string>();
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      while (offset < total) {
        const result = await getEnrichmentLeadsPageAction(buildPageArgs(offset));
        const page = result.ok ? result.page : undefined;
        if (!page) throw new Error(result.message || "CSV export failed.");
        for (const row of page.rows) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);
          rows.push(row);
        }
        total = page.totalCount;
        if (page.rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      const lines = [CSV_COLUMNS.map((column) => csvField(column.header)).join(",")];
      for (const lead of rows) {
        lines.push(CSV_COLUMNS.map((column) => csvField(column.value(lead))).join(","));
      }
      // UTF-8 BOM prefix so spreadsheet apps decode accents correctly.
      const blob = new Blob(["\uFEFF" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      anchor.href = url;
      anchor.download = `enrichment-${tableSlug}-${stamp}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast(true, `Exported ${rows.length.toLocaleString("en-US")} rows matching the current filters.`);
    } catch (error) {
      showToast(false, errorMessage(error, "CSV export failed."));
    } finally {
      setCsvPending(false);
    }
  };

  /* ── Menus (fixed-position panels so header truncation never clips them) ── */
  useEffect(() => {
    if (!runMenu && !viewsMenu && !tabMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRunMenu(null);
        setViewsMenu(null);
        setTabMenu(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [runMenu, viewsMenu, tabMenu]);

  /* ── Derived render state ── */
  // A durable run job is in flight: disable per-row run buttons so a manual
  // click cannot race the server-side run.
  const bulkBusy = runJob?.status === "running" || runJob?.status === "pending" || runJob?.status === "materializing";
  // Spin the header of the built-in column a run started from (matched by label).
  const runningAction: RunnableAction | null = bulkBusy && runJob
    ? ((Object.keys(ACTION_LABELS) as RunnableAction[]).find((a) => ACTION_LABELS[a] === runJob.label) ?? null)
    : null;
  const activeFilterCount =
    [
      filters.roleLevel !== "all",
      filters.emailStatus !== "all",
      filters.country !== "all",
      filters.hasEmail !== "all",
      filters.qualifiedOnly,
      filters.runState !== "all",
    ].filter(Boolean).length + (filters.search.trim() ? 1 : 0);

  const updateFilters = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  const resultDot = (action: RunnableAction, lead: EnrichmentLead) => {
    const result = cellResults[`${lead.id}:${action}`];
    if (!result) return null;
    return (
      <ResultDot
        result={result}
        onOpen={() => setRunDetails({ title: `${leadName(lead)} · ${ACTION_LABELS[action]}`, result })}
      />
    );
  };

  const fallbackMarker = (action: RunnableAction, lead: EnrichmentLead) => {
    const result = cellResults[`${lead.id}:${action}`];
    if (!result?.fallback) return null;
    return (
      <span
        role="img"
        aria-label="Deterministic fallback value"
        title="Deterministic fallback: the model output was unavailable or unusable, so the rule-based normalizer supplied this value."
        className="size-1.5 shrink-0 rounded-full bg-warning"
      />
    );
  };

  /* ── Per-key builtin cell renderers ──────────────────────────────────────
     Extracted verbatim from the v1 grid below so both layouts render the
     exact same markup for a given key. Every call site in the v1 grid below
     passes the same arguments it already computed inline, so v1's rendered
     output is unchanged; v2 (further down) calls the same functions. */
  const renderContactCell = (lead: EnrichmentLead, rowBg: string, qualification?: Qualification) => {
    const name = leadName(lead);
    const meta = contactMeta(lead);
    return (
      <BodyCell sticky rowBg={rowBg}>
        <button
          type="button"
          onClick={() => openLeadDetail(lead)}
          title="View lead details"
          className={`block w-full min-w-0 rounded text-left`}
        >
          {qualification ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium">{name}</span>
              <Pill tone={qualification.tone} label={qualification.label} title={qualification.detail} />
            </span>
          ) : (
            <span className="block truncate text-[13px] font-medium">{name}</span>
          )}
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
            {lead.title ?? "No title"}
          </span>
          {meta ? (
            <span className="block truncate text-[11px] leading-4 text-muted-foreground">{meta}</span>
          ) : null}
        </button>
      </BodyCell>
    );
  };

  const renderCompanyCell = (lead: EnrichmentLead, rowBg: string) => (
    <BodyCell rowBg={rowBg}>
      <span className="block truncate" title={lead.company ?? undefined}>
        {lead.company ?? <span className="text-muted-foreground">No company</span>}
      </span>
      {lead.domain ? (
        <span className="block truncate font-mono text-[11px] text-muted-foreground">{lead.domain}</span>
      ) : null}
    </BodyCell>
  );

  const renderEmailCell = (lead: EnrichmentLead, rowBg: string) => (
    <BodyCell rowBg={rowBg}>
      <span className="block truncate font-mono text-[11.5px]" title={lead.email ?? undefined}>
        {lead.email ?? <span className="font-sans text-muted-foreground">empty</span>}
      </span>
    </BodyCell>
  );

  const renderLinkedinCell = (lead: EnrichmentLead, rowBg: string) => (
    <BodyCell rowBg={rowBg}>
      <div className="flex items-center gap-1.5">
        {lead.linkedinEmploymentStatus ? (
          <button
            type="button"
            onClick={() => openLeadDetail(lead)}
            title="View the scraped LinkedIn details"
            className={`min-w-0 rounded`}
          >
            <Pill {...linkedinStatusPill(lead.linkedinEmploymentStatus)} />
          </button>
        ) : (
          <Pill tone="muted" label="not run" />
        )}
        <RunButton
          label={lead.linkedinEmploymentStatus ? "Recheck cell" : "Run cell"}
          pending={pendingCells.has(`${lead.id}:linkedin_verify`)}
          disabled={!lead.linkedinUrl || bulkBusy}
          title={lead.linkedinUrl ? undefined : "Needs a LinkedIn URL to check."}
          onClick={() => void runSingleCell("linkedin_verify", lead)}
        />
        {resultDot("linkedin_verify", lead)}
      </div>
    </BodyCell>
  );

  const renderValidateEmailCell = (lead: EnrichmentLead, rowBg: string) => (
    <BodyCell rowBg={rowBg}>
      <div className="flex items-center gap-1.5">
        {lead.emailStatus ? <Pill tone={emailStatusTone(lead.emailStatus)} label={emailStatusLabel(lead.emailStatus)} /> : null}
        <RunButton
          label={lead.emailStatus ? "Rerun" : "Run"}
          pending={pendingCells.has(`${lead.id}:validate_email`)}
          disabled={!lead.email || bulkBusy}
          title={lead.email ? undefined : "Validate Email depends on the Email column."}
          onClick={() => void runSingleCell("validate_email", lead)}
        />
        {resultDot("validate_email", lead)}
      </div>
    </BodyCell>
  );

  const renderEmailStatusCell = (lead: EnrichmentLead, rowBg: string) => (
    <BodyCell rowBg={rowBg}>
      {lead.emailStatus ? (
        <Pill tone={emailStatusTone(lead.emailStatus)} label={lead.emailStatus} />
      ) : (
        <Pill tone="muted" label="not run" />
      )}
    </BodyCell>
  );

  const renderFindEmailCell = (lead: EnrichmentLead, rowBg: string, canFind: boolean, findMissingInputs: boolean) => (
    <BodyCell rowBg={rowBg}>
      <div className="flex items-center gap-1.5">
        <RunButton
          icon="search"
          label={lead.emailStatus === "invalid" ? "Find replacement" : lead.email ? "Not needed" : "Run cell"}
          pending={pendingCells.has(`${lead.id}:find_email`)}
          disabled={!canFind || findMissingInputs || bulkBusy}
          title={
            !canFind
              ? "Find Email runs only when the email is missing or marked invalid."
              : findMissingInputs
                ? "Needs first name, last name, and domain."
                : undefined
          }
          onClick={() => void runSingleCell("find_email", lead)}
        />
        {resultDot("find_email", lead)}
      </div>
    </BodyCell>
  );

  const renderVariableCell = (
    lead: EnrichmentLead,
    rowBg: string,
    action: RunnableAction,
    value: string | null,
    personalizationReady: boolean,
    clickable?: boolean,
  ) => (
    <BodyCell rowBg={rowBg}>
      <div className="flex items-center gap-1.5">
        {clickable && value ? (
          <button
            type="button"
            onClick={() => openLeadDetail(lead)}
            title="View the ops candidate context"
            className={`min-w-0 flex-1 truncate rounded text-left font-medium underline-offset-2 hover:underline`}
          >
            {value}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium" title={value ?? undefined}>
            {value ?? <span className="font-normal text-muted-foreground">empty</span>}
          </span>
        )}
        {fallbackMarker(action, lead)}
        <IconRunButton
          pending={pendingCells.has(`${lead.id}:${action}`)}
          disabled={!personalizationReady || bulkBusy}
          title={
            personalizationReady
              ? value
                ? "Rerun cell"
                : "Run cell"
              : "Runs after ZeroBounce marks the email deliverable."
          }
          onClick={() => void runSingleCell(action, lead)}
        />
        {resultDot(action, lead)}
      </div>
    </BodyCell>
  );

  const renderSmartleadExportCell = (
    lead: EnrichmentLead,
    rowBg: string,
    exported: boolean,
    exportDisabledReason: string | undefined,
    exportTitle: string | undefined,
  ) => (
    <BodyCell rowBg={rowBg}>
      <div className="flex flex-col gap-1">
        <div>
          {lead.suppressionReason ? (
            <Pill tone="destructive" label="suppressed" title={lead.suppressionReason} />
          ) : lead.tableExportStatus ? (
            <Pill
              tone={
                lead.tableExportStatus === "exported"
                  ? "success"
                  : lead.tableExportStatus === "failed"
                    ? "destructive"
                    : "muted"
              }
              label={lead.tableExportStatus}
              title={
                lead.tableExportError ??
                (lead.tableExportedAt
                  ? `Exported from this list ${formatExportTimestamp(lead.tableExportedAt)}`
                  : undefined)
              }
            />
          ) : (
            <Pill tone="muted" label="not exported" />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <RunButton
            label={exported ? "Exported" : "Export"}
            pending={pendingCells.has(`${lead.id}:smartlead_export`)}
            disabled={Boolean(exportDisabledReason) || bulkBusy}
            title={exportTitle}
            onClick={() => void runSingleCell("smartlead_export", lead)}
          />
          {resultDot("smartlead_export", lead)}
          {!lead.suppressionReason ? (
            <button
              type="button"
              aria-label="Suppress lead"
              title="Suppress this lead: block it from every export. Manage the list from the Suppressions dialog."
              disabled={pendingCells.has(`${lead.id}:suppress`)}
              onClick={() => void suppressRow(lead)}
              className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:opacity-50`}
            >
              {pendingCells.has(`${lead.id}:suppress`) ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Ban className="size-3" />
              )}
            </button>
          ) : null}
          {lead.tableExportStatus === "exported" ? (
            <button
              type="button"
              aria-label="Remove from campaign"
              title="Remove this lead from the Smartlead campaign (stops its sequence). Does not delete the lead."
              disabled={pendingCells.has(`${lead.id}:remove`)}
              onClick={() => void removeFromCampaign(lead)}
              className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:opacity-50`}
            >
              {pendingCells.has(`${lead.id}:remove`) ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <UserMinus className="size-3" />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </BodyCell>
  );

  /* ── v2-only cell renderers (source + ai column kinds) ── */
  const renderLinkedinLinkCell = (lead: EnrichmentLead, rowBg: string) => {
    const raw = (lead.linkedinUrl ?? "").trim();
    if (!raw) {
      return (
        <BodyCell rowBg={rowBg}>
          <span className="text-muted-foreground">—</span>
        </BodyCell>
      );
    }
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const display = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
    return (
      <BodyCell rowBg={rowBg}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${display} in a new tab`}
          className={`flex min-w-0 items-center gap-1 rounded underline-offset-2 hover:underline`}
        >
          <span className="min-w-0 truncate">{display}</span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
        </a>
      </BodyCell>
    );
  };

  const renderCompanySummaryCell = (lead: EnrichmentLead, rowBg: string) => {
    const summary = readCompanySummary(lead.companySummary);
    return (
      <BodyCell rowBg={rowBg}>
        {summary ? (
          <button
            type="button"
            title={[summary.whatTheyMake, summary.markets ? `Markets: ${summary.markets}` : "", summary.summary]
              .filter(Boolean)
              .join("\n\n")}
            onClick={(event) =>
              setSummaryPopover({
                ...menuPosition(event, 320),
                whatTheyMake: summary.whatTheyMake,
                markets: summary.markets,
                summary: summary.summary,
              })
            }
            className={`block w-full min-w-0 truncate rounded text-left underline-offset-2 hover:underline`}
          >
            {summary.whatTheyMake || summary.summary || "View summary"}
          </button>
        ) : (
          <span className="text-muted-foreground">No summary</span>
        )}
      </BodyCell>
    );
  };

  const renderAiCell = (column: CustomColumn, lead: EnrichmentLead, rowBg: string) => {
    const key = `${lead.id}:custom:${column.key}`;
    const value = lead.customCells[column.key] ?? null;
    const result = cellResults[key];
    const stale = isCellStale(lead, column);
    return (
      <BodyCell rowBg={rowBg}>
        <div className="flex items-center gap-1.5">
          {value ? (
            <button
              type="button"
              title={`${value}${stale ? "\n\nStale: the prompt changed since this ran. Rerun to refresh." : ""}\n\nClick to read`}
              onClick={(event) =>
                setValuePopover({ ...menuPosition(event, 320), label: column.label, value })
              }
              className={`min-w-0 flex-1 truncate rounded text-left underline-offset-2 hover:underline ${stale ? "text-warning line-through decoration-warning/50" : ""}`}
            >
              {value}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">not run</span>
          )}
          {stale ? <span title="Stale: prompt changed since this ran" className="shrink-0 rounded bg-warning/15 px-1 text-[9px] font-semibold uppercase text-warning">stale</span> : null}
          <IconRunButton
            pending={pendingCells.has(key)}
            disabled={bulkBusy}
            title={stale ? "Prompt changed - rerun" : value ? "Rerun cell" : "Run cell"}
            onClick={() => void runCustomStepManual(column, lead)}
          />
          {result ? (
            <ResultDot
              result={result}
              onOpen={() => setRunDetails({ title: `${leadName(lead)} · ${column.label}`, result })}
            />
          ) : null}
        </div>
      </BodyCell>
    );
  };

  const renderEmailQaCell = (column: CustomColumn, lead: EnrichmentLead, rowBg: string) => {
    const key = `${lead.id}:custom:${column.key}`;
    const value = lead.customCells[column.key] ?? null;
    const ready = value === "Ready";
    const result = cellResults[key];
    return (
      <BodyCell rowBg={rowBg}>
        <div className="flex items-center gap-1.5">
          {value ? (
            <button
              type="button"
              title="Click to inspect the 3 emails, variables, and issues"
              onClick={() => void openEmailQaDialog(column, lead)}
              className={`min-w-0 flex-1 truncate rounded text-left`}
            >
              <Pill tone={ready ? "success" : "warning"} label={ready ? "Ready" : "Needs review"} />
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">not run</span>
          )}
          <IconRunButton
            pending={pendingCells.has(key)}
            disabled={bulkBusy}
            title={value ? "Re-run review" : "Run review"}
            onClick={() => void runCustomStepManual(column, lead)}
          />
          {result ? (
            <ResultDot result={result} onOpen={() => setRunDetails({ title: `${leadName(lead)} · ${column.label}`, result })} />
          ) : null}
        </div>
      </BodyCell>
    );
  };

  const renderReasonCell = (column: CustomColumn, lead: EnrichmentLead, rowBg: string) => {
    const value = lead.customCells[column.key] ?? null;
    return (
      <BodyCell rowBg={rowBg}>
        {value ? (
          <button
            type="button"
            title={`${value}\n\nClick to read`}
            onClick={(event) => setValuePopover({ ...menuPosition(event, 320), label: column.label, value })}
            className={`block w-full min-w-0 truncate rounded text-left underline-offset-2 hover:underline`}
          >
            {value}
          </button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </BodyCell>
    );
  };

  const renderV2Cell = (column: CustomColumn, lead: EnrichmentLead, rowBg: string): ReactNode => {
    if (column.kind === "ai") return renderAiCell(column, lead, rowBg);
    if (column.kind === "email_qa") return renderEmailQaCell(column, lead, rowBg);
    if (column.kind === "source" && column.key === "title_fit_reason") return renderReasonCell(column, lead, rowBg);
    if (column.kind === "source" && column.key === "company_summary") return renderCompanySummaryCell(lead, rowBg);
    if (column.kind === "source" && column.key === "linkedin_url") return renderLinkedinLinkCell(lead, rowBg);
    switch (column.key) {
      case "contact":
        return renderContactCell(lead, rowBg, getQualification(lead));
      case "company":
        return renderCompanyCell(lead, rowBg);
      case "email":
        return renderEmailCell(lead, rowBg);
      case "linkedin":
        return renderLinkedinCell(lead, rowBg);
      case "validate_email":
        return renderValidateEmailCell(lead, rowBg);
      case "email_status":
        return renderEmailStatusCell(lead, rowBg);
      case "find_email":
        return renderFindEmailCell(
          lead,
          rowBg,
          !lead.email || lead.emailStatus === "invalid",
          !lead.firstName || !lead.lastName || !lead.domain,
        );
      case "final_first_name":
        return renderVariableCell(lead, rowBg, "final_first_name", lead.finalFirstName, lead.emailStatus === "deliverable");
      case "final_company_name":
        return renderVariableCell(
          lead,
          rowBg,
          "final_company_name",
          lead.finalCompanyName,
          lead.emailStatus === "deliverable",
        );
      case "smartlead_export": {
        const exported = lead.tableExportStatus === "exported";
        const exportDisabledReason = lead.suppressionReason
          ? `Suppressed: ${lead.suppressionReason}`
          : exported
            ? "Already exported from this list. Each list exports a lead once."
            : !lead.email || lead.emailStatus !== "deliverable"
              ? "Requires a deliverable email."
              : undefined;
        const exportTitle =
          exportDisabledReason ?? (campaignTag ? undefined : "This list has no campaign tag yet. Opens the picker.");
        return renderSmartleadExportCell(lead, rowBg, exported, exportDisabledReason, exportTitle);
      }
      default:
        return (
          <BodyCell rowBg={rowBg}>
            <span className="text-muted-foreground">Unsupported column</span>
          </BodyCell>
        );
    }
  };

  /* Email health, in pipeline order: where every lead in this list currently
     sits on the way to being sendable. Each row carries the filter that isolates
     it, so the breakdown doubles as navigation - the number you just read is one
     click from being the rows in front of you.

     These lived in the header as six always-on chips. They are a diagnostic you
     consult, not a control you reach for, so they belong in the status bar the
     way row count and spend already do. */
  const healthItems: { key: string; label: string; value: number; tone: string; filter: Partial<Filters>; title: string }[] = [
    { key: "deliverable", label: "Deliverable", value: stats.deliverable, tone: "bg-success", filter: { emailStatus: "deliverable", hasEmail: "all" }, title: "ZeroBounce marked deliverable — ready to enrich and export" },
    { key: "pending", label: "Pending validation", value: stats.pendingValidation, tone: "bg-sky-500", filter: { emailStatus: "unknown", hasEmail: "has" }, title: "Has an email, not yet checked by ZeroBounce" },
    { key: "missing", label: "Missing email", value: stats.missingEmail, tone: "bg-muted-foreground/40", filter: { hasEmail: "missing", emailStatus: "all" }, title: "No email address on the lead yet" },
    { key: "catch_all", label: "Catch-all", value: stats.catchAll, tone: "bg-amber-400", filter: { emailStatus: "catch_all", hasEmail: "all" }, title: "Domain accepts every address, so ZeroBounce cannot confirm this one — never sent to" },
    { key: "risky", label: "Risky", value: stats.risky, tone: "bg-amber-500", filter: { emailStatus: "risky", hasEmail: "all" }, title: "ZeroBounce marked risky — never sent to" },
    { key: "invalid", label: "Invalid", value: stats.invalid, tone: "bg-destructive", filter: { emailStatus: "invalid", hasEmail: "all" }, title: "ZeroBounce marked invalid — never sent to" },
  ];
  // Percentages are of the list, so an unaccounted remainder stays visible as a
  // gap in the bar rather than being silently absorbed into a neighbour.
  const healthTotal = stats.totalLeads;

  /* Which model a column header should advertise, or undefined for a header
     that should show none. Mirrors the runner's own choice: the mode picks the
     field, so the chip names the model that would run right now rather than
     whichever of the pair was set most recently. A constant column is excluded
     even though it carries a model - it returns its fixed value and never calls
     one, so a chip there would describe work that never happens. */
  const runnerIsCli = runner?.provider === "cli-claude" || runner?.provider === "cli-codex";
  const headerModel = (column: CustomColumn): string | undefined =>
    (runnerIsCli ? column.cliModel : column.model) ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* ── Header: workbook + global actions ──────────────────────────────
          No breadcrumb. All three crumbs said something already on screen, and
          one of them lied: "Enrichment" repeats the sidebar's active item (same
          word, same icon), the table name is the selected sheet tab a row
          below, and the workbook link resolved to /enrichment/<workbook>, which
          redirects to the workbook's FIRST table - so from Champions it looked
          like "go up a level" and silently moved you to a different list.

          What is left is the one level nothing else shows. The sidebar says
          which section, the tabs say which table, and now the header says which
          workbook - the same division Sheets, Airtable and Clay use. */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight" title={workbook.name}>
          {workbook.name}
        </h1>
        {/* Segment counts used to sit here as six always-on chips. They are in
            the status bar now (see the footer's Email health control), leaving
            the header to the things you act with. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {runner ? (
            <RunnerToggle
              config={runner}
              isVercel={isVercel}
              showToast={showToast}
              onSwitched={(provider) => {
                setRunner((prev) => (prev ? { ...prev, provider } : prev));
                // Fold the switch into the cached settings so the next bulk
                // run uses the new runner without a refetch (same idiom as
                // the settings dialog's onSaved below).
                const current = settingsRef.current;
                if (!current) return;
                const value: RunnerSettings = { ...current, config: { ...current.config, provider } };
                settingsRef.current = value;
                setSettings(value);
              }}
            />
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={autorun}
            aria-label="Autorun"
            onClick={toggleAutorun}
            data-tip="Autorun: after you run a cell, automatically run that row's remaining steps (find email, validate, campaign variables, export) until the last step."
            data-tip-down=""
            className={`${BTN_OUTLINE} h-8 gap-2 px-2.5 text-[12px]`}
          >
            <span className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${autorun ? "bg-primary" : "bg-muted-foreground/30"}`}>
              <span className={`inline-block size-2.5 rounded-full bg-white shadow-xs transition-transform ${autorun ? "translate-x-3" : "translate-x-0.5"}`} />
            </span>
            Autorun
          </button>
          {reviewCount > 0 ? (
            <button
              type="button"
              onClick={() => setReviewOpen(true)}
              data-tip="Leads the email review flagged for your approval before export"
              data-tip-down=""
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 text-[12px] font-medium text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-400`}
            >
              <ClipboardCheck className="size-3.5" />
              Review {reviewCount.toLocaleString("en-US")}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="More table options"
            aria-haspopup="menu"
            data-tip="Auto-export, settings, suppressions, and CSV export"
            data-tip-down=""
            onClick={(event) => setToolbarMenu(menuPosition(event, 240))}
            className={`${BTN_OUTLINE} size-8`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>
      </header>

      {/* ── Toolbar: search + bordered filter selects + views ── */}
      <div className="shrink-0 border-b border-border bg-surface px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative w-60 min-w-44">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filters.search}
              onChange={(event) => updateFilters({ search: event.target.value })}
              placeholder="Search lead, company, domain"
              aria-label="Search leads"
              className={`${INPUT_CLASS} h-7 pl-8 pr-7 text-[12px]`}
            />
            {filters.search ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => updateFilters({ search: "" })}
                className={`absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground`}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
          <ToolbarSelect
            ariaLabel="Filter by role level"
            value={filters.roleLevel}
            onChange={(event) => updateFilters({ roleLevel: event.target.value })}
          >
            <option value="all">All roles</option>
            {filterOptions.roleLevels.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            ariaLabel="Filter by email status"
            value={filters.emailStatus}
            onChange={(event) => updateFilters({ emailStatus: event.target.value })}
          >
            <option value="all">All statuses</option>
            {filterOptions.emailStatuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            ariaLabel="Filter by country"
            value={filters.country}
            onChange={(event) => updateFilters({ country: event.target.value })}
            widthClass="w-40"
          >
            <option value="all">All countries</option>
            {filterOptions.countries.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            ariaLabel="Filter by email presence"
            value={filters.hasEmail}
            onChange={(event) =>
              updateFilters({
                hasEmail: event.target.value === "has" ? "has" : event.target.value === "missing" ? "missing" : "all",
              })
            }
          >
            <option value="all">Email: all</option>
            <option value="has">Has email</option>
            <option value="missing">Missing email</option>
          </ToolbarSelect>
          <button
            type="button"
            aria-pressed={filters.qualifiedOnly}
            onClick={() => updateFilters({ qualifiedOnly: !filters.qualifiedOnly })}
            data-tip="Show only leads that pass the server-side qualification gate"
            data-tip-down=""
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
              filters.qualifiedOnly
                ? "border-transparent bg-accent text-accent-foreground"
                : "border-border bg-surface text-muted-foreground hover:text-foreground"
            }`}
          >
            Qualified only
          </button>
          {customColumns.some((c) => c.kind === "ai" || c.kind === "email_qa") ? (
            <>
              <ToolbarSelect
                ariaLabel="Filter by run status"
                value={filters.runState}
                onChange={(event) => void applyRunStateFilter(event.target.value as RunStateFilter)}
                widthClass="w-36"
              >
                <option value="all">Run status: all</option>
                <option value="not_run">Not run</option>
                <option value="done">Done</option>
                <option value="outdated">Outdated</option>
                <option value="queued">Queued (current run)</option>
                <option value="errored">Errored (last run)</option>
              </ToolbarSelect>
              {filters.runState === "not_run" || filters.runState === "done" || filters.runState === "outdated" ? (
                <ToolbarSelect
                  ariaLabel="Run status column"
                  value={filters.runStateColumnKey ?? ""}
                  onChange={(event) => updateFilters({ runStateColumnKey: event.target.value || null })}
                  widthClass="w-40"
                >
                  {customColumns
                    .filter((c) => c.kind === "ai" || c.kind === "email_qa")
                    .map((c) => (
                      <option key={c.id} value={c.key}>{c.label}</option>
                    ))}
                </ToolbarSelect>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            onClick={(event) => setViewsMenu(menuPosition(event, 288))}
            className={`${BTN_OUTLINE} h-7 px-2 text-[11.5px]`}
          >
            <Bookmark className="size-3.5" />
            Views
            {views.length > 0 ? <span className="tabular-nums text-muted-foreground">{views.length}</span> : null}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {activeFilterCount > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setFilters(DEFAULT_FILTERS);
                  setSort(null);
                }}
                className={`whitespace-nowrap text-[11px] font-medium text-muted-foreground transition hover:text-foreground`}
              >
                Clear filters
              </button>
            ) : null}
            {/* The campaign tag moved to the header, beside the list name: it
                describes where this list SENDS, which is part of what the list
                is, not a way of looking at its rows. */}
          </div>
        </div>
      </div>

      {/* ── Grid ── */}
      {layoutVersion === "v2" ? (
        <div ref={scrollerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <table className="border-separate border-spacing-0" style={{ width: v2TotalWidth, tableLayout: "fixed" }}>
            <colgroup>
              {visibleColumns.map((column) => (
                <col key={column.id} style={{ width: v2Width(column) }} />
              ))}
              <col style={{ width: 40 }} />
            </colgroup>
            <thead>
              <tr>
                {visibleColumns.map((column, index) => {
                  const sticky = index === 0;
                  const width = v2Width(column);
                  const onResizeStart = (event: ReactMouseEvent<HTMLElement>) => startV2ColumnResize(column.id, width, event);
                  if (column.kind === "ai") {
                    return (
                      <V2HeaderCell
                        key={column.id}
                        label={column.label}
                        width={width}
                        sticky={sticky}
                        onResizeStart={onResizeStart}
                        running={Boolean(bulkBusy) && runJob?.label === column.label}
                        runMenuDisabled={Boolean(bulkBusy)}
                        onOpenRunMenu={(event) => setColumnRunMenu({ ...menuPosition(event, 224), column })}
                        onConfigure={() => { void loadModelChoices(); setColumnEditor({ mode: "edit", column }); }}
                        configureTitle={`Edit the ${column.label} prompt`}
                        model={headerModel(column)}
                        cliMode={runnerIsCli}
                        constantValue={column.constantValue}
                        {...reorderProps(column)}
                      />
                    );
                  }
                  if (column.kind === "email_qa") {
                    // The email-review column is a runnable start column too, so it
                    // gets the same run menu (Test 10 / unrun / outdated / force).
                    return (
                      <V2HeaderCell
                        key={column.id}
                        label={column.label}
                        width={width}
                        sticky={sticky}
                        onResizeStart={onResizeStart}
                        running={Boolean(bulkBusy) && runJob?.label === column.label}
                        runMenuDisabled={Boolean(bulkBusy)}
                        onOpenRunMenu={(event) => setColumnRunMenu({ ...menuPosition(event, 224), column })}
                        onConfigure={() => { void loadModelChoices(); setQaModelColumn(column); }}
                        configureTitle={`Choose the model that reviews emails`}
                        model={headerModel(column)}
                        cliMode={runnerIsCli}
                        {...reorderProps(column)}
                      />
                    );
                  }
                  if (column.kind === "source") {
                    return <V2HeaderCell key={column.id} label={column.label} width={width} sticky={sticky} onResizeStart={onResizeStart} {...reorderProps(column)} />;
                  }
                  const builtinDef = isV2BuiltinKey(column.key) ? TABLE_COLUMNS_BY_ID[column.key] : undefined;
                  const dir = builtinDef?.sortKey && sort?.key === builtinDef.sortKey ? sort.dir : null;
                  return (
                    <V2HeaderCell
                      key={column.id}
                      label={column.label}
                      width={width}
                      sticky={sticky}
                      onResizeStart={onResizeStart}
                      dir={dir}
                      onSort={builtinDef?.sortKey ? () => toggleSort(builtinDef.sortKey!) : undefined}
                      running={runningAction !== null && builtinDef?.runAction === runningAction}
                      runMenuDisabled={bulkBusy}
                      // The built-in personalization columns run prompts too, so
                      // they carry the same chip. Everything else here (email
                      // status, export, LinkedIn) calls no model and gets none.
                      model={builtinDef?.runAction && isAiPromptColumn(builtinDef.runAction) ? headerModel(column) : undefined}
                      cliMode={runnerIsCli}
                      onOpenRunMenu={
                        builtinDef?.runAction
                          ? (event) => setRunMenu({ ...menuPosition(event, 288), action: builtinDef.runAction! })
                          : undefined
                      }
                      onConfigure={
                        builtinDef?.runAction && isAiPromptColumn(builtinDef.runAction)
                          ? () => void openPromptDialog(builtinDef.runAction as AiPromptColumn)
                          : column.key === "smartlead_export"
                            ? () => setExportSettingsOpen(true)
                            : undefined
                      }
                      configureTitle={
                        column.key === "smartlead_export"
                          ? campaignTag
                            ? `Exports go to ${campaignTag.name}. Click to change.`
                            : "Tag the Smartlead campaign this list exports to"
                          : `Configure the ${column.label} prompt`
                      }
                      {...reorderProps(column)}
                    />
                  );
                })}
                <th
                  style={{ width: 40, minWidth: 40 }}
                  className="sticky top-0 z-30 border-b border-border bg-surface-muted px-1 py-1.5 align-middle"
                >
                  <button
                    type="button"
                    aria-label="Add column"
                    title="Add a column"
                    onClick={(event) => setAddColumnMenu(menuPosition(event, 220))}
                    className={`flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
                  >
                    <Plus className="size-3.5" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="text-[12.5px]">
              {virtualRange.topSpacerHeight > 0 ? (
                <tr aria-hidden="true">
                  <td colSpan={visibleColumns.length + 1} style={{ height: virtualRange.topSpacerHeight }} />
                </tr>
              ) : null}
              {virtualRange.rows.map((lead, index) => {
                const absoluteIndex = virtualRange.startIndex + index;
                const rowBg = absoluteIndex % 2 === 1 ? "bg-subtle" : "bg-surface";
                return (
                  <tr key={lead.id} className={`group/row ${rowBg}`}>
                    {visibleColumns.map((column) => (
                      <Fragment key={column.id}>{renderV2Cell(column, lead, rowBg)}</Fragment>
                    ))}
                    <BodyCell rowBg={rowBg}>{null}</BodyCell>
                  </tr>
                );
              })}
              {virtualRange.bottomSpacerHeight > 0 ? (
                <tr aria-hidden="true">
                  <td colSpan={visibleColumns.length + 1} style={{ height: virtualRange.bottomSpacerHeight }} />
                </tr>
              ) : null}
              {effectiveLeads.length === 0 && !isLoadingRows ? (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                    {loadError ?? "No leads match the current filters."}
                  </td>
                </tr>
              ) : null}
              {isLoadingRows ? (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">
                    Loading more leads...
                  </td>
                </tr>
              ) : null}
              {loadError && effectiveLeads.length > 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="px-3 py-4 text-center text-[11.5px] text-destructive">
                    {loadError}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
      <div ref={scrollerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <table
          className="border-separate border-spacing-0"
          style={{ width: totalTableWidth, tableLayout: "fixed" }}
        >
          <colgroup>
            {TABLE_COLUMNS.map((column) => (
              <col key={column.id} style={{ width: columnWidths[column.id] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {TABLE_COLUMNS.map((column) => (
                <HeaderCell
                  key={column.id}
                  column={column}
                  width={columnWidths[column.id]}
                  sortState={sort}
                  onSort={column.sortKey ? () => toggleSort(column.sortKey!) : undefined}
                  running={runningAction !== null && column.runAction === runningAction}
                  menuDisabled={bulkBusy}
                  onOpenMenu={
                    column.runAction
                      ? (event) => setRunMenu({ ...menuPosition(event, 288), action: column.runAction! })
                      : undefined
                  }
                  onConfigure={
                    column.runAction && isAiPromptColumn(column.runAction)
                      ? () => void openPromptDialog(column.runAction as AiPromptColumn)
                      : column.id === "smartlead_export"
                        ? () => setExportSettingsOpen(true)
                        : undefined
                  }
                  configureTitle={
                    column.id === "smartlead_export"
                      ? campaignTag
                        ? `Exports go to ${campaignTag.name}. Click to change.`
                        : "Tag the Smartlead campaign this list exports to"
                      : `Configure the ${column.label} prompt`
                  }
                  onResizeStart={startColumnResize}
                  onResizeReset={resetColumnWidth}
                />
              ))}
            </tr>
          </thead>
          <tbody className="text-[12.5px]">
            {virtualRange.topSpacerHeight > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={TABLE_COLUMNS.length} style={{ height: virtualRange.topSpacerHeight }} />
              </tr>
            ) : null}
            {virtualRange.rows.map((lead, index) => {
              const absoluteIndex = virtualRange.startIndex + index;
              const rowBg = absoluteIndex % 2 === 1 ? "bg-subtle" : "bg-surface";
              const name = leadName(lead);
              const meta = contactMeta(lead);
              const qualification = getQualification(lead);
              const canFind = !lead.email || lead.emailStatus === "invalid";
              const findMissingInputs = !lead.firstName || !lead.lastName || !lead.domain;
              const personalizationReady = lead.emailStatus === "deliverable";
              const exported = lead.tableExportStatus === "exported";
              const rowResult = lastRowResults[lead.id];
              const exportDisabledReason = lead.suppressionReason
                ? `Suppressed: ${lead.suppressionReason}`
                : exported
                  ? "Already exported from this list. Each list exports a lead once."
                  : !lead.email || lead.emailStatus !== "deliverable"
                    ? "Requires a deliverable email."
                    : undefined;
              // An untagged list keeps the button enabled: clicking it opens
              // the campaign picker instead of running.
              const exportTitle =
                exportDisabledReason ?? (campaignTag ? undefined : "This list has no campaign tag yet. Opens the picker.");

              const variableCell = (action: RunnableAction, value: string | null, clickable?: boolean) => (
                <BodyCell rowBg={rowBg}>
                  <div className="flex items-center gap-1.5">
                    {clickable && value ? (
                      <button
                        type="button"
                        onClick={() => openLeadDetail(lead)}
                        title="View the ops candidate context"
                        className={`min-w-0 flex-1 truncate rounded text-left font-medium underline-offset-2 hover:underline`}
                      >
                        {value}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate font-medium" title={value ?? undefined}>
                        {value ?? <span className="font-normal text-muted-foreground">empty</span>}
                      </span>
                    )}
                    {fallbackMarker(action, lead)}
                    <IconRunButton
                      pending={pendingCells.has(`${lead.id}:${action}`)}
                      disabled={!personalizationReady || bulkBusy}
                      title={
                        personalizationReady
                          ? value
                            ? "Rerun cell"
                            : "Run cell"
                          : "Runs after ZeroBounce marks the email deliverable."
                      }
                      onClick={() => void runSingleCell(action, lead)}
                    />
                    {resultDot(action, lead)}
                  </div>
                </BodyCell>
              );

              return (
                <tr key={lead.id} className={`group/row ${rowBg}`}>
                  {/* Contact (sticky) */}
                  <BodyCell sticky rowBg={rowBg}>
                    <button
                      type="button"
                      onClick={() => openLeadDetail(lead)}
                      title="View lead details"
                      className={`block w-full min-w-0 rounded text-left`}
                    >
                      <span className="block truncate text-[13px] font-medium">{name}</span>
                      <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                        {lead.title ?? "No title"}
                      </span>
                      {meta ? (
                        <span className="block truncate text-[11px] leading-4 text-muted-foreground">{meta}</span>
                      ) : null}
                    </button>
                  </BodyCell>
                  {/* Company */}
                  <BodyCell rowBg={rowBg}>
                    <span className="block truncate" title={lead.company ?? undefined}>
                      {lead.company ?? <span className="text-muted-foreground">No company</span>}
                    </span>
                    {lead.domain ? (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{lead.domain}</span>
                    ) : null}
                  </BodyCell>
                  {/* Qualification */}
                  <BodyCell rowBg={rowBg}>
                    <Pill tone={qualification.tone} label={qualification.label} title={qualification.detail} />
                  </BodyCell>
                  {/* Email */}
                  <BodyCell rowBg={rowBg}>
                    <span className="block truncate font-mono text-[11.5px]" title={lead.email ?? undefined}>
                      {lead.email ?? <span className="font-sans text-muted-foreground">empty</span>}
                    </span>
                  </BodyCell>
                  {/* LinkedIn: employment check (Apify) - the first gate, before ZeroBounce */}
                  <BodyCell rowBg={rowBg}>
                    <div className="flex items-center gap-1.5">
                      {lead.linkedinEmploymentStatus ? (
                        <button
                          type="button"
                          onClick={() => openLeadDetail(lead)}
                          title="View the scraped LinkedIn details"
                          className={`min-w-0 rounded`}
                        >
                          <Pill {...linkedinStatusPill(lead.linkedinEmploymentStatus)} />
                        </button>
                      ) : (
                        <Pill tone="muted" label="not run" />
                      )}
                      <RunButton
                        label={lead.linkedinEmploymentStatus ? "Recheck cell" : "Run cell"}
                        pending={pendingCells.has(`${lead.id}:linkedin_verify`)}
                        disabled={!lead.linkedinUrl || bulkBusy}
                        title={lead.linkedinUrl ? undefined : "Needs a LinkedIn URL to check."}
                        onClick={() => void runSingleCell("linkedin_verify", lead)}
                      />
                      {resultDot("linkedin_verify", lead)}
                    </div>
                  </BodyCell>
                  {/* ZeroBounce: validate */}
                  <BodyCell rowBg={rowBg}>
                    <div className="flex items-center gap-1.5">
                      <RunButton
                        label={lead.emailStatus ? "Rerun cell" : "Run cell"}
                        pending={pendingCells.has(`${lead.id}:validate_email`)}
                        disabled={!lead.email || bulkBusy}
                        title={lead.email ? undefined : "Validate Email depends on the Email column."}
                        onClick={() => void runSingleCell("validate_email", lead)}
                      />
                      {resultDot("validate_email", lead)}
                    </div>
                  </BodyCell>
                  {/* Email status */}
                  <BodyCell rowBg={rowBg}>
                    {lead.emailStatus ? (
                      <Pill tone={emailStatusTone(lead.emailStatus)} label={lead.emailStatus} />
                    ) : (
                      <Pill tone="muted" label="not run" />
                    )}
                  </BodyCell>
                  {/* LeadMagic: find email */}
                  <BodyCell rowBg={rowBg}>
                    <div className="flex items-center gap-1.5">
                      <RunButton
                        icon="search"
                        label={lead.emailStatus === "invalid" ? "Find replacement" : lead.email ? "Not needed" : "Run cell"}
                        pending={pendingCells.has(`${lead.id}:find_email`)}
                        disabled={!canFind || findMissingInputs || bulkBusy}
                        title={
                          !canFind
                            ? "Find Email runs only when the email is missing or marked invalid."
                            : findMissingInputs
                              ? "Needs first name, last name, and domain."
                              : undefined
                        }
                        onClick={() => void runSingleCell("find_email", lead)}
                      />
                      {resultDot("find_email", lead)}
                    </div>
                  </BodyCell>
                  {/* Personalization variables */}
                  {variableCell("final_first_name", lead.finalFirstName)}
                  {variableCell("final_title", lead.finalTitle)}
                  {variableCell("final_company_name", lead.finalCompanyName)}
                  {variableCell("operations_task", lead.operationsTask)}
                  {variableCell("ops_candidate", lead.opsCandidate, true)}
                  {/* Smartlead export */}
                  <BodyCell rowBg={rowBg}>
                    <div className="flex flex-col gap-1">
                      <div>
                        {lead.suppressionReason ? (
                          <Pill tone="destructive" label="suppressed" title={lead.suppressionReason} />
                        ) : lead.tableExportStatus ? (
                          <Pill
                            tone={
                              lead.tableExportStatus === "exported"
                                ? "success"
                                : lead.tableExportStatus === "failed"
                                  ? "destructive"
                                  : "muted"
                            }
                            label={lead.tableExportStatus}
                            title={
                              lead.tableExportError ??
                              (lead.tableExportedAt
                                ? `Exported from this list ${formatExportTimestamp(lead.tableExportedAt)}`
                                : undefined)
                            }
                          />
                        ) : (
                          <Pill tone="muted" label="not exported" />
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <RunButton
                          label={exported ? "Exported" : "Export"}
                          pending={pendingCells.has(`${lead.id}:smartlead_export`)}
                          disabled={Boolean(exportDisabledReason) || bulkBusy}
                          title={exportTitle}
                          onClick={() => void runSingleCell("smartlead_export", lead)}
                        />
                        {resultDot("smartlead_export", lead)}
                        {!lead.suppressionReason ? (
                          <button
                            type="button"
                            aria-label="Suppress lead"
                            title="Suppress this lead: block it from every export. Manage the list from the Suppressions dialog."
                            disabled={pendingCells.has(`${lead.id}:suppress`)}
                            onClick={() => void suppressRow(lead)}
                            className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive disabled:opacity-50`}
                          >
                            {pendingCells.has(`${lead.id}:suppress`) ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Ban className="size-3" />
                            )}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </BodyCell>
                  {/* Last row run */}
                  <BodyCell rowBg={rowBg}>
                    <div className="flex items-start gap-1">
                      <div className="min-w-0 flex-1">
                        {rowResult ? (
                          <button
                            type="button"
                            title={rowResult.message}
                            onClick={() =>
                              setRunDetails({ title: `${name} · Last row run`, result: rowResult })
                            }
                            className={`flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium transition-colors hover:bg-muted/60 ${
                              rowResult.ok ? "text-success" : "text-destructive"
                            }`}
                          >
                            {rowResult.ok ? (
                              <CheckCircle2 className="size-3.5 shrink-0" />
                            ) : (
                              <AlertTriangle className="size-3.5 shrink-0" />
                            )}
                            <span className="truncate">{rowResult.ok ? "Success" : "Failed"}</span>
                          </button>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">No run in this session</span>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label="View run history"
                        title="View the full run history for this lead"
                        onClick={() => openRunHistory(lead)}
                        className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
                      >
                        <History className="size-3.5" />
                      </button>
                    </div>
                  </BodyCell>
                </tr>
              );
            })}
            {virtualRange.bottomSpacerHeight > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={TABLE_COLUMNS.length} style={{ height: virtualRange.bottomSpacerHeight }} />
              </tr>
            ) : null}
            {effectiveLeads.length === 0 && !isLoadingRows ? (
              <tr>
                <td colSpan={TABLE_COLUMNS.length} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
                  {loadError ?? "No leads match the current filters."}
                </td>
              </tr>
            ) : null}
            {isLoadingRows ? (
              <tr>
                <td colSpan={TABLE_COLUMNS.length} className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">
                  Loading more leads...
                </td>
              </tr>
            ) : null}
            {loadError && effectiveLeads.length > 0 ? (
              <tr>
                <td colSpan={TABLE_COLUMNS.length} className="px-3 py-4 text-center text-[11.5px] text-destructive">
                  {loadError}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      )}

      {/* ── Run job progress (server-side; survives refresh) ── */}
      {runJob ? (() => {
        const active = runJob.status === "running" || runJob.status === "pending" || runJob.status === "materializing";
        const processed = runJob.done + runJob.failed;
        return (
          <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-surface px-4 text-[11.5px]">
            {active ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
            ) : runJob.status === "failed" || runJob.failed > 0 ? (
              <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 className="size-3.5 shrink-0 text-success" />
            )}
            <span className="shrink-0 font-medium">{runJob.label}</span>
            <span className="hidden shrink-0 text-muted-foreground sm:inline">
              {runJob.kind === "waterfall" ? "Waterfall" : "Column"}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {processed.toLocaleString("en-US")}/{runJob.total.toLocaleString("en-US")}
              {runJob.failed > 0 ? ` · ${runJob.failed.toLocaleString("en-US")} failed` : ""}
              {runJob.status === "canceled" ? " · stopped" : ""}
              {runJob.status === "failed" ? " · stopped on error" : ""}
            </span>
            <div className="h-1.5 max-w-64 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${runJob.total > 0 ? Math.round((processed / runJob.total) * 100) : 0}%` }}
              />
            </div>
            {active ? (
              <button type="button" onClick={() => void stopRunJob()} className={`${BTN_SUBTLE} ml-auto h-6 px-2 text-[11px]`}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                aria-label="Dismiss run summary"
                onClick={() => setRunJob(null)}
                className={`ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        );
      })() : null}

      {/* ── Sheet tabs: the workbook's tables, at the bottom like a
          spreadsheet's sheet tabs (Excel puts them in their own row above
          the status bar; this mirrors that). ── */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-surface px-3">
        {/* Only the tabs scroll. The campaign sits outside this box so it stays
            pinned at the right instead of drifting off with a long tab strip. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <div role="tablist" aria-label={`Tables in ${workbook.name}`} className="flex items-center gap-1">
            {siblings.map((tab) =>
              tab.id === tableId ? (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected="true"
                  className="flex h-7 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border border-border bg-surface pl-2.5 pr-1 text-[12px] font-semibold shadow-xs"
                  title={tab.description || tab.name}
                >
                  <span className="max-w-56 truncate">{tab.name}</span>
                  <button
                    type="button"
                    aria-label={`Table actions for ${tab.name}`}
                    title="Rename, reorder, move, or delete this table"
                    onClick={(event) => {
                      setTabDeleteArmed(false);
                      // ~260px covers the menu at its tallest (delete armed).
                      // This is the one menu anchored to the bottom of the
                      // window, so it is the one that has to flip.
                      setTabMenu(menuPosition(event, 288, 260));
                    }}
                    className={`flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Link
                  key={tab.id}
                  role="tab"
                  aria-selected="false"
                  href={`/enrichment/${workbook.slug}/${tab.slug}`}
                  title={tab.description || tab.name}
                  className={`flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
                >
                  <span className="max-w-56 truncate">{tab.name}</span>
                </Link>
              ),
            )}
          </div>
          <button
            type="button"
            aria-label="New table"
            title="Add a table to this workbook"
            onClick={() => setNewTableOpen(true)}
            className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
          >
            <Plus className="size-3.5" />
          </button>
        </div>

        {/* Where the SELECTED table sends. It belongs on this row rather than
            beside the header title: a campaign can be tagged on the workbook and
            inherited ("via workbook"), so a tag chip next to the workbook name
            would read as the workbook's own. Here the subject is the open tab,
            which is exactly whose tag this is. */}
        <button
          type="button"
          disabled={tagPending}
          onClick={() => setTagDialog({})}
          data-tip={
            campaignTag
              ? campaignTag.source && campaignTag.source !== "table"
                ? `Inherited from this list's ${campaignTag.source}. Exports go to ${campaignTag.name}. Click to set a tag for this list only.`
                : `Exports from this list go to ${campaignTag.name}. Click to change or remove.`
              : "No campaign tagged, so this list cannot export. Click to choose one."
          }
          data-tip-down=""
          className={
            campaignTag
              ? `flex h-7 min-w-0 max-w-[22rem] shrink items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/70 disabled:opacity-50`
              : /* Untagged is a gap in the list's setup, not a neutral state: it
                   blocks every export. A dashed outline reads as a slot waiting
                   to be filled rather than a button someone might ignore. */
                `flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-amber-500/60 px-2 text-[12px] font-medium text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400`
          }
        >
          <Tag className="size-3.5 shrink-0 opacity-70" />
          {campaignTag ? (
            <>
              <span className="truncate font-medium text-foreground">{campaignTag.name}</span>
              {campaignTag.source && campaignTag.source !== "table" ? (
                <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-medium">via {campaignTag.source}</span>
              ) : null}
            </>
          ) : (
            <span className="whitespace-nowrap">Tag campaign</span>
          )}
        </button>
      </div>

      {/* ── Footer strip ── */}
      <div className="flex h-7 shrink-0 items-center justify-between border-t border-border px-4 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          <span className="font-medium text-foreground">{leads.length.toLocaleString("en-US")}</span> loaded of{" "}
          <span className="font-medium text-foreground">{totalRows.toLocaleString("en-US")}</span> matching rows
        </span>
        <div className="flex items-center gap-3">
          {healthTotal > 0 ? (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={healthOpen}
              onClick={() => setHealthOpen((open) => !open)}
              title="Email health of this list. Click for the full breakdown."
              className={`flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 font-medium tabular-nums text-foreground shadow-xs transition-colors hover:bg-muted/60`}
            >
              {/* The bar IS the summary: proportions at a glance, exact numbers
                  on click. A single headline number could not show that this
                  list is mostly unvalidated rather than mostly bad. */}
              <span className="flex h-2 w-16 overflow-hidden rounded-full bg-muted">
                {healthItems.map((item) => (
                  <span key={item.key} className={item.tone} style={{ width: `${(item.value / healthTotal) * 100}%` }} />
                ))}
              </span>
              {Math.round((stats.deliverable / healthTotal) * 100)}% deliverable
              <ChevronDown className={`size-3 text-muted-foreground transition-transform ${healthOpen ? "rotate-180" : ""}`} />
            </button>
          ) : null}
          {healthTotal > 0 && spend && spend.total.cells > 0 ? <span className="h-3 w-px bg-border" /> : null}
          {spend && spend.total.cells > 0 ? (
            <button
              type="button"
              onClick={() => { const next = !spendOpen; setSpendOpen(next); if (next) void refreshSpend(); }}
              title="Enrichment token + time spend. Click for the API vs CLI breakdown."
              className={`flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 font-medium tabular-nums text-foreground shadow-xs transition-colors hover:bg-muted/60`}
            >
              <Coins className="size-3 text-muted-foreground" />
              {formatTokens(spend.total.tokens)} tokens
              <span className="text-muted-foreground">·</span>
              {formatDuration(spend.total.durationMs)}
            </button>
          ) : null}
          {spend && spend.total.cells > 0 && activeFilterCount > 0 ? <span className="h-3 w-px bg-border" /> : null}
          {activeFilterCount > 0 ? (
            <span>
              {activeFilterCount} {activeFilterCount === 1 ? "filter" : "filters"} active
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Email health breakdown (click a row to filter the grid to it) ── */}
      {healthOpen && healthTotal > 0 ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setHealthOpen(false)}>
          <div
            role="dialog"
            aria-label="Email health breakdown"
            style={{ "--menu-origin": "bottom right" } as CSSProperties}
            className="anim-menu-in fixed bottom-9 right-3 z-50 flex w-[20rem] max-w-[calc(100vw-1.5rem)] cursor-auto flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Email health</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-[15px] font-semibold tabular-nums text-foreground">{healthTotal.toLocaleString("en-US")}</span>
                <span className="text-[11px] text-muted-foreground">leads in {tableName}</span>
              </div>
            </div>

            <span className="flex h-2 overflow-hidden rounded-full bg-muted">
              {healthItems.map((item) => (
                <span key={item.key} className={item.tone} style={{ width: `${(item.value / healthTotal) * 100}%` }} />
              ))}
            </span>

            <div className="flex flex-col">
              {healthItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  data-tip={item.title}
                  onClick={() => { updateFilters({ ...DEFAULT_FILTERS, ...item.filter }); setHealthOpen(false); }}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
                >
                  <span className={`size-2 shrink-0 rounded-full ${item.tone}`} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{item.label}</span>
                  <span className="shrink-0 text-[12px] font-medium tabular-nums text-foreground">{item.value.toLocaleString("en-US")}</span>
                  <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                    {healthTotal ? Math.round((item.value / healthTotal) * 100) : 0}%
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[10.5px] leading-4 text-muted-foreground">
              Click a row to filter the grid to it. Counts cover the whole list, not the current filters.
            </p>
          </div>
        </div>
      ) : null}

      {/* ── Spend breakdown (API vs CLI + per-column averages) ── */}
      {spendOpen && spend ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setSpendOpen(false)}>
          <div
            role="dialog"
            aria-label="Enrichment spend breakdown"
            style={{ "--menu-origin": "bottom right" } as CSSProperties}
            className="anim-menu-in fixed bottom-9 right-3 z-50 flex w-[22rem] max-w-[calc(100vw-1.5rem)] cursor-auto flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Coins className="size-3" /> Enrichment spend
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-[15px] font-semibold tabular-nums text-foreground">{spend.total.tokens.toLocaleString("en-US")}</span>
                <span className="text-[11px] text-muted-foreground">tokens</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-[13px] font-medium tabular-nums text-foreground">{formatDuration(spend.total.durationMs)}</span>
              </div>
              <div className="text-[10.5px] text-muted-foreground">across {spend.total.cells.toLocaleString("en-US")} cells</div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-border bg-muted/20 p-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">API · metered</div>
                <div className="mt-0.5 text-[12.5px] font-semibold tabular-nums text-foreground">{spend.api.tokens.toLocaleString("en-US")} tok</div>
                <div className="text-[10.5px] tabular-nums text-muted-foreground">{formatDuration(spend.api.durationMs)} · {spend.api.cells.toLocaleString("en-US")} cells</div>
                {spend.api.tokens > 0 ? (
                  <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">in {spend.api.inputTokens.toLocaleString("en-US")} · out {spend.api.outputTokens.toLocaleString("en-US")}</div>
                ) : null}
              </div>
              <div className="rounded-md border border-border bg-muted/20 p-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Local CLI</div>
                <div className="mt-0.5 text-[12.5px] font-semibold tabular-nums text-foreground">{formatDuration(spend.cli.durationMs)}</div>
                <div className="text-[10.5px] tabular-nums text-muted-foreground">{spend.cli.cells.toLocaleString("en-US")} cells</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">no token cost</div>
              </div>
            </div>

            {spend.columns.length ? (
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">By column · avg per cell</div>
                <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                  {spend.columns.map((c) => (
                    <div key={c.key} className="flex items-center justify-between gap-2 text-[11px]" title={`${c.cells.toLocaleString("en-US")} cells · ${c.tokens.toLocaleString("en-US")} tokens · ${formatDuration(c.durationMs)} total`}>
                      <span className="min-w-0 flex-1 truncate text-foreground">{c.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {c.tokens > 0 ? `${formatTokens(Math.round(c.tokens / Math.max(1, c.cells)))} tok` : "no tok"} · {formatDuration(Math.round(c.durationMs / Math.max(1, c.cells)))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── Column run menu ── */}
      {runMenu ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setRunMenu(null)}>
          <div
            role="menu"
            aria-label={`Run column ${ACTION_LABELS[runMenu.action]}`}
            style={{ left: runMenu.left, top: runMenu.top, "--menu-origin": "top left" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-72 cursor-auto rounded-md border border-border bg-surface p-1 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {ACTION_LABELS[runMenu.action]}
            </div>
            {runModesFor(runMenu.action).map((mode) => (
              <Fragment key={mode}>
                {mode === "force" ? <div className="my-1 h-px bg-border" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const action = runMenu.action;
                    setRunMenu(null);
                    // Pass the ACTION as the start key: the server resolves it via
                    // findStartStep by key OR action, which works on both v2 (step
                    // keyed by column key, e.g. "linkedin") and v1 (step keyed by
                    // action, e.g. "linkedin_verify"). Reverse-mapping to the key
                    // broke v1 LinkedIn, whose step is keyed by the action.
                    void startRunJob(action, ACTION_LABELS[action], mode);
                  }}
                  className={MENU_ITEM}
                >
                  {RUN_MODE_LABELS[mode]}
                </button>
              </Fragment>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => { const action = runMenu.action; setRunMenu(null); setCountRunDialog({ columnKey: action, label: ACTION_LABELS[action] }); }}
              className={MENU_ITEM}
            >
              {RUN_MODE_LABELS.count}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Custom AI column run menu (v2 layout) ── */}
      {columnRunMenu ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setColumnRunMenu(null)}>
          <div
            role="menu"
            aria-label={`Run column ${columnRunMenu.column.label}`}
            style={{ left: columnRunMenu.left, top: columnRunMenu.top, "--menu-origin": "top left" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-64 cursor-auto rounded-md border border-border bg-surface p-1 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {columnRunMenu.column.label}
            </div>
            {(["test10", "unrun", "outdated", "force"] as RunMode[]).map((mode) => (
              <Fragment key={mode}>
                {mode === "force" ? <div className="my-1 h-px bg-border" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { const column = columnRunMenu.column; setColumnRunMenu(null); void startRunJob(column.key, column.label, mode); }}
                  className={MENU_ITEM}
                >
                  {RUN_MODE_LABELS[mode]}
                </button>
              </Fragment>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => { const column = columnRunMenu.column; setColumnRunMenu(null); setCountRunDialog({ columnKey: column.key, label: column.label }); }}
              className={MENU_ITEM}
            >
              {RUN_MODE_LABELS.count}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Email review (manual approval before export) ── */}
      {reviewOpen ? (
        <EmailReviewModal
          tableId={tableId}
          onClose={() => { setReviewOpen(false); void refreshReviewState(); }}
          onResolved={() => { void refreshReviewState(); void loadPage({ offset: 0, replace: true }); }}
        />
      ) : null}

      {/* ── Run a specific number of rows ── */}
      {countRunDialog ? (
        <CountRunDialog
          label={countRunDialog.label}
          onCancel={() => setCountRunDialog(null)}
          onRun={(count, offset) => {
            const target = countRunDialog;
            setCountRunDialog(null);
            void startRunJob(target.columnKey, target.label, "count", { count, offset });
          }}
        />
      ) : null}

      {/* ── Company summary popover (v2 layout) ── */}
      {summaryPopover ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setSummaryPopover(null)}>
          <div
            role="dialog"
            aria-label="Company summary"
            style={{ left: summaryPopover.left, top: summaryPopover.top, "--menu-origin": "top left" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-80 cursor-auto rounded-md border border-border bg-surface p-3 text-[12px] leading-5 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            {summaryPopover.whatTheyMake ? (
              <p>
                <span className="font-semibold">What they make: </span>
                {summaryPopover.whatTheyMake}
              </p>
            ) : null}
            {summaryPopover.markets ? (
              <p className="mt-1">
                <span className="font-semibold">Markets: </span>
                {summaryPopover.markets}
              </p>
            ) : null}
            {summaryPopover.summary ? <p className="mt-1 text-muted-foreground">{summaryPopover.summary}</p> : null}
            {!summaryPopover.whatTheyMake && !summaryPopover.markets && !summaryPopover.summary ? (
              <p className="text-muted-foreground">No summary yet.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {valuePopover ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setValuePopover(null)}>
          <div
            role="dialog"
            aria-label={valuePopover.label}
            style={{ left: valuePopover.left, top: valuePopover.top, "--menu-origin": "top left" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-80 cursor-auto rounded-md border border-border bg-surface p-3 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {valuePopover.label}
            </p>
            <p className="whitespace-pre-wrap text-[12px] leading-5 text-foreground">{valuePopover.value}</p>
          </div>
        </div>
      ) : null}

      {/* ── Views menu ── */}
      {viewsMenu ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setViewsMenu(null)}>
          <div
            role="menu"
            aria-label="Saved views"
            style={{ left: viewsMenu.left, top: viewsMenu.top, "--menu-origin": "top left" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-72 cursor-auto rounded-md border border-border bg-surface p-1 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            {views.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No saved views yet</div>
            ) : (
              views.map((view) => (
                <div key={view.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      applyView(view);
                      setViewsMenu(null);
                    }}
                    className={`${MENU_ITEM} min-w-0 flex-1`}
                  >
                    <span className="truncate">{view.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete view ${view.name}`}
                    onClick={() => void deleteView(view)}
                    className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-destructive`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))
            )}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setViewsMenu(null);
                setSaveViewOpen(true);
              }}
              className={MENU_ITEM}
            >
              <Plus className="size-3.5" />
              Save current view...
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Sheet-tab menu (active table actions) ── */}
      {tabMenu ? (
        <div className="fixed inset-0 z-40 cursor-pointer" onClick={() => setTabMenu(null)}>
          <div
            role="menu"
            aria-label={`Table actions for ${tableName}`}
            style={{ left: tabMenu.left, top: tabMenu.top, "--menu-origin": tabMenu.up ? "bottom left" : "top left" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-72 cursor-auto rounded-md border border-border bg-surface p-1 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="truncate px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {tableName}
            </div>
            <button
              type="button"
              role="menuitem"
              disabled={tablePending}
              onClick={() => {
                setTabMenu(null);
                setRenameTableOpen(true);
              }}
              className={`${MENU_ITEM} disabled:opacity-50`}
            >
              <Pencil className="size-3.5" />
              Rename
            </button>
            {activeTabIndex > 0 ? (
              <button
                type="button"
                role="menuitem"
                disabled={tablePending}
                onClick={() => void reorderActiveTable("left")}
                className={`${MENU_ITEM} disabled:opacity-50`}
              >
                <ArrowLeft className="size-3.5" />
                Move left
              </button>
            ) : null}
            {activeTabIndex >= 0 && activeTabIndex < siblings.length - 1 ? (
              <button
                type="button"
                role="menuitem"
                disabled={tablePending}
                onClick={() => void reorderActiveTable("right")}
                className={`${MENU_ITEM} disabled:opacity-50`}
              >
                <ArrowRight className="size-3.5" />
                Move right
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              disabled={tablePending}
              onClick={() => {
                setTabMenu(null);
                setMoveTableOpen(true);
              }}
              className={`${MENU_ITEM} disabled:opacity-50`}
            >
              <FolderInput className="size-3.5" />
              Move to workbook...
            </button>
            <div className="my-1 h-px bg-border" />
            {siblings.length <= 1 ? (
              <div
                role="menuitem"
                aria-disabled="true"
                data-tip="A workbook needs at least one table."
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground opacity-60"
              >
                <Trash2 className="size-3.5" />
                <span className="min-w-0">
                  Delete
                  <span className="block text-[10.5px] leading-4">Blocked: this is the workbook&apos;s only table.</span>
                </span>
              </div>
            ) : tabDeleteArmed ? (
              <button
                type="button"
                role="menuitem"
                disabled={tablePending}
                onClick={() => void deleteActiveTable()}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-destructive transition-colors hover:bg-destructive-soft disabled:opacity-50`}
              >
                {tablePending ? (
                  <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                ) : (
                  <Trash2 className="mt-0.5 size-3.5 shrink-0" />
                )}
                <span className="min-w-0">
                  Confirm delete
                  <span className="block text-[10.5px] leading-4 text-destructive/80">
                    Removes this list and its saved views. Leads are not deleted.
                  </span>
                </span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                disabled={tablePending}
                onClick={() => setTabDeleteArmed(true)}
                className={`${MENU_ITEM} text-destructive hover:bg-destructive-soft disabled:opacity-50`}
              >
                <Trash2 className="size-3.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Dialogs ── */}
      {runDetails ? <RunDetailsDialog details={runDetails} onClose={() => setRunDetails(null)} /> : null}
      {runHistory ? <RunHistoryDialog history={runHistory} onClose={() => setRunHistory(null)} /> : null}
      {leadDetail ? (
        <LeadDetailDialog
          detail={leadDetail}
          onClose={() => setLeadDetail(null)}
          onSuppress={(kind) => void suppressFromDetail(kind)}
          suppressPending={suppressPending}
        />
      ) : null}
      {suppressionsOpen ? (
        <SuppressionsDialog
          onClose={() => setSuppressionsOpen(false)}
          showToast={showToast}
          onChanged={() => void loadPage({ offset: 0, replace: true })}
        />
      ) : null}
      {prospectSettingsOpen ? (
        <ProspectSettingsDialog
          onClose={() => setProspectSettingsOpen(false)}
          showToast={showToast}
          onSaved={(config) => {
            // Reflect the save in the header's API/CLI toggle immediately.
            setRunner({
              provider: config.provider,
            });
            // Fold the saved runner config into the cached settings so the
            // next bulk run picks up the new concurrency without a refetch.
            // With no cache yet, the next ensureSettings() fetches fresh.
            const current = settingsRef.current;
            if (!current) return;
            // Merge concurrency so lanes the settings dialog does not expose
            // (e.g. apify) survive a save of the four visible lanes.
            const value: RunnerSettings = { ...current, config: { ...config, concurrency: { ...current.config.concurrency, ...config.concurrency } } };
            settingsRef.current = value;
            setSettings(value);
          }}
        />
      ) : null}
      {qaModelColumn ? (
        <ColumnModelDialog
          title={`${qaModelColumn.label} model`}
          description="The model that reviews each generated email before it can be exported. Its prompts are built from the sequence being judged, so the model is the only thing to choose here."
          initialModel={qaModelColumn.model ?? ""}
          initialCliModel={qaModelColumn.cliModel ?? ""}
          initialReasoningEffort={qaModelColumn.reasoningEffort ?? ""}
          apiModels={modelChoices.apiModels}
          cliModels={modelChoices.cliModels}
          cliMode={runnerIsCli}
          modelsLoading={modelChoices.loading}
          modelSource={modelChoices.source}
          pending={qaModelPending}
          onClose={() => setQaModelColumn(null)}
          onSave={async ({ model, cliModel, reasoningEffort }) => {
            const key = qaModelColumn.key;
            setQaModelPending(true);
            try {
              const result = await setColumnModelsAction(tableId, key, { model, cliModel, reasoningEffort });
              showToast(result.ok, result.ok ? "Model updated." : result.message || "Could not update the model.");
              if (result.ok) {
                setCustomColumns((cols) => cols.map((c) => (c.key === key ? { ...c, model: model || null, cliModel: cliModel || null, reasoningEffort: reasoningEffort || null } : c)));
                setQaModelColumn(null);
              }
            } catch (error) {
              showToast(false, errorMessage(error, "Could not update the model."));
            } finally {
              setQaModelPending(false);
            }
          }}
        />
      ) : null}
      {promptColumn && settings ? (
        <PromptEditorDialog
          key={promptColumn}
          column={promptColumn}
          initialPrompt={settings.prompts.prompts[promptColumn]}
          initialExamples={settings.prompts.examples?.[promptColumn] ?? []}
          initialModel={customColumns.find((c) => c.key === promptColumn)?.model ?? ""}
          initialCliModel={customColumns.find((c) => c.key === promptColumn)?.cliModel ?? ""}
          apiModels={modelChoices.apiModels}
          cliModels={modelChoices.cliModels}
          cliMode={modelChoices.cliMode}
          modelsLoading={modelChoices.loading}
          modelSource={modelChoices.source}
          pending={promptSavePending}
          onSave={(column, prompt, examples, model, cliModel) => void savePrompt(column, prompt, examples, model, cliModel)}
          onClose={() => setPromptColumn(null)}
        />
      ) : null}
      {columnEditor ? (
        <CustomColumnEditorDialog
          key={columnEditor.mode === "edit" ? columnEditor.column.id : "create"}
          mode={columnEditor.mode}
          initialLabel={columnEditor.mode === "edit" ? columnEditor.column.label : ""}
          initialPrompt={columnEditor.mode === "edit" ? columnEditor.column.prompt ?? "" : ""}
          initialModel={columnEditor.mode === "edit" ? columnEditor.column.model ?? "claude-sonnet-5" : "claude-sonnet-5"}
          initialExamples={columnEditor.mode === "edit" ? columnEditor.column.examples : []}
          initialCliModel={columnEditor.mode === "edit" ? columnEditor.column.cliModel ?? "" : ""}
          initialReasoningEffort={columnEditor.mode === "edit" ? columnEditor.column.reasoningEffort ?? "" : ""}
          apiModels={modelChoices.apiModels}
          cliModels={modelChoices.cliModels}
          cliMode={modelChoices.cliMode}
          modelsLoading={modelChoices.loading}
          modelSource={modelChoices.source}
          variables={promptVariablesFor(customColumns, columnEditor.mode === "edit" ? columnEditor.column.id : null)}
          previewLeadName={leads.length > 0 ? leadName(leads[0]) : null}
          onPreview={
            leads.length > 0
              ? async (prompt, model, examples) => {
                  const result = await previewCustomColumnPromptAction({
                    tableId,
                    columnId: columnEditor.mode === "edit" ? columnEditor.column.id : null,
                    prompt,
                    model,
                    leadId: leads[0].id,
                    examples,
                  });
                  return result.ok
                    ? { ok: true, full: result.full, missing: result.missing }
                    : { ok: false, message: result.message };
                }
              : undefined
          }
          pending={columnEditorPending}
          deletePending={columnDeletePending}
          onSave={(label, prompt, model, cliModel, examples, reasoningEffort) => void saveColumnEditor(label, prompt, model, cliModel, examples, reasoningEffort)}
          onDelete={columnEditor.mode === "edit" ? () => void deleteColumnEditor() : undefined}
          onClose={() => setColumnEditor(null)}
        />
      ) : null}
      {emailQaDialog ? (
        <EmailQaDialog
          leadName={emailQaDialog.leadName}
          loading={emailQaDialog.loading}
          details={emailQaDialog.details}
          onClose={() => setEmailQaDialog(null)}
        />
      ) : null}
      {addColumnMenu ? (
        <div className="fixed inset-0 z-40" onClick={() => setAddColumnMenu(null)}>
          <div
            role="menu"
            style={{ left: addColumnMenu.left, top: addColumnMenu.top, "--menu-origin": "top left" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-56 rounded-md border border-border bg-surface p-1 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => { setAddColumnMenu(null); void loadModelChoices(); setColumnEditor({ mode: "create" }); }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70`}
            >
              <Plus className="size-3.5 text-muted-foreground" />
              AI column
            </button>
            <button
              type="button"
              disabled={hasTitleCheckColumn || addEmailQaPending}
              title={hasTitleCheckColumn ? "This list already has a title check column" : undefined}
              onClick={() => { setAddColumnMenu(null); void addTitleCheckColumn(); }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70 disabled:opacity-40`}
            >
              <Check className="size-3.5 text-muted-foreground" />
              Title check column (yes/no gate)
            </button>
            <button
              type="button"
              disabled={hasEmailQaColumn || addEmailQaPending}
              title={hasEmailQaColumn ? "This list already has an email review column" : undefined}
              onClick={() => { setAddColumnMenu(null); void addEmailReviewColumn(); }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70 disabled:opacity-40`}
            >
              <CheckCircle2 className="size-3.5 text-muted-foreground" />
              Email review column
            </button>
          </div>
        </div>
      ) : null}
      {toolbarMenu ? (
        <div className="fixed inset-0 z-40" onClick={() => setToolbarMenu(null)}>
          <div
            role="menu"
            style={{ left: toolbarMenu.left, top: toolbarMenu.top, "--menu-origin": "top right" } as CSSProperties}
            className="anim-menu-in fixed z-50 w-60 rounded-md border border-border bg-surface p-1 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="switch"
              aria-checked={autoExport}
              onClick={toggleAutoExport}
              title="When the autorun chain reaches export and the email review is Ready, push to Smartlead automatically."
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70`}
            >
              <span className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${autoExport ? "bg-primary" : "bg-muted-foreground/30"}`}>
                <span className={`inline-block size-2.5 rounded-full bg-white shadow-xs transition-transform ${autoExport ? "translate-x-3" : "translate-x-0.5"}`} />
              </span>
              Auto-export when review passes
            </button>
            {emailReviewMode !== null ? (
              <button
                type="button"
                role="switch"
                aria-checked={emailReviewMode === "auto"}
                onClick={() => { setToolbarMenu(null); void toggleEmailReviewMode(); }}
                title="Manual: the reviewer proposes fixes and you approve them before export. Automatic: the reviewer applies its own fixes."
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70`}
              >
                <span className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${emailReviewMode === "auto" ? "bg-primary" : "bg-muted-foreground/30"}`}>
                  <span className={`inline-block size-2.5 rounded-full bg-white shadow-xs transition-transform ${emailReviewMode === "auto" ? "translate-x-3" : "translate-x-0.5"}`} />
                </span>
                Auto-apply email review fixes
              </button>
            ) : null}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => { setToolbarMenu(null); setProspectSettingsOpen(true); }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70`}
            >
              <Settings2 className="size-3.5 text-muted-foreground" />
              Prospect settings
            </button>
            <button
              type="button"
              onClick={() => { setToolbarMenu(null); setSuppressionsOpen(true); }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70`}
            >
              <Ban className="size-3.5 text-muted-foreground" />
              Suppression list
            </button>
            <button
              type="button"
              disabled={csvPending || bulkBusy}
              onClick={() => { setToolbarMenu(null); void exportCsv(); }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted/70 disabled:opacity-40`}
            >
              {csvPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <Download className="size-3.5 text-muted-foreground" />}
              {csvPending ? "Preparing CSV..." : "Download CSV"}
            </button>
          </div>
        </div>
      ) : null}
      {tagDialog ? (
        <CampaignTagDialog
          campaigns={campaigns}
          smartleadError={smartleadError}
          current={campaignTag}
          caption={tagDialog.caption}
          pending={tagPending}
          onSave={(tag) => void applyCampaignTag(tag)}
          /* Only a tag set ON this list can be removed here. An inherited one
             belongs to the workbook or folder, so offering to remove it from
             the list would either do nothing or silently untag its siblings.
             Also withheld mid-run: exports in flight would start failing. */
          onRemove={
            campaignTag && (campaignTag.source ?? "table") === "table" && !bulkBusy
              ? () => void applyCampaignTag(null)
              : undefined
          }
          onClose={() => setTagDialog(null)}
        />
      ) : null}
      {exportSettingsOpen ? (
        <ExportSettingsDialog
          tableId={tableId}
          campaigns={campaigns}
          smartleadError={smartleadError}
          currentTag={campaignTag}
          tagPending={tagPending}
          onTagCampaign={(tag) => applyCampaignTag(tag)}
          onClose={() => setExportSettingsOpen(false)}
        />
      ) : null}
      {newTableOpen ? (
        <NewTableDialog
          hasActiveFilters={Boolean(encodeCanonicalFilter(filters))}
          pending={tablePending}
          onCreate={(name, description, snapshotFilters) => void createTable(name, description, snapshotFilters)}
          onClose={() => setNewTableOpen(false)}
        />
      ) : null}
      {renameTableOpen ? (
        <RenameTableDialog
          initialName={tableName}
          pending={tablePending}
          onSave={(name) => void renameTable(name)}
          onClose={() => setRenameTableOpen(false)}
        />
      ) : null}
      {moveTableOpen ? (
        <MoveToWorkbookDialog
          currentWorkbookId={workbook.id}
          tableName={tableName}
          pending={tablePending}
          onMove={(target) => void moveActiveTable(target)}
          onClose={() => setMoveTableOpen(false)}
        />
      ) : null}
      {saveViewOpen ? (
        <SaveViewDialog
          pending={viewSavePending}
          onSave={(name) => void saveCurrentView(name)}
          onClose={() => setSaveViewOpen(false)}
        />
      ) : null}

    </div>
  );
}

/* ── Small building blocks ────────────────────────────────────────────── */

function ToolbarSelect({
  ariaLabel,
  value,
  onChange,
  children,
  widthClass = "w-36",
}: {
  ariaLabel: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
  widthClass?: string;
}) {
  return (
    <div className={`relative ${widthClass} shrink-0`}>
      <select value={value} onChange={onChange} aria-label={ariaLabel} className={`${SELECT_CLASS} w-full truncate`}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function HeaderCell({
  column,
  width,
  sortState,
  onSort,
  running,
  menuDisabled,
  onOpenMenu,
  onConfigure,
  configureTitle,
  onResizeStart,
  onResizeReset,
}: {
  column: ColumnDef;
  width: number;
  sortState: SortState;
  onSort?: () => void;
  running: boolean;
  menuDisabled: boolean;
  onOpenMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onConfigure?: () => void;
  configureTitle: string;
  onResizeStart: (columnId: ColumnId, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onResizeReset: (columnId: ColumnId) => void;
}) {
  const sticky = column.id === "contact";
  const dir = column.sortKey && sortState?.key === column.sortKey ? sortState.dir : null;
  return (
    <th
      style={{ width, minWidth: width, maxWidth: width }}
      className={`overflow-hidden border-b border-r border-border bg-surface-muted px-2 py-1.5 text-left align-middle ${
        sticky ? "sticky left-0 top-0 z-40" : "sticky top-0 z-30"
      }`}
    >
      <div className="flex min-w-0 items-center gap-1 pr-1.5">
        {onSort ? (
          <button
            type="button"
            onClick={onSort}
            title={
              dir === "asc"
                ? "Sorted ascending. Click for descending."
                : dir === "desc"
                  ? "Sorted descending. Click to clear."
                  : "Click to sort"
            }
            className={`group/sort flex h-5 min-w-0 flex-1 items-center gap-1 rounded text-left`}
          >
            <span className="min-w-0 truncate text-[11px] font-semibold text-muted-foreground">{column.label}</span>
            {dir === "asc" ? (
              <ArrowUp className="size-3 shrink-0 text-primary" />
            ) : dir === "desc" ? (
              <ArrowDown className="size-3 shrink-0 text-primary" />
            ) : (
              <ArrowUpDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover/sort:opacity-60" />
            )}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted-foreground">
            {column.label}
          </span>
        )}
        {onConfigure ? (
          <button
            type="button"
            aria-label={configureTitle}
            title={configureTitle}
            onClick={onConfigure}
            className={`flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
          >
            <SlidersHorizontal className="size-3" />
          </button>
        ) : null}
        {onOpenMenu ? (
          <button
            type="button"
            aria-label={`Run column ${column.label}`}
            title="Run this column (choose a mode)"
            disabled={menuDisabled}
            onClick={onOpenMenu}
            className={`flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Play className="size-3" />
          </button>
        ) : null}
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" /> : null}
      </div>
      <button
        type="button"
        aria-label={`Resize ${column.label} column`}
        title="Drag to resize. Double-click to reset."
        onMouseDown={(event) => onResizeStart(column.id, event)}
        onDoubleClick={() => onResizeReset(column.id)}
        className="group/resize absolute right-0 top-0 z-10 flex h-full w-3 cursor-col-resize items-center justify-end"
      >
        <span className="h-full w-px bg-border transition-all group-hover/resize:w-[3px] group-hover/resize:bg-ring/60 group-active/resize:w-[3px] group-active/resize:bg-ring" />
      </button>
    </th>
  );
}

/* v2 layout only: a simpler header cell (no column resize) shared by
   builtin, source, and ai columns. Sort/run/configure are all optional so
   the same component covers every kind. */
function V2HeaderCell({
  label,
  width,
  sticky = false,
  dir = null,
  onSort,
  running = false,
  onOpenRunMenu,
  runMenuDisabled = false,
  onConfigure,
  configureTitle,
  onResizeStart,
  columnId,
  onReorderStart,
  onReorderEnter,
  onReorderDrop,
  onReorderEnd,
  dropTarget = false,
  model,
  cliMode = false,
  constantValue = null,
}: {
  label: string;
  width: number;
  sticky?: boolean;
  dir?: "asc" | "desc" | null;
  onSort?: () => void;
  running?: boolean;
  onOpenRunMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  runMenuDisabled?: boolean;
  onConfigure?: () => void;
  configureTitle?: string;
  onResizeStart?: (event: ReactMouseEvent<HTMLElement>) => void;
  columnId?: string;
  onReorderStart?: (id: string) => void;
  onReorderEnter?: (id: string) => void;
  onReorderDrop?: (id: string) => void;
  onReorderEnd?: () => void;
  dropTarget?: boolean;
  /* The model this column will ACTUALLY run on, already resolved for the
     current mode. Given only for columns that call a model, so a header
     without a chip means "this column runs no prompt" rather than "unknown". */
  model?: string | null;
  cliMode?: boolean;
  /* A pinned value the column returns instead of running its prompt. Takes
     precedence over `model` in the header: the column still HAS models stored
     (unpinning restores them), but none of them run, so naming one would
     advertise work that never happens. Saying "Fixed" instead answers the
     question the empty space otherwise raises. */
  constantValue?: string | null;
}) {
  const reorderable = Boolean(columnId && onReorderStart);
  return (
    <th
      style={{ width, minWidth: width, maxWidth: width }}
      onDragOver={reorderable ? (event) => { event.preventDefault(); if (columnId) onReorderEnter?.(columnId); } : undefined}
      onDrop={reorderable ? (event) => { event.preventDefault(); if (columnId) onReorderDrop?.(columnId); } : undefined}
      className={`relative overflow-hidden border-b border-r border-border bg-surface-muted px-2 py-1.5 text-left align-middle ${
        sticky ? "sticky left-0 top-0 z-40" : "sticky top-0 z-30"
      } ${dropTarget ? "outline outline-2 -outline-offset-2 outline-ring" : ""}`}
    >
      {onResizeStart ? (
        <button
          type="button"
          aria-label={`Resize ${label} column`}
          tabIndex={-1}
          onMouseDown={onResizeStart}
          className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize select-none hover:bg-primary/40"
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-1">
        {reorderable ? (
          <span
            draggable
            onDragStart={() => columnId && onReorderStart?.(columnId)}
            onDragEnd={() => onReorderEnd?.()}
            title="Drag to reorder this column"
            className="shrink-0 cursor-grab text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </span>
        ) : null}
        {onSort ? (
          <button
            type="button"
            onClick={onSort}
            title={
              dir === "asc"
                ? "Sorted ascending. Click for descending."
                : dir === "desc"
                  ? "Sorted descending. Click to clear."
                  : "Click to sort"
            }
            className={`group/sort flex h-5 min-w-0 flex-1 items-center gap-1 rounded text-left`}
          >
            <span className="min-w-0 truncate text-[11px] font-semibold text-muted-foreground">{label}</span>
            {dir === "asc" ? (
              <ArrowUp className="size-3 shrink-0 text-primary" />
            ) : dir === "desc" ? (
              <ArrowDown className="size-3 shrink-0 text-primary" />
            ) : (
              <ArrowUpDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover/sort:opacity-60" />
            )}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted-foreground">{label}</span>
        )}
        {constantValue ? (
          <span
            className="flex shrink-0 items-center gap-1 text-muted-foreground"
            title={`Always writes "${constantValue}". No model runs for this column — clear the pinned value in its editor to go back to generating it.`}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-current text-[8px] font-bold leading-none">=</span>
            {width - label.length * 6.2 > 150 ? <span className="text-[10px] font-medium">Fixed</span> : null}
          </span>
        ) : model === undefined || model === null ? null : (
          /* Whether the model NAME fits, judged per column rather than by a flat
             width cut-off: "Tenure" at 200px has room to spare while "Final
             company_name" at the same width does not. ~6.2px per character at
             11px semibold, against the ~150px the row's fixed furniture and a
             model name need. The mark shows either way, so a column that fails
             this still says which vendor it is - and widening reveals the name. */
          <ColumnModelChip
            model={model}
            cliMode={cliMode}
            showName={width - label.length * 6.2 > 150}
          />
        )}
        {onConfigure ? (
          <button
            type="button"
            aria-label={configureTitle ?? `Configure ${label}`}
            title={configureTitle}
            onClick={onConfigure}
            className={`flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
          >
            <SlidersHorizontal className="size-3" />
          </button>
        ) : null}
        {onOpenRunMenu ? (
          <button
            type="button"
            aria-label={`Run column ${label}`}
            title="Run this column"
            disabled={runMenuDisabled}
            onClick={onOpenRunMenu}
            className={`flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Play className="size-3" />
          </button>
        ) : null}
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" /> : null}
      </div>
    </th>
  );
}

/* The model a column runs, inline on the header's own row.

   It sits on that row rather than under the name deliberately: a second line
   grows the whole header band, and since only model-running columns would have
   one, every other header gains dead space to pay for it. Here it costs the
   label a few characters of truncation and nothing else.

   Small and quiet, because it is there to be SCANNED - setting six columns to
   one model and missing the seventh should be visible without opening
   anything. The vendor mark does most of that: an odd colour in the row
   registers before any text is read.

   `showName` is driven by the column's width. The mark always fits; the name
   only appears once the column is wide enough to hold it without eating the
   column's own label. Widening the column reveals it, and the title carries the
   exact id at any width.

   Native `title`, not the app's data-tip helper: data-tip draws its bubble as
   an ::after INSIDE the trigger, and this header cell is overflow-hidden, so it
   would be clipped to nothing. Every other control here uses `title` for the
   same reason. */
function ColumnModelChip({ model, cliMode, showName }: { model: string; cliMode: boolean; showName: boolean }) {
  const trimmed = model.trim();
  const markClass = "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] text-[8px] font-bold leading-none";

  if (!trimmed) {
    /* Empty means opposite things per mode. On the CLI it is legitimate - the
       CLI falls back to whatever model it is configured with. Through the API
       there is nothing to send, so the column fails every row until one is set,
       which is worth flagging in the header rather than at run time. */
    return cliMode ? (
      <span
        className="flex shrink-0 items-center gap-1"
        title="No model pinned, so this column runs on whatever the Claude Code CLI is set to."
      >
        <span className={`${markClass} bg-muted-foreground/30 text-muted-foreground`}>C</span>
        {showName ? <span className="text-[10px] font-medium text-muted-foreground">CLI default</span> : null}
      </span>
    ) : (
      <span
        className="flex shrink-0 items-center gap-1"
        title="No API model set for this column. It cannot run while the runner is on API."
      >
        <span className={`${markClass} bg-amber-500 text-white`}>!</span>
        {showName ? <span className="text-[10px] font-medium text-amber-700 dark:text-amber-400">No model</span> : null}
      </span>
    );
  }

  const vendor = modelVendor(trimmed);
  const name = shortModelName(trimmed);
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-muted-foreground"
      title={`${MODEL_VENDOR_LABEL[vendor] ? `${MODEL_VENDOR_LABEL[vendor]} · ` : ""}${trimmed} (${cliMode ? "CLI" : "API"} mode)`}
    >
      <VendorMark vendor={vendor} fallback={name} className="size-3.5 shrink-0" />
      {showName ? <span className="max-w-24 truncate text-[10px] font-medium">{name}</span> : null}
    </span>
  );
}

function BodyCell({
  sticky = false,
  rowBg,
  children,
}: {
  sticky?: boolean;
  rowBg: string;
  children: ReactNode;
}) {
  return (
    <td
      className={`border-b border-r border-border px-2 py-1.5 align-top ${
        sticky
          ? `sticky left-0 z-10 ${rowBg} transition-colors group-hover/row:bg-muted`
          : "overflow-hidden transition-colors group-hover/row:bg-muted/40"
      }`}
    >
      {children}
    </td>
  );
}

function RunButton({
  label,
  title,
  pending,
  disabled,
  onClick,
  icon = "play",
}: {
  label: string;
  title?: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  icon?: "play" | "search";
}) {
  const Icon = icon === "search" ? Search : Play;
  return (
    <button
      type="button"
      disabled={disabled || pending}
      title={title ?? label}
      aria-label={title ?? label}
      onClick={onClick}
      className={`${BTN_OUTLINE} size-6 shrink-0 p-0`}
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
    </button>
  );
}

function IconRunButton({
  title,
  pending,
  disabled,
  onClick,
}: {
  title?: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || pending}
      title={title}
      aria-label={title ?? "Run cell"}
      onClick={onClick}
      className={`${BTN_OUTLINE} size-6 shrink-0 p-0`}
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
    </button>
  );
}

function ResultDot({ result, onOpen }: { result: CellResult; onOpen: () => void }) {
  return (
    <button
      type="button"
      title={`View run output: ${result.message}`}
      aria-label="View run output"
      onClick={onOpen}
      className={`flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted/60 ${
        result.ok ? "text-success" : "text-destructive"
      }`}
    >
      {result.ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
    </button>
  );
}
