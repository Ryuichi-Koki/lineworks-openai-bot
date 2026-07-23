import { paidPeriodFromNextBillingDate } from "./periods.ts";
import { planForMembershipId } from "./plans.ts";
import type { MembershipSync } from "./types.ts";
import { lineApiBaseUrl } from "../line/config.ts";

type LineSubscriptionResponse = {
  subscriptions?: Array<{
    membership?: { membershipId?: number; title?: string; price?: number; currency?: string };
    user?: { joinedTime?: number; nextBillingDate?: string; totalSubscriptionMonths?: number };
  }>;
};

function channelToken(): string {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
  return token;
}

export async function fetchLineDisplayName(lineUserId: string): Promise<string | null> {
  const response = await fetch(
    `${lineApiBaseUrl()}/profile/${encodeURIComponent(lineUserId)}`,
    { headers: { Authorization: `Bearer ${channelToken()}` } },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { displayName?: unknown };
  return typeof body.displayName === "string" ? body.displayName.slice(0, 200) : null;
}

export async function fetchLineMembership(
  lineUserId: string,
): Promise<MembershipSync | null> {
  const response = await fetch(
    `${lineApiBaseUrl()}/membership/subscription/${encodeURIComponent(lineUserId)}`,
    { headers: { Authorization: `Bearer ${channelToken()}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`LINE membership API failed: ${response.status}`);
  }
  const body = (await response.json()) as LineSubscriptionResponse;
  const subscription = body.subscriptions?.[0];
  const membershipId = subscription?.membership?.membershipId;
  const nextBillingDate = subscription?.user?.nextBillingDate;
  if (typeof membershipId !== "number" || !nextBillingDate) return null;
  const planCode = planForMembershipId(String(membershipId));
  if (!planCode) {
    throw new Error(`Unmapped LINE membership ID: ${membershipId}`);
  }
  const period = paidPeriodFromNextBillingDate(nextBillingDate);
  return {
    lineUserId,
    planCode,
    membershipPlanId: String(membershipId),
    status: "active",
    periodStart: period.start,
    periodEnd: period.end,
  };
}
