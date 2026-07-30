import type { Metadata } from "next";
import { billingStatusContent } from "@/lib/stripe/billingStatusContent";
import { BillingStatusPage } from "../BillingStatusPage";

export const metadata: Metadata = {
  title: "お申し込み未完了",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function BillingCancelPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string | string[] }>;
}) {
  const { purchase } = await searchParams;
  return <BillingStatusPage {...billingStatusContent("cancel", purchase)} />;
}
