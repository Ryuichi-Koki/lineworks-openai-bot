import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { pushLineMessage } from "../lib/line/client.ts";
import {
  isPricingInquiry,
  TAX_AI_PRICING_MESSAGE,
} from "../lib/tax/hybridService.ts";
import { createSubscriptionCheckoutSession } from "../lib/stripe/billing.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "55432" ||
  parsedDatabaseUrl.pathname !== "/apexbrain_test"
) {
  throw new Error("This diagnostic only supports the local test database");
}
if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
  throw new Error("A Stripe test-mode secret key is required");
}
if (!isPricingInquiry("料金を教えて")) {
  throw new Error("The pricing inquiry detector is not active");
}

const sql = postgres(databaseUrl, { ssl: false, max: 1 });
const rows = await sql`
  select line_user_id
  from users
  where created_at > now() - interval '30 minutes'
  order by created_at desc
  limit 1
`;
await sql.end();

const lineUserId = rows[0]?.line_user_id;
if (typeof lineUserId !== "string" || !lineUserId) {
  throw new Error("No recent LINE test user was found");
}

try {
  const checkoutUrl = await createSubscriptionCheckoutSession({
    lineUserId,
    planCode: "anshin",
    idempotencyKey: `diagnostic-${randomUUID()}`,
  });
  await pushLineMessage(
    lineUserId,
    TAX_AI_PRICING_MESSAGE,
    randomUUID(),
    {
      includeMembershipJoinButton: true,
      membershipJoinUrl: checkoutUrl,
    },
  );
  console.log(
    JSON.stringify({
      ok: true,
      pricingTextLength: TAX_AI_PRICING_MESSAGE.length,
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(
    JSON.stringify({
      ok: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: message
        .replace(/sk_(?:test|live)_[A-Za-z0-9]+/gu, "[REDACTED]")
        .replace(/whsec_[A-Za-z0-9]+/gu, "[REDACTED]")
        .replace(/https:\/\/checkout\.stripe\.com\/[^\s"]+/gu, "[CHECKOUT_URL]"),
      pricingTextLength: TAX_AI_PRICING_MESSAGE.length,
    }),
  );
  process.exitCode = 1;
}
