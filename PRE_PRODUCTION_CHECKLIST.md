# 本番移行チェックリスト

更新日: 2026-07-27

## 現在の判定

- テスト運用: **Go**
- Stripeライブ課金: **No-Go**
- 実顧客への本番公開: **条件付きNo-Go**

`bot.abtax.jp` はVercel Productionで稼働していますが、Stripeはテストモードです。
ライブ課金、実顧客データ変更、最終公開告知は、下記の未了事項を完了してから行います。

## 完了済み

- [x] Vercel Pro、`bot.abtax.jp`、Productionデプロイ
- [x] ApexBrain税理士法人LINE公式アカウントのWebhook疎通
- [x] リッチメニュー、規約同意、無料・有料会員導線
- [x] StripeテストCheckout、Webhook、Customer Portal、退会予約
- [x] 税理士相談の受付、LINE WORKS通知、返信
- [x] Supabase本番プロジェクトとmigration 001〜004
- [x] 未登録LINE利用者を登録導線へ誘導
- [x] AI回答前の受付メッセージ
- [x] LINE WORKS承認者の本番許可リスト設定
- [x] 公開ページのUI改善と個人情報送信注意表示
- [x] Stripeライブ誤作動防止フラグ
- [x] 秘密情報のGit除外と履歴検査

## 本番公開前の必須項目

- [ ] 最新版でLINE新規登録→同意→無料登録→AI回答の実機E2E
- [ ] Supabase本番DBの初回バックアップ取得とアーカイブ検証
- [ ] 復旧先テストDBへのリストア演習
- [ ] 監視通知先、一次対応者、法務・税務承認者を記名
- [ ] 管理画面を使う場合の認証情報とアクセス制限を設定
- [ ] Stripeライブの本人確認・事業情報・入金口座を確認
- [ ] ライブ用Product / Price / Portal / Webhookを新規作成
- [ ] Stripe Taxの本店所在地、商品税コード、税務登録を承認
- [ ] 3,300円、更新日、返金、解約、相談枠の表示を最終承認
- [ ] 少額の限定ライブ決済を1件だけ実施し、入金・返金・解約を確認

## DBバックアップの現状

Supabase Free Planには管理バックアップがありません。`scripts/backup-supabase-production.mjs`
と `SUPABASE_BACKUP_RUNBOOK.md` を準備済みです。

Vercelの `DATABASE_URL` はSensitive設定のため値を再取得できません。初回バックアップには次のどちらかが必要です。

1. DBパスワードを再ローテーションし、Vercelへ同時反映して論理バックアップを取得する。
2. Supabase Proへアップグレードして管理バックアップを有効化する。

## ロールバック

1. `STRIPE_BILLING_ENABLED=false` で新規Checkoutを停止する。
2. 必要なら `MEMBERSHIP_BILLING_ENABLED=false` で会員DB連携を停止する。
3. LINE / LINE WORKSの既存回答機能は維持する。
4. StripeイベントID単位で未処理Webhookを再処理する。
5. Vercelの直前の正常Deploymentへロールバックする。

詳細は `OPERATIONS_RUNBOOK.md` と `STRIPE_PRODUCTION_RUNBOOK.md` を参照してください。
