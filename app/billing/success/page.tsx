import type { Metadata } from "next";
import { BillingStatusPage } from "../BillingStatusPage";

export const metadata: Metadata = {
  title: "お申し込み受付",
  robots: {
    index: false,
    follow: false,
  },
};

export default function BillingSuccessPage() {
  return (
    <BillingStatusPage
      badge="決済状況を確認中"
      description="お手続きありがとうございます。Stripeからの通知を確認後、LINEの会員状態へ自動的に反映します。"
      icon="✓"
      note="二重申込みを防ぐため、反映を待っている間は同じ決済を繰り返さないでください。"
      steps={[
        "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
        "通常はまもなく、契約状態を知らせるメッセージが届きます。",
        "届かない場合は少し時間をおいて、会員メニューから契約状態をご確認ください。",
      ]}
      title="お申し込みを受け付けました"
      tone="success"
    />
  );
}
