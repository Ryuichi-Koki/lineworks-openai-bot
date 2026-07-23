import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Stripe from "stripe";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env.local");
const secretKey = process.env.STRIPE_SECRET_KEY;
const baseUrl = process.env.STRIPE_APP_BASE_URL;

if (!secretKey?.startsWith("sk_test_")) {
  throw new Error("A Stripe test-mode secret key is required");
}
if (!baseUrl) throw new Error("STRIPE_APP_BASE_URL is required");

const parsedBaseUrl = new URL(baseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedBaseUrl.hostname) ||
  parsedBaseUrl.port !== "3000"
) {
  throw new Error("Sandbox Portal setup requires localhost:3000");
}

function replaceEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^\\s*${key}\\s*=.*$`, "mu");
  return matcher.test(source)
    ? source.replace(matcher, line)
    : `${source.replace(/\s*$/u, "")}\n${line}\n`;
}

const stripe = new Stripe(secretKey, {
  appInfo: {
    name: "ApexBrain LINE tax consultation",
    version: "0.1.0",
  },
  maxNetworkRetries: 2,
});

const existing = await stripe.billingPortal.configurations.list({
  active: true,
  limit: 100,
});
let configuration = existing.data.find(
  (item) => item.metadata.apexbrain_environment === "local_test",
);

if (!configuration) {
  configuration = await stripe.billingPortal.configurations.create(
    {
      business_profile: {
        headline: "あんしん会員の契約・お支払い情報を管理できます。",
      },
      default_return_url: `${baseUrl}/billing/manage`,
      features: {
        customer_update: {
          enabled: true,
          allowed_updates: ["name", "email", "address", "tax_id"],
        },
        invoice_history: {
          enabled: true,
        },
        payment_method_update: {
          enabled: true,
        },
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          cancellation_reason: {
            enabled: true,
            options: [
              "too_expensive",
              "missing_features",
              "switched_service",
              "unused",
              "other",
            ],
          },
        },
        subscription_update: {
          enabled: false,
        },
      },
      metadata: {
        apexbrain_environment: "local_test",
        cancellation_policy: "at_period_end",
      },
    },
    {
      idempotencyKey: "apexbrain-local-portal-configuration-v1",
    },
  );
}

if (
  configuration.livemode ||
  !configuration.id.startsWith("bpc_") ||
  configuration.features.subscription_cancel.mode !== "at_period_end" ||
  !configuration.features.subscription_cancel.enabled
) {
  throw new Error("Stripe returned an unsafe Customer Portal configuration");
}

const source = await readFile(envPath, "utf8");
const nextSource = replaceEnvValue(
  source,
  "STRIPE_PORTAL_CONFIGURATION_ID",
  configuration.id,
);
await writeFile(envPath, nextSource, { encoding: "utf8", mode: 0o600 });

console.log("Stripe Sandbox Customer Portal configuration is ready.");
console.log(`Configuration: ${configuration.id}`);
console.log("Cancellation mode: at_period_end");
