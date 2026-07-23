import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import Stripe from "stripe";

const databaseUrl = process.env.DATABASE_URL;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("A Stripe test-mode secret key is required");
}
if (!webhookSecret?.startsWith("whsec_")) {
  throw new Error("A Stripe webhook test secret is required");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "55432" ||
  parsedDatabaseUrl.pathname !== "/apexbrain_test"
) {
  throw new Error("This reconciliation only supports the local test database");
}

const sql = postgres(databaseUrl, { ssl: false, max: 1 });
const rows = await sql`
  select stripe_subscription_id
  from users
  where stripe_subscription_id is not null
  order by created_at desc
  limit 1
`;
const subscriptionId = rows[0]?.stripe_subscription_id;
if (typeof subscriptionId !== "string" || !subscriptionId) {
  await sql.end();
  throw new Error("No linked test subscription was found");
}

const stripe = new Stripe(stripeSecretKey, { maxNetworkRetries: 2 });
const subscription = await stripe.subscriptions.retrieve(subscriptionId);
if (subscription.livemode) {
  await sql.end();
  throw new Error("Live-mode subscriptions cannot be reconciled");
}

const timestamp = Math.floor(Date.now() / 1000);
const event = {
  id: `evt_local_reconcile_${randomUUID().replaceAll("-", "")}`,
  object: "event",
  api_version: "2026-06-24.dahlia",
  created: timestamp,
  data: { object: subscription },
  livemode: false,
  pending_webhooks: 1,
  request: null,
  type: "customer.subscription.updated",
};
const payload = JSON.stringify(event);
const signature = createHmac("sha256", webhookSecret)
  .update(`${timestamp}.${payload}`)
  .digest("hex");
const response = await fetch("http://127.0.0.1:3000/api/stripe/webhook", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Stripe-Signature": `t=${timestamp},v1=${signature}`,
  },
  body: payload,
});
if (!response.ok) {
  await sql.end();
  throw new Error(
    `Local Stripe subscription reconciliation failed with status ${response.status}`,
  );
}

const stateRows = await sql`
  select plan_code, membership_status, current_period_end
  from users
  where stripe_subscription_id = ${subscriptionId}
`;
await sql.end();

console.log(
  JSON.stringify({
    ok: true,
    mode: "test",
    planCode: stateRows[0]?.plan_code,
    membershipStatus: stateRows[0]?.membership_status,
    periodEnd: stateRows[0]?.current_period_end,
  }),
);
