import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "解約・退会方法",
  robots: { index: false, follow: false },
};

export default function CancellationPage() {
  return (
    <main className="legal-shell legal-document">
      <header className="legal-header">
        <p className="legal-kicker">スグ税</p>
        <h1>解約・退会方法</h1>
        <p>
          既存の有料会員の定期契約の解約と、無料利用の終了に関する窓口をご案内します。税理士へのLINE個別相談は1回ごとの都度払いで、自動更新はありません。
        </p>
      </header>

      <article className="legal-card legal-body">
        <section className="legal-callout" aria-labelledby="deadline-heading">
          <h2 id="deadline-heading">既存の有料会員の解約期限</h2>
          <p>
            次回決済日の前日までに手続してください。解約後も既払期間の末日まで利用できます。
            既払料金の日割返金は行いません。
          </p>
        </section>

        <h2>LINEから既存の有料会員を解約する</h2>
        <ol className="legal-steps">
          <li>スグ税のLINE公式アカウントを開きます。</li>
          <li>画面下部のリッチメニューから「退会・契約管理」を選びます。</li>
          <li>表示される現在の契約状態を確認し、解約へ進みます。</li>
          <li>最終確認画面の内容を確認して、手続を確定します。</li>
          <li>LINEに届く完了メッセージを確認します。</li>
        </ol>

        <p className="legal-warning">
          LINE公式アカウントのブロック又は友だち登録解除だけでは、有料会員の解約になりません。
        </p>

        <h2>メールから既存の有料会員を解約する</h2>
        <p>
          LINEから手続できない場合は、
          <a href="mailto:info@abtax.jp">info@abtax.jp</a>
          宛てに、登録した氏名、LINE表示名、解約希望の旨をお送りください。
          本人確認のため追加情報をお願いする場合があります。
        </p>

        <h2>無料会員の退会・個人データに関する請求</h2>
        <p>
          無料会員の利用終了、保有個人データの削除又は利用停止等を希望する場合は、
          本サービスのLINE公式アカウント又は当法人ウェブサイトのお問い合わせフォームから
          ご連絡ください。本人確認書類等による本人確認をお願いする場合があります。
        </p>

        <h2>返金の取扱い</h2>
        <p>
          サービス提供開始後の利用者都合による返金は行いません。ただし、重複決済、
          明らかな決済誤り、当法人の責めに帰すべき事由その他法令上必要な場合を除きます。
        </p>

        <h2>関連する規程</h2>
        <ul>
          <li>
            <Link href="/terms">スグ税利用規約（第11条）</Link>
          </li>
          <li>
            <Link href="/tokusho">特定商取引法に基づく表記</Link>
          </li>
          <li>
            <Link href="/privacy">プライバシーポリシー</Link>
          </li>
        </ul>
      </article>

      <nav className="legal-bottom-nav" aria-label="規約ページ内ナビゲーション">
        <Link href="/legal">規約・各種情報の一覧へ戻る</Link>
      </nav>

      <footer className="legal-footer">
        Apex Brain税理士法人 沖縄事務所
      </footer>
    </main>
  );
}
