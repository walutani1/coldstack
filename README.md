# Coldstack

**The all-in-one, open-source cold email app.** Coldstack covers the whole
motion in one place — provisioning sending inboxes, running campaigns,
working replies with AI triage, mining hiring signals for leads, and
analytics — so you don't have to duct-tape five tools together. If you're
just getting into cold email, it's a great way to start: self-host it, plug
in your keys, and you have everything you need.

## What's inside

- **Inbox provisioning** — spin up sending domains and mailboxes through
  [Zapmail](https://zapmail.ai): domain-variant suggestions, bulk mailbox
  creation with username patterns, avatar management, and automatic website
  forwarding once domains activate.
- **Campaigns** — campaign setup and sending through
  [Smartlead](https://smartlead.ai), with sending limits, follow-up
  controls, and a live campaign inbox summary.
- **Reply inbox** — every reply lands in a fast review UI. Claude
  categorizes it against your editable taxonomy, extracts referrals, drafts
  replies in your voice, and proposes CRM updates a human approves or
  corrects. Replies send through the original campaign inbox thread, so the
  lead never sees a different address.
- **Signals** — a lead-mining funnel that watches for hiring signals: you
  describe your business and the job postings that mean "this company needs
  us right now," and a staged AI pipeline (agency screen → title gate → JD
  scoring) turns raw job data into qualified, scored outreach targets with
  per-run spend caps.
- **Analytics** — deliverability, funnel, and reply analytics across
  campaigns.

## How a reply flows

1. **Webhook** — Smartlead `EMAIL_REPLY` → `POST /api/webhooks/smartlead?secret=…`
   (secret checked in constant time). The event is stored and deduped by
   message id.
2. **Categorize** — after the 200 is returned, Claude reads the full thread
   and returns structured JSON: category (from your editable taxonomy),
   referral extraction, summary, and three flags — `is_automated`
   (auto-replies → Out Of Office), `dnc` (hostile / "remove me"),
   `email_defunct` (mailbox dead → block just that address).
3. **Tag sync** — the AI's category is mirrored onto the lead in Smartlead
   immediately (tag only), again if a human overrides the category, and again
   on approval (tag + pause). Both inboxes always show the same read; a newer
   reply supersedes older pending proposals (one active read per lead).
4. **Suggested replies** — for categories you flag as draft-worthy, replies
   arrive with a pre-written draft in your voice (style samples + rules you
   set in Settings) plus colleague research: your own CRM first (free), then
   at most 2 web searches — cached per company domain for 30 days, empty
   results included, so no company is ever paid for twice.
5. **Review** — Approve applies the changes (CRM fields, suppression, block
   list, Smartlead pause); Decline discards; "Add context & re-run"
   regenerates with your correction. Pure out-of-office replies can skip the
   queue entirely (configurable): auto-approved, paused, and scheduled to
   resume after the stated return date, canceled if they reply first.
6. **Notify** — every categorized reply fans out to your notification
   channels (email / Slack webhooks), each with its own category filter.
7. **Safety nets** — a Vercel cron (`/api/cron/process`, every 10 min) and a
   quiet drain on inbox page-load process anything the webhook missed.

## Configurable from the app

Almost everything lives in **Settings** (backed by your database, not code):

- **Reply categories** — add, rename, describe, color, and reorder the
  taxonomy the AI classifies into; per-category default actions (suppression
  list, Smartlead block list) and per-category AI draft guidance. Four system
  categories (fallback, out-of-office, do-not-contact, wrong-person) carry
  pipeline semantics and can be edited but not deleted.
- **AI & Automation** — campaign context the AI reads, model choice, reply
  drafting (sender identity, proof points, style samples pasted from your own
  sent emails, voice rules, signature), out-of-office auto-handling and
  resume delays, colleague web research.
- **Integrations** — Smartlead API key, API base URL, connection test, and
  one-click reply-webhook registration per campaign; Zapmail key for inbox
  provisioning; notification email transport (Resend or SMTP). Credentials
  are AES-256-GCM encrypted at rest (set `APP_ENCRYPTION_KEY`); every field
  falls back to env vars.
- **Signals** — your business context, valid/invalid role rules, industry
  filters, model choices per stage, scoring weights, and spend caps. The
  shipped defaults are a worked example — rewrite them for your business.
- **Workspace** — name, tagline, display timezone and locale; team members
  (invite by email, activate/deactivate — sign-in is by magic link).
- **Notifications** (own tab) — email/Slack channels with per-category
  filters, pause, test sends, and a delivery log with errors.

## Security model

- Layer 1: `src/proxy.ts` — every non-public route requires a valid Supabase
  session (JWT verified via `getClaims`).
- Layer 2: `inbox_profiles.is_active` allowlist, enforced in the app layout,
  the login action, and every server action (`requireActiveProfile`).
- Supabase signups are disabled; members are invited from Settings (or
  bootstrapped via script). Note: auth users live at the Supabase project
  level, so they are shared with any other app on the same project.
- All data access is server-side via the service-role key (never shipped to
  the browser). App tables have RLS enabled with no client policies.
- Machine endpoints authenticate independently: webhook secret (query param,
  constant-time compare) and `CRON_SECRET` bearer token.
- Integration credentials stored by the app are AES-256-GCM encrypted with a
  key derived from `APP_ENCRYPTION_KEY`; without that env var, in-app
  credential entry is disabled and env vars are used directly.
- Inbound email is rendered as plain text only — no HTML injection surface.

## Setup

```bash
npm install
cp .env.example .env.local            # fill in Supabase, Anthropic, Smartlead
node scripts/apply-migration.mjs 005_inbox_portal.sql   # then 006..013 in order
node scripts/bootstrap-admin.mjs you@example.com "Your Name"   # first login
npm run dev
```

Sign in at `/login` with a magic link (or set a password in Supabase). Then
open **Settings** to configure categories, AI behavior, Smartlead, Zapmail,
Signals, and your workspace — and **Notifications** to add email/Slack
channels.

Deploy: any Next.js host (Vercel works out of the box — `vercel.json` ships
the processing cron). Set the same env vars, point `APP_BASE_URL` at the
deployment URL, then register the reply webhooks from Settings →
Integrations (or `node scripts/register-smartlead-webhook.mjs <url>`).

## Environment variables

See [.env.example](.env.example) — required: Supabase URL/keys, Anthropic API
key, Smartlead webhook secret, cron secret, `APP_BASE_URL`. Optional:
`SMARTLEAD_API_KEY` (or set it in-app), `APP_ENCRYPTION_KEY` (unlocks in-app
credentials), and the email transport block (or configure it in-app).

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/apply-migration.mjs <file>` | Apply a migration from `supabase/migrations/` via the Supabase Management API (idempotent) |
| `scripts/bootstrap-admin.mjs <email> [name]` | Create the first (or any) active member on a fresh install |
| `scripts/register-smartlead-webhook.mjs <url>` | Point campaign `EMAIL_REPLY` webhooks at a deployment (also available in Settings) |
| `scripts/campaign-readiness.ts` | Print validation / enrichment / export queue counts per campaign |
| `scripts/run-watchdog.ts` | Kick stalled long-running jobs (pair with any 5-minute scheduler) |

## Notes

- Categorization model: `claude-haiku-4-5` by default (cheap and fast).
  Change it in Settings → AI & Automation, or via `ANTHROPIC_MODEL` — the
  code paths are identical.
- The taxonomy ships aligned to Smartlead's native reply categories so tag
  sync works out of the box; custom categories that don't exist in Smartlead
  simply skip tag sync.
- Team avatar photos are a code-level customization point: drop images in
  `public/avatars/` and map them in `src/lib/team-avatars.ts`.

## License

[MIT](LICENSE)
