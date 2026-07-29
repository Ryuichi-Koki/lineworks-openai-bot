begin;

-- 新料金体系ではAI回答を全会員共通で月100件まで無料とする。
-- 既存のあんしん会員は自動解約せず、現在の契約期間中の権利を保護する。
update plans
set ai_limit = 100, updated_at = now()
where plan_code = 'free';

alter table review_requests
  drop constraint if exists review_requests_status_check;

alter table review_requests
  add constraint review_requests_status_check
  check (status in (
    'draft',
    'awaiting_payment',
    'reserved',
    'submitted',
    'canceled',
    'failed'
  ));

create table if not exists tax_review_payments (
  id uuid primary key default gen_random_uuid(),
  review_request_id uuid not null unique
    references review_requests (id) on delete restrict,
  user_id uuid not null references users (id) on delete restrict,
  price_code text not null check (price_code in ('promo_2026', 'standard')),
  amount integer not null check (amount in (1000, 3000)),
  currency text not null default 'jpy' check (currency = 'jpy'),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'consumed', 'failed', 'refunded')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  checkout_url text,
  checkout_expires_at timestamptz,
  paid_at timestamptz,
  consumed_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tax_review_payments_user_status_idx
  on tax_review_payments (user_id, status, created_at desc);

alter table tax_review_payments enable row level security;

-- ブラウザ向けpolicyは作成しない。サーバー専用DBロールだけが操作する。

commit;
