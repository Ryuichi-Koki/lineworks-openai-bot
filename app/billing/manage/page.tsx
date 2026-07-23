import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function BillingManagePage() {
  return (
    <main>
      <h1>契約管理画面から戻りました</h1>
      <p>
        退会予約や契約状況はStripeからの通知後に反映されます。画面を閉じてLINEへ戻り、しばらくしてから契約状況をご確認ください。
      </p>
    </main>
  );
}
