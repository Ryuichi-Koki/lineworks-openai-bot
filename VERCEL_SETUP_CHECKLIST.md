# Vercel Pro セットアップチェックリスト

更新日: 2026-07-24

対象:

- GitHub: `Ryuichi-Koki/lineworks-openai-bot`
- ブランチ: `codex/stripe-line-membership-20260724`
- 本番候補URL: `https://bot.abtax.jp`
- Vercel Functions: Tokyo `hnd1`

## 1. プロジェクト作成前

- [ ] Vercel Proチームで作業する
- [ ] GitHubリポジトリへのアクセス権を確認する
- [ ] Production Branchを決定する
- [ ] 自動Production Deploymentを有効にする前に承認を得る
- [ ] PreviewとProductionのSecretsを分離する

この段階ではProduction Branchを`main`へ接続しない。最初は専用ブランチの
Previewだけで検証し、本番デプロイの明示許可後に切り替える。

## 2. Preview環境変数

値はVercelのEnvironment Variablesへ直接登録し、Gitやログへ記録しない。

### OpenAI

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TAX_SEARCH_MODEL`

### LINE

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_RICH_MENU_EXPECTED_BASIC_ID`
- `LINE_HYBRID_AUTO_REPLY_ENABLED`

### LINE WORKS

- `LINEWORKS_CLIENT_ID`
- `LINEWORKS_CLIENT_SECRET`
- `LINEWORKS_SERVICE_ACCOUNT`
- `LINEWORKS_PRIVATE_KEY`
- `LINEWORKS_BOT_ID`
- `LINEWORKS_BOT_SECRET`
- `LINEWORKS_STAFF_CHANNEL_ID`
- `LINEWORKS_APPROVER_USER_IDS`

### Redis

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### PostgreSQL

- `DATABASE_URL`
- `DATABASE_SSL_MODE=require`
- `MEMBERSHIP_BILLING_ENABLED=false`

Previewのアプリ実行時はSupabase Transaction Poolerを使う。migrationには
Direct connectionを使う。

### Stripe

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ANSHIN`
- `STRIPE_PRICE_PREMIUM`
- `STRIPE_PORTAL_CONFIGURATION_ID`
- `STRIPE_APP_BASE_URL`
- `STRIPE_BILLING_ENABLED=false`

PreviewではStripe test modeの値だけを登録する。本番キーは登録しない。

### 管理画面

- `MEMBERSHIP_ADMIN_SECRET`

## 3. Preview検証

- [ ] `pnpm build` が成功
- [ ] LINE署名不正リクエストが拒否される
- [ ] LINE WORKS署名不正リクエストが拒否される
- [ ] Stripe署名不正リクエストが拒否される
- [ ] PostgreSQLへのTLS接続を確認
- [ ] Upstashへの保存・取得を確認
- [ ] Stripe test CheckoutとCustomer Portalを確認
- [ ] Webhookの重複・順序逆転を確認
- [ ] 加入、更新、支払失敗、退会予約、退会完了を確認
- [ ] 税理士相談の送信確認・キャンセルを確認

## 4. bot.abtax.jp

本番デプロイ承認後に実施する。

1. Vercelプロジェクトへ`bot.abtax.jp`を追加する。
2. Vercelが表示するプロジェクト固有のCNAME値を取得する。
3. GMO側DNSへ`bot`のCNAMEだけを追加する。
4. `abtax.jp`と`www.abtax.jp`の既存レコードは変更しない。
5. VercelでDNS検証とSSL発行完了を確認する。
6. `https://bot.abtax.jp`のHTTPS応答を確認する。

## 5. 本番有効化

次はそれぞれ別の明示許可後に実施する。

- Production Deployment
- 本番PostgreSQL migration
- Stripe live mode Secretsの登録
- LINE / LINE WORKS / Stripe Webhook URLの本番変更
- 実顧客によるCheckout
- `MEMBERSHIP_BILLING_ENABLED=true`
- `STRIPE_BILLING_ENABLED=true`

課金フラグはすべてのWebhook検証が完了するまでOFFを維持する。
