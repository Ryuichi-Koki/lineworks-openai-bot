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

export type BillingDocumentLine = {
  amount: number | null;
  currency: string | null;
  hostedUrl: string;
  occurredAt: string | null;
};

function formatDocumentDate(value: string | null): string {
  if (!value) return "日付不明";
  const jst = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;
}

function formatDocumentAmount(document: BillingDocumentLine): string {
  if (document.amount === null) return "";
  const currency = (document.currency ?? "jpy").toLowerCase();
  if (currency !== "jpy") return ` ${document.amount} ${currency.toUpperCase()}`;
  return ` ${document.amount.toLocaleString("ja-JP")}円`;
}

/**
 * 「お支払い」メニューの本文。
 * 領収書は決済ごとに1件ずつリンクで返す。
 */
export function billingDocumentsMessage(
  documents: BillingDocumentLine[],
  options: { savedCardEnabled: boolean; invoiceIssuanceEnabled: boolean },
): string {
  const lines = ["【お支払い】", ""];

  if (documents.length === 0) {
    lines.push(
      options.invoiceIssuanceEnabled
        ? "まだお支払いの記録がありません。税理士相談をご利用いただくと、この画面から領収書を確認できます。"
        : "まだお支払いの記録がありません。",
    );
  } else {
    lines.push("■ 領収書");
    for (const document of documents) {
      lines.push(
        `・${formatDocumentDate(document.occurredAt)}${formatDocumentAmount(document)}`,
        `　${document.hostedUrl}`,
      );
    }
    lines.push("", "領収書はダウンロード・印刷できます。");
  }

  lines.push("");
  lines.push(
    options.savedCardEnabled
      ? "■ お支払い方法\n下のボタンから、登録済みカードの変更・削除ができます。"
      : "■ お支払い方法\n現在、カード情報は保存していません。お支払いのたびにカード番号をご入力いただきます。",
  );

  lines.push(
    "",
    "月額料金・自動更新はありません。税理士相談は1回ごとのお支払いです。",
  );
  return lines.join("\n");
}

export const BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE = [
  "申し訳ありません。現在、Stripeの契約管理画面を開けませんでした。",
  "この操作による請求や契約変更は発生していません。",
  "",
  "旧あんしん会員の契約確認・解約をご希望の場合は、復旧まで次のページをご確認ください。",
  "https://bot.abtax.jp/cancellation",
].join("\n");
