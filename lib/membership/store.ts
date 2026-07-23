import postgres, { type Sql } from "postgres";
import type { PlanCode } from "./plans.ts";
import { freePeriod } from "./periods.ts";
import type {
  MembershipStatus,
  MembershipSync,
  UsageReservation,
  UsageSummary,
  UsageType,
} from "./types.ts";

let client: Sql | null = null;

export function membershipBillingEnabled(): boolean {
  return process.env.MEMBERSHIP_BILLING_ENABLED?.toLowerCase() === "true";
}

function database(): Sql {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required when membership billing is enabled");
  }
  client = postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: process.env.DATABASE_SSL_MODE === "disable" ? false : "require",
    prepare: false,
  });
  return client;
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toReservation(row: Record<string, unknown>): UsageReservation {
  return {
    allowed: Boolean(row.allowed),
    usageEventId: row.usage_event_id ? String(row.usage_event_id) : null,
    planCode: String(row.plan_code) as PlanCode,
    membershipStatus: String(row.membership_status) as MembershipStatus,
    usageLimit: Number(row.usage_limit),
    usedCount: Number(row.used_count),
    remainingCount: Number(row.remaining_count),
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
  };
}

export async function ensureMembershipUser(
  lineUserId: string,
  displayName?: string | null,
): Promise<string | null> {
  const registration = await registerMembershipUser(lineUserId, displayName);
  return registration.displayName;
}

export async function registerMembershipUser(
  lineUserId: string,
  displayName?: string | null,
): Promise<{ displayName: string | null; isNew: boolean }> {
  const sql = database();
  const period = freePeriod();
  return sql.begin(async (transaction) => {
    const inserted = await transaction`
      insert into users (
        line_user_id, display_name, plan_code, membership_provider,
        membership_status, current_period_start, current_period_end
      ) values (
        ${lineUserId}, ${displayName ?? null}, 'free', 'line_membership',
        'free', ${period.start}, ${period.end}
      )
      on conflict (line_user_id) do nothing
      returning id
    `;
    if (!inserted[0]) {
      await transaction`
        update users set
          display_name = coalesce(${displayName ?? null}, display_name),
          updated_at = now()
        where line_user_id = ${lineUserId}
      `;
    }
    const rows = await transaction`
      select display_name from users where line_user_id = ${lineUserId}
    `;
    return {
      displayName: rows[0]?.display_name
        ? String(rows[0].display_name)
        : null,
      isNew: Boolean(inserted[0]),
    };
  });
}

export async function updateMembershipDisplayName(
  lineUserId: string,
  displayName: string,
): Promise<void> {
  const sql = database();
  await sql`
    update users set display_name = ${displayName.slice(0, 200)}, updated_at = now()
    where line_user_id = ${lineUserId}
  `;
}

export async function reserveUsage(input: {
  lineUserId: string;
  usageType: UsageType;
  idempotencyKey: string;
  conversationId?: string | null;
  reviewRequestId?: string | null;
}): Promise<UsageReservation> {
  const sql = database();
  const rows = await sql`
    select * from reserve_usage(
      ${input.lineUserId},
      ${input.usageType},
      ${input.idempotencyKey},
      ${input.conversationId ?? null},
      ${input.reviewRequestId ?? null}
    )
  `;
  if (!rows[0]) throw new Error("Usage reservation returned no result");
  return toReservation(rows[0]);
}

export async function consumeUsage(usageEventId: string): Promise<boolean> {
  const sql = database();
  const rows = await sql`select transition_usage(${usageEventId}, 'consumed') as changed`;
  return Boolean(rows[0]?.changed);
}

export async function cancelUsage(usageEventId: string): Promise<boolean> {
  const sql = database();
  const rows = await sql`select transition_usage(${usageEventId}, 'canceled') as changed`;
  return Boolean(rows[0]?.changed);
}

export async function getUsageSummary(lineUserId: string): Promise<UsageSummary> {
  const sql = database();
  await ensureMembershipUser(lineUserId);
  const rows = await sql`
    select
      u.line_user_id, u.display_name, u.plan_code, u.membership_status,
      u.membership_provider, u.membership_plan_id,
      u.current_period_start, u.current_period_end, u.last_used_at,
      u.payment_failed_at,
      p.ai_limit, p.tax_review_limit,
      count(e.id) filter (
        where e.usage_type = 'ai_answer' and e.status = 'consumed'
      )::integer as ai_used,
      count(e.id) filter (
        where e.usage_type = 'tax_review' and e.status = 'consumed'
      )::integer as tax_review_used
      ,count(e.id) filter (
        where e.usage_type = 'ai_answer' and e.status in ('reserved','consumed')
      )::integer as ai_active
      ,count(e.id) filter (
        where e.usage_type = 'tax_review' and e.status in ('reserved','consumed')
      )::integer as tax_review_active
    from users u
    join plans p on p.plan_code = u.plan_code
    left join usage_events e on e.user_id = u.id
      and e.billing_period_start = u.current_period_start
      and e.billing_period_end = u.current_period_end
    where u.line_user_id = ${lineUserId}
    group by u.id, p.ai_limit, p.tax_review_limit
  `;
  const row = rows[0];
  if (!row) throw new Error("Membership user not found");
  const aiUsed = Number(row.ai_used);
  const reviewUsed = Number(row.tax_review_used);
  const aiActive = Number(row.ai_active);
  const reviewActive = Number(row.tax_review_active);
  return {
    lineUserId: String(row.line_user_id),
    displayName: row.display_name ? String(row.display_name) : null,
    planCode: String(row.plan_code) as PlanCode,
    membershipStatus: String(row.membership_status) as MembershipStatus,
    membershipProvider: String(row.membership_provider),
    membershipPlanId: row.membership_plan_id ? String(row.membership_plan_id) : null,
    periodStart: toIsoDate(row.current_period_start),
    periodEnd: toIsoDate(row.current_period_end),
    aiUsed,
    aiRemaining: Math.max(Number(row.ai_limit) - aiActive, 0),
    taxReviewUsed: reviewUsed,
    taxReviewRemaining: Math.max(Number(row.tax_review_limit) - reviewActive, 0),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
    paymentFailed: Boolean(row.payment_failed_at),
  };
}

export async function beginWebhookEvent(input: {
  provider: "line" | "stripe";
  eventId: string;
  eventType: string;
  payloadHash: string;
}): Promise<boolean> {
  const sql = database();
  return sql.begin(async (transaction) => {
    const inserted = await transaction`
      insert into webhook_events (
        provider, event_id, event_type, payload_hash, processing_status
      ) values (
        ${input.provider}, ${input.eventId}, ${input.eventType},
        ${input.payloadHash}, 'processing'
      )
      on conflict (provider, event_id) do nothing
      returning id
    `;
    if (inserted[0]) return true;
    const existing = await transaction`
      select processing_status, payload_hash, created_at
      from webhook_events
      where provider = ${input.provider} and event_id = ${input.eventId}
      for update
    `;
    if (existing[0]) {
      if (String(existing[0].payload_hash) !== input.payloadHash) {
        throw new Error("Webhook event ID was reused with a different payload");
      }
      const staleProcessing =
        existing[0].processing_status === "processing" &&
        Date.now() - new Date(String(existing[0].created_at)).getTime() >
          10 * 60 * 1000;
      if (existing[0].processing_status !== "failed" && !staleProcessing) return false;
      await transaction`
        update webhook_events set processing_status = 'processing',
          processing_result = null, processed_at = null
        where provider = ${input.provider} and event_id = ${input.eventId}
      `;
      return true;
    }
    return false;
  });
}

export async function finishWebhookEvent(
  provider: "line" | "stripe",
  eventId: string,
  status: "processed" | "failed" | "ignored",
  result: string,
): Promise<void> {
  const sql = database();
  await sql`
    update webhook_events set
      processing_status = ${status},
      processing_result = ${result.slice(0, 500)},
      processed_at = now()
    where provider = ${provider} and event_id = ${eventId}
  `;
}

export async function syncMembership(sync: MembershipSync): Promise<void> {
  const sql = database();
  await ensureMembershipUser(sync.lineUserId);
  await sql`
    update users set
      plan_code = ${sync.planCode},
      membership_provider = 'line_membership',
      membership_plan_id = ${sync.membershipPlanId},
      membership_status = ${sync.status},
      current_period_start = ${sync.periodStart},
      current_period_end = ${sync.periodEnd},
      payment_failed_at = null,
      updated_at = now()
    where line_user_id = ${sync.lineUserId}
      and not (
        membership_provider = 'stripe'
        and stripe_subscription_id is not null
        and membership_status in (
          'active', 'past_due', 'cancel_at_period_end', 'suspended'
        )
      )
  `;
}

export async function endMembership(lineUserId: string): Promise<void> {
  const sql = database();
  const period = freePeriod();
  await ensureMembershipUser(lineUserId);
  await sql`
    update users set
      plan_code = 'free',
      membership_status = 'free',
      membership_plan_id = null,
      current_period_start = ${period.start},
      current_period_end = ${period.end},
      updated_at = now()
    where line_user_id = ${lineUserId}
      and not (
        membership_provider = 'stripe'
        and stripe_subscription_id is not null
        and membership_status in (
          'active', 'past_due', 'cancel_at_period_end', 'suspended'
        )
      )
  `;
}

export async function createReviewDraft(input: {
  lineUserId: string;
  conversationId: string;
  summary: string;
}): Promise<string> {
  const sql = database();
  await ensureMembershipUser(input.lineUserId);
  const rows = await sql`
    insert into review_requests (user_id, conversation_id, question_summary, status)
    select id, ${input.conversationId}, ${input.summary.slice(0, 1200)}, 'draft'
    from users where line_user_id = ${input.lineUserId}
    returning id
  `;
  if (!rows[0]) throw new Error("Failed to create review request draft");
  return String(rows[0].id);
}

export async function submitReviewRequest(input: {
  lineUserId: string;
  reviewRequestId: string;
  idempotencyKey: string;
}): Promise<UsageReservation> {
  const sql = database();
  return sql.begin(async (transaction) => {
    const requestRows = await transaction`
      select r.id, r.conversation_id, r.status
      from review_requests r
      join users u on u.id = r.user_id
      where r.id = ${input.reviewRequestId} and u.line_user_id = ${input.lineUserId}
      for update
    `;
    const request = requestRows[0];
    if (!request) throw new Error("Review request not found");
    if (request.status === "submitted" || request.status === "reserved") {
      const existing = await transaction`
        select
          true as allowed, e.id as usage_event_id, u.plan_code,
          u.membership_status, p.tax_review_limit as usage_limit,
          1 as used_count, greatest(p.tax_review_limit - 1, 0) as remaining_count,
          e.billing_period_start as period_start, e.billing_period_end as period_end
        from usage_events e
        join users u on u.id = e.user_id
        join plans p on p.plan_code = u.plan_code
        where e.review_request_id = ${input.reviewRequestId}
      `;
      if (!existing[0]) throw new Error("Submitted review request has no usage event");
      return toReservation(existing[0]);
    }
    const reservationRows = await transaction`
      select * from reserve_usage(
        ${input.lineUserId}, 'tax_review', ${input.idempotencyKey},
        ${String(request.conversation_id)}, ${input.reviewRequestId}
      )
    `;
    const reservation = toReservation(reservationRows[0]);
    if (!reservation.allowed || !reservation.usageEventId) return reservation;
    await transaction`
      update review_requests set status = 'reserved', updated_at = now()
      where id = ${input.reviewRequestId}
    `;
    return reservation;
  });
}

export async function completeReviewRequest(
  lineUserId: string,
  reviewRequestId: string,
  usageEventId: string,
): Promise<boolean> {
  const sql = database();
  return sql.begin(async (transaction) => {
    const rows = await transaction`
      update review_requests r set status = 'submitted', submitted_at = now(), updated_at = now()
      from users u
      where r.id = ${reviewRequestId} and r.user_id = u.id
        and u.line_user_id = ${lineUserId} and r.status = 'reserved'
      returning r.id
    `;
    if (!rows[0]) return false;
    const changed = await transaction`
      select transition_usage(${usageEventId}, 'consumed') as changed
    `;
    return Boolean(changed[0]?.changed);
  });
}

export async function failReviewRequest(
  lineUserId: string,
  reviewRequestId: string,
  usageEventId: string,
): Promise<void> {
  const sql = database();
  await sql.begin(async (transaction) => {
    await transaction`
      update review_requests r set status = 'failed', updated_at = now()
      from users u
      where r.id = ${reviewRequestId} and r.user_id = u.id
        and u.line_user_id = ${lineUserId} and r.status = 'reserved'
    `;
    await transaction`select transition_usage(${usageEventId}, 'canceled')`;
  });
}

export async function cancelReviewRequest(
  lineUserId: string,
  reviewRequestId: string,
): Promise<boolean> {
  const sql = database();
  const rows = await sql`
    update review_requests r set status = 'canceled', canceled_at = now(), updated_at = now()
    from users u
    where r.id = ${reviewRequestId} and r.user_id = u.id
      and u.line_user_id = ${lineUserId}
      and r.status in ('draft','reserved')
    returning r.id
  `;
  return rows.length > 0;
}

export async function startTaxReviewIntake(lineUserId: string): Promise<void> {
  const sql = database();
  await ensureMembershipUser(lineUserId);
  await sql`
    insert into tax_review_intakes (line_user_id, started_at, expires_at)
    values (${lineUserId}, now(), now() + interval '30 minutes')
    on conflict (line_user_id) do update set
      started_at = excluded.started_at,
      expires_at = excluded.expires_at
  `;
}

export async function takeTaxReviewIntake(lineUserId: string): Promise<boolean> {
  const sql = database();
  const rows = await sql`
    delete from tax_review_intakes
    where line_user_id = ${lineUserId}
      and expires_at > now()
    returning line_user_id
  `;
  return rows.length > 0;
}

export async function cancelTaxReviewIntake(
  lineUserId: string,
): Promise<boolean> {
  const sql = database();
  const rows = await sql`
    delete from tax_review_intakes
    where line_user_id = ${lineUserId}
    returning line_user_id
  `;
  return rows.length > 0;
}

export async function listAdminUsers(search = ""): Promise<UsageSummary[]> {
  const sql = database();
  const pattern = `%${search.slice(0, 100)}%`;
  const rows = await sql`
    select line_user_id from users
    where ${search === ""} or coalesce(display_name, '') ilike ${pattern}
      or line_user_id ilike ${pattern}
    order by updated_at desc
    limit 100
  `;
  return Promise.all(rows.map((row) => getUsageSummary(String(row.line_user_id))));
}

export async function getAdminUsageHistory(lineUserId: string): Promise<
  Array<{
    id: string;
    usageType: string;
    status: string;
    periodStart: string;
    periodEnd: string;
    createdAt: string;
  }>
> {
  const sql = database();
  const rows = await sql`
    select e.id, e.usage_type, e.status, e.billing_period_start,
      e.billing_period_end, e.created_at
    from usage_events e
    join users u on u.id = e.user_id
    where u.line_user_id = ${lineUserId}
    order by e.created_at desc
    limit 100
  `;
  return rows.map((row) => ({
    id: String(row.id),
    usageType: String(row.usage_type),
    status: String(row.status),
    periodStart: toIsoDate(row.billing_period_start),
    periodEnd: toIsoDate(row.billing_period_end),
    createdAt: new Date(String(row.created_at)).toISOString(),
  }));
}

export async function getPlanCounts(): Promise<Array<{ planCode: string; count: number }>> {
  const sql = database();
  const rows = await sql`
    select plan_code, count(*)::integer as count
    from users group by plan_code order by plan_code
  `;
  return rows.map((row) => ({
    planCode: String(row.plan_code),
    count: Number(row.count),
  }));
}

export async function findStripeCustomerForLineUser(
  lineUserId: string,
): Promise<string | null> {
  const identity = await findStripeBillingIdentityForLineUser(lineUserId);
  return identity?.customerId ?? null;
}

export async function findStripeBillingIdentityForLineUser(
  lineUserId: string,
): Promise<{ customerId: string; subscriptionId: string | null } | null> {
  const sql = database();
  const rows = await sql`
    select stripe_customer_id, stripe_subscription_id
    from users where line_user_id = ${lineUserId}
  `;
  if (!rows[0]?.stripe_customer_id) return null;
  return {
    customerId: String(rows[0].stripe_customer_id),
    subscriptionId: rows[0].stripe_subscription_id
      ? String(rows[0].stripe_subscription_id)
      : null,
  };
}

export async function getMembershipBillingState(
  lineUserId: string,
): Promise<{ provider: string; status: MembershipStatus } | null> {
  const sql = database();
  const rows = await sql`
    select membership_provider, membership_status
    from users where line_user_id = ${lineUserId}
  `;
  if (!rows[0]) return null;
  return {
    provider: String(rows[0].membership_provider),
    status: String(rows[0].membership_status) as MembershipStatus,
  };
}

export async function findLineUserForStripeIdentity(input: {
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<string | null> {
  const customerId = input.customerId?.trim() || null;
  const subscriptionId = input.subscriptionId?.trim() || null;
  if (!customerId && !subscriptionId) return null;
  const sql = database();
  const rows =
    customerId && subscriptionId
      ? await sql`
          select line_user_id from users
          where stripe_customer_id = ${customerId}
            or stripe_subscription_id = ${subscriptionId}
          limit 1
        `
      : customerId
        ? await sql`
            select line_user_id from users
            where stripe_customer_id = ${customerId}
            limit 1
          `
        : await sql`
            select line_user_id from users
            where stripe_subscription_id = ${subscriptionId as string}
            limit 1
          `;
  return rows[0]?.line_user_id ? String(rows[0].line_user_id) : null;
}

export async function linkStripeBillingIdentity(input: {
  lineUserId: string;
  customerId: string;
  subscriptionId?: string | null;
}): Promise<void> {
  const sql = database();
  await ensureMembershipUser(input.lineUserId);
  await sql`
    update users set
      stripe_customer_id = ${input.customerId},
      stripe_subscription_id = coalesce(
        ${input.subscriptionId ?? null},
        stripe_subscription_id
      ),
      updated_at = now()
    where line_user_id = ${input.lineUserId}
  `;
}

export async function syncStripeMembership(input: {
  lineUserId: string;
  customerId: string;
  subscriptionId: string;
  planCode: PlanCode;
  status: MembershipStatus;
  periodStart: string;
  periodEnd: string;
}): Promise<void> {
  const sql = database();
  await ensureMembershipUser(input.lineUserId);
  await sql`
    update users set
      plan_code = case
        when ${input.status} in ('active', 'cancel_at_period_end', 'past_due')
          then ${input.planCode}
        else 'free'
      end,
      membership_provider = 'stripe',
      membership_plan_id = ${input.subscriptionId},
      membership_status = ${input.status},
      current_period_start = ${input.periodStart},
      current_period_end = ${input.periodEnd},
      stripe_customer_id = ${input.customerId},
      stripe_subscription_id = ${input.subscriptionId},
      payment_failed_at = case
        when ${input.status} = 'past_due' then coalesce(payment_failed_at, now())
        else null
      end,
      updated_at = now()
    where line_user_id = ${input.lineUserId}
  `;
}

export async function markStripePaymentFailed(input: {
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<void> {
  const customerId = input.customerId?.trim() || null;
  const subscriptionId = input.subscriptionId?.trim() || null;
  if (!customerId && !subscriptionId) return;
  const sql = database();
  if (customerId && subscriptionId) {
    await sql`
      update users set
        membership_status = 'past_due',
        payment_failed_at = coalesce(payment_failed_at, now()),
        updated_at = now()
      where stripe_customer_id = ${customerId}
        or stripe_subscription_id = ${subscriptionId}
    `;
  } else if (customerId) {
    await sql`
      update users set
        membership_status = 'past_due',
        payment_failed_at = coalesce(payment_failed_at, now()),
        updated_at = now()
      where stripe_customer_id = ${customerId}
    `;
  } else {
    await sql`
      update users set
        membership_status = 'past_due',
        payment_failed_at = coalesce(payment_failed_at, now()),
        updated_at = now()
      where stripe_subscription_id = ${subscriptionId as string}
    `;
  }
}

export async function upsertStripeBillingObject(input: {
  objectId: string;
  objectType: "checkout_session" | "payment_intent" | "invoice" | "credit_note" | "refund";
  lineUserId?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  status: string;
  amount?: number | null;
  currency?: string | null;
  hostedUrl?: string | null;
  metadata?: Record<string, string>;
  occurredAt?: string | null;
}): Promise<void> {
  const sql = database();
  await sql`
    insert into stripe_billing_objects (
      stripe_object_id, object_type, line_user_id, stripe_customer_id,
      stripe_subscription_id, status, amount, currency, hosted_url,
      metadata, occurred_at
    ) values (
      ${input.objectId}, ${input.objectType}, ${input.lineUserId ?? null},
      ${input.customerId ?? null}, ${input.subscriptionId ?? null},
      ${input.status.slice(0, 100)}, ${input.amount ?? null},
      ${input.currency ?? null}, ${input.hostedUrl ?? null},
      ${sql.json(input.metadata ?? {})}, ${input.occurredAt ?? null}
    )
    on conflict (stripe_object_id) do update set
      status = excluded.status,
      line_user_id = coalesce(excluded.line_user_id, stripe_billing_objects.line_user_id),
      stripe_customer_id = coalesce(
        excluded.stripe_customer_id,
        stripe_billing_objects.stripe_customer_id
      ),
      stripe_subscription_id = coalesce(
        excluded.stripe_subscription_id,
        stripe_billing_objects.stripe_subscription_id
      ),
      amount = coalesce(excluded.amount, stripe_billing_objects.amount),
      currency = coalesce(excluded.currency, stripe_billing_objects.currency),
      hosted_url = coalesce(excluded.hosted_url, stripe_billing_objects.hosted_url),
      metadata = excluded.metadata,
      occurred_at = coalesce(excluded.occurred_at, stripe_billing_objects.occurred_at),
      updated_at = now()
  `;
}

export async function recordAdminAction(input: {
  operatorId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  beforeValue?: Record<string, unknown> | null;
  afterValue?: Record<string, unknown> | null;
}): Promise<void> {
  const sql = database();
  await sql`
    insert into admin_audit_logs (
      operator_id, action, target_type, target_id,
      before_value, after_value, reason
    ) values (
      ${input.operatorId}, ${input.action}, ${input.targetType}, ${input.targetId},
      ${JSON.stringify(input.beforeValue ?? null)}::jsonb,
      ${JSON.stringify(input.afterValue ?? null)}::jsonb,
      ${input.reason.slice(0, 500)}
    )
  `;
}

export async function cancelErroneousUsage(input: {
  usageEventId: string;
  operatorId: string;
  reason: string;
}): Promise<boolean> {
  const sql = database();
  return sql.begin(async (transaction) => {
    const rows = await transaction`
      select to_jsonb(e.*) as before_value from usage_events e
      where e.id = ${input.usageEventId} and e.status = 'consumed'
      for update
    `;
    if (!rows[0]) return false;
    const changed = await transaction`
      update usage_events set status = 'canceled', canceled_at = now()
      where id = ${input.usageEventId} and status = 'consumed'
      returning to_jsonb(usage_events.*) as after_value
    `;
    await transaction`
      insert into admin_audit_logs (
        operator_id, action, target_type, target_id,
        before_value, after_value, reason
      ) values (
        ${input.operatorId}, 'cancel_usage', 'usage_event', ${input.usageEventId},
        ${transaction.json(rows[0].before_value)}, ${transaction.json(changed[0].after_value)},
        ${input.reason.slice(0, 500)}
      )
    `;
    return true;
  });
}
