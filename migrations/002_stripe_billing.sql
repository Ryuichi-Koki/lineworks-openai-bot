begin;

alter table plans
  add column if not exists stripe_price_id text;

create unique index if not exists plans_stripe_price_id_idx
  on plans (stripe_price_id)
  where stripe_price_id is not null;

alter table users
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists users_stripe_customer_id_idx
  on users (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists users_stripe_subscription_id_idx
  on users (stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists stripe_billing_objects (
  stripe_object_id text primary key,
  object_type text not null
    check (object_type in ('checkout_session','payment_intent','invoice','credit_note','refund')),
  line_user_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null,
  amount integer,
  currency text,
  hosted_url text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_billing_objects_user_idx
  on stripe_billing_objects (line_user_id, object_type, updated_at desc);

alter table stripe_billing_objects enable row level security;

-- No browser policies are added. Access is restricted to the server-only DB role.

commit;
