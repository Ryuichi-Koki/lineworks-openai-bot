import Link from "next/link";

type BillingStatusPageProps = {
  badge: string;
  description: string;
  icon: string;
  note: string;
  steps: string[];
  title: string;
  tone: "success" | "neutral" | "warning";
};

export function BillingStatusPage({
  badge,
  description,
  icon,
  note,
  steps,
  title,
  tone,
}: BillingStatusPageProps) {
  return (
    <main className="billing-shell">
      <section className={`billing-card billing-card-${tone}`}>
        <div className="billing-icon" aria-hidden="true">
          {icon}
        </div>
        <p className="legal-kicker">スグ税</p>
        <span className={`billing-badge billing-badge-${tone}`}>{badge}</span>
        <h1>{title}</h1>
        <p className="billing-lead">{description}</p>

        <ol className="billing-steps">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        <p className="billing-note">{note}</p>

        <nav className="billing-links" aria-label="関連情報">
          <Link href="/legal">規約・各種情報</Link>
          <Link href="/cancellation">解約・退会方法</Link>
        </nav>
      </section>
      <footer className="legal-footer">Apex Brain税理士法人 沖縄事務所</footer>
    </main>
  );
}
