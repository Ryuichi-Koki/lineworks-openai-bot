import type { Metadata } from "next";
import { billingStatusContent } from "@/lib/stripe/billingStatusContent";
import { BillingStatusPage } from "../BillingStatusPage";

export const metadata: Metadata = {
  title: "お申し込み受付",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function BillingSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string | string[] }>;
}) {
  const { purchase } = await searchParams;
  return <BillingStatusPage {...billingStatusContent("success", purchase)} />;
}
