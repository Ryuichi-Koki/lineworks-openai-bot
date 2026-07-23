import type Stripe from "stripe";
import type { MembershipStatus } from "../membership/types.ts";

export function stripeSubscriptionStatus(
  subscription: Pick<Stripe.Subscription, "status" | "cancel_at_period_end"> &
    Partial<Pick<Stripe.Subscription, "cancel_at">>,
): MembershipStatus {
  if (subscription.status === "active" || subscription.status === "trialing") {
    return subscription.cancel_at_period_end || Boolean(subscription.cancel_at)
      ? "cancel_at_period_end"
      : "active";
  }
  if (
    subscription.status === "past_due" ||
    subscription.status === "unpaid"
  ) {
    return "past_due";
  }
  if (subscription.status === "canceled") return "canceled";
  return "suspended";
}

function tokyoDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export function isoDateFromUnix(timestamp: number): string {
  return tokyoDate(timestamp);
}

export function inclusiveEndDateFromUnix(timestamp: number): string {
  return tokyoDate(timestamp - 1);
}

export function stripeId(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
