"use client";

/* The Enrichment landing as a Clay-style workspace overview: folders hold
   workbooks, workbooks hold tables. Idioms (bg-surface cards, quiet toolbars,
   fixed-position menus, the modal grammar, the bottom toast) are copied from
   the host (inboxes-client, campaigns-client, enrichment-dialogs), not shared
   code, so this landing stays decoupled from the concurrently-edited table. */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderInput,
  FolderPlus,
  LayoutGrid,
  Loader2,
  Pencil,
  Plus,
  Rows3,
  Table2,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  createFolderAction,
  createWorkbookAction,
  deleteFolderAction,
  deleteWorkbookAction,
  moveWorkbookAction,
  renameFolderAction,
  renameWorkbookAction,
  setFolderCampaignAction,
  setWorkbookCampaignAction,
} from "./actions";
import { useToast } from "../toast";

/* ── Host visual idioms (copied, not imported) ────────────────────────── */

const BTN_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN_BASE} bg-primary text-primary-foreground shadow-xs hover:opacity-90`;
const BTN_OUTLINE = `${BTN_BASE} border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-muted/60`;
const INPUT_CLASS =
  "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring";
const ICON_BTN_QUIET = `flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50`;
const MENU_ITEM = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors`;

const COLLAPSED_KEY = "prospects:home:v1:collapsed";
// v2: the card grid became the default view; the key bump re-defaults
// everyone to tiles once instead of resurrecting a stale "list" choice.
const VIEW_KEY = "prospects:home:v2:view";

/* ── Local view types (mirror the frozen workspace contract) ──────────── */

type FolderNode = {
  id: string;
  name: string;
  smartleadCampaignId: string | null;
  smartleadCampaignName: string | null;
  sortOrder: number;
};
type TableNode = {
  id: string;
  slug: string;
  name: string;
  description: string;
  smartleadCampaignId: string | null;
  smartleadCampaignName: string | null;
  sortOrder: number;
};
type WorkbookNode = {
  id: string;
  slug: string;
  name: string;
  description: string;
  folderId: string | null;
  smartleadCampaignId: string | null;
  smartleadCampaignName: string | null;
  sortOrder: number;
  tables: TableNode[];
};
export type WorkspaceTreeView = { folders: FolderNode[]; workbooks: WorkbookNode[] };

/* Landing snapshot of one table's segment stats (enrichment_segment_stats):
   pending counts leads whose email is still awaiting validation. */
export type TableStats = { leads: number; deliverable: number; pending: number };

type CampaignOption = { id: string; name: string; status: string | null };
type CampaignTag = { id: string; name: string };
type ViewMode = "list" | "tiles";

type ActionResult = { ok: boolean; message: string };

/* One-line campaign tag helper for anything that carries the two columns. */
function ownTag(node: {
  smartleadCampaignId: string | null;
  smartleadCampaignName: string | null;
}): CampaignTag | null {
  return node.smartleadCampaignId && node.smartleadCampaignName
    ? { id: node.smartleadCampaignId, name: node.smartleadCampaignName }
    : null;
}

/* Effective tag for a table: own beats workbook beats folder. */
function effectiveTableTag(
  table: TableNode,
  workbook: WorkbookNode,
  folderTag: CampaignTag | null,
): { name: string; source: "table" | "workbook" | "folder" } | null {
  const own = ownTag(table);
  if (own) return { name: own.name, source: "table" };
  const book = ownTag(workbook);
  if (book) return { name: book.name, source: "workbook" };
  if (folderTag) return { name: folderTag.name, source: "folder" };
  return null;
}

function bySort<T extends { sortOrder: number; name: string; id: string }>(a: T, b: T) {
  return (
    a.sortOrder - b.sortOrder ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    a.id.localeCompare(b.id)
  );
}

/* ── Anchored menu (fixed position + backdrop + close-on-scroll) ───────── */

function useAnchoredMenu(
  width: number,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const open = coords !== null;

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setCoords(null);
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", dismiss, { capture: true });
  }, [open]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCoords({ top: rect.bottom + 4, left: Math.max(8, rect.right - width) });
  };
  const closeMenu = () => setCoords(null);
  return { coords, open, openMenu, closeMenu };
}

/* ── Campaign pills (shared presentational) ───────────────────────────── */

function CampaignPill({
  name,
  suffix,
  dimmed = false,
  title,
  responsive = false,
}: {
  name: string;
  suffix?: string;
  dimmed?: boolean;
  title?: string;
  responsive?: boolean;
}) {
  const display = responsive ? "hidden sm:inline-flex" : "inline-flex";
  return (
    <span
      data-tip={title}
      className={`${display} max-w-[220px] shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium ring-1 ring-inset ring-border ${
        dimmed ? "text-muted-foreground/70" : "text-muted-foreground"
      }`}
    >
      <span className="truncate">
        Campaign: {name}
        {suffix ? ` ${suffix}` : ""}
      </span>
    </span>
  );
}

/* Workbook header pill: own tag reads solid, an inherited folder tag reads
   dimmed with a "via folder" suffix (the title spells out inheritance). */
function WorkbookCampaignPill({
  workbook,
  folderTag,
}: {
  workbook: WorkbookNode;
  folderTag: CampaignTag | null;
}) {
  const own = ownTag(workbook);
  if (own) return <CampaignPill name={own.name} title="This workbook's campaign tag" />;
  if (folderTag) {
    return (
      <CampaignPill
        name={folderTag.name}
        suffix="via folder"
        dimmed
        title="Inherited from the folder's campaign tag. Tag this workbook to override it."
      />
    );
  }
  return null;
}

function campaignStatusClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "ACTIVE" || normalized === "COMPLETED") return "bg-success-soft text-success";
  if (normalized === "PAUSED") return "bg-warning-soft text-warning";
  return "bg-muted text-muted-foreground";
}

/* ── Root ──────────────────────────────────────────────────────────────── */

export function EnrichmentHomeClient({
  tree: incoming,
  campaigns,
  smartleadError = false,
  tableStats,
}: {
  tree: WorkspaceTreeView;
  campaigns: CampaignOption[];
  smartleadError?: boolean;
  /* Per-table segment stats keyed by table id; a missing entry (stats RPC
     failed for that table) just hides that table's numbers. */
  tableStats: Record<string, TableStats>;
}) {
  const router = useRouter();
  const showToast = useToast();

  // Tag controls disable themselves only when Smartlead is actually
  // unreachable; a genuinely empty campaign list still opens the picker,
  // which explains itself.
  const campaignsAvailable = campaigns.length > 0 || !smartleadError;

  // Local, optimistic copy of the tree so a mutation never blanks the page
  // while router.refresh() re-fetches. When the server delivers a fresh prop
  // (new object identity), adopt it as truth during render (no effect, so no
  // synchronous setState in an effect body).
  const [tree, setTree] = useState<WorkspaceTreeView>(incoming);
  const [syncedFrom, setSyncedFrom] = useState<WorkspaceTreeView>(incoming);
  const [busy, setBusy] = useState<string | null>(null);
  // While a mutation is in flight, an earlier refresh's snapshot may predate
  // it; adopting would flicker-revert the optimistic update.
  if (incoming !== syncedFrom && busy === null) {
    setSyncedFrom(incoming);
    setTree(incoming);
  }

  const [view, setView] = useState<ViewMode>("tiles");
  useEffect(() => {
    // Deferred so the read+setState lands outside the effect body (host idiom)
    // and the server's tiles render is never contradicted synchronously.
    const t = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(VIEW_KEY);
        if (raw === "list" || raw === "tiles") setView(raw);
      } catch {
        // localStorage unavailable, so the view choice just won't restore.
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // localStorage unavailable, so the view choice just won't persist.
    }
  };

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Deferred so the read+setState lands outside the effect body (host idiom
    // in enrichment-table) and never mismatches the server's expanded render.
    const t = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY);
        if (raw) {
          const ids = JSON.parse(raw) as unknown;
          if (Array.isArray(ids)) setCollapsed(new Set(ids.filter((v): v is string => typeof v === "string")));
        }
      } catch {
        window.localStorage.removeItem(COLLAPSED_KEY);
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const persistCollapsed = (next: Set<string>) => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // localStorage unavailable, so collapse state just won't persist.
    }
  };
  const toggleFolder = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistCollapsed(next);
      return next;
    });
  };

  const [, startTransition] = useTransition();

  // Every mutation runs on one transition: optimistically fold the result into
  // local state, toast the action's message, then refresh to reconcile.
  const run = (
    marker: string,
    action: () => Promise<ActionResult>,
    onOk?: (result: ActionResult) => void,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      setBusy(marker);
      startTransition(async () => {
        let ok = false;
        try {
          const result = await action();
          ok = result.ok;
          if (result.ok) onOk?.(result);
          showToast(result.ok, result.message || (result.ok ? "Done." : "Something went wrong."));
          if (result.ok) router.refresh();
        } catch (error) {
          showToast(false, error instanceof Error ? error.message : "Something went wrong.");
        } finally {
          setBusy((prev) => (prev === marker ? null : prev));
          resolve(ok);
        }
      });
    });

  // Dialog state: one of the modal kinds is open at a time.
  type Dialog =
    | { kind: "new-workbook" }
    | { kind: "new-folder" }
    | { kind: "rename-folder"; id: string; name: string }
    | { kind: "rename-workbook"; id: string; name: string }
    | { kind: "tag"; target: "folder" | "workbook"; id: string; current: CampaignTag | null };
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const folders = useMemo(() => [...tree.folders].sort(bySort), [tree.folders]);
  const workbooksByFolder = useMemo(() => {
    const map = new Map<string, WorkbookNode[]>();
    const ungrouped: WorkbookNode[] = [];
    for (const wb of tree.workbooks) {
      if (wb.folderId) {
        const list = map.get(wb.folderId) ?? [];
        list.push(wb);
        map.set(wb.folderId, list);
      } else {
        ungrouped.push(wb);
      }
    }
    for (const list of map.values()) list.sort(bySort);
    ungrouped.sort(bySort);
    return { map, ungrouped };
  }, [tree.workbooks]);

  const empty = folders.length === 0 && tree.workbooks.length === 0;

  /* Mutations (optimistic local edits then refresh) ─────────────────────── */

  // Returns the created folder so composite flows (new workbook into a new
  // folder, move-to-new-folder) can chain on its id.
  const createFolderReturning = (name: string): Promise<FolderNode | null> => {
    let created: FolderNode | null = null;
    return run(
      "new-folder",
      () => createFolderAction(name) as Promise<ActionResult & { folder?: FolderNode }>,
      (result) => {
        const folder = (result as { folder?: FolderNode }).folder ?? null;
        created = folder;
        if (folder) setTree((prev) => ({ ...prev, folders: [...prev.folders, folder] }));
      },
    ).then((ok) => (ok ? created : null));
  };
  const createFolder = (name: string) => createFolderReturning(name).then((folder) => folder !== null);

  const renameFolder = (id: string, name: string) =>
    run(
      `folder:${id}`,
      () => renameFolderAction(id, name) as Promise<ActionResult & { folder?: FolderNode }>,
      (result) => {
        const folder = (result as { folder?: FolderNode }).folder;
        if (folder) {
          setTree((prev) => ({
            ...prev,
            folders: prev.folders.map((f) => (f.id === id ? { ...f, name: folder.name } : f)),
          }));
        }
      },
    );

  const deleteFolder = (id: string) =>
    run(`folder:${id}`, () => deleteFolderAction(id), () => {
      setTree((prev) => ({ ...prev, folders: prev.folders.filter((f) => f.id !== id) }));
    });

  const setFolderCampaign = (id: string, tag: CampaignTag | null) =>
    run(`folder:${id}`, () => setFolderCampaignAction(id, tag), () => {
      setTree((prev) => ({
        ...prev,
        folders: prev.folders.map((f) =>
          f.id === id
            ? { ...f, smartleadCampaignId: tag?.id ?? null, smartleadCampaignName: tag?.name ?? null }
            : f,
        ),
      }));
    });

  const createWorkbook = (name: string, description: string, folderId: string | null) =>
    run(
      "new-workbook",
      () =>
        createWorkbookAction(name, description, folderId ?? undefined) as Promise<
          ActionResult & { workbook?: Omit<WorkbookNode, "tables"> }
        >,
      (result) => {
        const wb = (result as { workbook?: Omit<WorkbookNode, "tables"> }).workbook;
        if (wb) setTree((prev) => ({ ...prev, workbooks: [...prev.workbooks, { ...wb, tables: [] }] }));
      },
    );

  const renameWorkbook = (id: string, name: string) =>
    run(
      `wb:${id}`,
      () => renameWorkbookAction(id, name) as Promise<ActionResult & { workbook?: WorkbookNode }>,
      (result) => {
        const wb = (result as { workbook?: WorkbookNode }).workbook;
        if (wb) {
          setTree((prev) => ({
            ...prev,
            workbooks: prev.workbooks.map((w) => (w.id === id ? { ...w, name: wb.name } : w)),
          }));
        }
      },
    );

  const moveWorkbook = (id: string, folderId: string | null) =>
    run(
      `wb:${id}`,
      () => moveWorkbookAction(id, folderId) as Promise<ActionResult & { workbook?: WorkbookNode }>,
      () => {
        setTree((prev) => ({
          ...prev,
          workbooks: prev.workbooks.map((w) => (w.id === id ? { ...w, folderId } : w)),
        }));
      },
    );

  const moveWorkbookToNewFolder = async (id: string, name: string) => {
    const folder = await createFolderReturning(name);
    if (folder) await moveWorkbook(id, folder.id);
  };

  const deleteWorkbook = (id: string) =>
    run(`wb:${id}`, () => deleteWorkbookAction(id), () => {
      setTree((prev) => ({ ...prev, workbooks: prev.workbooks.filter((w) => w.id !== id) }));
    });

  const setWorkbookCampaign = (id: string, tag: CampaignTag | null) =>
    run(`wb:${id}`, () => setWorkbookCampaignAction(id, tag), () => {
      setTree((prev) => ({
        ...prev,
        workbooks: prev.workbooks.map((w) =>
          w.id === id
            ? { ...w, smartleadCampaignId: tag?.id ?? null, smartleadCampaignName: tag?.name ?? null }
            : w,
        ),
      }));
    });

  // Shared handler bundle every workbook card (list or tile) receives.
  const workbookCommon: WorkbookCardCommon = {
    busy,
    allFolders: folders,
    campaignsAvailable,
    tableStats,
    onRename: (id, name) => setDialog({ kind: "rename-workbook", id, name }),
    onMove: moveWorkbook,
    onMoveToNewFolder: moveWorkbookToNewFolder,
    onDelete: deleteWorkbook,
    onTag: (id, current) => setDialog({ kind: "tag", target: "workbook", id, current }),
    onRemoveTag: (id) => setWorkbookCampaign(id, null),
  };

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 xl:p-8">
      {/* Action row */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDialog({ kind: "new-workbook" })}
          className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
        >
          <Plus className="size-3.5" />
          New workbook
        </button>
        <button
          type="button"
          onClick={() => setDialog({ kind: "new-folder" })}
          className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}
        >
          <FolderPlus className="size-3.5" />
          New folder
        </button>

        <div className="ml-auto flex items-center gap-2">
          <div
            role="group"
            aria-label="Layout"
            className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-xs"
          >
            <ViewToggleButton
              active={view === "list"}
              label="List view"
              onClick={() => changeView("list")}
            >
              <Rows3 className="size-3.5" />
            </ViewToggleButton>
            <ViewToggleButton
              active={view === "tiles"}
              label="Tile view"
              onClick={() => changeView("tiles")}
            >
              <LayoutGrid className="size-3.5" />
            </ViewToggleButton>
          </div>
        </div>
      </div>

      {empty ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface/50 px-6 py-16 text-center">
          <Folder className="size-7 text-muted-foreground/70" strokeWidth={1.5} />
          <div className="flex flex-col gap-1">
            <p className="text-[13px] font-medium">No workbooks yet</p>
            <p className="text-[12px] text-muted-foreground">
              Create a workbook to start organizing prospect tables.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDialog({ kind: "new-workbook" })}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            <Plus className="size-3.5" />
            New workbook
          </button>
        </div>
      ) : view === "list" ? (
        <WorkspaceBrowser
          folders={folders}
          workbooks={tree.workbooks}
          common={workbookCommon}
          folderBusy={(id) => busy === `folder:${id}`}
          onRenameFolder={(folder) => setDialog({ kind: "rename-folder", id: folder.id, name: folder.name })}
          onDeleteFolder={deleteFolder}
          onTagFolder={(folder) => setDialog({ kind: "tag", target: "folder", id: folder.id, current: ownTag(folder) })}
          onRemoveFolderTag={(id) => setFolderCampaign(id, null)}
        />
      ) : (
        <div className="flex flex-col gap-5">
          {folders.map((folder) => {
            const contents = workbooksByFolder.map.get(folder.id) ?? [];
            return (
              <FolderSection
                key={folder.id}
                folder={folder}
                workbooks={contents}
                collapsed={collapsed.has(folder.id)}
                onToggle={() => toggleFolder(folder.id)}
                busy={busy}
                campaignsAvailable={campaignsAvailable}
                common={workbookCommon}
                onRenameFolder={() => setDialog({ kind: "rename-folder", id: folder.id, name: folder.name })}
                onDeleteFolder={() => deleteFolder(folder.id)}
                onTagFolder={() =>
                  setDialog({ kind: "tag", target: "folder", id: folder.id, current: ownTag(folder) })
                }
                onRemoveFolderTag={() => setFolderCampaign(folder.id, null)}
              />
            );
          })}

          {workbooksByFolder.ungrouped.length > 0 ? (
            <section className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 px-0.5">
                <h2 className="text-[13px] font-semibold tracking-tight">Workbooks</h2>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {workbooksByFolder.ungrouped.length}
                </span>
              </div>
              <WorkbookCollection
                workbooks={workbooksByFolder.ungrouped}
                folderTag={null}
                common={workbookCommon}
                onNewWorkbook={() => setDialog({ kind: "new-workbook" })}
              />
            </section>
          ) : null}
        </div>
      )}

      {/* Dialogs */}
      {dialog?.kind === "new-workbook" ? (
        <NewWorkbookDialog
          folders={folders}
          busy={busy === "new-workbook" || busy === "new-folder"}
          onClose={() => setDialog(null)}
          onSubmit={async (name, description, folderChoice) => {
            let folderId: string | null;
            if (folderChoice.kind === "new") {
              const created = await createFolderReturning(folderChoice.name);
              if (!created) return; // folder action already toasted; keep dialog open
              folderId = created.id;
            } else {
              folderId = folderChoice.id;
            }
            const ok = await createWorkbook(name, description, folderId);
            if (ok) setDialog(null);
          }}
        />
      ) : null}

      {dialog?.kind === "new-folder" ? (
        <SingleInputDialog
          title="New folder"
          label="Folder name"
          placeholder="e.g. Manufacturing Ops"
          submitLabel="Create folder"
          busy={busy === "new-folder"}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const ok = await createFolder(name);
            if (ok) setDialog(null);
          }}
        />
      ) : null}

      {dialog?.kind === "rename-folder" ? (
        <SingleInputDialog
          title="Rename folder"
          label="Folder name"
          initial={dialog.name}
          submitLabel="Save"
          busy={busy === `folder:${dialog.id}`}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const ok = await renameFolder(dialog.id, name);
            if (ok) setDialog(null);
          }}
        />
      ) : null}

      {dialog?.kind === "rename-workbook" ? (
        <SingleInputDialog
          title="Rename workbook"
          label="Workbook name"
          initial={dialog.name}
          submitLabel="Save"
          busy={busy === `wb:${dialog.id}`}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const ok = await renameWorkbook(dialog.id, name);
            if (ok) setDialog(null);
          }}
        />
      ) : null}

      {dialog?.kind === "tag" ? (
        <CampaignPickerDialog
          campaigns={campaigns}
          current={dialog.current}
          title={dialog.target === "folder" ? "Tag folder campaign" : "Tag workbook campaign"}
          caption={
            dialog.target === "folder"
              ? "Tables in this folder inherit this campaign unless their workbook or the table sets its own."
              : "Tables in this workbook inherit this campaign unless the table sets its own. An own tag overrides the folder's."
          }
          pending={busy === (dialog.target === "folder" ? `folder:${dialog.id}` : `wb:${dialog.id}`)}
          onClose={() => setDialog(null)}
          onSave={async (tag) => {
            const ok =
              dialog.target === "folder"
                ? await setFolderCampaign(dialog.id, tag)
                : await setWorkbookCampaign(dialog.id, tag);
            if (ok) setDialog(null);
          }}
        />
      ) : null}

    </div>
  );
}

function ViewToggleButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
      data-tip-down=""
      onClick={onClick}
      className={`flex size-6.5 items-center justify-center rounded transition-colors ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/* ── Shared workbook-card handlers ────────────────────────────────────── */

type WorkbookCardCommon = {
  busy: string | null;
  allFolders: FolderNode[];
  campaignsAvailable: boolean;
  tableStats: Record<string, TableStats>;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, folderId: string | null) => void;
  onMoveToNewFolder: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onTag: (id: string, current: CampaignTag | null) => void;
  onRemoveTag: (id: string) => void;
};

/* ── Table stats (landing snapshot) ───────────────────────────────────── */

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/* Verification progress: complete when no lead is still pending validation. */
function verifiedPct(stats: TableStats): number {
  if (stats.leads <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((stats.leads - stats.pending) / stats.leads) * 100)));
}

/* Native title, not data-tip: these sit inside overflow-clipped cards. */
function TableStatCluster({ stats }: { stats: TableStats }) {
  const pct = verifiedPct(stats);
  return (
    <span
      className="flex shrink-0 items-center gap-2.5"
      title={`${formatCount(stats.leads)} leads · ${pct}% verified · ${formatCount(stats.deliverable)} deliverable · ${formatCount(stats.pending)} pending validation`}
    >
      <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
        {formatCount(stats.leads)} {stats.leads === 1 ? "lead" : "leads"}
      </span>
      <span className="hidden items-center gap-1.5 sm:flex">
        <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
        </span>
        <span className="w-8 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground">
          {pct}%
        </span>
      </span>
    </span>
  );
}

function StatCell({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className={`text-[17px] font-semibold tracking-tight tabular-nums ${warn ? "text-warning" : ""}`}>
        {formatCount(value)}
      </span>
      <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-foreground-subtle">{label}</span>
    </div>
  );
}

/* Sum of whichever of a workbook's tables have stats; null when none do, so
   a stats outage degrades to hidden numbers rather than zeros. */
function sumStats(tables: TableNode[], tableStats: Record<string, TableStats>): TableStats | null {
  const known = tables.map((t) => tableStats[t.id]).filter((s): s is TableStats => Boolean(s));
  if (known.length === 0) return null;
  return known.reduce(
    (acc, s) => ({
      leads: acc.leads + s.leads,
      deliverable: acc.deliverable + s.deliverable,
      pending: acc.pending + s.pending,
    }),
    { leads: 0, deliverable: 0, pending: 0 },
  );
}

/* Workbook-level totals band for the tile card. */
function WorkbookStatBand({
  tables,
  tableStats,
}: {
  tables: TableNode[];
  tableStats: Record<string, TableStats>;
}) {
  const sum = sumStats(tables, tableStats);
  if (!sum) return null;
  return (
    <div className="flex gap-7 border-t border-border px-4 py-3">
      <StatCell label="Leads" value={sum.leads} />
      <StatCell label="Deliverable" value={sum.deliverable} />
      <StatCell label="Pending" value={sum.pending} warn={sum.pending > 0} />
    </div>
  );
}

/* Tile grid for one collection of workbooks (the list view renders the
   WorkspaceBrowser instead and never reaches this). */
function WorkbookCollection({
  workbooks,
  folderTag,
  common,
  onNewWorkbook,
}: {
  workbooks: WorkbookNode[];
  folderTag: CampaignTag | null;
  common: WorkbookCardCommon;
  /* When set, the tile grid ends with a dashed ghost card that opens the
     new-workbook dialog (only the top-level collection passes it). */
  onNewWorkbook?: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {workbooks.map((wb) => (
        <CompactWorkbookCard key={wb.id} workbook={wb} folderTag={folderTag} {...common} />
      ))}
      {onNewWorkbook ? (
        <button
          type="button"
          onClick={onNewWorkbook}
          className="flex min-h-[180px] flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-border-strong text-muted-foreground transition-colors hover:bg-surface/70 hover:text-foreground"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-muted">
            <Plus className="size-4" />
          </span>
          <span className="text-[12.5px] font-medium">New workbook</span>
        </button>
      ) : null}
    </div>
  );
}

/* ── Folder section (collapsible) ─────────────────────────────────────── */

function FolderSection({
  folder,
  workbooks,
  collapsed,
  onToggle,
  busy,
  campaignsAvailable,
  common,
  onRenameFolder,
  onDeleteFolder,
  onTagFolder,
  onRemoveFolderTag,
}: {
  folder: FolderNode;
  workbooks: WorkbookNode[];
  collapsed: boolean;
  onToggle: () => void;
  busy: string | null;
  campaignsAvailable: boolean;
  common: WorkbookCardCommon;
  onRenameFolder: () => void;
  onDeleteFolder: () => void;
  onTagFolder: () => void;
  onRemoveFolderTag: () => void;
}) {
  const folderTag = ownTag(folder);
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 px-0.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className={`flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left transition-colors hover:text-foreground`}
        >
          {collapsed ? (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )}
          <Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="truncate text-[13px] font-semibold tracking-tight">{folder.name}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{workbooks.length}</span>
        </button>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {folderTag ? <CampaignPill name={folderTag.name} title="This folder's campaign tag" /> : null}
          <FolderMenu
            busy={busy === `folder:${folder.id}`}
            hasTag={folderTag !== null}
            campaignsAvailable={campaignsAvailable}
            onRename={onRenameFolder}
            onTag={onTagFolder}
            onRemoveTag={onRemoveFolderTag}
            onDelete={onDeleteFolder}
          />
        </div>
      </div>

      {!collapsed ? (
        workbooks.length > 0 ? (
          <WorkbookCollection workbooks={workbooks} folderTag={folderTag} common={common} />
        ) : (
          <p className="pl-8 text-[12px] text-muted-foreground">No workbooks yet.</p>
        )
      ) : null}
    </section>
  );
}

function FolderMenu({
  busy,
  hasTag,
  campaignsAvailable,
  onRename,
  onTag,
  onRemoveTag,
  onDelete,
}: {
  busy: boolean;
  hasTag: boolean;
  campaignsAvailable: boolean;
  onRename: () => void;
  onTag: () => void;
  onRemoveTag: () => void;
  onDelete: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menu = useAnchoredMenu(224, triggerRef);
  const [armed, setArmed] = useState<"delete" | "removeTag" | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);

  const close = () => {
    menu.closeMenu();
    setArmed(null);
    if (armTimer.current) clearTimeout(armTimer.current);
  };
  const arm = (which: "delete" | "removeTag", action: () => void) => {
    if (armed === which) {
      close();
      action();
      return;
    }
    setArmed(which);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(null), 3000);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Folder actions"
        aria-haspopup="menu"
        disabled={busy}
        onClick={() => (menu.open ? close() : menu.openMenu())}
        className={ICON_BTN_QUIET}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Ellipsis className="size-3.5" />}
      </button>
      {menu.coords ? (
        <>
          <div className="fixed inset-0 z-40 cursor-pointer" aria-hidden onClick={close} />
          <div
            role="menu"
            className="anim-menu-in fixed z-50 w-56 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-pop"
            style={{ top: menu.coords.top, left: menu.coords.left }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onRename();
              }}
              className={`${MENU_ITEM} hover:bg-muted/60`}
            >
              <Pencil className="size-3.5 text-muted-foreground" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!campaignsAvailable}
              data-tip={campaignsAvailable ? undefined : "Smartlead is unreachable"}
              onClick={() => {
                close();
                onTag();
              }}
              className={`${MENU_ITEM} hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <Tag className="size-3.5 text-muted-foreground" />
              Tag campaign
            </button>
            {hasTag ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => arm("removeTag", onRemoveTag)}
                className={`${MENU_ITEM} hover:bg-muted/60`}
              >
                <X className="size-3.5 text-muted-foreground" />
                {armed === "removeTag" ? "Remove tag? Click again" : "Remove campaign tag"}
              </button>
            ) : null}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              onClick={() => arm("delete", onDelete)}
              className={`${MENU_ITEM} text-destructive hover:bg-destructive-soft`}
            >
              <Trash2 className="size-3.5" />
              {armed === "delete" ? "Delete? Click again" : "Delete"}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

/* ── Workspace browser (list layout) ──────────────────────────────────────
   Clay-style drill-down file browser: one flat table per level — folders
   and un-foldered workbooks at the root, a folder's workbooks inside it, a
   workbook's tables inside that — with a breadcrumb to climb back out.
   Hierarchy lives in the navigation, not in nested boxes: every level
   shares the same columns, every row shows its aggregates, and
   descriptions live on the drilled-in header, never in rows. */

type BrowserPath = { folderId: string | null; workbookId: string | null };

const TH_CLASS =
  "px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.05em] text-foreground-subtle";
/* Bare campaign pill (no "Campaign:" prefix — the column header names it). */
const BARE_PILL =
  "inline-block max-w-full truncate rounded px-1.5 py-px text-[10px] font-medium text-muted-foreground ring-1 ring-inset ring-border";

function BrowserStatCells({ stats }: { stats: TableStats | null }) {
  const numTd = "px-3 py-2.5 text-right text-[12.5px] tabular-nums align-middle";
  const pct = stats ? verifiedPct(stats) : 0;
  return (
    <>
      <td className={numTd}>{stats ? formatCount(stats.leads) : null}</td>
      <td className="px-3 py-2.5 align-middle">
        {stats ? (
          <span
            className="flex items-center justify-end gap-2"
            title={`${pct}% of leads have finished email verification`}
          >
            <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
            </span>
            <span className="w-8 text-right text-[12px] tabular-nums text-muted-foreground">{pct}%</span>
          </span>
        ) : null}
      </td>
      <td className={numTd}>{stats ? formatCount(stats.deliverable) : null}</td>
      <td
        className={`${numTd} ${stats && stats.pending > 0 ? "font-medium text-warning" : "text-muted-foreground"}`}
      >
        {stats ? formatCount(stats.pending) : null}
      </td>
    </>
  );
}

function BrowserRowShell({
  isLast,
  onOpen,
  children,
}: {
  isLast: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <tr
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`cursor-pointer transition-colors hover:bg-muted/50 ${isLast ? "" : "border-b border-border"}`}
    >
      {children}
    </tr>
  );
}

function BrowserNameCell({
  icon,
  name,
  description,
}: {
  icon: ReactNode;
  name: string;
  description?: string;
}) {
  return (
    <td className="py-2.5 pl-4 pr-3 align-middle">
      <span className="flex min-w-0 items-center gap-2.5" title={description || undefined}>
        {icon}
        <span className="truncate text-[12.5px] font-medium">{name}</span>
      </span>
    </td>
  );
}

function WorkspaceBrowser({
  folders,
  workbooks,
  common,
  folderBusy,
  onRenameFolder,
  onDeleteFolder,
  onTagFolder,
  onRemoveFolderTag,
}: {
  folders: FolderNode[];
  workbooks: WorkbookNode[];
  common: WorkbookCardCommon;
  folderBusy: (id: string) => boolean;
  onRenameFolder: (folder: FolderNode) => void;
  onDeleteFolder: (id: string) => void;
  onTagFolder: (folder: FolderNode) => void;
  onRemoveFolderTag: (id: string) => void;
}) {
  const router = useRouter();
  const { busy, allFolders, campaignsAvailable, tableStats } = common;
  const [path, setPath] = useState<BrowserPath>({ folderId: null, workbookId: null });

  const currentWorkbook = path.workbookId ? (workbooks.find((w) => w.id === path.workbookId) ?? null) : null;
  const liveFolderId = currentWorkbook ? currentWorkbook.folderId : path.folderId;
  const currentFolder = liveFolderId ? (folders.find((f) => f.id === liveFolderId) ?? null) : null;

  // A refresh can delete the node we're standing in; pop to the nearest
  // surviving ancestor during render (same adopt-during-render idiom as the
  // tree itself).
  if (path.workbookId && !currentWorkbook) {
    setPath({ folderId: path.folderId, workbookId: null });
  } else if (!path.workbookId && path.folderId && !currentFolder) {
    setPath({ folderId: null, workbookId: null });
  }

  const folderTables = (folder: FolderNode): TableNode[] =>
    workbooks.filter((w) => w.folderId === folder.id).flatMap((w) => w.tables);

  const workbookMenuFor = (workbook: WorkbookNode) => (
    <WorkbookMenu
      busy={busy === `wb:${workbook.id}`}
      folders={allFolders}
      currentFolderId={workbook.folderId}
      hasTables={workbook.tables.length > 0}
      hasOwnTag={ownTag(workbook) !== null}
      campaignsAvailable={campaignsAvailable}
      onRename={() => common.onRename(workbook.id, workbook.name)}
      onMove={(folderId) => common.onMove(workbook.id, folderId)}
      onMoveToNewFolder={(name) => common.onMoveToNewFolder(workbook.id, name)}
      onDelete={() => common.onDelete(workbook.id)}
      onTag={() => common.onTag(workbook.id, ownTag(workbook))}
      onRemoveTag={() => common.onRemoveTag(workbook.id)}
    />
  );

  const folderMenuFor = (folder: FolderNode) => (
    <FolderMenu
      busy={folderBusy(folder.id)}
      hasTag={ownTag(folder) !== null}
      campaignsAvailable={campaignsAvailable}
      onRename={() => onRenameFolder(folder)}
      onTag={() => onTagFolder(folder)}
      onRemoveTag={() => onRemoveFolderTag(folder.id)}
      onDelete={() => onDeleteFolder(folder.id)}
    />
  );

  /* Rows for the current level. */
  const folderRows = currentWorkbook || currentFolder ? [] : folders;
  const workbookRows = currentWorkbook
    ? []
    : [...workbooks.filter((w) => (currentFolder ? w.folderId === currentFolder.id : !w.folderId))].sort(bySort);
  const tableRows = currentWorkbook ? [...currentWorkbook.tables].sort(bySort) : [];
  const rowCount = folderRows.length + workbookRows.length + tableRows.length;

  const currentOwnTag = currentWorkbook ? ownTag(currentWorkbook) : currentFolder ? ownTag(currentFolder) : null;
  const currentDescription = currentWorkbook?.description || undefined;

  return (
    <div className="flex flex-col gap-3">
      {currentFolder || currentWorkbook ? (
        <div className="flex flex-col gap-1 px-0.5">
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <button
              type="button"
              onClick={() => setPath({ folderId: null, workbookId: null })}
              className="rounded transition-colors hover:text-foreground"
            >
              Workbooks
            </button>
            {currentFolder ? (
              <>
                <span className="text-border-strong">/</span>
                {currentWorkbook ? (
                  <button
                    type="button"
                    onClick={() => setPath({ folderId: currentFolder.id, workbookId: null })}
                    className="rounded transition-colors hover:text-foreground"
                  >
                    {currentFolder.name}
                  </button>
                ) : (
                  <span className="text-foreground">{currentFolder.name}</span>
                )}
              </>
            ) : null}
            {currentWorkbook ? (
              <>
                <span className="text-border-strong">/</span>
                <span className="text-foreground">{currentWorkbook.name}</span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-[16px] font-semibold tracking-tight">
              {currentWorkbook ? currentWorkbook.name : currentFolder?.name}
            </h2>
            {currentOwnTag ? (
              <span className={BARE_PILL} title="This node's own campaign tag">
                {currentOwnTag.name}
              </span>
            ) : null}
            <div className="ml-auto">
              {currentWorkbook ? workbookMenuFor(currentWorkbook) : currentFolder ? folderMenuFor(currentFolder) : null}
            </div>
          </div>
          {currentDescription ? (
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">{currentDescription}</p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-baseline gap-2 px-0.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Workbooks</h2>
          <span className="text-[11px] tabular-nums text-muted-foreground">{rowCount}</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-xs">
        <table className="w-full min-w-[840px] table-fixed">
          <colgroup>
            <col />
            <col className="w-[88px]" />
            <col className="w-[126px]" />
            <col className="w-[100px]" />
            <col className="w-[84px]" />
            <col className="w-[216px]" />
            <col className="w-[44px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              <th className={`${TH_CLASS} pl-4 text-left`}>Name</th>
              <th className={`${TH_CLASS} text-right`}>Leads</th>
              <th className={`${TH_CLASS} text-right`}>Verified</th>
              <th className={`${TH_CLASS} text-right`}>Deliverable</th>
              <th className={`${TH_CLASS} text-right`}>Pending</th>
              <th className={`${TH_CLASS} text-left`}>Campaign</th>
              <th className={TH_CLASS} />
            </tr>
          </thead>
          <tbody>
            {rowCount === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[12px] text-muted-foreground">
                  {currentWorkbook ? "No tables yet." : currentFolder ? "No workbooks in this folder yet." : "No workbooks yet."}
                </td>
              </tr>
            ) : null}

            {folderRows.map((folder, index) => {
              const own = ownTag(folder);
              return (
                <BrowserRowShell
                  key={folder.id}
                  isLast={index === rowCount - 1}
                  onOpen={() => setPath({ folderId: folder.id, workbookId: null })}
                >
                  <BrowserNameCell
                    icon={<Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
                    name={folder.name}
                  />
                  <BrowserStatCells stats={sumStats(folderTables(folder), tableStats)} />
                  <td className="px-3 py-2.5 align-middle">
                    {own ? (
                      <span className={BARE_PILL} title="This folder's campaign tag">
                        {own.name}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3 align-middle">
                    <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
                      {folderMenuFor(folder)}
                    </div>
                  </td>
                </BrowserRowShell>
              );
            })}

            {workbookRows.map((workbook, index) => {
              const own = ownTag(workbook);
              return (
                <BrowserRowShell
                  key={workbook.id}
                  isLast={folderRows.length + index === rowCount - 1}
                  onOpen={() => setPath({ folderId: workbook.folderId, workbookId: workbook.id })}
                >
                  <BrowserNameCell
                    icon={<LayoutGrid className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
                    name={workbook.name}
                    description={workbook.description}
                  />
                  <BrowserStatCells stats={sumStats(workbook.tables, tableStats)} />
                  <td className="px-3 py-2.5 align-middle">
                    {own ? (
                      <span className={BARE_PILL} title="This workbook's campaign tag">
                        {own.name}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3 align-middle">
                    <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
                      {workbookMenuFor(workbook)}
                    </div>
                  </td>
                </BrowserRowShell>
              );
            })}

            {tableRows.map((table, index) => {
              const own = ownTag(table);
              return (
                <BrowserRowShell
                  key={table.id}
                  isLast={index === rowCount - 1}
                  onOpen={() => router.push(`/enrichment/${currentWorkbook!.slug}/${table.slug}`)}
                >
                  <BrowserNameCell
                    icon={<Table2 className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
                    name={table.name}
                    description={table.description}
                  />
                  <BrowserStatCells stats={tableStats[table.id] ?? null} />
                  <td className="px-3 py-2.5 align-middle">
                    {own ? (
                      <span className={BARE_PILL} title="This table's own campaign tag">
                        {own.name}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3 align-middle">
                    <ChevronRight className="ml-auto size-3.5 text-muted-foreground/70" />
                  </td>
                </BrowserRowShell>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Workbook card (tile layout, the default) ─────────────────────────────
   The approved "Cards" draft: header (name, description, campaign pill,
   table count), a Leads/Deliverable/Pending stat band summing the workbook's
   tables, then every table as a row with its own count and verification
   progress. Falls back gracefully wherever stats are missing. */

function CompactWorkbookCard({
  workbook,
  folderTag,
  busy,
  allFolders,
  campaignsAvailable,
  tableStats,
  onRename,
  onMove,
  onMoveToNewFolder,
  onDelete,
  onTag,
  onRemoveTag,
}: { workbook: WorkbookNode; folderTag: CampaignTag | null } & WorkbookCardCommon) {
  const router = useRouter();
  const tables = useMemo(() => [...workbook.tables].sort(bySort), [workbook.tables]);
  const firstTable = tables[0];
  const cardBusy = busy === `wb:${workbook.id}`;
  const targetHref = firstTable ? `/enrichment/${workbook.slug}/${firstTable.slug}` : null;

  const openFirst = () => {
    if (targetHref) router.push(targetHref);
  };

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs transition hover:shadow-sm ${
        targetHref ? "cursor-pointer hover:border-border-strong" : ""
      }`}
      role={targetHref ? "button" : undefined}
      tabIndex={targetHref ? 0 : undefined}
      onClick={targetHref ? openFirst : undefined}
      onKeyDown={
        targetHref
          ? (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openFirst();
              }
            }
          : undefined
      }
    >
      <div className="flex items-start gap-2 px-4 pt-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-semibold tracking-tight">{workbook.name}</span>
          {workbook.description ? (
            <span className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
              {workbook.description}
            </span>
          ) : null}
        </div>
        <div onClick={(event) => event.stopPropagation()}>
          <WorkbookMenu
            busy={cardBusy}
            folders={allFolders}
            currentFolderId={workbook.folderId}
            hasTables={tables.length > 0}
            hasOwnTag={ownTag(workbook) !== null}
            campaignsAvailable={campaignsAvailable}
            onRename={() => onRename(workbook.id, workbook.name)}
            onMove={(folderId) => onMove(workbook.id, folderId)}
            onMoveToNewFolder={(name) => onMoveToNewFolder(workbook.id, name)}
            onDelete={() => onDelete(workbook.id)}
            onTag={() => onTag(workbook.id, ownTag(workbook))}
            onRemoveTag={() => onRemoveTag(workbook.id)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-2">
        <WorkbookCampaignPill workbook={workbook} folderTag={folderTag} />
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {tables.length} {tables.length === 1 ? "table" : "tables"}
        </span>
      </div>

      <WorkbookStatBand tables={tables} tableStats={tableStats} />

      {tables.length > 0 ? (
        <div className="mt-auto flex flex-col border-t border-border p-1.5">
          {tables.map((table) => {
            const eff = effectiveTableTag(table, workbook, folderTag);
            const stats = tableStats[table.id];
            return (
              <Link
                key={table.id}
                href={`/enrichment/${workbook.slug}/${table.slug}`}
                onClick={(event) => event.stopPropagation()}
                className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Table2 className="size-3.5" strokeWidth={1.75} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium">{table.name}</span>
                  {table.description ? (
                    <span className="truncate text-[11px] text-muted-foreground">{table.description}</span>
                  ) : null}
                </span>
                {/* Only a table's own tag, and only as a compact marker: a
                    full pill starves the name column in a half-width card.
                    The workbook pill above covers what the card inherits. */}
                {eff && eff.source === "table" ? (
                  <span
                    className="flex shrink-0 items-center text-muted-foreground/70"
                    title={`This table's own campaign tag: ${eff.name}`}
                  >
                    <Tag className="size-3" strokeWidth={1.75} />
                  </span>
                ) : null}
                {stats ? <TableStatCluster stats={stats} /> : null}
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="mt-auto border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          No tables yet.
        </p>
      )}
    </div>
  );
}

function WorkbookMenu({
  busy,
  folders,
  currentFolderId,
  hasTables,
  hasOwnTag,
  campaignsAvailable,
  onRename,
  onMove,
  onMoveToNewFolder,
  onDelete,
  onTag,
  onRemoveTag,
}: {
  busy: boolean;
  folders: FolderNode[];
  currentFolderId: string | null;
  hasTables: boolean;
  hasOwnTag: boolean;
  campaignsAvailable: boolean;
  onRename: () => void;
  onMove: (folderId: string | null) => void;
  onMoveToNewFolder: (name: string) => void;
  onDelete: () => void;
  onTag: () => void;
  onRemoveTag: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menu = useAnchoredMenu(240, triggerRef);
  const [view, setView] = useState<"main" | "move" | "new-folder">("main");
  const [folderName, setFolderName] = useState("");
  const [armed, setArmed] = useState<"delete" | "removeTag" | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);

  const close = () => {
    menu.closeMenu();
    setView("main");
    setFolderName("");
    setArmed(null);
    if (armTimer.current) clearTimeout(armTimer.current);
  };
  const open = () => {
    menu.openMenu();
    setView("main");
    setFolderName("");
    setArmed(null);
  };
  const arm = (which: "delete" | "removeTag", action: () => void) => {
    if (armed === which) {
      close();
      action();
      return;
    }
    setArmed(which);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(null), 3000);
  };
  const moveTo = (folderId: string | null) => {
    close();
    onMove(folderId);
  };
  const confirmNewFolder = () => {
    const trimmed = folderName.trim();
    if (!trimmed) return;
    close();
    onMoveToNewFolder(trimmed);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Workbook actions"
        aria-haspopup="menu"
        disabled={busy}
        onClick={() => (menu.open ? close() : open())}
        className={ICON_BTN_QUIET}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Ellipsis className="size-3.5" />}
      </button>
      {menu.coords ? (
        <>
          <div className="fixed inset-0 z-40 cursor-pointer" aria-hidden onClick={close} />
          <div
            role="menu"
            className="anim-menu-in fixed z-50 w-60 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-pop"
            style={{ top: menu.coords.top, left: menu.coords.left }}
          >
            {view === "main" ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onRename();
                  }}
                  className={`${MENU_ITEM} hover:bg-muted/60`}
                >
                  <Pencil className="size-3.5 text-muted-foreground" />
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!campaignsAvailable}
                  data-tip={campaignsAvailable ? undefined : "Smartlead is unreachable"}
                  onClick={() => {
                    close();
                    onTag();
                  }}
                  className={`${MENU_ITEM} hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <Tag className="size-3.5 text-muted-foreground" />
                  Tag campaign
                </button>
                {hasOwnTag ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => arm("removeTag", onRemoveTag)}
                    className={`${MENU_ITEM} hover:bg-muted/60`}
                  >
                    <X className="size-3.5 text-muted-foreground" />
                    {armed === "removeTag" ? "Remove tag? Click again" : "Remove campaign tag"}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView("move")}
                  className={`${MENU_ITEM} hover:bg-muted/60`}
                >
                  <FolderInput className="size-3.5 text-muted-foreground" />
                  Move to folder
                  <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => arm("delete", onDelete)}
                  className={`${MENU_ITEM} text-destructive hover:bg-destructive-soft`}
                >
                  <Trash2 className="size-3.5" />
                  {armed === "delete" ? "Delete? Click again" : "Delete"}
                </button>
                {hasTables ? (
                  <p className="px-2 pb-1 pt-0.5 text-[10.5px] leading-snug text-muted-foreground">
                    Delete the workbook&apos;s tables first.
                  </p>
                ) : null}
              </>
            ) : view === "move" ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView("main")}
                  className={`${MENU_ITEM} text-muted-foreground hover:bg-muted/60`}
                >
                  <ChevronRight className="size-3.5 rotate-180" />
                  Back
                </button>
                <div className="my-1 h-px bg-border" />
                <div className="max-h-64 overflow-y-auto">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => moveTo(null)}
                    className={`${MENU_ITEM} hover:bg-muted/60`}
                  >
                    <span className="truncate">No folder</span>
                    {currentFolderId === null ? <Check className="ml-auto size-3.5 text-success" /> : null}
                  </button>
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      role="menuitem"
                      onClick={() => moveTo(folder.id)}
                      className={`${MENU_ITEM} hover:bg-muted/60`}
                    >
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                      <span className="truncate">{folder.name}</span>
                      {currentFolderId === folder.id ? <Check className="ml-auto size-3.5 text-success" /> : null}
                    </button>
                  ))}
                </div>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFolderName("");
                    setView("new-folder");
                  }}
                  className={`${MENU_ITEM} hover:bg-muted/60`}
                >
                  <FolderPlus className="size-3.5 text-muted-foreground" />
                  New folder...
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView("move")}
                  className={`${MENU_ITEM} text-muted-foreground hover:bg-muted/60`}
                >
                  <ChevronRight className="size-3.5 rotate-180" />
                  Back
                </button>
                <div className="my-1 h-px bg-border" />
                <div className="flex items-center gap-1.5 p-1">
                  <input
                    autoFocus
                    value={folderName}
                    maxLength={80}
                    placeholder="New folder name"
                    onChange={(event) => setFolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        confirmNewFolder();
                      }
                    }}
                    className={INPUT_CLASS}
                  />
                  <button
                    type="button"
                    aria-label="Create folder and move"
                    disabled={!folderName.trim()}
                    onClick={confirmNewFolder}
                    className={`${BTN_PRIMARY} size-8 shrink-0`}
                  >
                    <Check className="size-3.5" />
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

/* ── Modal grammar (backdrop, Escape, focus, scroll lock) ─────────────── */

function ModalShell({
  title,
  onClose,
  closeDisabled = false,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Exit animation: a close intent flips `closing`, swapping the in-animations
  // for the out-animations, then unmounts (via the parent's onClose) after the
  // panel-out finishes. A ref guards against a double close re-arming the timer.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestClose = useCallback(() => {
    if (closeDisabled || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 150);
  }, [closeDisabled, onClose]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-background/70 p-4 backdrop-blur-sm ${
        closing ? "anim-overlay-out" : "anim-overlay-in"
      }`}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[85vh] w-full max-w-md cursor-auto flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop outline-none ${
          closing ? "anim-panel-out" : "anim-panel-in"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="truncate text-[13.5px] font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            disabled={closeDisabled}
            onClick={requestClose}
            className={ICON_BTN_QUIET}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

function SingleInputDialog({
  title,
  label,
  placeholder,
  initial = "",
  submitLabel,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  submitLabel: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const submit = () => {
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  };

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !trimmed}
            onClick={submit}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {submitLabel}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <input
          autoFocus
          value={value}
          maxLength={80}
          placeholder={placeholder}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className={INPUT_CLASS}
        />
      </label>
    </ModalShell>
  );
}

type FolderChoice = { kind: "existing"; id: string | null } | { kind: "new"; name: string };

function NewWorkbookDialog({
  folders,
  busy,
  onClose,
  onSubmit,
}: {
  folders: FolderNode[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, description: string, folder: FolderChoice) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folderId, setFolderId] = useState<string>("");
  const [newFolderName, setNewFolderName] = useState("");
  const isNew = folderId === "__new__";
  const trimmed = name.trim();
  const trimmedFolder = newFolderName.trim();
  const canSubmit = !!trimmed && (!isNew || !!trimmedFolder);
  const submit = () => {
    if (!canSubmit || busy) return;
    onSubmit(
      trimmed,
      description.trim(),
      isNew ? { kind: "new", name: trimmedFolder } : { kind: "existing", id: folderId || null },
    );
  };

  return (
    <ModalShell
      title="New workbook"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !canSubmit}
            onClick={submit}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Create workbook
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Workbook name</span>
        <input
          autoFocus
          value={name}
          maxLength={80}
          placeholder="e.g. Two-contact send list"
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className={INPUT_CLASS}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Description</span>
        <textarea
          value={description}
          maxLength={300}
          rows={3}
          placeholder="What this workbook holds (optional)."
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Folder</span>
        <div className="relative">
          <select
            value={folderId}
            disabled={busy}
            onChange={(event) => setFolderId(event.target.value)}
            className="h-8 w-full appearance-none rounded-md border border-border bg-surface pl-2.5 pr-7 text-[12.5px] text-foreground shadow-xs outline-none transition focus:border-ring"
          >
            <option value="">No folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
            <option value="__new__">New folder...</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
      </label>

      {isNew ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">New folder name</span>
          <input
            autoFocus
            value={newFolderName}
            maxLength={80}
            placeholder="e.g. Manufacturing Ops"
            disabled={busy}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            className={INPUT_CLASS}
          />
          <span className="text-[10.5px] leading-snug text-muted-foreground">
            The folder is created first, then the workbook is placed inside it.
          </span>
        </label>
      ) : null}
    </ModalShell>
  );
}

/* ── Campaign picker (shared by folder and workbook tagging) ──────────── */

function CampaignPickerDialog({
  campaigns,
  current,
  title,
  caption,
  pending,
  onSave,
  onClose,
}: {
  campaigns: CampaignOption[];
  current: CampaignTag | null;
  title: string;
  caption: string;
  pending: boolean;
  onSave: (tag: CampaignTag) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(current?.id ?? "");
  const [query, setQuery] = useState("");
  const searchable = campaigns.length > 6;
  const trimmedQuery = query.trim().toLowerCase();
  const visible = trimmedQuery
    ? campaigns.filter((campaign) => campaign.name.toLowerCase().includes(trimmedQuery))
    : campaigns;
  const selected = campaigns.find((campaign) => campaign.id === selectedId) ?? null;

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <button type="button" disabled={pending} onClick={onClose} className={`${BTN_OUTLINE} h-8 px-3 text-[12px]`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !selected || selected.id === current?.id}
            onClick={() => {
              if (selected) onSave({ id: selected.id, name: selected.name });
            }}
            className={`${BTN_PRIMARY} h-8 px-3 text-[12px]`}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {pending ? "Tagging..." : "Tag campaign"}
          </button>
        </>
      }
    >
      <p className="text-[12px] leading-relaxed text-muted-foreground">{caption}</p>
      {searchable ? (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search campaigns"
          aria-label="Search campaigns"
          className={INPUT_CLASS}
        />
      ) : null}
      {campaigns.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
          The Smartlead campaign list could not be loaded. Check the API key under Settings, then reload this page.
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground">
          No campaigns match the search.
        </div>
      ) : (
        <div
          className="max-h-72 overflow-y-auto rounded-lg border border-border"
          role="radiogroup"
          aria-label="Smartlead campaign"
        >
          <div className="divide-y divide-border">
            {visible.map((campaign) => {
              const isSelected = campaign.id === selectedId;
              return (
                <button
                  key={campaign.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={pending}
                  onClick={() => setSelectedId(campaign.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-muted/60 disabled:opacity-50 ${
                    isSelected ? "bg-muted/50" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium" title={campaign.name}>
                    {campaign.name}
                  </span>
                  {campaign.status ? (
                    <span
                      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${campaignStatusClass(
                        campaign.status,
                      )}`}
                    >
                      {campaign.status.toLowerCase()}
                    </span>
                  ) : null}
                  {isSelected ? <CheckCircle2 className="size-3.5 shrink-0 text-primary" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </ModalShell>
  );
}
