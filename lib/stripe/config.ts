import type { PlanCode } from "../membership/plans.ts";

const STRIPE_PRICE_ENV: Partial<Record<PlanCode, string>> = {
  anshin: "STRIPE_PRICE_ANSHIN",
  premium_future: "STRIPE_PRICE_PREMIUM",
};

export type StripeMode = "test" | "live";

export function stripeBillingEnabled(): boolean {
  return process.env.STRIPE_BILLING_ENABLED?.toLowerCase() === "true";
}

export function stripeMode(): StripeMode {
  const value = process.env.STRIPE_MODE?.trim().toLowerCase() || "test";
  if (value !== "test" && value !== "live") {
    throw new Error("STRIPE_MODE must be test or live");
  }
  return value;
}

export function stripeLiveModeEnabled(): boolean {
  return process.env.STRIPE_LIVE_MODE_ENABLED?.toLowerCase() === "true";
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

export function assertSafeStripeSecret(
  secretKey: string,
  mode: StripeMode = stripeMode(),
  liveModeEnabled = stripeLiveModeEnabled(),
): void {
  if (mode === "test" && !secretKey.startsWith("sk_test_")) {
    throw new Error(
      "STRIPE_MODE=test requires a Stripe test-mode secret key",
    );
  }
  if (mode === "live") {
    if (!liveModeEnabled) {
      throw new Error(
        "Stripe live mode requires STRIPE_LIVE_MODE_ENABLED=true",
      );
    }
    if (!secretKey.startsWith("sk_live_") && !secretKey.startsWith("rk_live_")) {
      throw new Error(
        "STRIPE_MODE=live requires a Stripe live-mode secret or restricted key",
      );
    }
  }
}

export function assertStripeObjectMode(
  livemode: boolean,
  mode: StripeMode = stripeMode(),
): void {
  if (livemode !== (mode === "live")) {
    throw new Error(`Stripe object mode does not match STRIPE_MODE=${mode}`);
  }
}
