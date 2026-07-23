import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Stripe from "stripe";

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r\n|\n|\r/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2] === "") continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}

const localEnv = parseEnvFile(resolve(process.cwd(), ".env.local"));
const secretKey = process.env.STRIPE_SECRET_KEY || localEnv.STRIPE_SECRET_KEY;
if (!secretKey?.startsWith("sk_test_")) {
  throw new Error("Sandbox setup requires STRIPE_SECRET_KEY beginning with sk_test_");
}

const stripe = new Stripe(secretKey, {
  appInfo: { name: "ApexBrain LINE tax consultation", version: "0.1.0" },
  maxNetworkRetries: 2,
});

const lookupKey = "apexbrain_anshin_monthly_jpy";
const existingPrices = await stripe.prices.list({
  active: true,
  lookup_keys: [lookupKey],
  limit: 1,
});

if (existingPrices.data[0]) {
  const existing = existingPrices.data[0];
  console.log(
    JSON.stringify({
      created: false,
      productId:
        typeof existing.product === "string"
          ? existing.product
          : existing.product.id,
      priceId: existing.id,
      lookupKey,
    }),
  );
  process.exit(0);
}

const products = await stripe.products.list({ active: true, limit: 100 });
let product = products.data.find(
  (item) => item.metadata.integration_key === "apexbrain_anshin",
);
if (!product) {
  product = await stripe.products.create(
    {
      name: "あんしん会員",
      description: "AI回答 月100回・税理士確認 月1件",
      tax_code: "txcd_20030000",
      metadata: {
        integration_key: "apexbrain_anshin",
        plan_code: "anshin",
      },
    },
    { idempotencyKey: "apexbrain:product:anshin:v1" },
  );
}

const price = await stripe.prices.create(
  {
    product: product.id,
    currency: "jpy",
    unit_amount: 3300,
    recurring: { interval: "month" },
    tax_behavior: "inclusive",
    lookup_key: lookupKey,
    metadata: { plan_code: "anshin" },
  },
  { idempotencyKey: "apexbrain:price:anshin:monthly:jpy:3300:inclusive:v1" },
);

console.log(
  JSON.stringify({
    created: true,
    productId: product.id,
    priceId: price.id,
    lookupKey,
  }),
);
