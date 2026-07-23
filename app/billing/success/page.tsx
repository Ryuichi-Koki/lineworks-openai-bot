import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function BillingSuccessPage() {
  return (
    <main>
      <h1>お申し込みを受け付けました</h1>
      <p>決済状況の反映後、LINEでサービスをご利用いただけます。</p>
    </main>
  );
}
