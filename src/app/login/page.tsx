import type { Metadata } from "next";
import { Suspense } from "react";
import { getWorkspaceSettings } from "@/lib/settings-store";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const workspace = await getWorkspaceSettings();

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <svg viewBox="0 0 24 24" fill="none" className="size-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{workspace.workspaceName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{workspace.tagline}</p>
          </div>
        </div>

        <div className="rounded-2xl bg-surface p-6 shadow-sm">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Same sign-in as the sales portal. We&apos;ll email you a one-time link. Access is limited to approved team
          members.
        </p>
      </div>
    </main>
  );
}
