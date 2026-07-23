import type { PlanCode } from "../membership/plans.ts";

const STRIPE_PRICE_ENV: Partial<Record<PlanCode, string>> = {
  anshin: "STRIPE_PRICE_ANSHIN",
  premium_future: "STRIPE_PRICE_PREMIUM",
};

export function stripeBillingEnabled(): boolean {
  return process.env.STRIPE_BILLING_ENABLED?.toLowerCase() === "true";
}

export function requireStripeEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function stripePriceForPlan(planCode: PlanCode): string {
  const envName = STRIPE_PRICE_ENV[planCode];
  if (!envName) throw new Error(`Plan ${planCode} is not available for Stripe Checkout`);
  const priceId = requireStripeEnv(envName);
  if (!priceId.startsWith("price_")) {
    throw new Error(`${envName} must contain a Stripe Price ID`);
  }
  return priceId;
}

export function stripeAppBaseUrl(): string {
  const value = requireStripeEnv("STRIPE_APP_BASE_URL");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("STRIPE_APP_BASE_URL must use HTTPS outside localhost");
  }
  return url.toString().replace(/\/$/, "");
}

export function assertSafeStripeSecret(secretKey: string): void {
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error(
      "Only a Stripe test-mode secret key is allowed by this implementation",
    );
  }
}
