export function noActiveSubscriptionManagementMessage(
  oneTimeConsultationEnabled: boolean,
): string {
  if (oneTimeConsultationEnabled) {
    return oneTimeBillingManagementMessage(false);
  }
  return [
    "現在、有料契約はありません。無料会員としてご利用中です。",
    "あんしん会員のお申し込みは「料金プラン」からご確認いただけます。",
  ].join("\n");
}

export function oneTimeBillingManagementMessage(
  hasLegacySubscriptionRecord: boolean,
): string {
  return [
    "現在のスグ税に、月額・自動更新の有料契約はありません。",
    "AI回答は無料（月100件まで）、税理士への個別相談は1回ごとの都度払いです。",
    ...(hasLegacySubscriptionRecord
      ? [
          "",
          "旧月額契約の記録が残っていますが、このボタンから新たな請求や契約変更は行われません。",
          "旧契約の確認・利用終了・個人データの削除をご希望の場合は、次の案内をご確認ください。",
        ]
      : [
          "",
          "利用終了・個人データの削除をご希望の場合は、次の案内をご確認ください。",
        ]),
    "https://bot.abtax.jp/cancellation",
  ].join("\n");
}

export const BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE = [
  "申し訳ありません。現在、Stripeの契約管理画面を開けませんでした。",
  "この操作による請求や契約変更は発生していません。",
  "",
  "旧あんしん会員の契約確認・解約をご希望の場合は、復旧まで次のページをご確認ください。",
  "https://bot.abtax.jp/cancellation",
].join("\n");
