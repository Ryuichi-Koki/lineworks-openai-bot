begin;

create extension if not exists pgcrypto;

create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null unique,
  plan_name text not null,
  monthly_price integer not null check (monthly_price >= 0),
  ai_limit integer not null check (ai_limit >= 0),
  tax_review_limit integer not null check (tax_review_limit >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into plans (plan_code, plan_name, monthly_price, ai_limit, tax_review_limit, active)
values
  ('free', '無料会員', 0, 10, 0, true),
  ('anshin', 'あんしん会員', 3300, 100, 1, true),
  ('premium_future', '上位プラン', 7700, 200, 3, false)
on conflict (plan_code) do update set
  plan_name = excluded.plan_name,
  monthly_price = excluded.monthly_price,
  ai_limit = excluded.ai_limit,
  tax_review_limit = excluded.tax_review_limit,
  active = excluded.active,
  updated_at = now();

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  display_name text,
  plan_code text not null default 'free' references plans(plan_code),
  membership_provider text not null default 'line_membership',
  membership_plan_id text,
  membership_status text not null default 'free'
    check (membership_status in ('free','active','past_due','cancel_at_period_end','canceled','suspended')),
  current_period_start date,
  current_period_end date,
  payment_failed_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_plan_status_idx on users (plan_code, membership_status);
create index if not exists users_display_name_idx on users (lower(display_name));

create table if not exists review_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  conversation_id text not null,
  question_summary text not null,
  status text not null
    check (status in ('draft','reserved','submitted','canceled','failed')),
  submitted_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_requests_user_created_idx
  on review_requests (user_id, created_at desc);

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  usage_type text not null check (usage_type in ('ai_answer','tax_review')),
  conversation_id text,
  review_request_id uuid references review_requests(id) on delete restrict,
  billing_period_start date not null,
  billing_period_end date not null,
  status text not null check (status in ('reserved','consumed','canceled')),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  canceled_at timestamptz
);

create index if not exists usage_events_period_count_idx
  on usage_events (user_id, usage_type, billing_period_start, billing_period_end, status);
create index if not exists usage_events_review_idx on usage_events (review_request_id);

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text not null,
  payload_hash text not null,
  processing_status text not null
    check (processing_status in ('processing','processed','failed','ignored')),
  processing_result text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

create table if not exists admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  operator_id text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  before_value jsonb,
  after_value jsonb,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_target_idx
  on admin_audit_logs (target_type, target_id, created_at desc);

alter table plans enable row level security;
alter table users enable row level security;
alter table usage_events enable row level security;
alter table webhook_events enable row level security;
alter table review_requests enable row level security;
alter table admin_audit_logs enable row level security;

-- No browser/client policies are created. The application must use a server-only
-- database role. This prevents one LINE user from reading another user's data.

create or replace function reserve_usage(
  p_line_user_id text,
  p_usage_type text,
  p_idempotency_key text,
  p_conversation_id text default null,
  p_review_request_id uuid default null,
  p_now timestamptz default now()
)
returns table (
  allowed boolean,
  usage_event_id uuid,
  plan_code text,
  membership_status text,
  usage_limit integer,
  used_count integer,
  remaining_count integer,
  period_start date,
  period_end date
)
language plpgsql
security invoker
as $$
declare
  v_user users%rowtype;
  v_plan plans%rowtype;
  v_start date;
  v_end date;
  v_limit integer;
  v_count integer;
  v_existing usage_events%rowtype;
begin
  insert into users (
    line_user_id, plan_code, membership_provider, membership_status,
    current_period_start, current_period_end
  )
  values (
    p_line_user_id, 'free', 'line_membership', 'free',
    date_trunc('month', p_now at time zone 'Asia/Tokyo')::date,
    (date_trunc('month', p_now at time zone 'Asia/Tokyo') + interval '1 month - 1 day')::date
  )
  on conflict (line_user_id) do nothing;

  select * into v_user from users where line_user_id = p_line_user_id for update;

  if v_user.membership_status in ('active','cancel_at_period_end')
     and v_user.current_period_start is not null
     and v_user.current_period_end is not null
     and (p_now at time zone 'Asia/Tokyo')::date between v_user.current_period_start and v_user.current_period_end then
    v_start := v_user.current_period_start;
    v_end := v_user.current_period_end;
  else
    v_start := date_trunc('month', p_now at time zone 'Asia/Tokyo')::date;
    v_end := (date_trunc('month', p_now at time zone 'Asia/Tokyo') + interval '1 month - 1 day')::date;
    update users as target set
      plan_code = case
        when v_user.membership_status in ('free','canceled') then target.plan_code
        else 'free'
      end,
      membership_status = case
        when v_user.membership_status in ('free','canceled')
          then target.membership_status
        else 'free'
      end,
      current_period_start = v_start,
      current_period_end = v_end,
      updated_at = now()
    where target.id = v_user.id;
    if v_user.membership_status not in ('free','canceled') then
      v_user.plan_code := 'free';
      v_user.membership_status := 'free';
    end if;
  end if;

  select * into v_plan from plans where plans.plan_code = v_user.plan_code;
  v_limit := case when p_usage_type = 'ai_answer' then v_plan.ai_limit
                  when p_usage_type = 'tax_review' then v_plan.tax_review_limit
                  else 0 end;

  select * into v_existing from usage_events where idempotency_key = p_idempotency_key;
  if found then
    select count(*)::integer into v_count from usage_events
      where user_id = v_user.id and usage_type = p_usage_type
        and billing_period_start = v_start and billing_period_end = v_end
        and status in ('reserved','consumed');
    return query select
      v_existing.status in ('reserved','consumed'), v_existing.id, v_plan.plan_code,
      v_user.membership_status, v_limit, v_count, greatest(v_limit - v_count, 0),
      v_start, v_end;
    return;
  end if;

  select count(*)::integer into v_count from usage_events
    where user_id = v_user.id and usage_type = p_usage_type
      and billing_period_start = v_start and billing_period_end = v_end
      and status in ('reserved','consumed');

  if v_count >= v_limit then
    return query select false, null::uuid, v_plan.plan_code, v_user.membership_status,
      v_limit, v_count, 0, v_start, v_end;
    return;
  end if;

  insert into usage_events (
    user_id, usage_type, conversation_id, review_request_id,
    billing_period_start, billing_period_end, status, idempotency_key
  ) values (
    v_user.id, p_usage_type, p_conversation_id, p_review_request_id,
    v_start, v_end, 'reserved', p_idempotency_key
  ) returning id into usage_event_id;

  update users set last_used_at = p_now, updated_at = now() where id = v_user.id;
  return query select true, usage_event_id, v_plan.plan_code, v_user.membership_status,
    v_limit, v_count + 1, greatest(v_limit - v_count - 1, 0), v_start, v_end;
end;
$$;

create or replace function transition_usage(
  p_usage_event_id uuid,
  p_next_status text
)
returns boolean
language plpgsql
security invoker
as $$
begin
  if p_next_status = 'consumed' then
    update usage_events set status = 'consumed', consumed_at = now()
      where id = p_usage_event_id and status = 'reserved';
  elsif p_next_status = 'canceled' then
    update usage_events set status = 'canceled', canceled_at = now()
      where id = p_usage_event_id and status = 'reserved';
  else
    return false;
  end if;
  return found;
end;
$$;

commit;
