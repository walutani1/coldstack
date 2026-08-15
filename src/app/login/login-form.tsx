"use client";

import { useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MailCheck } from "lucide-react";
import { sendMagicLinkAction, signInAction, type LoginState } from "./actions";

const initialState: LoginState = { message: "" };

const inputClass =
  "h-9 rounded-md border border-border bg-surface px-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20";

const primaryButtonClass =
  "h-9 rounded-md bg-primary text-sm font-semibold text-primary-foreground shadow-xs transition hover:bg-[color-mix(in_srgb,var(--primary)_92%,var(--foreground))] disabled:cursor-not-allowed disabled:opacity-60";

export function LoginForm() {
  const [mode, setMode] = useState<"link" | "password">("link");
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLinkAction, initialState);
  const [passwordState, passwordAction, passwordPending] = useActionState(signInAction, initialState);
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/inbox";
  const linkError = searchParams.get("error") === "link";

  if (mode === "link" && linkState.ok) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-success-soft text-success">
          <MailCheck className="size-5" />
        </div>
        <p className="text-sm font-medium">Check your email</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{linkState.message}</p>
        <p className="text-[11px] text-muted-foreground">Nothing arriving? Check spam, or use a password instead.</p>
        <button
          type="button"
          onClick={() => setMode("password")}
          className="text-xs font-medium text-primary hover:underline"
        >
          Use a password instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {linkError ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs font-medium text-warning">
          That sign-in link expired or was already used. Request a fresh one.
        </p>
      ) : null}

      {mode === "link" ? (
        <form action={linkAction} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              className={inputClass}
            />
          </label>

          {linkState.message && !linkState.ok ? (
            <p className="rounded-md bg-destructive-soft px-3 py-2 text-xs font-medium text-destructive">
              {linkState.message}
            </p>
          ) : null}

          <button type="submit" disabled={linkPending} className={primaryButtonClass}>
            {linkPending ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      ) : (
        <form action={passwordAction} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Password</span>
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className={inputClass}
            />
          </label>

          {passwordState.message && !passwordState.ok ? (
            <p className="rounded-md bg-destructive-soft px-3 py-2 text-xs font-medium text-destructive">
              {passwordState.message}
            </p>
          ) : null}

          <button type="submit" disabled={passwordPending} className={primaryButtonClass}>
            {passwordPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={() => setMode(mode === "link" ? "password" : "link")}
        className="text-center text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        {mode === "link" ? "Use a password instead" : "Email me a sign-in link instead"}
      </button>
    </div>
  );
}
