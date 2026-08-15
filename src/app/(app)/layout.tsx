import Link from "next/link";
import Image from "next/image";
import { requireActiveProfile } from "@/lib/auth";
import { getPendingCount } from "@/lib/replies/queries";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { getWorkspaceLogo } from "@/lib/branding";
import { NavLinks, RailExpandOverlay, ShellControls, SidebarToggle } from "./shell-controls";
import { ToastProvider } from "./toast";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [profile, pendingCount, workspace, logo] = await Promise.all([
    requireActiveProfile(),
    getPendingCount(),
    getWorkspaceSettings(),
    getWorkspaceLogo(),
  ]);

  return (
    <ToastProvider>
      <div className="flex h-full overflow-hidden bg-background">
        <aside className="app-sidebar flex h-full shrink-0 flex-col border-r border-border bg-surface">
          {/* `group relative` lets the collapsed rail's expand control morph
              over the brand tile on hover instead of sitting in the nav column
              where it reads as another tab. */}
          <div className="group rail-item relative flex h-14 items-center gap-2 px-3.5">
            <Link href="/inbox" title={workspace.workspaceName} className="rail-item flex min-w-0 flex-1 items-center gap-2.5">
              {logo ? (
                <Image
                  src={`/api/branding/logo?v=${encodeURIComponent(logo.version)}`}
                  alt={`${workspace.workspaceName} logo`}
                  width={28}
                  height={28}
                  unoptimized
                  className="size-7 shrink-0 rounded-md object-contain"
                />
              ) : (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                  <svg viewBox="0 0 24 24" fill="none" className="size-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                </span>
              )}
              <span className="rail-hide min-w-0">
                <span className="block text-[13px] font-semibold leading-tight tracking-tight">{workspace.workspaceName}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{workspace.tagline}</span>
              </span>
            </Link>
            <SidebarToggle variant="collapse" />
            <RailExpandOverlay />
          </div>

          <NavLinks pendingCount={pendingCount} />

          <ShellControls email={profile.email} name={profile.full_name} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </ToastProvider>
  );
}
