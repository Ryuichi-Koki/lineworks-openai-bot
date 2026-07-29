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
      description="お手続きありがとうございます。Stripeからの通知を確認後、LINEの会員状態へ自動的に反映し、完了メッセージをお送りします。"
      icon="✓"
      note="二重申込みを防ぐため、完了メッセージが届くまで同じ決済を繰り返さないでください。"
      steps={[
        "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
        "反映が完了すると、ご利用開始日・次回更新日・残り回数を記載した完了メッセージがLINEに届きます（通常1分以内）。",
        "10分以上届かない場合は、会員メニューから契約状態をご確認ください。",
      ]}
      title="お申し込みを受け付けました"
      tone="success"
    />
  );
}
