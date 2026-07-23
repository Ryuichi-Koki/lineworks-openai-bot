import type Stripe from "stripe";
import type { PlanCode } from "../membership/plans.ts";
import {
  findLineUserForStripeIdentity,
  linkStripeBillingIdentity,
  markStripePaymentFailed,
  syncStripeMembership,
  upsertStripeBillingObject,
} from "../membership/store.ts";
import { stripeClient } from "./client.ts";
import { stripePriceForPlan } from "./config.ts";
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

export async function projectStripeSubscription(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId = stripeId(subscription.customer);
  if (!customerId) throw new Error("Stripe subscription has no customer");
  const item = subscription.items.data[0];
  if (!item) throw new Error("Stripe subscription has no subscription item");
  await syncStripeMembership({
    lineUserId: await lineUserForSubscription(subscription),
    customerId,
    subscriptionId: subscription.id,
    planCode: planFromSubscription(subscription),
    status: stripeSubscriptionStatus(subscription),
    periodStart: isoDateFromUnix(item.current_period_start),
    periodEnd: inclusiveEndDateFromUnix(item.current_period_end),
  });
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
      await handleCheckoutSession(event.data.object as Stripe.Checkout.Session);
      return "checkout_session_projected";
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
