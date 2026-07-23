import postgres from "postgres";
import Stripe from "stripe";

const databaseUrl = process.env.DATABASE_URL;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("A Stripe test-mode secret key is required");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "55432" ||
  parsedDatabaseUrl.pathname !== "/apexbrain_test"
) {
  throw new Error("This check only supports the local test database");
}

const sql = postgres(databaseUrl, { ssl: false, max: 1 });
const rows = await sql`
  select stripe_subscription_id
  from users
  where stripe_subscription_id is not null
  order by created_at desc
  limit 1
`;
await sql.end();

const subscriptionId = rows[0]?.stripe_subscription_id;
if (typeof subscriptionId !== "string" || !subscriptionId) {
  throw new Error("No linked test subscription was found");
}

const stripe = new Stripe(stripeSecretKey, { maxNetworkRetries: 2 });
const subscription = await stripe.subscriptions.retrieve(subscriptionId);
if (subscription.livemode) {
  throw new Error("Live-mode subscriptions cannot be inspected");
}

console.log(
  JSON.stringify({
    mode: "test",
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at
      ? new Date(subscription.cancel_at * 1000).toISOString()
      : null,
    canceledAt: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null,
    endedAt: subscription.ended_at
      ? new Date(subscription.ended_at * 1000).toISOString()
      : null,
  }),
);
