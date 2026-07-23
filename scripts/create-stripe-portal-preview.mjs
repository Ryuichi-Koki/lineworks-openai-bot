import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const priceId = process.env.STRIPE_PRICE_ANSHIN;
const portalConfigurationId = process.env.STRIPE_PORTAL_CONFIGURATION_ID;

if (!stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("Stripe test-mode secret key is required");
}
if (!priceId?.startsWith("price_")) {
  throw new Error("STRIPE_PRICE_ANSHIN is required");
}
if (!portalConfigurationId?.startsWith("bpc_")) {
  throw new Error("STRIPE_PORTAL_CONFIGURATION_ID is required");
}

const stripe = new Stripe(stripeSecretKey, {
  appInfo: {
    name: "ApexBrain LINE tax consultation",
    version: "0.1.0",
  },
  maxNetworkRetries: 2,
});

const customer = await stripe.customers.create(
  {
    name: "ApexBrain local portal probe",
    metadata: {
      apexbrain_environment: "local_test",
      line_user_id: "UcodexPortalLocalProbe",
    },
  },
  {
    idempotencyKey: "apexbrain-local-portal-customer-v1",
  },
);
if (customer.deleted || customer.livemode) {
  throw new Error("Stripe returned an unsafe Customer");
}

const subscriptions = await stripe.subscriptions.list({
  customer: customer.id,
  status: "all",
  limit: 100,
});
let subscription = subscriptions.data.find(
  (item) =>
    ["active", "trialing"].includes(item.status) &&
    item.metadata.apexbrain_environment === "local_test",
);

if (!subscription) {
  subscription = await stripe.subscriptions.create(
    {
      customer: customer.id,
      items: [{ price: priceId }],
      trial_period_days: 7,
      metadata: {
        apexbrain_environment: "local_test",
        line_user_id: "UcodexPortalLocalProbe",
        plan_code: "anshin",
      },
    },
    {
      idempotencyKey: `apexbrain-local-portal-subscription-${Date.now()}`,
    },
  );
}
if (subscription.livemode || !["active", "trialing"].includes(subscription.status)) {
  throw new Error("Stripe returned an unsafe Subscription");
}

const session = await stripe.billingPortal.sessions.create({
  customer: customer.id,
  configuration: portalConfigurationId,
  locale: "ja",
  return_url: "http://localhost:3000/billing/manage",
  flow_data: {
    type: "subscription_cancel",
    subscription_cancel: {
      subscription: subscription.id,
    },
    after_completion: {
      type: "redirect",
      redirect: {
        return_url: "http://localhost:3000/billing/manage",
      },
    },
  },
});

const portalUrl = new URL(session.url);
if (portalUrl.protocol !== "https:" || portalUrl.hostname !== "billing.stripe.com") {
  throw new Error("Stripe returned an unexpected Portal URL");
}

const toolsDirectory = path.join(process.cwd(), ".tools");
const outputPath = path.join(toolsDirectory, "stripe-portal-preview.json");
await mkdir(toolsDirectory, { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({ url: session.url, createdAt: new Date().toISOString() })}\n`,
  { encoding: "utf8", mode: 0o600 },
);
await chmod(outputPath, 0o600);

console.log(
  JSON.stringify({
    ok: true,
    mode: "test",
    host: portalUrl.hostname,
    subscriptionStatus: subscription.status,
    output: ".tools/stripe-portal-preview.json",
  }),
);
