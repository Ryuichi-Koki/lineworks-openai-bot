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
  appInfo: { name: "ApexBrain LINE tax consultation", version: "0.2.0" },
  maxNetworkRetries: 2,
});

const products = await stripe.products.list({ active: true, limit: 100 });
let product = products.data.find(
  (item) => item.metadata.integration_key === "apexbrain_tax_review",
);
if (!product) {
  product = await stripe.products.create(
    {
      name: "税理士へのLINE個別相談",
      description: "税理士へのLINE個別相談 1回分（自動更新なし）",
      tax_code: "txcd_20030000",
      metadata: {
        integration_key: "apexbrain_tax_review",
        billing_model: "one_time",
      },
    },
    { idempotencyKey: "apexbrain:product:tax-review:v1" },
  );
}

const definitions = [
  {
    envName: "STRIPE_PRICE_TAX_REVIEW_PROMO",
    lookupKey: "apexbrain_tax_review_promo_2026_jpy",
    amount: 1100,
    priceCode: "promo_2026",
  },
  {
    envName: "STRIPE_PRICE_TAX_REVIEW_STANDARD",
    lookupKey: "apexbrain_tax_review_standard_jpy",
    amount: 3300,
    priceCode: "standard",
  },
];

const result = {};
for (const definition of definitions) {
  const existing = await stripe.prices.list({
    active: true,
    lookup_keys: [definition.lookupKey],
    limit: 1,
  });
  let price = existing.data[0];
  if (price) {
    if (
      price.type !== "one_time" ||
      price.currency !== "jpy" ||
      price.unit_amount !== definition.amount ||
      price.tax_behavior !== "inclusive"
    ) {
      throw new Error(
        `Existing ${definition.lookupKey} does not match the required one-time tax-inclusive JPY Price`,
      );
    }
  } else {
    price = await stripe.prices.create(
      {
        product: product.id,
        currency: "jpy",
        unit_amount: definition.amount,
        tax_behavior: "inclusive",
        lookup_key: definition.lookupKey,
        metadata: {
          purchase_type: "tax_review",
          price_code: definition.priceCode,
        },
      },
      {
        idempotencyKey: `apexbrain:price:tax-review:${definition.priceCode}:jpy:${definition.amount}:inclusive:v1`,
      },
    );
  }
  result[definition.envName] = price.id;
}

console.log(
  JSON.stringify({
    mode: "test",
    productId: product.id,
    prices: result,
  }),
);
