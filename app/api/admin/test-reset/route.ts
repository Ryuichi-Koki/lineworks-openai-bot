import { timingSafeEqual } from "node:crypto";
import postgres from "postgres";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function targetLineUserId(): string {
  const userIds = (process.env.LINE_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (userIds.length !== 1) {
    throw new Error("Exactly one allowed LINE user is required");
  }
  return userIds[0];
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.TEST_RESET_ENABLED !== "true") {
    return Response.json({ ok: false, error: "disabled" }, { status: 404 });
  }

  const expectedToken = process.env.TEST_RESET_TOKEN ?? "";
  const providedToken =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (
    expectedToken.length < 32 ||
    !providedToken ||
    !secureEqual(providedToken, expectedToken)
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";
  if (!stripeSecretKey.startsWith("sk_test_")) {
    return Response.json(
      { ok: false, error: "test_mode_required" },
      { status: 412 },
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return Response.json(
      { ok: false, error: "database_unavailable" },
      { status: 503 },
    );
  }

  const lineUserId = targetLineUserId();
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    ssl: process.env.DATABASE_SSL_MODE === "disable" ? false : "require",
    prepare: false,
  });

  try {
    const users = await sql`
      select id, stripe_customer_id, stripe_subscription_id
      from users
      where line_user_id = ${lineUserId}
      limit 1
    `;
    const user = users[0];
    if (!user) {
      return Response.json({
        ok: true,
        subscriptionCanceled: false,
        databaseReset: false,
        alreadyFresh: true,
      });
    }

    let subscriptionCanceled = false;
    const subscriptionId = user.stripe_subscription_id
      ? String(user.stripe_subscription_id)
      : null;
    if (subscriptionId) {
      const stripe = new Stripe(stripeSecretKey, { maxNetworkRetries: 2 });
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (subscription.livemode) {
        return Response.json(
          { ok: false, error: "live_subscription_blocked" },
          { status: 412 },
        );
      }
      if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
        await stripe.subscriptions.cancel(subscriptionId);
        subscriptionCanceled = true;
      }
    }

    const userId = String(user.id);
    const customerId = user.stripe_customer_id
      ? String(user.stripe_customer_id)
      : null;
    await sql.begin(async (transaction) => {
      await transaction`
        delete from stripe_billing_objects
        where line_user_id = ${lineUserId}
          or stripe_customer_id = ${customerId}
          or stripe_subscription_id = ${subscriptionId}
      `;
      await transaction`
        delete from policy_acceptances where line_user_id = ${lineUserId}
      `;
      await transaction`
        delete from usage_events where user_id = ${userId}
      `;
      await transaction`
        delete from review_requests where user_id = ${userId}
      `;
      await transaction`
        delete from tax_review_intakes where line_user_id = ${lineUserId}
      `;
      await transaction`
        delete from users where id = ${userId} and line_user_id = ${lineUserId}
      `;
      await transaction`
        insert into admin_audit_logs (
          operator_id, action, target_type, target_id, reason, after_value
        ) values (
          'codex-authorized-test-reset',
          'reset_test_membership',
          'line_user',
          'allowed-test-user',
          'User explicitly authorized Stripe test cancellation and test-data reset',
          ${transaction.json({
            subscriptionCanceled,
            databaseReset: true,
          })}
        )
      `;
    });

    return Response.json({
      ok: true,
      subscriptionCanceled,
      databaseReset: true,
      alreadyFresh: false,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
