import type { PlanCode } from "./plans.ts";

export type MembershipStatus =
  | "free"
  | "active"
  | "past_due"
  | "cancel_at_period_end"
  | "canceled"
  | "suspended";

export type UsageType = "ai_answer" | "tax_review";
export type UsageStatus = "reserved" | "consumed" | "canceled";

export type UsageReservation = {
  allowed: boolean;
  usageEventId: string | null;
  planCode: PlanCode;
  membershipStatus: MembershipStatus;
  usageLimit: number;
  usedCount: number;
  remainingCount: number;
  periodStart: string;
  periodEnd: string;
};

export type UsageSummary = {
  lineUserId: string;
  displayName: string | null;
  planCode: PlanCode;
  membershipStatus: MembershipStatus;
  membershipProvider: string;
  membershipPlanId: string | null;
  periodStart: string;
  periodEnd: string;
  aiUsed: number;
  aiRemaining: number;
  taxReviewUsed: number;
  taxReviewRemaining: number;
  lastUsedAt: string | null;
  paymentFailed: boolean;
};

export type MembershipSync = {
  lineUserId: string;
  planCode: PlanCode;
  membershipPlanId: string;
  status: MembershipStatus;
  periodStart: string;
  periodEnd: string;
};

export type TaxReviewPaymentStatus =
  | "pending"
  | "paid"
  | "consumed"
  | "failed"
  | "refunded";

export type TaxReviewPayment = {
  id: string;
  reviewRequestId: string;
  lineUserId: string;
  questionSummary: string;
  priceCode: "promo_2026" | "standard";
  amount: number;
  currency: "jpy";
  status: TaxReviewPaymentStatus;
  checkoutSessionId: string | null;
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
};
