import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_DOCUMENTS } from "@/lib/legal/config";

export const metadata: Metadata = {
  title: "規約・各種情報",
  robots: { index: false, follow: false },
};

export default function LegalIndexPage() {
  return (
    <main className="legal-shell">
      <section className="legal-header">
        <p className="legal-kicker">TAX HOT LINE</p>
        <h1>規約・各種情報</h1>
        <p>
          Tax Hot Lineのサービス利用条件、個人情報の取扱い、料金・解約条件をご確認いただけます。
        </p>
      </section>

      <nav className="legal-list" aria-label="規約・各種情報">
        {LEGAL_DOCUMENTS.map((document) => (
          <Link className="legal-link" href={`/${document.slug}`} key={document.slug}>
            <strong>{document.title}</strong>
            <span>{document.description}</span>
          </Link>
        ))}
      </nav>

      <section className="legal-card">
        <span className="legal-status legal-status-ready">公開中</span>
        <p className="legal-note">
          制定日は2026年7月24日、最終改定日は2026年7月30日です。会員登録前にも各文書の全文をご確認いただけます。
        </p>
      </section>

      <footer className="legal-footer">
        Apex Brain税理士法人 沖縄事務所
      </footer>
    </main>
  );
}
