import Stripe from "stripe";
import nodeFetch from "node-fetch";
import { assertSafeStripeSecret, requireStripeEnv } from "./config.ts";

let stripe: Stripe | null = null;

export function stripeClient(): Stripe {
  if (stripe) return stripe;
  const secretKey = requireStripeEnv("STRIPE_SECRET_KEY");
  assertSafeStripeSecret(secretKey);
  stripe = new Stripe(secretKey, {
    appInfo: {
      name: "ApexBrain LINE tax consultation",
      version: "0.1.0",
    },
    httpClient: Stripe.createFetchHttpClient(
      nodeFetch as unknown as typeof globalThis.fetch,
    ),
    maxNetworkRetries: 2,
  });
  return stripe;
}
