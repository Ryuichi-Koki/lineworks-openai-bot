import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = postgres(databaseUrl, {
  ssl: process.env.DATABASE_SSL_MODE === "disable" ? false : "require",
  max: 1,
});

try {
  const [identity] = await sql`
    select current_database() as database, current_user as role
  `;
  const [counts] = await sql`
    select
      (select count(*)::integer from webhook_events where provider = 'stripe')
        as stripe_webhook_events,
      (select count(*)::integer from stripe_billing_objects)
        as stripe_billing_objects
  `;
  const recent = await sql`
    select event_type, processing_status, processing_result
    from webhook_events
    where provider = 'stripe'
    order by created_at desc
    limit 10
  `;

  console.log(
    JSON.stringify(
      {
        database: identity.database,
        role: identity.role,
        stripeWebhookEvents: counts.stripe_webhook_events,
        stripeBillingObjects: counts.stripe_billing_objects,
        recentStripeWebhooks: recent,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
