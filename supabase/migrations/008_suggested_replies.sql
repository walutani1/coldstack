-- AI-suggested reply drafts (in the sender's voice) + lightweight colleague
-- research attached to each proposal, for human review before sending.
alter table reply_proposals add column if not exists suggested_reply text;
alter table reply_proposals add column if not exists research jsonb;
