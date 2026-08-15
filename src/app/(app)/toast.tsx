"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Check, ShieldAlert } from "lucide-react";

/* The app's single toast. Mounted once by the (app) layout, so every screen
   shares one viewport instead of each client page carrying its own copy.
   One toast at a time: a new call replaces whatever is showing and restarts
   the 4s dismiss timer. Rendered after {children} at z-50 so it paints over
   the z-50 modals and drawers without needing a higher layer. */

const DISMISS_MS = 4000;

export type ShowToast = (ok: boolean, text: string) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function useToast(): ShowToast {
  const showToast = useContext(ToastContext);
  if (!showToast) throw new Error("useToast must be used inside <ToastProvider>");
  return showToast;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // seq keys the bubble so a replacement toast replays the enter animation
  // instead of silently swapping its text in place.
  const [toast, setToast] = useState<{ ok: boolean; text: string; seq: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const showToast = useCallback<ShowToast>((ok, text) => {
    seq.current += 1;
    setToast({ ok, text, seq: seq.current });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), DISMISS_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {toast ? (
        <div className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2">
          <div
            key={toast.seq}
            role="status"
            aria-live="polite"
            className={`anim-toast-in flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] shadow-pop ${
              toast.ok
                ? "border-border bg-surface-elevated text-foreground"
                : "border-destructive/30 bg-destructive-soft text-destructive"
            }`}
          >
            {toast.ok ? (
              <Check className="size-3.5 text-success" />
            ) : (
              <ShieldAlert className="size-3.5 text-destructive" />
            )}
            <span>{toast.text}</span>
          </div>
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}
