"use client";

import type { ModelVendor } from "./enrichment/enrichment-model";

/* ── Vendor logomarks ──────────────────────────────────────────────────────

   Real brand marks, inline so nothing is fetched at runtime. Anthropic's and
   OpenAI's were already in the app (Settings -> Integrations); they live here
   now so the integrations list and the enrichment column headers draw the same
   glyph from one definition instead of two copies that can drift.

   All are monochrome and inherit currentColor: at 14px in a column header the
   silhouette is what identifies the vendor - a rosette, a triangular A, a
   four-point star - so colour is free to carry meaning elsewhere. */

export function AnthropicMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 46 32" className={className} fill="currentColor" aria-hidden>
      <path d="M32.73 0h-6.945L38.45 32h6.945L32.73 0ZM12.665 0 0 32h7.082l2.59-6.72h13.25l2.59 6.72h7.082L19.929 0h-7.264Zm-.702 19.337 4.334-11.246 4.334 11.246h-8.668Z" />
    </svg>
  );
}

export function OpenAiMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073ZM13.2599 22.4301a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944Zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6455ZM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0L4.0294 14.049a4.504 4.504 0 0 1-1.6886-6.1534Zm16.5963 3.8558-5.8428-3.3874L15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.4069-.6669Zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66ZM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813Zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function GeminiMark({ className = "size-4" }: { className?: string }) {
  // Google's four-point star: straight-line points with concave sides.
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 0c0 6.627 5.373 12 12 12-6.627 0-12 5.373-12 12 0-6.627-5.373-12-12-12C6.627 12 12 6.627 12 0Z" />
    </svg>
  );
}

function XaiMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M2.4 2h5.04l6.06 8.4L20.4 2H24l-8.7 10.1L24 22h-5.04l-6.3-8.73L4.8 22H1.2l9-10.44L2.4 2Z" />
    </svg>
  );
}

/* Anything without a mark of its own: the vendor's initial, so an unknown
   vendor still reads as a distinct thing rather than a blank. */
function LetterMark({ letter, className = "size-4" }: { letter: string; className?: string }) {
  return (
    <span aria-hidden className={`${className} flex items-center justify-center rounded-[3px] border border-current text-[8px] font-bold leading-none`}>
      {letter}
    </span>
  );
}

export function VendorMark({ vendor, fallback, className }: { vendor: ModelVendor; fallback: string; className?: string }) {
  if (vendor === "anthropic") return <AnthropicMark className={className} />;
  if (vendor === "openai") return <OpenAiMark className={className} />;
  if (vendor === "google") return <GeminiMark className={className} />;
  if (vendor === "xai") return <XaiMark className={className} />;
  return <LetterMark letter={(fallback || "?").charAt(0).toUpperCase()} className={className} />;
}
