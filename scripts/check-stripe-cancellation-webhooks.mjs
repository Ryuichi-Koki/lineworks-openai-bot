import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Stripe from "stripe";

const databaseUrl = process.env.DATABASE_URL;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const priceId = process.env.STRIPE_PRICE_ANSHIN;
const webhookUrl = "http://127.0.0.1:3000/api/stripe/webhook";
const lineUserId = `UstripeCancellation${randomUUID().replaceAll("-", "")}`;
const customerId = `cus_local_${randomUUID().replaceAll("-", "")}`;
const subscriptionId = `sub_local_${randomUUID().replaceAll("-", "")}`;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!webhookSecret?.startsWith("whsec_")) {
  throw new Error("STRIPE_WEBHOOK_SECRET is required");
}
if (!priceId?.startsWith("price_")) throw new Error("STRIPE_PRICE_ANSHIN is required");

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "55432" ||
  parsedDatabaseUrl.pathname !== "/apexbrain_test"
) {
  throw new Error("Cancellation webhook check only supports the local test database");
}

const sql = postgres(databaseUrl, {
  ssl: false,
  max: 1,
});

const now = Math.floor(Date.now() / 1000);
const periodEnd = now + 30 * 24 * 60 * 60;

function subscriptionObject(status, cancelAtPeriodEnd) {
  return {
    id: subscriptionId,
    object: "subscription",
    cancel_at_period_end: cancelAtPeriodEnd,
    created: now,
    currency: "jpy",
    current_period_end: periodEnd,
    current_period_start: now,
    customer: customerId,
    items: {
      object: "list",
      data: [
        {
          id: `si_local_${randomUUID().replaceAll("-", "")}`,
          object: "subscription_item",
          current_period_end: periodEnd,
          current_period_start: now,
          price: { id: priceId, object: "price" },
          quantity: 1,
        },
      ],
      has_more: false,
      url: `/v1/subscription_items?subscription=${subscriptionId}`,
    },
    latest_invoice: null,
    livemode: false,
    metadata: {
      line_user_id: lineUserId,
      plan_code: "anshin",
    },
    status,
  };
}

function eventPayload(type, subscription) {
  return JSON.stringify({
    id: `evt_local_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    api_version: "2025-12-15.clover",
    created: now,
    data: { object: subscription },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  });
}

async function sendSignedWebhook(payload) {
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
  });
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
    },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`Stripe cancellation webhook failed with status ${response.status}`);
  }
  return response.json();
}

try {
  await sql`
    insert into users (
      line_user_id, display_name, plan_code, membership_provider,
      membership_plan_id, membership_status, current_period_start,
      current_period_end, stripe_customer_id, stripe_subscription_id
    ) values (
      ${lineUserId}, 'Cancellation webhook probe', 'anshin', 'stripe',
      ${subscriptionId}, 'active', current_date,
      current_date + 30, ${customerId}, ${subscriptionId}
    )
  `;

  const scheduledPayload = eventPayload(
    "customer.subscription.updated",
    subscriptionObject("active", true),
  );
  await sendSignedWebhook(scheduledPayload);

  const scheduledRows = await sql`
    select plan_code, membership_status
    from users where line_user_id = ${lineUserId}
  `;
  if (
    scheduledRows[0]?.plan_code !== "anshin" ||
    scheduledRows[0]?.membership_status !== "cancel_at_period_end"
  ) {
    throw new Error("Cancellation scheduling did not preserve paid entitlement");
  }

  const deletedPayload = eventPayload(
    "customer.subscription.deleted",
    subscriptionObject("canceled", false),
  );
  await sendSignedWebhook(deletedPayload);
  const duplicateResult = await sendSignedWebhook(deletedPayload);

  const canceledRows = await sql`
    select plan_code, membership_status
    from users where line_user_id = ${lineUserId}
  `;
  if (
    canceledRows[0]?.plan_code !== "free" ||
    canceledRows[0]?.membership_status !== "canceled"
  ) {
    throw new Error("Completed cancellation did not return the user to free");
  }
  if (!duplicateResult.duplicate) {
    throw new Error("Duplicate cancellation webhook was not suppressed");
  }

  console.log(
    JSON.stringify(
      {
        signedWebhookAccepted: true,
        scheduledCancellationStatus: "cancel_at_period_end",
        paidEntitlementPreservedUntilPeriodEnd: true,
        completedCancellationStatus: "canceled",
        returnedToPlan: "free",
        duplicateSuppressed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await sql`
    delete from users
    where line_user_id = ${lineUserId}
      and stripe_customer_id = ${customerId}
      and stripe_subscription_id = ${subscriptionId}
  `;
  await sql.end({ timeout: 5 });
}
