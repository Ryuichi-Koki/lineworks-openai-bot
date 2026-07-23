# 推奨本番構成

更新日: 2026-07-24

## 結論

既存の `www.abtax.jp` は移設せず、LINE・LINE WORKS・Stripe連携用の
Next.jsアプリだけを別環境へ配置する。

推奨構成:

- アプリ: Vercel Pro
- 公開URL: `https://bot.abtax.jp`
- ソース: GitHubの非公開リポジトリ
- 会員・課金台帳: Supabase PostgreSQL
- 一時状態・LINE WORKS承認状態: Upstash Redis
- 決済: Stripe
- メッセージング: LINE Messaging API / LINE WORKS
- 実行リージョン: Vercel Tokyo `hnd1`
- DB・Redis: 可能な限り東京リージョン

Vercel Hobbyは個人・非商用向けであるため、税理士法人の商用サービスには
使用しない。

## ドメイン方針

- `www.abtax.jp`: 現行GMOサーバーのWebサイトを維持
- `bot.abtax.jp`: VercelへCNAME接続
- `bot.abtax.jp/api/line/callback`: LINE Webhook
- `bot.abtax.jp/api/lineworks/callback`: LINE WORKS Callback
- `bot.abtax.jp/api/stripe/webhook`: Stripe Webhook

既存サイトのAレコードやネームサーバーは変更せず、`bot` サブドメインの
レコードだけを追加する。DNS変更は初回Vercelデプロイと疎通確認後に行う。

## PostgreSQL接続

- アプリ実行時はSupabaseのTransaction Poolerを使う。
- migration、バックアップ、復旧にはDirect connectionを使う。
- `DATABASE_SSL_MODE=require` を設定する。
- アプリはprepared statementsを無効化済み。
- migrationは `001` → `002` → `003` の順に適用する。
- 本番DB適用前にバックアップと復旧点を作る。

## 環境変数

秘密値はVercel、Supabase、Upstash、Stripe等のSecrets管理だけへ登録する。
Git、README、ログ、LINEメッセージには出力しない。

本番では少なくとも次を分離して登録する。

- OpenAI
- LINE
- LINE WORKS
- Upstash
- PostgreSQL
- Stripe
- 公開URLと機能フラグ

最初のデプロイでは課金機能を無効にする。

```text
MEMBERSHIP_BILLING_ENABLED=false
STRIPE_BILLING_ENABLED=false
STRIPE_APP_BASE_URL=https://bot.abtax.jp
DATABASE_SSL_MODE=require
```

## 段階的リリース

1. GitHubへ反映する差分をレビューする。
2. Vercel Proプロジェクトを作成し、GitHubリポジトリを接続する。
3. Preview環境へテスト用Secretsだけを登録する。
4. Previewでビルド、署名検証、DB接続、Webhook回帰テストを行う。
5. 本番用SupabaseとUpstashを作成し、バックアップ方針を確認する。
6. Productionへ本番Secretsを登録するが、課金フラグはOFFに保つ。
7. `bot.abtax.jp` を接続し、HTTPSを確認する。
8. LINE・LINE WORKS・StripeのWebhook URLを本番URLへ変更する。
9. 管理者用テスト顧客で受信とDB反映を確認する。
10. 最終承認後だけ課金フラグをONにする。

## ソース統合の現状

開発版と運用元を秘密ファイル・生成物を除外してSHA-256比較した結果:

- 同一: 23ファイル
- 内容が異なる: 18ファイル
- 開発版だけに存在: 34ファイル
- 運用元だけに存在: 0ファイル

2026-07-24に、秘密ファイルと生成物を除外した87ファイルを運用元へ反映し、
全ファイルのSHA-256一致を確認した。上書き前の47ファイルは作業領域へ退避済み。

運用元から作成した秘密情報なしの検証コピーで、次を確認済み:

- lockfileの供給網ポリシー検査
- lint
- TypeScript型検査
- 58件の自動テスト
- Next.js本番ビルド

運用元Gitリポジトリには未コミット変更とバックアップフォルダーが多数あるため、
差分レビュー前にcommit、push、直接デプロイしない。

推奨統合手順:

1. 退避バックアップを保持する。
2. Git差分をレビューする。
3. `.env.local`、秘密鍵、`.next`、`node_modules`、バックアップフォルダーを
   commit対象から除外する。
4. 差分レビュー後にだけcommitする。
5. 明示許可後にだけGitHubへpushする。

## 現在の機能範囲

動作確認済み:

- Stripe Billingの継続課金Checkout
- Stripe Customer Portalによる退会予約
- Stripe Webhookによる加入・更新・支払失敗・退会状態の反映
- Stripe Taxを有効にしたCheckout
- LINEの常設メニューと税理士相談受付
- PostgreSQLの会員・利用回数・監査台帳

本番公開前に別途業務設計・承認が必要:

- 単発Paymentsを顧客へ案内する画面・LINE導線
- 専門業務向けInvoice発行の管理者承認画面
- 適格請求書の表示、税区分、税率、端数処理
- 返金・Credit Noteの承認フロー
- Stripe Taxの登録地・商品Tax code・税込／税別設定

## ロールバック

- 新規課金停止: `STRIPE_BILLING_ENABLED=false`
- 会員DB連携停止: `MEMBERSHIP_BILLING_ENABLED=false`
- LINE / LINE WORKSの既存回答は維持
- Webhookイベントは重複防止台帳へ記録
- 未処理イベントはイベントID単位で再処理
- 既存契約の一括解約や一括返金は行わない

詳細な障害対応は `STRIPE_PRODUCTION_RUNBOOK.md` を参照する。
