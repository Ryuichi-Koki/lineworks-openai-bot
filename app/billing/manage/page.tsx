import type { Metadata } from "next";
import { BillingStatusPage } from "../BillingStatusPage";

export const metadata: Metadata = {
  title: "契約管理受付",
  robots: {
    index: false,
    follow: false,
  },
};

export default function BillingManagePage() {
  return (
    <BillingStatusPage
      badge="契約情報を更新中"
      description="契約管理画面で行った変更は、Stripeからの通知後にLINEの会員状態へ反映されます。"
      icon="↻"
      note="退会予約後も、現在の契約期間が終了するまでは有料会員の機能をご利用いただけます。"
      steps={[
        "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
        "少し時間をおいて、会員メニューの「契約管理」から状態をご確認ください。",
      ]}
      title="契約管理を受け付けました"
      tone="neutral"
    />
  );
}
