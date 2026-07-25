import { PLAN_CONFIG } from "./plans.ts";
import { formatJapaneseDate, nextAvailableDate } from "./periods.ts";
import type {
  MembershipStatus,
  UsageReservation,
  UsageSummary,
} from "./types.ts";

export function buildPaidPeriodLine(
  membershipStatus: MembershipStatus,
  date: string,
): string {
  const label =
    membershipStatus === "cancel_at_period_end"
      ? "有料機能の利用期限"
      : "次回更新日";
  return `${label}：${date}`;
}

export function buildLimitMessage(reservation: UsageReservation): string {
  const next = formatJapaneseDate(nextAvailableDate(reservation.periodEnd));
  const periodDate =
    reservation.membershipStatus === "cancel_at_period_end"
      ? formatJapaneseDate(reservation.periodEnd)
      : next;
  if (reservation.planCode === "free") {
    return [
      "今月の無料AI回答回数を使い切りました。",
      "",
      `次回利用可能日：${next}`,
      "",
      `あんしん会員では、AI回答を1契約期間につき${PLAN_CONFIG.anshin.aiLimit}回まで利用でき、${PLAN_CONFIG.anshin.taxReviewLimit}件まで税理士への確認を依頼できます。`,
      "",
      "［あんしん会員に登録する］",
    ].join("\n");
  }
  return [
    "今期のAI回答上限に達しました。",
    "",
    buildPaidPeriodLine(reservation.membershipStatus, periodDate),
    "",
    "税理士確認枠が残っている場合は、税理士への確認依頼をご利用いただけます。",
  ].join("\n");
}

export function appendUsageSummary(answer: string, summary: UsageSummary): string {
  const divider = "\n\n────────────\n";
  if (summary.planCode === "free") {
    return `${answer}${divider}今月のAI回答残り回数：${summary.aiRemaining}回`;
  }
  const periodDate =
    summary.membershipStatus === "cancel_at_period_end"
      ? formatJapaneseDate(summary.periodEnd)
      : formatJapaneseDate(nextAvailableDate(summary.periodEnd));
  return [
    answer,
    `${divider}今期のAI回答残り回数：${summary.aiRemaining}回`,
    `税理士確認残り件数：${summary.taxReviewRemaining}件`,
    buildPaidPeriodLine(summary.membershipStatus, periodDate),
  ].join("\n");
}
