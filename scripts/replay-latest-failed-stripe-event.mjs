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
  throw new Error("This replay only supports the local test database");
}

const sql = postgres(databaseUrl, { ssl: false, max: 1 });
const failedRows = await sql`
  select event_id, event_type
  from webhook_events
  where provider = 'stripe' and processing_status = 'failed'
  order by created_at desc
  limit 1
`;
const failedEventId = failedRows[0]?.event_id;
if (typeof failedEventId !== "string" || !failedEventId) {
  await sql.end();
  throw new Error("No failed Stripe event is available to replay");
}

const stripe = new Stripe(stripeSecretKey, { maxNetworkRetries: 2 });
const event = await stripe.events.retrieve(failedEventId);
if (event.livemode) {
  await sql.end();
  throw new Error("Live-mode Stripe events cannot be replayed");
}

const verificationEventId = `evt_local_verify_${randomUUID().replaceAll("-", "")}`;
const payload = JSON.stringify({
  ...event,
  id: verificationEventId,
});
const timestamp = Math.floor(Date.now() / 1000);
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
  throw new Error(`Local Stripe webhook replay failed with status ${response.status}`);
}

const resultRows = await sql`
  select processing_status, processing_result
  from webhook_events
  where provider = 'stripe' and event_id = ${verificationEventId}
`;
await sql.end();

console.log(
  JSON.stringify({
    ok: resultRows[0]?.processing_status === "processed",
    eventType: failedRows[0]?.event_type,
    status: resultRows[0]?.processing_status,
    result: resultRows[0]?.processing_result,
  }),
);
