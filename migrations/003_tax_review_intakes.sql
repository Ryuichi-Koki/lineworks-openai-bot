begin;

create table if not exists tax_review_intakes (
  line_user_id text primary key
    references users (line_user_id) on delete cascade,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists tax_review_intakes_expires_at_idx
  on tax_review_intakes (expires_at);

alter table tax_review_intakes enable row level security;

-- No browser policies are added. Access is restricted to the server-only DB role.

commit;
