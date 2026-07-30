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

/**
 * 都度払いのカードを次回以降のために保存するか。
 * 保存する個人データが増えるため、利用規約・プライバシーポリシーへの
 * 記載と決済時の同意表示が整うまでOFFのままにできるようフラグにする。
 */
export function savedPaymentMethodEnabled(): boolean {
  return process.env.STRIPE_SAVE_PAYMENT_METHOD_ENABLED?.toLowerCase() === "true";
}

/** 領収書（適格請求書）をStripeのInvoiceとして発行するか。 */
export function invoiceIssuanceEnabled(): boolean {
  return process.env.STRIPE_INVOICE_ISSUANCE_ENABLED?.toLowerCase() === "true";
}

/**
 * 適格請求書に記載する発行者の登録番号（T+13桁）。
 * 記載要件を満たすかの最終判断は当法人が行うため、値は環境変数で管理する。
 */
export function invoiceRegistrationNumber(): string | null {
  const value = process.env.STRIPE_INVOICE_REGISTRATION_NUMBER?.trim();
  if (!value) return null;
  if (!/^T\d{13}$/.test(value)) {
    throw new Error(
      "STRIPE_INVOICE_REGISTRATION_NUMBER must be a qualified invoice number in the form T + 13 digits",
    );
  }
  return value;
}

export function stripePortalConfigurationId(): string | undefined {
  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  if (configuration && !configuration.startsWith("bpc_")) {
    throw new Error(
      "STRIPE_PORTAL_CONFIGURATION_ID must contain a Portal configuration ID",
    );
  }
  return configuration || undefined;
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
