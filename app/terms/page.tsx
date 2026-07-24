import type { Metadata } from "next";
import { LegalDocumentPage } from "@/app/legal/LegalDocumentPage";
import { termsDocument } from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "Tax Hot Line利用規約",
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  return <LegalDocumentPage document={termsDocument} />;
}
