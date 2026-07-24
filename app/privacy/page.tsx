import type { Metadata } from "next";
import { LegalDocumentPage } from "@/app/legal/LegalDocumentPage";
import { privacyDocument } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "プライバシーポリシー",
  robots: { index: false, follow: false },
};

export default function PrivacyPage() {
  return <LegalDocumentPage document={privacyDocument} />;
}
