import type { Metadata } from "next";
import { BillingStatusPage } from "../BillingStatusPage";

export const metadata: Metadata = {
  title: "お申し込み未完了",
  robots: {
    index: false,
    follow: false,
  },
};

export default function BillingCancelPage() {
  return (
    <BillingStatusPage
      badge="未完了・請求なし"
      description="決済手続きは完了していません。この画面で新たな請求は発生していません。"
      icon="!"
      note="決済を再開する場合は、必ずLINEの会員メニューから改めてお進みください。"
      steps={[
        "右上の「×」でこの画面を閉じ、LINEのトーク画面へ戻ります。",
        "有料会員になる場合は、会員メニューの「有料会員」を選びます。",
      ]}
      title="お申し込みは完了していません"
      tone="warning"
    />
  );
}
