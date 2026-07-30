import Stripe from "stripe";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const confirmLive = args.has("--confirm-live");
const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
const baseUrl = process.env.STRIPE_APP_BASE_URL?.trim() ?? "";

if (!/^(sk_live_|rk_live_)/u.test(secretKey)) {
  throw new Error("A Stripe live secret or restricted key is required");
}
if (!confirmLive) {
  throw new Error("--confirm-live is required for a live Stripe account");
}
if (!/^https:\/\//u.test(baseUrl)) {
  throw new Error("STRIPE_APP_BASE_URL must be an HTTPS URL");
}

const endpointUrl = new URL("/api/stripe/webhook", baseUrl).toString();
const enabledEvents = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
];

const stripe = new Stripe(secretKey);
const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
const endpoint = endpoints.data.find((item) => item.url === endpointUrl);
if (!endpoint) {
  throw new Error("The production Stripe webhook endpoint was not found");
}

const current = [...endpoint.enabled_events].sort();
const expected = [...enabledEvents].sort();
const changed = JSON.stringify(current) !== JSON.stringify(expected);
console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      endpointFound: true,
      changed,
      eventCount: expected.length,
      events: expected,
    },
    null,
    2,
  ),
);

if (apply && changed) {
  await stripe.webhookEndpoints.update(endpoint.id, {
    enabled_events: enabledEvents,
  });
  console.log("UPDATED Stripe production webhook event subscriptions.");
} else if (!apply && changed) {
  console.log("DRY RUN only. Add --apply after reviewing the event list.");
} else {
  console.log("UNCHANGED Stripe webhook subscriptions already match.");
}
