import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { pushLineMessage } from "../line/client.ts";
import {
  buildBillingNotification,
  resolveBillingNotification,
} from "../membership/messages.ts";
import type { PlanCode } from "../membership/plans.ts";
import {
  enqueueTaxReviewDelivery,
  findLineUserForStripeIdentity,
  getUsageSummary,
  linkStripeBillingIdentity,
  markTaxReviewPaymentFailed,
  recordTaxReviewRefund,
  markTaxReviewPaymentPaid,
  markStripePaymentFailed,
  syncStripeMembership,
  upsertStripeBillingObject,
} from "../membership/store.ts";
import type { MembershipStatus } from "../membership/types.ts";
import type { TaxReviewRefundProjection } from "../membership/types.ts";
import { stripeClient } from "./client.ts";
import { stripePriceForPlan } from "./config.ts";
import { processTaxReviewDelivery } from "../tax/deliveryQueue.ts";
import {
  inclusiveEndDateFromUnix,
  isoDateFromUnix,
  stripeId,
  stripeSubscriptionStatus,
} from "./mapping.ts";

const PAID_PLANS: Array<Exclude<PlanCode, "free">> = [
  "anshin",
  "premium_future",
];

function validPlanCode(value: string | undefined): Exclude<PlanCode, "free"> | null {
  return PAID_PLANS.find((plan) => plan === value) ?? null;
}

function planFromSubscription(
  subscription: Stripe.Subscription,
): Exclude<PlanCode, "free"> {
  const metadataPlan = validPlanCode(subscription.metadata.plan_code);
  if (metadataPlan) return metadataPlan;
  const priceId = subscription.items.data[0]?.price.id;
  const matched = PAID_PLANS.find((plan) => {
    try {
      return stripePriceForPlan(plan) === priceId;
    } catch {
      return false;
    }
  });
  if (!matched) throw new Error(`Unmapped Stripe Price ID: ${priceId ?? "missing"}`);
  return matched;
}

async function lineUserForSubscription(
  subscription: Stripe.Subscription,
): Promise<string> {
  const customerId = stripeId(subscription.customer);
  const metadataUser = subscription.metadata.line_user_id?.trim();
  const lineUserId =
    metadataUser ||
    (await findLineUserForStripeIdentity({
      customerId,
      subscriptionId: subscription.id,
    }));
  if (!lineUserId) {
    throw new Error(`Stripe subscription ${subscription.id} has no LINE user mapping`);
  }
  return lineUserId;
}

/**
 * LINEのリトライキーはUUID形式である必要があるため、
 * 「利用者・通知種別・契約期間」からUUIDv4形式の決定的なキーを組み立てる。
 * これによりStripeの再配信でpushが二重に走ってもLINE側で重複排除される。
 */
function deterministicRetryKey(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * 契約状態が変化したときだけLINEへ通知する。
 * 通知の失敗は会員台帳の更新を巻き戻さない（決済反映が通知障害で壊れないようにする）。
 */
async function notifyMembershipChange(input: {
  lineUserId: string;
  previousStatus: MembershipStatus | null;
  nextStatus: MembershipStatus;
}): Promise<void> {
  const kind = resolveBillingNotification(input);
  if (!kind) return;
  try {
    const summary = await getUsageSummary(input.lineUserId);
    await pushLineMessage(
      input.lineUserId,
      buildBillingNotification(kind, summary),
      deterministicRetryKey(
        `billing:${input.lineUserId}:${kind}:${summary.periodStart}:${summary.periodEnd}`,
      ),
      { includePersistentMenuButton: true },
    );
  } catch (error) {
    console.error("Failed to notify LINE of a membership change", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      notificationKind: kind,
    });
  }
}

export async function projectStripeSubscription(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId = stripeId(subscription.customer);
  if (!customerId) throw new Error("Stripe subscription has no customer");
  const item = subscription.items.data[0];
  if (!item) throw new Error("Stripe subscription has no subscription item");
  const lineUserId = await lineUserForSubscription(subscription);
  const nextStatus = stripeSubscriptionStatus(subscription);
  const previousStatus = await syncStripeMembership({
    lineUserId,
    customerId,
    subscriptionId: subscription.id,
    planCode: planFromSubscription(subscription),
    status: nextStatus,
    periodStart: isoDateFromUnix(item.current_period_start),
    periodEnd: inclusiveEndDateFromUnix(item.current_period_end),
  });
  await notifyMembershipChange({ lineUserId, previousStatus, nextStatus });
}

async function handleCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
  const customerId = stripeId(session.customer);
  const subscriptionId = stripeId(session.subscription);
  const lineUserId =
    session.client_reference_id?.trim() ||
    session.metadata?.line_user_id?.trim() ||
    null;
  if (lineUserId && customerId) {
    await linkStripeBillingIdentity({ lineUserId, customerId, subscriptionId });
  }
  await upsertStripeBillingObject({
    objectId: session.id,
    objectType: "checkout_session",
    lineUserId,
    customerId,
    subscriptionId,
    status: session.status ?? "unknown",
    amount: session.amount_total,
    currency: session.currency,
    metadata: session.metadata ?? {},
    occurredAt: new Date(session.created * 1000).toISOString(),
  });

  if (
    session.metadata?.purchase_type === "tax_review" &&
    session.payment_status === "paid"
  ) {
    const paymentId = session.metadata.reference_id?.trim();
    const metadataLineUserId = session.metadata.line_user_id?.trim();
    const metadataReviewRequestId = session.metadata.review_request_id?.trim();
    if (
      !paymentId ||
      !metadataLineUserId ||
      !metadataReviewRequestId ||
      session.amount_total === null ||
      !session.currency
    ) {
      throw new Error("Paid tax review Checkout Session is missing payment metadata");
    }
    const payment = await markTaxReviewPaymentPaid({
      paymentId,
      lineUserId: metadataLineUserId,
      reviewRequestId: metadataReviewRequestId,
      checkoutSessionId: session.id,
      paymentIntentId: stripeId(session.payment_intent),
      amount: session.amount_total,
      currency: session.currency,
    });
    const jobId = await enqueueTaxReviewDelivery({
      eventId: `stripe:${session.id}:tax_review`,
      lineUserId: payment.lineUserId,
      reviewRequestId: payment.reviewRequestId,
      paymentId: payment.id,
    });
    // The delivery is durably queued before contacting LINE WORKS or LINE.
    // Make one best-effort attempt for a quick receipt; cron retries any
    // remaining work without asking Stripe to resend the payment event.
    await processTaxReviewDelivery(jobId);
  }
}

export function buildTaxReviewRefundNotification(
  projection: TaxReviewRefundProjection,
): string {
  const amount = projection.amount.toLocaleString("ja-JP");
  if (projection.refundStatus === "succeeded") {
    return projection.paymentStatus === "refunded"
      ? `税理士相談のお支払いについて、${amount}円の返金が完了しました。`
      : `税理士相談のお支払いについて、${amount}円の一部返金が完了しました。`;
  }
  if (projection.refundStatus === "failed") {
    return [
      "税理士相談のお支払いの返金処理を完了できませんでした。",
      "当法人で状況を確認し、必要に応じて個別にご案内します。",
    ].join("\n");
  }
  return `税理士相談のお支払いについて、${amount}円の返金処理を受け付けました。`;
}

async function notifyTaxReviewPaymentFailure(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const payment = await markTaxReviewPaymentFailed(session.id);
  if (!payment) return;
  await pushLineMessage(
    payment.lineUserId,
    [
      "税理士相談のお支払いを完了できませんでした。",
      "ご請求は確定していません。",
      "相談する場合は、リッチメニューの［税理士に相談］からもう一度お進みください。",
    ].join("\n"),
    deterministicRetryKey(`tax-review-payment-failed:${session.id}`),
    { includePersistentMenuButton: true },
  );
}

async function handleRefund(refund: Stripe.Refund): Promise<void> {
  const paymentIntentId = stripeId(refund.payment_intent);
  if (!paymentIntentId) return;
  const projection = await recordTaxReviewRefund({
    refundId: refund.id,
    paymentIntentId,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status ?? "unknown",
    reason: refund.reason,
    failureReason: refund.failure_reason,
  });
  if (!projection) return;
  await upsertStripeBillingObject({
    objectId: refund.id,
    objectType: "refund",
    lineUserId: projection.lineUserId,
    status: refund.status ?? "unknown",
    amount: refund.amount,
    currency: refund.currency,
    metadata: refund.metadata ?? {},
    occurredAt: new Date(refund.created * 1000).toISOString(),
  });
  await pushLineMessage(
    projection.lineUserId,
    buildTaxReviewRefundNotification(projection),
    deterministicRetryKey(
      `tax-review-refund:${projection.refundId}:${projection.refundStatus}`,
    ),
    { includePersistentMenuButton: true },
  );
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return stripeId(invoice.parent?.subscription_details?.subscription);
}

async function handleInvoice(invoice: Stripe.Invoice, eventType: string): Promise<void> {
  const customerId = stripeId(invoice.customer);
  const subscriptionId = invoiceSubscriptionId(invoice);
  const lineUserId = await findLineUserForStripeIdentity({
    customerId,
    subscriptionId,
  });
  await upsertStripeBillingObject({
    objectId: invoice.id,
    objectType: "invoice",
    lineUserId,
    customerId,
    subscriptionId,
    status: invoice.status ?? eventType,
    amount: invoice.amount_paid || invoice.amount_due,
    currency: invoice.currency,
    hostedUrl: invoice.hosted_invoice_url,
    metadata: invoice.metadata ?? {},
    occurredAt: new Date(invoice.created * 1000).toISOString(),
  });
  if (eventType === "invoice.payment_failed") {
    await markStripePaymentFailed({ customerId, subscriptionId });
    return;
  }
  if (eventType === "invoice.paid" && subscriptionId) {
    const subscription = await stripeClient().subscriptions.retrieve(subscriptionId);
    await projectStripeSubscription(subscription);
  }
}

export async function processStripeEvent(event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await handleCheckoutSession(event.data.object as Stripe.Checkout.Session);
      return "checkout_session_projected";
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      await notifyTaxReviewPaymentFailure(
        event.data.object as Stripe.Checkout.Session,
      );
      return "tax_review_payment_failed";
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      await handleRefund(event.data.object as Stripe.Refund);
      return "refund_projected";
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await projectStripeSubscription(event.data.object as Stripe.Subscription);
      return "subscription_projected";
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.voided":
      await handleInvoice(event.data.object as Stripe.Invoice, event.type);
      return "invoice_projected";
    default:
      return "ignored";
  }
}
