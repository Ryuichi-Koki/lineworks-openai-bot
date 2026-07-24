import type { Metadata } from "next";
import { LegalDocumentPage } from "@/app/legal/LegalDocumentPage";
import { tokushoDocument } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "特定商取引法に基づく表記",
  robots: { index: false, follow: false },
};

export default function TokushoPage() {
  return <LegalDocumentPage document={tokushoDocument} />;
}
