import type { BillingStatusPageProps } from "@/app/billing/BillingStatusPage";

type BillingResult = "success" | "cancel";

const SUBSCRIPTION_CONTENT: Record<BillingResult, BillingStatusPageProps> = {
  success: {
    badge: "決済状況を確認中",
    description:
      "お手続きありがとうございます。Stripeからの通知を確認後、LINEの会員状態へ自動的に反映し、完了メッセージをお送りします。",
    icon: "✓",
    note: "二重申込みを防ぐため、完了メッセージが届くまで同じ決済を繰り返さないでください。",
    steps: [
      "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
      "反映が完了すると、ご利用開始日・次回更新日・残り回数を記載した完了メッセージがLINEに届きます（通常1分以内）。",
      "10分以上届かない場合は、会員メニューから契約状態をご確認ください。",
    ],
    title: "お申し込みを受け付けました",
    tone: "success",
  },
  cancel: {
    badge: "未完了・請求なし",
    description:
      "決済手続きは完了していません。この画面で新たな請求は発生していません。",
    icon: "!",
    note: "決済を再開する場合は、必ずLINEの会員メニューから改めてお進みください。",
    steps: [
      "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
      "有料会員になる場合は、会員メニューの「有料会員」を選びます。",
    ],
    title: "お申し込みは完了していません",
    tone: "warning",
  },
};

const TAX_REVIEW_CONTENT: Record<BillingResult, BillingStatusPageProps> = {
  success: {
    badge: "支払完了を確認中",
    description:
      "お支払いありがとうございます。Stripeからの支払完了通知を確認後、税理士への個別相談を自動的に受け付け、LINEへ受付完了メッセージをお送りします。",
    icon: "✓",
    note:
      "このお支払いは税理士への個別相談1回分です。月額料金や自動更新はありません。受付完了メッセージが届くまで、同じ相談を再決済しないでください。",
    steps: [
      "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
      "受付が完了すると、税理士からの回答をお待ちいただく旨のメッセージがLINEに届きます（通常1分以内）。",
      "10分以上届かない場合も、二重決済せずにLINEのトーク画面でお知らせください。",
    ],
    title: "税理士相談のお支払いを受け付けました",
    tone: "success",
  },
  cancel: {
    badge: "未完了・請求なし",
    description:
      "税理士相談のお支払いは完了していません。この画面を閉じただけでは請求は発生しません。",
    icon: "!",
    note:
      "決済ページの有効期限を過ぎた場合は、LINEの会員メニューにある「税理士相談」から、相談内容の入力をやり直してください。",
    steps: [
      "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
      "決済を再開する場合は、LINEに届いている「お支払いへ進む」ボタンをもう一度押してください。",
    ],
    title: "税理士相談のお支払いは完了していません",
    tone: "warning",
  },
};

export function billingStatusContent(
  result: BillingResult,
  purchase: string | string[] | undefined,
): BillingStatusPageProps {
  return purchase === "tax_review"
    ? TAX_REVIEW_CONTENT[result]
    : SUBSCRIPTION_CONTENT[result];
}
