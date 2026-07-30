import { PLAN_CONFIG, type PlanCode } from "./plans.ts";
import { formatJapaneseDate, nextAvailableDate } from "./periods.ts";
import type {
  MembershipStatus,
  UsageReservation,
  UsageSummary,
} from "./types.ts";
import { oneTimeConsultationBillingEnabled } from "../stripe/consultationPricing.ts";

const PAID_STATUSES: MembershipStatus[] = [
  "active",
  "past_due",
  "cancel_at_period_end",
  "suspended",
];

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
      ...(oneTimeConsultationBillingEnabled()
        ? [
            "",
            "税理士へのLINE個別相談は、AI回答の残数にかかわらず1回ごとにお申し込みいただけます。",
          ]
        : [
            "",
            `あんしん会員では、AI回答を1契約期間につき${PLAN_CONFIG.anshin.aiLimit}回まで利用でき、${PLAN_CONFIG.anshin.taxReviewLimit}件まで税理士への確認を依頼できます。`,
            "",
            "下のボタンから、あんしん会員のご案内をご確認いただけます。",
          ]),
    ].join("\n");
  }
  return [
    "今期のAI回答上限に達しました。",
    "",
    buildPaidPeriodLine(reservation.membershipStatus, periodDate),
    "",
    "税理士相談の枠が残っている場合は、税理士への個別相談をご利用いただけます。",
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
    `税理士相談残り件数：${summary.taxReviewRemaining}件`,
    buildPaidPeriodLine(summary.membershipStatus, periodDate),
  ].join("\n");
}

const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  free: "無料会員",
  active: "ご利用中",
  past_due: "お支払いの確認ができていません",
  cancel_at_period_end: "退会予約済み",
  canceled: "契約終了",
  suspended: "一時停止中",
};

/**
 * 会員状態の照会。AI回答の回数を消費せずに現状を確認できるようにする。
 * 従来は残回数がAI回答の末尾にしか出ず、確認するために回数を使う必要があった。
 */
export function buildStatusMessage(summary: UsageSummary): string {
  const plan = PLAN_CONFIG[summary.planCode];
  const lines = ["【現在のご契約・利用状況】", ""];

  lines.push(`■ プラン：${planHeadline(summary.planCode)}`);

  if (summary.planCode === "free") {
    lines.push(
      `■ 今月のご利用期間：${formatJapaneseDate(summary.periodStart)}〜${formatJapaneseDate(summary.periodEnd)}`,
    );
  } else {
    lines.push(`■ ご契約状況：${MEMBERSHIP_STATUS_LABELS[summary.membershipStatus]}`);
    lines.push(`■ ${renewalLine(summary)}`);
    if (summary.membershipStatus === "cancel_at_period_end") {
      lines.push(
        `■ ${formatJapaneseDate(nextAvailableDate(summary.periodEnd))}以降は自動的に無料会員へ切り替わります`,
      );
    }
  }

  lines.push("", summary.planCode === "free" ? "【今月の残り】" : "【今期の残り】");
  lines.push(`・AI回答：${summary.aiRemaining}回 / ${plan.aiLimit}回`);
  lines.push(
    plan.taxReviewLimit > 0
      ? `・旧月額契約の税理士相談特典：${summary.taxReviewRemaining}件 / ${plan.taxReviewLimit}件（利用時の追加決済なし）`
      : oneTimeConsultationBillingEnabled()
        ? "・税理士相談：1回ごとのお支払いで利用できます"
        : "・税理士相談：あんしん会員でご利用いただけます",
  );

  if (summary.planCode !== "free") {
    lines.push(
      "",
      `残りの回数と件数は、${renewalLine(summary).replace(/^[^：]+：/, "")}にリセットされます。`,
    );
  }

  if (summary.paymentFailed) {
    lines.push(
      "",
      "⚠ 旧月額契約のお支払いを確認できません。［利用状況・退会］から支払方法をご確認ください。",
    );
  }

  lines.push("", "※このメッセージではAI回答の回数を消費していません。");
  return lines.join("\n");
}

export type BillingNotificationKind =
  | "activated"
  | "cancellation_scheduled"
  | "cancellation_reverted"
  | "payment_failed"
  | "payment_recovered"
  | "downgraded";

/**
 * Stripeの契約状態が「変化したとき」だけ通知種別を返す。
 * 同じ状態を繰り返し受信しても null を返すため、Webhookの再配信や
 * invoice.paid と customer.subscription.updated の重複でも二重送信しない。
 */
export function resolveBillingNotification(input: {
  previousStatus: MembershipStatus | null;
  nextStatus: MembershipStatus;
}): BillingNotificationKind | null {
  const { previousStatus, nextStatus } = input;
  if (previousStatus === nextStatus) return null;
  const wasPaid = previousStatus !== null && PAID_STATUSES.includes(previousStatus);
  switch (nextStatus) {
    case "active":
      if (previousStatus === "cancel_at_period_end") return "cancellation_reverted";
      if (previousStatus === "past_due" || previousStatus === "suspended") {
        return "payment_recovered";
      }
      return "activated";
    case "cancel_at_period_end":
      return wasPaid ? "cancellation_scheduled" : null;
    case "past_due":
      return wasPaid ? "payment_failed" : null;
    case "canceled":
      return wasPaid ? "downgraded" : null;
    default:
      return null;
  }
}

function planHeadline(planCode: PlanCode): string {
  const plan = PLAN_CONFIG[planCode];
  if (plan.monthlyPrice === 0) return plan.name;
  return `${plan.name}（旧月額契約・月額${plan.monthlyPrice.toLocaleString("ja-JP")}円 税込）`;
}

function renewalLine(summary: UsageSummary): string {
  const date =
    summary.membershipStatus === "cancel_at_period_end"
      ? formatJapaneseDate(summary.periodEnd)
      : formatJapaneseDate(nextAvailableDate(summary.periodEnd));
  return buildPaidPeriodLine(summary.membershipStatus, date);
}

function remainingBlock(summary: UsageSummary): string {
  return [
    "【現在の残数】",
    `・AI回答：${summary.aiRemaining}回`,
    `・旧月額契約の税理士相談特典：${summary.taxReviewRemaining}件`,
  ].join("\n");
}

export function buildBillingNotification(
  kind: BillingNotificationKind,
  summary: UsageSummary,
): string {
  switch (kind) {
    case "activated":
      return [
        `${PLAN_CONFIG.anshin.name}のご登録が完了しました。`,
        "ありがとうございます。",
        "",
        `■ プラン：${planHeadline(summary.planCode)}`,
        `■ ご利用開始：${formatJapaneseDate(summary.periodStart)}`,
        `■ ${renewalLine(summary)}`,
        "",
        remainingBlock(summary),
        "",
        "さっそくご質問をどうぞ。このトークにそのままお送りください。",
      ].join("\n");
    case "cancellation_scheduled":
      return [
        "退会（次回更新の停止）を承りました。",
        "",
        `■ 有料機能の利用期限：${formatJapaneseDate(summary.periodEnd)}`,
        "■ この日までは、AI回答と税理士相談をこれまでどおりご利用いただけます",
        `■ ${formatJapaneseDate(nextAvailableDate(summary.periodEnd))}以降は自動的に無料会員へ切り替わります`,
        "■ 追加のご請求は発生しません",
        "",
        remainingBlock(summary),
        "",
        "退会予約はいつでも取り消せます。「退会したい」と送信すると契約管理画面を開けます。",
      ].join("\n");
    case "cancellation_reverted":
      return [
        "退会予約を取り消しました。",
        `${PLAN_CONFIG.anshin.name}の契約は継続します。`,
        "",
        `■ プラン：${planHeadline(summary.planCode)}`,
        `■ ${renewalLine(summary)}`,
        "",
        remainingBlock(summary),
      ].join("\n");
    case "payment_failed":
      return [
        "お支払いの確認ができませんでした。",
        "",
        "カードの有効期限切れや限度額超過などが考えられます。",
        "お手数ですが、契約管理画面から支払方法をご確認ください。",
        "「退会したい」と送信すると契約管理画面を開けます。",
        "",
        "お支払いが確認できるまで、有料機能のご利用を一時的に制限する場合があります。",
      ].join("\n");
    case "payment_recovered":
      return [
        "お支払いを確認しました。",
        `${PLAN_CONFIG.anshin.name}の機能をこれまでどおりご利用いただけます。`,
        "",
        `■ ${renewalLine(summary)}`,
        "",
        remainingBlock(summary),
      ].join("\n");
    case "downgraded":
      return [
        `${PLAN_CONFIG.anshin.name}の契約が終了しました。`,
        "ご利用ありがとうございました。",
        "",
        "本日から無料会員としてご利用いただけます。",
        `・AI回答：毎月${PLAN_CONFIG.free.aiLimit}回まで`,
        oneTimeConsultationBillingEnabled()
          ? "・税理士へのLINE個別相談：1回ごとのお支払い"
          : "・税理士への個別相談：ご利用いただけません",
        "",
        "再度のご登録はいつでも可能です。",
      ].join("\n");
  }
}
