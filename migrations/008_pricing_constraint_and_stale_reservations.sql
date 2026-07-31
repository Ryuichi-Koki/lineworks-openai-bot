begin;

-- =============================================================================
-- C-01: 税理士相談の決済金額のCHECK制約を実価格から切り離す
-- =============================================================================
-- migration 006 は `check (amount in (1000, 3000))` を定義していたが、
-- その後の価格改定（1,100円 / 3,300円）に対応するmigrationが無かった。
-- このため createOrGetTaxReviewPayment のINSERTが制約違反となり、
-- 税理士相談の決済ページを作成できない状態だった。
--
-- 価格の正しさは、Stripe Priceの実値照合（lib/stripe/billing.ts）と
-- 決済完了時の金額照合（markTaxReviewPaymentPaid）で既に担保している。
-- DBは「いくら請求したか」の記録に徹し、価格そのものを制約に埋め込まない。
alter table tax_review_payments
  drop constraint if exists tax_review_payments_amount_check;

alter table tax_review_payments
  add constraint tax_review_payments_amount_check
  check (amount > 0 and amount <= 1000000);

-- =============================================================================
-- H-01: 宙に浮いた利用予約が月間枠を永久に消費する問題への対応
-- =============================================================================
-- reserve_usage と getUsageSummary は status in ('reserved','consumed') を
-- 上限に算入する。一方、関数タイムアウト・デプロイ・クラッシュで
-- 'reserved' のまま残った行を回収する仕組みが無かった。
--
-- 対策は二重にする。
--   1) 集計から「古い ai_answer の予約」を除外する（このmigration）
--   2) Cronで古い予約を 'canceled' へ回収する（lib/membership/store.ts）
-- 1) があるため、回収バッチが遅延・停止しても利用者は枠を失わない。
--
-- tax_review の予約は配送キューの再試行（最大8回・指数バックオフ）で
-- 数時間 'reserved' のまま正当に残りうるため、この扱いの対象にしない。

create index if not exists usage_events_stale_reservation_idx
  on usage_events (created_at)
  where status = 'reserved';

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
  -- ai_answer の予約がこの時間を超えて残っている場合、処理が落ちたものとみなす。
  v_stale_before timestamptz := p_now - interval '30 minutes';
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
        and (
          status = 'consumed'
          or (
            status = 'reserved'
            and (p_usage_type <> 'ai_answer' or created_at > v_stale_before)
          )
        );
    return query select
      v_existing.status in ('reserved','consumed'), v_existing.id, v_plan.plan_code,
      v_user.membership_status, v_limit, v_count, greatest(v_limit - v_count, 0),
      v_start, v_end;
    return;
  end if;

  select count(*)::integer into v_count from usage_events
    where user_id = v_user.id and usage_type = p_usage_type
      and billing_period_start = v_start and billing_period_end = v_end
      and (
        status = 'consumed'
        or (
          status = 'reserved'
          and (p_usage_type <> 'ai_answer' or created_at > v_stale_before)
        )
      );

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

commit;
