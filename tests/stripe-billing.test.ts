import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeStripePortalUrl,
  buildSubscriptionCheckoutParams,
} from "../lib/stripe/billing.ts";
import { assertSafeStripeSecret } from "../lib/stripe/config.ts";
import {
  inclusiveEndDateFromUnix,
  isoDateFromUnix,
  stripeId,
  stripeSubscriptionStatus,
} from "../lib/stripe/mapping.ts";

test("Stripe integration rejects live and malformed secret keys", () => {
  assert.doesNotThrow(() => assertSafeStripeSecret("sk_test_example"));
  assert.throws(() => assertSafeStripeSecret("sk_live_example"), /test-mode/);
  assert.throws(() => assertSafeStripeSecret("not-a-stripe-key"), /test-mode/);
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
