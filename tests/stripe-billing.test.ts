import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeStripePortalUrl,
  buildSubscriptionCheckoutParams,
  checkoutDayBucket,
  checkoutIdempotencyKey,
  isMissingStripeCustomerError,
  resolveReusableStripeCustomerId,
} from "../lib/stripe/billing.ts";
import type Stripe from "stripe";
import {
  assertSafeStripeSecret,
  assertStripeObjectMode,
} from "../lib/stripe/config.ts";
import {
  inclusiveEndDateFromUnix,
  isoDateFromUnix,
  stripeId,
  stripeSubscriptionStatus,
} from "../lib/stripe/mapping.ts";

test("Stripe integration requires explicit mode-matched keys", () => {
  assert.doesNotThrow(() => assertSafeStripeSecret("sk_test_example"));
  assert.throws(() => assertSafeStripeSecret("sk_live_example"), /test-mode/);
  assert.throws(() => assertSafeStripeSecret("not-a-stripe-key"), /test-mode/);
  assert.throws(
    () => assertSafeStripeSecret("sk_live_example", "live", false),
    /STRIPE_LIVE_MODE_ENABLED/,
  );
  assert.doesNotThrow(() =>
    assertSafeStripeSecret("rk_live_example", "live", true),
  );
});

test("Stripe objects and webhooks must match the configured mode", () => {
  assert.doesNotThrow(() => assertStripeObjectMode(false, "test"));
  assert.doesNotThrow(() => assertStripeObjectMode(true, "live"));
  assert.throws(() => assertStripeObjectMode(true, "test"), /does not match/);
  assert.throws(() => assertStripeObjectMode(false, "live"), /does not match/);
});

test("Stripe subscription states map to local entitlement states", () => {
  assert.equal(
    stripeSubscriptionStatus({ status: "active", cancel_at_period_end: false }),
    "active",
  );
  assert.equal(
    stripeSubscriptionStatus({ status: "active", cancel_at_period_end: true }),
    "cancel_at_period_end",
  );
  assert.equal(
    stripeSubscriptionStatus({
      status: "active",
      cancel_at_period_end: false,
      cancel_at: 1_787_490_000,
    }),
    "cancel_at_period_end",
  );
  assert.equal(
    stripeSubscriptionStatus({ status: "past_due", cancel_at_period_end: false }),
    "past_due",
  );
  assert.equal(
    stripeSubscriptionStatus({ status: "incomplete", cancel_at_period_end: false }),
    "suspended",
  );
  assert.equal(
    stripeSubscriptionStatus({ status: "canceled", cancel_at_period_end: false }),
    "canceled",
  );
});

test("Stripe IDs and Unix billing dates normalize deterministically", () => {
  assert.equal(stripeId("cus_test"), "cus_test");
  assert.equal(stripeId({ id: "sub_test" }), "sub_test");
  assert.equal(stripeId(null), null);
  assert.equal(isoDateFromUnix(1_704_067_200), "2024-01-01");
  const juneStartJst = Date.parse("2024-05-31T15:00:00Z") / 1000;
  assert.equal(isoDateFromUnix(juneStartJst), "2024-06-01");
  assert.equal(inclusiveEndDateFromUnix(juneStartJst), "2024-05-31");
});

test("Stripe subscription Checkout stays in the configured plan and LINE user", () => {
  const params = buildSubscriptionCheckoutParams({
    lineUserId: "line-test-user",
    planCode: "anshin",
    priceId: "price_test_anshin",
    baseUrl: "http://localhost:3000",
  });

  assert.equal(params.mode, "subscription");
  assert.equal(params.client_reference_id, "line-test-user");
  assert.deepEqual(params.line_items, [
    { price: "price_test_anshin", quantity: 1 },
  ]);
  assert.deepEqual(params.automatic_tax, { enabled: true });
  assert.deepEqual(params.metadata, {
    line_user_id: "line-test-user",
    plan_code: "anshin",
  });
  assert.deepEqual(params.subscription_data?.metadata, params.metadata);
  assert.equal(
    params.success_url,
    "http://localhost:3000/billing/success?session_id={CHECKOUT_SESSION_ID}",
  );
  assert.equal(params.cancel_url, "http://localhost:3000/billing/cancel");
  assert.equal(params.customer, undefined);
});

test("Stripe subscription Checkout reuses an existing customer safely", () => {
  const params = buildSubscriptionCheckoutParams({
    lineUserId: "line-test-user",
    planCode: "anshin",
    priceId: "price_test_anshin",
    baseUrl: "http://localhost:3000",
    customerId: "cus_test_existing",
  });

  assert.equal(params.customer, "cus_test_existing");
  assert.deepEqual(params.customer_update, { address: "auto", name: "auto" });
});

test("同じ利用者の連打は同一のCheckoutセッションへ収束する", () => {
  const params = buildSubscriptionCheckoutParams({
    lineUserId: "line-test-user",
    planCode: "anshin",
    priceId: "price_test_anshin",
    baseUrl: "http://localhost:3000",
  });

  // 連打相当：同じ内容・同じ日なら冪等キーは一致する（＝Stripeは新規セッションを作らない）
  assert.equal(
    checkoutIdempotencyKey(params, "2026-07-29"),
    checkoutIdempotencyKey(params, "2026-07-29"),
  );
  assert.match(checkoutIdempotencyKey(params, "2026-07-29"), /^checkout:[0-9a-f]{40}$/);
});

test("利用者・日付・顧客紐付けが変われば冪等キーも変わる", () => {
  const base = {
    lineUserId: "line-test-user",
    planCode: "anshin" as const,
    priceId: "price_test_anshin",
    baseUrl: "http://localhost:3000",
  };
  const params = buildSubscriptionCheckoutParams(base);
  const otherUser = buildSubscriptionCheckoutParams({
    ...base,
    lineUserId: "line-other-user",
  });
  // 顧客紐付け後はパラメータが変わるため、同じキーで異なる内容を送る事故が起きない
  const withCustomer = buildSubscriptionCheckoutParams({
    ...base,
    customerId: "cus_test_existing",
  });

  assert.notEqual(
    checkoutIdempotencyKey(params, "2026-07-29"),
    checkoutIdempotencyKey(otherUser, "2026-07-29"),
  );
  assert.notEqual(
    checkoutIdempotencyKey(params, "2026-07-29"),
    checkoutIdempotencyKey(withCustomer, "2026-07-29"),
  );
  assert.notEqual(
    checkoutIdempotencyKey(params, "2026-07-29"),
    checkoutIdempotencyKey(params, "2026-07-30"),
  );
});

test("Checkoutの冪等キーは日単位で区切る", () => {
  assert.equal(checkoutDayBucket(new Date("2026-07-29T23:59:59Z")), "2026-07-29");
  assert.equal(checkoutDayBucket(new Date("2026-07-30T00:00:01Z")), "2026-07-30");
});

test("Customer Portal URL accepts only Stripe-hosted HTTPS URLs", () => {
  assert.equal(
    assertSafeStripePortalUrl(
      "https://billing.stripe.com/p/session/test_portal_session",
    ),
    "https://billing.stripe.com/p/session/test_portal_session",
  );
  assert.throws(
    () => assertSafeStripePortalUrl("https://example.com/fake-portal"),
    /unexpected Customer Portal URL/,
  );
  assert.throws(
    () => assertSafeStripePortalUrl("http://billing.stripe.com/insecure"),
    /unexpected Customer Portal URL/,
  );
});

test("存在しない旧Stripe顧客は新規Checkout作成へフォールバックする", async () => {
  const stripe = {
    customers: {
      retrieve: async () => {
        throw { code: "resource_missing", param: "id" };
      },
    },
  } as unknown as Stripe;

  assert.equal(
    await resolveReusableStripeCustomerId("cus_old_test_record", stripe),
    null,
  );
  assert.equal(
    isMissingStripeCustomerError({
      code: "resource_missing",
      param: "customer",
    }),
    true,
  );
  assert.equal(
    isMissingStripeCustomerError({
      code: "resource_missing",
      param: "id",
    }),
    true,
  );
});

test("顧客不存在以外のStripeエラーは握り潰さない", async () => {
  const stripe = {
    customers: {
      retrieve: async () => {
        throw { code: "api_connection_error" };
      },
    },
  } as unknown as Stripe;

  await assert.rejects(
    resolveReusableStripeCustomerId("cus_connection_failure", stripe),
  );
});
