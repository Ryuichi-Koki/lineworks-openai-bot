import { createSubscriptionCheckoutSession } from "../lib/stripe/billing.ts";

const checkout = await createSubscriptionCheckoutSession({
  lineUserId: "codex_local_checkout_probe",
  planCode: "anshin",
});

// 連打相当の2回目。冪等キーにより同じセッションURLが返ることを確認する。
const repeated = await createSubscriptionCheckoutSession({
  lineUserId: "codex_local_checkout_probe",
  planCode: "anshin",
});
if (repeated.url !== checkout.url) {
  throw new Error(
    "Repeated Checkout requests created a second session; double payment is possible",
  );
}
if (!repeated.reused) {
  throw new Error("The repeated Checkout request was not detected as a reuse");
}

const checkoutUrl = checkout.url;
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
