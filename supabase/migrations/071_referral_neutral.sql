-- Referral demoted from positive to neutral. In practice the category mostly
-- captures automated "X is no longer with the company, contact Y" notices,
-- not genuine human hand-offs, and each one inflated positive-lead analytics.
-- The tag itself stays (referral volume remains its own KPI); it just stops
-- counting as a positive signal.

update reply_categories
set sentiment_type = 'neutral', updated_at = now()
where value = 'referral';

-- Re-align history: proposals categorized Referral no longer read as positive
-- anywhere analytics look, and the positive-lead flag the category used to
-- force is withdrawn. (Label-keyed like the rest of reply_proposals.)
update reply_proposals
set sentiment_type = 'neutral', positive_lead = false
where sentiment_type = 'positive'
  and sentiment in (select label from reply_categories where value = 'referral');

-- Leads flagged positive solely by referral replies drop the flag; any lead
-- with another positive-typed reply keeps it.
update leads l
set positive_lead = false
where l.positive_lead = true
  and exists (
    select 1 from reply_proposals p
    where p.lead_id = l.id
      and p.sentiment in (select label from reply_categories where value = 'referral')
  )
  and not exists (
    select 1 from reply_proposals p2
    where p2.lead_id = l.id and p2.sentiment_type = 'positive'
  );
