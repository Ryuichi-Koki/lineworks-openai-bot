export function noActiveSubscriptionManagementMessage(
  oneTimeConsultationEnabled: boolean,
): string {
  if (oneTimeConsultationEnabled) {
    return [
      "現在、月額・自動更新の有料契約はありません。",
      "AI回答は無料（月100件まで）、税理士への個別相談は1回ごとの都度払いです。",
      "",
      "無料会員の利用終了、個人データの削除・利用停止をご希望の場合は、次のページをご確認ください。",
      "https://bot.abtax.jp/cancellation",
    ].join("\n");
  }
  return [
    "現在、有料契約はありません。無料会員としてご利用中です。",
    "あんしん会員のお申し込みは「料金プラン」からご確認いただけます。",
  ].join("\n");
}

export const BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE = [
  "申し訳ありません。現在、Stripeの契約管理画面を開けませんでした。",
  "この操作による請求や契約変更は発生していません。",
  "",
  "旧あんしん会員の契約確認・解約をご希望の場合は、復旧まで次のページをご確認ください。",
  "https://bot.abtax.jp/cancellation",
].join("\n");
