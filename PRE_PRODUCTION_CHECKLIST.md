# Stripe・LINE 本番移行前チェックリスト

更新日: 2026-07-25

## 現在の到達点

- Vercel Productionの `bot.abtax.jp` でStripeテストモードだけを使用している。
- SupabaseテストDBに migration 001、002、003、004 を適用済み。
- LINEテストアカウント「GPT-san」で規約同意、無料・有料選択、購入、
  契約管理、退会予約、期間内権限維持、税理士相談、通知、返信を確認済み。
- 常設リッチメニューを GPT-san に適用済み。
- 退会予約中は「次回更新日」ではなく「有料機能の利用期限」を表示する。
- `pnpm lint`、`pnpm typecheck`、67件の自動テスト、`pnpm build` は成功。
- Vercel直近30分のログは Error / Warning / Fatal が0件。
- Git全52コミットに実Stripe/OpenAI/Webhookキーの一致はない。
- Cloudflare 一時トンネル、ローカル Next.js、Stripe CLI は停止済み。

## ライブ課金の明示承認まで実施しないこと

- Stripe 本番キー、Live mode Product / Price / Webhook の設定
- 本番課金と実顧客への Checkout URL の案内
- ライブ用Supabaseへのmigrationまたは実顧客データ変更
- コードのtest-onlyガード解除
- 実額決済、返金、請求書・Credit Note操作

## 本番移行前の確認事項

- [x] GPT-san の一時 Webhook 利用を OFF にしたことをLINE Developersで確認
- [x] 開発版を運用元へ反映し、SHA-256一致と全自動検証を確認
- [x] 推奨案（Vercel Pro、`https://bot.abtax.jp`）を事業責任者が承認
- [x] テスト用Supabase、Stripe、LINEで加入から退会予約までを実機確認
- [x] 規約同意記録と退会後の期間内権限維持を確認
- [x] 秘密情報の現行ファイル・Git全履歴監査を実施
- [ ] 本番 PostgreSQL のバックアップ・復旧手順を確認
- [ ] migration 001 → 002 → 003 → 004 の順番と適用方法を承認
- [ ] Stripe Live mode の Product / Price / Customer Portal 設定を承認
- [ ] Stripe Live Webhook Endpoint と購読イベントをレビュー
- [ ] 本番 Secrets をホスティング側の秘密管理へ登録
- [ ] LINE と LINE WORKS の本番資格情報を秘密管理へ登録
- [ ] `STRIPE_BILLING_ENABLED=false` のまま初回デプロイ
- [ ] Webhook 疎通とDB反映を管理者用テスト顧客で確認
- [ ] Checkout、更新、支払失敗、退会予約、退会完了を確認
- [ ] ロールバック手順と担当者を確認
- [ ] 管理画面を使用する場合だけ認証3変数を登録し、二要素保護を検討
- [ ] 監視通知先、一次対応者、返金承認者を確定
- [ ] 最終承認後にだけ課金フラグを有効化

## ロールバック要点

1. `STRIPE_BILLING_ENABLED=false` にして新規 Checkout を停止する。
2. 必要なら `MEMBERSHIP_BILLING_ENABLED=false` にして会員DB連携を停止する。
3. LINE / LINE WORKS の既存回答機能は維持する。
4. Stripe Webhook はイベント監査のため受信を継続し、失敗イベントを記録する。
5. 原因修正後、未処理イベントをイベントID単位で再処理する。
6. 既存契約を一括解約・返金せず、影響を個別確認する。

詳細は `STRIPE_PRODUCTION_RUNBOOK.md` を参照する。
