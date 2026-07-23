# Stripe・LINE 本番移行前チェックリスト

更新日: 2026-07-24

## 現在の到達点

- Stripe はテストモードだけを使用している。
- ローカル PostgreSQL に migration 001、002、003 を適用済み。
- LINE テストアカウント「GPT-san」で購入、契約管理、退会予約、
  税理士相談の送信確認・キャンセルを確認済み。
- 常設リッチメニューを GPT-san に適用済み。
- `pnpm check:stripe` は全項目 PASS。
- `pnpm lint`、`pnpm typecheck`、58件の自動テスト、`pnpm build` は成功。
- Cloudflare 一時トンネル、ローカル Next.js、Stripe CLI は停止済み。

## 本番承認まで実施しないこと

- Stripe 本番キー、Live mode Product / Price / Webhook の設定
- 本番課金と実顧客への Checkout URL の案内
- 運用元コードへの反映
- 本番 PostgreSQL の migration または顧客データ変更
- 本番デプロイ
- Git commit / push
- 本番 LINE アカウントへのリッチメニューまたは Webhook の適用

## 本番移行前の確認事項

- [x] GPT-san の一時 Webhook 利用を OFF にしたことをLINE Developersで確認
- [x] 開発版を運用元へ反映し、SHA-256一致と全自動検証を確認
- [x] 推奨案（Vercel Pro、`https://bot.abtax.jp`）を事業責任者が承認
- [ ] 本番 PostgreSQL のバックアップ・復旧手順を確認
- [ ] migration 001 → 002 → 003 の順番とトランザクション適用を承認
- [ ] Stripe Live mode の Product / Price / Customer Portal 設定を承認
- [ ] Stripe Live Webhook Endpoint と購読イベントをレビュー
- [ ] 本番 Secrets をホスティング側の秘密管理へ登録
- [ ] LINE と LINE WORKS の本番資格情報を秘密管理へ登録
- [ ] `STRIPE_BILLING_ENABLED=false` のまま初回デプロイ
- [ ] Webhook 疎通とDB反映を管理者用テスト顧客で確認
- [ ] Checkout、更新、支払失敗、退会予約、退会完了を確認
- [ ] ロールバック手順と担当者を確認
- [ ] 最終承認後にだけ課金フラグを有効化

## ロールバック要点

1. `STRIPE_BILLING_ENABLED=false` にして新規 Checkout を停止する。
2. 必要なら `MEMBERSHIP_BILLING_ENABLED=false` にして会員DB連携を停止する。
3. LINE / LINE WORKS の既存回答機能は維持する。
4. Stripe Webhook はイベント監査のため受信を継続し、失敗イベントを記録する。
5. 原因修正後、未処理イベントをイベントID単位で再処理する。
6. 既存契約を一括解約・返金せず、影響を個別確認する。

詳細は `STRIPE_PRODUCTION_RUNBOOK.md` を参照する。
