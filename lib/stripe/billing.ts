import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { legalDocumentUrl } from "../legal/config.ts";
import type { PlanCode } from "../membership/plans.ts";
import {
  attachTaxReviewCheckout,
  cancelTaxReviewPayment,
  createOrGetTaxReviewPayment,
  findCancelableTaxReviewCheckout,
  findStripeBillingIdentityForLineUser,
  findStripeCustomerForLineUser,
} from "../membership/store.ts";
import { stripeClient } from "./client.ts";
import {
  assertStripeObjectMode,
  stripeAppBaseUrl,
  stripePriceForPlan,
} from "./config.ts";
import {
  taxReviewPriceAt,
  taxReviewPriceId,
} from "./consultationPricing.ts";

function safeMetadata(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.slice(0, 500)]),
  );
}

export function buildSubscriptionCheckoutParams(input: {
  lineUserId: string;
  planCode: Exclude<PlanCode, "free">;
  priceId: string;
  baseUrl: string;
  customerId?: string | null;
}): Stripe.Checkout.SessionCreateParams {
  if (!input.priceId.startsWith("price_")) {
    throw new Error("A Stripe Price ID is required");
  }
  const metadata = safeMetadata({
    line_user_id: input.lineUserId,
    plan_code: input.planCode,
  });
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    locale: "ja",
    client_reference_id: input.lineUserId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    metadata,
    subscription_data: { metadata },
    success_url: `${input.baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.baseUrl}/billing/cancel`,
  };
  if (input.customerId) {
    params.customer = input.customerId;
    params.customer_update = { address: "auto", name: "auto" };
  }
  return params;
}

/**
 * 同一利用者・同一内容・同一日のCheckout要求を1つのStripeセッションに収束させる。
 *
 * 冪等キーをリクエスト内容そのものから導出することで、
 * 1. ボタン連打では新しいセッションが作られず、同じ決済ページが返る
 * 2. 内容が変われば（顧客紐付けが済んだ等）キーも変わるため、
 *    「同じキーで異なるパラメータ」によるStripeエラーが構造的に起きない
 */
export function checkoutIdempotencyKey(
  params: Stripe.Checkout.SessionCreateParams,
  dayBucket: string,
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ params, dayBucket }))
    .digest("hex")
    .slice(0, 40);
  return `checkout:${fingerprint}`;
}

export function checkoutDayBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function createSubscriptionCheckoutSession(input: {
  lineUserId: string;
  planCode: Exclude<PlanCode, "free">;
}): Promise<{ url: string; reused: boolean }> {
  const stripe = stripeClient();
  const baseUrl = stripeAppBaseUrl();
  const customer = await findStripeCustomerForLineUser(input.lineUserId);
  const params = buildSubscriptionCheckoutParams({
    lineUserId: input.lineUserId,
    planCode: input.planCode,
    priceId: stripePriceForPlan(input.planCode),
    baseUrl,
    customerId: customer,
  });
  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: checkoutIdempotencyKey(params, checkoutDayBucket()),
  });
  assertStripeObjectMode(session.livemode);
  if (!session.url) throw new Error("Stripe Checkout Session returned no URL");
  // 冪等キーによる再生成では、既存セッションの作成時刻がそのまま返る。
  return {
    url: session.url,
    reused: Date.now() / 1000 - session.created > 10,
  };
}

export async function createOneTimeCheckoutSession(input: {
  lineUserId: string;
  priceId: string;
  referenceId: string;
  idempotencyKey: string;
}): Promise<string> {
  if (!input.priceId.startsWith("price_")) {
    throw new Error("A Stripe Price ID is required");
  }
  const customer = await findStripeCustomerForLineUser(input.lineUserId);
  const metadata = safeMetadata({
    line_user_id: input.lineUserId,
    reference_id: input.referenceId,
  });
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    locale: "ja",
    client_reference_id: input.lineUserId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    customer_creation: customer ? undefined : "always",
    customer: customer ?? undefined,
    customer_update: customer ? { address: "auto", name: "auto" } : undefined,
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    metadata,
    payment_intent_data: { metadata },
    success_url: `${stripeAppBaseUrl()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${stripeAppBaseUrl()}/billing/cancel`,
  };
  const session = await stripeClient().checkout.sessions.create(params, {
    idempotencyKey: `payment-checkout:${input.idempotencyKey}`,
  });
  assertStripeObjectMode(session.livemode);
  if (!session.url) throw new Error("Stripe Checkout Session returned no URL");
  return session.url;
}

export async function createTaxReviewCheckoutSession(input: {
  lineUserId: string;
  reviewRequestId: string;
  now?: Date;
}): Promise<{ url: string; amount: number; reused: boolean }> {
  const now = input.now ?? new Date();
  const selectedPrice = taxReviewPriceAt(now);
  const payment = await createOrGetTaxReviewPayment({
    lineUserId: input.lineUserId,
    reviewRequestId: input.reviewRequestId,
    priceCode: selectedPrice.code,
    amount: selectedPrice.amount,
  });
  if (
    payment.status === "pending" &&
    payment.checkoutUrl &&
    payment.checkoutExpiresAt &&
    Date.parse(payment.checkoutExpiresAt) > now.getTime() + 60_000
  ) {
    return { url: payment.checkoutUrl, amount: payment.amount, reused: true };
  }
  if (payment.status === "paid" || payment.status === "consumed") {
    throw new Error("This tax review has already been paid");
  }

  const stripe = stripeClient();
  const priceId = taxReviewPriceId(selectedPrice);
  const price = await stripe.prices.retrieve(priceId);
  assertStripeObjectMode(price.livemode);
  if (
    price.type !== "one_time" ||
    price.currency !== selectedPrice.currency ||
    price.unit_amount !== selectedPrice.amount ||
    price.tax_behavior !== "inclusive"
  ) {
    throw new Error(
      `${selectedPrice.priceIdEnv} must be a one-time JPY ${selectedPrice.amount} tax-inclusive Price`,
    );
  }

  const customer = await findStripeCustomerForLineUser(input.lineUserId);
  const metadata = safeMetadata({
    purchase_type: "tax_review",
    line_user_id: input.lineUserId,
    reference_id: payment.id,
    review_request_id: input.reviewRequestId,
    price_code: selectedPrice.code,
  });
  // Stripeは作成時点から最低30分後を要求する。API往復中に下回らないよう31分にする。
  const expiresAt = Math.floor(now.getTime() / 1000) + 31 * 60;
  const termsUrl = legalDocumentUrl("terms");
  const tokushoUrl = legalDocumentUrl("tokusho");
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    submit_type: "pay",
    locale: "ja",
    client_reference_id: input.lineUserId,
    line_items: [{ price: priceId, quantity: 1 }],
    customer_creation: customer ? undefined : "always",
    customer: customer ?? undefined,
    customer_update: customer ? { address: "auto", name: "auto" } : undefined,
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    metadata,
    payment_intent_data: { metadata },
    custom_text: {
      submit: {
        message: [
          "決済完了後に税理士相談の受付を開始します。",
          "相談1回ごとの都度払いで、自動更新はありません。",
          `利用規約: ${termsUrl}`,
          `返金条件・特定商取引法に基づく表記: ${tokushoUrl}`,
        ].join("\n"),
      },
    },
    expires_at: expiresAt,
    success_url: `${stripeAppBaseUrl()}/billing/success?purchase=tax_review&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${stripeAppBaseUrl()}/billing/cancel?purchase=tax_review`,
  };
  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: [
      "tax-review-checkout",
      payment.id,
      selectedPrice.code,
      Math.floor(now.getTime() / (30 * 60 * 1000)),
    ].join(":"),
  });
  assertStripeObjectMode(session.livemode);
  if (!session.url) throw new Error("Stripe Checkout Session returned no URL");
  await attachTaxReviewCheckout({
    paymentId: payment.id,
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    checkoutExpiresAt: new Date(expiresAt * 1000).toISOString(),
  });
  return { url: session.url, amount: selectedPrice.amount, reused: false };
}

export async function cancelTaxReviewCheckout(input: {
  lineUserId: string;
  reviewRequestId: string;
}): Promise<boolean> {
  const payment = await findCancelableTaxReviewCheckout(input);
  if (!payment) return false;
  const checkoutStillValid =
    payment.checkoutExpiresAt &&
    Date.parse(payment.checkoutExpiresAt) > Date.now();
  if (payment.checkoutSessionId && checkoutStillValid) {
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(
      payment.checkoutSessionId,
    );
    assertStripeObjectMode(session.livemode);
    if (session.payment_status === "paid") {
      throw new Error("A paid tax review Checkout Session cannot be canceled");
    }
    if (session.status === "complete") {
      throw new Error(
        "A tax review payment that is still processing cannot be canceled",
      );
    }
    if (session.status === "open") {
      const expired = await stripe.checkout.sessions.expire(session.id);
      assertStripeObjectMode(expired.livemode);
    }
  }
  return cancelTaxReviewPayment(input);
}

export async function createCustomerPortalSession(
  lineUserId: string,
  options: { cancellationFlow?: boolean } = {},
): Promise<string> {
  const identity = await findStripeBillingIdentityForLineUser(lineUserId);
  if (!identity) throw new Error("No Stripe customer is linked to this LINE user");
  if (!identity.subscriptionId) {
    throw new Error("No Stripe subscription is linked to this LINE user");
  }
  const baseUrl = stripeAppBaseUrl();
  const returnUrl = `${baseUrl}/billing/manage`;
  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  if (configuration && !configuration.startsWith("bpc_")) {
    throw new Error("STRIPE_PORTAL_CONFIGURATION_ID must contain a Portal configuration ID");
  }
  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: identity.customerId,
    configuration: configuration || undefined,
    locale: "ja",
    return_url: returnUrl,
    flow_data:
      options.cancellationFlow === false
        ? undefined
        : {
            type: "subscription_cancel",
            subscription_cancel: {
              subscription: identity.subscriptionId,
            },
            after_completion: {
              type: "redirect",
              redirect: {
                return_url: `${returnUrl}?status=cancellation_requested`,
              },
            },
          },
  };
  const session = await stripeClient().billingPortal.sessions.create(params);
  assertStripeObjectMode(session.livemode);
  return assertSafeStripePortalUrl(session.url);
}

export function assertSafeStripePortalUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !(
      url.hostname === "billing.stripe.com" ||
      url.hostname.endsWith(".stripe.com")
    )
  ) {
    throw new Error("Stripe returned an unexpected Customer Portal URL");
  }
  return url.toString();
}

export async function createProfessionalServiceInvoice(input: {
  customerId: string;
  engagementId: string;
  description: string;
  amount: number;
  currency?: string;
  taxCode: string;
  taxBehavior: "inclusive" | "exclusive";
  daysUntilDue?: number;
}): Promise<Stripe.Invoice> {
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new Error("Invoice amount must be a positive integer in the minor currency unit");
  }
  const stripe = stripeClient();
  const metadata = safeMetadata({ engagement_id: input.engagementId });
  await stripe.invoiceItems.create(
    {
      customer: input.customerId,
      amount: input.amount,
      currency: input.currency ?? "jpy",
      description: input.description.slice(0, 500),
      tax_code: input.taxCode,
      tax_behavior: input.taxBehavior,
      metadata,
    },
    { idempotencyKey: `invoice-item:${input.engagementId}` },
  );
  const invoice = await stripe.invoices.create(
    {
      customer: input.customerId,
      collection_method: "send_invoice",
      days_until_due: input.daysUntilDue ?? 30,
      automatic_tax: { enabled: true },
      auto_advance: true,
      metadata,
    },
    { idempotencyKey: `invoice:${input.engagementId}` },
  );
  assertStripeObjectMode(invoice.livemode);
  return invoice;
}
