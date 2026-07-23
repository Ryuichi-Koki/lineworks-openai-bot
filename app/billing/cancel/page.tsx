import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function BillingCancelPage() {
  return (
    <main>
      <h1>お申し込みは完了していません</h1>
      <p>請求は行われていません。LINEに戻って、必要なときに再度お試しください。</p>
    </main>
  );
}
