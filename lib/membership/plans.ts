export const PLAN_CONFIG = {
  free: {
    code: "free",
    name: "無料会員",
    monthlyPrice: 0,
    aiLimit: 10,
    taxReviewLimit: 0,
    active: true,
  },
  anshin: {
    code: "anshin",
    name: "あんしん会員",
    monthlyPrice: 3300,
    aiLimit: 100,
    taxReviewLimit: 1,
    active: true,
  },
  premium_future: {
    code: "premium_future",
    name: "上位プラン",
    monthlyPrice: 7700,
    aiLimit: 200,
    taxReviewLimit: 3,
    active: false,
  },
} as const;

export type PlanCode = keyof typeof PLAN_CONFIG;

export function planForMembershipId(membershipId: string): PlanCode | null {
  const configured = new Map<string, PlanCode>();
  const anshinId = process.env.LINE_MEMBERSHIP_ANSHIN_ID?.trim();
  const premiumId = process.env.LINE_MEMBERSHIP_PREMIUM_ID?.trim();
  if (anshinId) configured.set(anshinId, "anshin");
  if (premiumId) configured.set(premiumId, "premium_future");
  return configured.get(membershipId) ?? null;
}
