import Link from "next/link";
import type { LegalBlock, LegalDocument } from "@/lib/legal/documents";

function renderBlock(block: LegalBlock, index: number) {
  switch (block.type) {
    case "heading": {
      if (block.level === 3) {
        return <h3 key={index}>{block.text}</h3>;
      }
      return <h2 key={index}>{block.text}</h2>;
    }
    case "paragraph":
      return <p key={index}>{block.text}</p>;
    case "list":
      return (
        <ul key={index}>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="legal-table-block" key={index}>
          <p className="legal-table-hint">表は横にスクロールできます。</p>
          <div className="legal-table-wrap">
            <table>
              {block.headers ? (
                <thead>
                  <tr>
                    {block.headers.map((header) => (
                      <th key={header} scope="col">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${rowIndex}-${row[0]}`}>
                    {row.map((cell, cellIndex) => {
                      const Cell =
                        block.firstColumnHeader && cellIndex === 0 ? "th" : "td";
                      return (
                        <Cell
                          key={`${cellIndex}-${cell.slice(0, 24)}`}
                          scope={Cell === "th" ? "row" : undefined}
                        >
                          {cell.split("\n").map((line, lineIndex) => (
                            <span
                              className="legal-table-line"
                              key={`${lineIndex}-${line}`}
                            >
                              {line}
                            </span>
                          ))}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
  }
}

export function LegalDocumentPage({ document }: { document: LegalDocument }) {
  return (
    <main className="legal-shell legal-document">
      <header className="legal-header">
        <p className="legal-kicker">TAX HOT LINE</p>
        <h1>{document.title}</h1>
        <p className="legal-office">{document.office}</p>
        <dl className="legal-dates">
          <div>
            <dt>制定日</dt>
            <dd>{document.enactedOn}</dd>
          </div>
          <div>
            <dt>最終改定日</dt>
            <dd>{document.revisedOn}</dd>
          </div>
        </dl>
      </header>

      <article className="legal-card legal-body">
        {document.introduction ? (
          <p className="legal-introduction">{document.introduction}</p>
        ) : null}
        {document.blocks.map(renderBlock)}
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
