begin;

alter table tax_review_payments
  drop constraint if exists tax_review_payments_status_check;

alter table tax_review_payments
  add constraint tax_review_payments_status_check
  check (status in (
    'pending',
    'paid',
    'consumed',
    'failed',
    'canceled',
    'partially_refunded',
    'refunded'
  ));

alter table tax_review_payments
  add column if not exists refunded_amount integer not null default 0
    check (refunded_amount >= 0);

create table if not exists tax_review_refunds (
  id uuid primary key default gen_random_uuid(),
  stripe_refund_id text not null unique,
  payment_id uuid not null
    references tax_review_payments (id) on delete restrict,
  amount integer not null check (amount > 0),
  currency text not null check (currency = 'jpy'),
  status text not null,
  reason text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tax_review_refunds_payment_idx
  on tax_review_refunds (payment_id, created_at desc);

create table if not exists tax_review_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  review_request_id uuid not null unique
    references review_requests (id) on delete restrict,
  payment_id uuid unique
    references tax_review_payments (id) on delete restrict,
  usage_event_id uuid unique
    references usage_events (id) on delete restrict,
  line_user_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'canceled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  staff_sent_at timestamptz,
  customer_sent_at timestamptz,
  conversation_saved_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payment_id is not null or usage_event_id is not null)
);

create index if not exists tax_review_delivery_jobs_ready_idx
  on tax_review_delivery_jobs (status, next_attempt_at, created_at);

alter table tax_review_refunds enable row level security;
alter table tax_review_delivery_jobs enable row level security;

-- Browser/client policies are intentionally omitted. These tables are accessed
-- only by the server-side PostgreSQL role.

commit;
