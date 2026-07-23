import { createSubscriptionCheckoutSession } from "../lib/stripe/billing.ts";

const checkoutUrl = await createSubscriptionCheckoutSession({
  lineUserId: "codex_local_checkout_probe",
  planCode: "anshin",
  idempotencyKey: "local-checkout-probe-v1",
});

const parsed = new URL(checkoutUrl);
if (
  parsed.protocol !== "https:" ||
  !(
    parsed.hostname === "checkout.stripe.com" ||
    parsed.hostname.endsWith(".stripe.com")
  )
) {
  throw new Error("Stripe returned an unexpected Checkout URL");
}

console.log("Stripe Sandbox Checkout session is ready.");
console.log(`Checkout host: ${parsed.hostname}`);
