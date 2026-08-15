"use client";

import { useState } from "react";

import { TEAM_AVATARS } from "@/lib/team-avatars";

export function avatarSrcFor(email: string | null | undefined): string | null {
  if (!email) return null;
  const key = email.trim().toLowerCase();
  if (TEAM_AVATARS[key]) return TEAM_AVATARS[key];
  // Sending aliases keep the person's face: jane.d@... still maps to jane@...
  const local = key.split("@")[0]?.split(".")[0];
  if (!local) return null;
  for (const [known, src] of Object.entries(TEAM_AVATARS)) {
    if (known.split("@")[0]?.split(".")[0] === local) return src;
  }
  return null;
}

/** size-8 round avatar: the person's photo when we have one, else initials.
    A load failure quietly falls back to initials, so a missing file can
    never render a broken image glyph. */
export function Avatar({
  email,
  initials,
  title,
}: {
  email: string | null | undefined;
  initials: string;
  title?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : avatarSrcFor(email);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        aria-hidden
        title={title}
        onError={() => setFailed(true)}
        className="size-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      title={title}
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
    >
      {initials}
    </span>
  );
}
