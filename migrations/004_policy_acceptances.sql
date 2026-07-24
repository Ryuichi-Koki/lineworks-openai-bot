begin;

create table if not exists policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null,
  policy_version text not null,
  terms_accepted boolean not null default true,
  privacy_accepted boolean not null default true,
  foreign_transfer_accepted boolean not null default true,
  source text not null check (source in ('line_postback','admin_import')),
  idempotency_key text not null unique,
  accepted_at timestamptz not null default now()
);

create unique index if not exists policy_acceptances_user_version_idx
  on policy_acceptances (line_user_id, policy_version);

create index if not exists policy_acceptances_user_accepted_idx
  on policy_acceptances (line_user_id, accepted_at desc);

alter table policy_acceptances enable row level security;

-- No browser policies are added. Consent records are available only to the
-- server-side database role used by the application.

commit;
