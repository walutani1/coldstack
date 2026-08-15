-- Add two reply categories so referral-style campaigns stop producing false
-- positives on positive leads:
--   * Referral  (positive) — a human hands us off to another named person.
--   * Engaged   (neutral)  — a constructive reply sharing helpful context, but
--                            no buying signal and no named person.
-- Also tighten Interested / Information Request / Wrong Person so the classifier
-- routes those helpful-but-non-committal and referral replies correctly.

-- Make room: shift the existing lower-priority categories down by two.
update reply_categories set sort_order = 5 where value = 'wrong_person';
update reply_categories set sort_order = 6 where value = 'out_of_office';
update reply_categories set sort_order = 7 where value = 'not_interested';
update reply_categories set sort_order = 8 where value = 'do_not_contact';
update reply_categories set sort_order = 9 where value = 'uncategorizable';

update reply_categories
set description = 'The lead expresses genuine interest in the offering itself or explicitly asks to move forward or hear more about it — a real buying signal, not merely a polite or helpful reply.',
    updated_at = now()
where value = 'interested';

update reply_categories
set description = 'The lead asks US a specific question about the offering or requests more detail about what we do, in a way that signals they are evaluating it — not a reply that merely shares information about their own company.',
    updated_at = now()
where value = 'information_request';

update reply_categories
set description = 'The recipient says they are not the right person but does NOT name a specific person to contact instead. If they name someone to reach out to, use Referral.',
    draft_guidance = 'They said it isn''t them. Thank them briefly and ask one small question to find the right owner. Keep it very short.',
    updated_at = now()
where value = 'wrong_person';

insert into reply_categories (
  value, label, description, sentiment_type, suppress, dnc, draft_reply,
  draft_guidance, sort_order, system_role
)
values
  (
    'referral', 'Referral',
    'The lead is not the buyer but points us to another specific, named person who owns this area — a genuine human hand-off. NOT an out-of-office stand-in and NOT an automated "no longer with the company" notice.',
    'positive', false, false, true,
    'They pointed to someone else. Thank them by name, confirm you''ll reach out to the person they named, and optionally ask one small question (e.g. whether a quick intro is easier). Keep it very short.',
    3, null
  ),
  (
    'engaged', 'Engaged',
    'The lead replied constructively and shared genuinely helpful context or information about their company, process, or how things work there — but did NOT express buying interest and did NOT name a specific person to contact. A useful, non-committal engagement: not positive, not negative.',
    'neutral', false, false, true,
    'They engaged and shared useful context. Thank them, briefly acknowledge what they shared, and ask ONE focused follow-up that moves toward the right owner or a concrete next step. Keep it short and low-pressure.',
    4, null
  )
on conflict (value) do nothing;
