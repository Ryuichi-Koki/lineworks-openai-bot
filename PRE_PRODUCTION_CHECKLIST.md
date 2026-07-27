# 本番移行チェックリスト

更新日: 2026-07-28

## 現在の判定

- テスト運用: **Go**
- Stripeライブ課金: **No-Go**
- 実顧客への本番公開: **条件付きNo-Go**

`bot.abtax.jp` はVercel Productionで稼働しています。Stripe本番アカウントは
有効化済みですが、アプリは安全のため引き続きテストモードです。
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
- [x] Stripe本番アカウントを有効化（2026-07-28）
- [x] Stripe本番へ商品2件とBilling設定をコピーし、「あんしん会員」月額3,300円を確認（2026-07-28）

## 本番公開前の必須項目

- [x] 最新版でLINE新規登録→同意→無料登録→受付通知→AI回答の実機E2E（2026-07-28確認）
- [x] Supabase Proの日次バックアップを有効化し、初回Physicalバックアップを確認（2026-07-28）
- [ ] 復旧先テストDBへのリストア演習
- [ ] 監視通知先、一次対応者、法務・税務承認者を記名
- [ ] 管理画面を使う場合の認証情報とアクセス制限を設定
- [ ] Stripe代表者の本人確認書類を提出し、決済・入金の停止を解除
- [ ] Stripeのクレジット取引セキュリティ対策に関する追加情報を提出し、決済・入金の停止を解除
- [ ] Stripeライブの事業情報と入金口座を最終確認
- [ ] ライブ用Customer Portal / Webhookを作成（Product / Priceはコピー済み）
- [ ] Stripe Taxの本店所在地、商品税コード、税務登録を承認
- [ ] 3,300円、更新日、返金、解約、相談枠の表示を最終承認
- [ ] 少額の限定ライブ決済を1件だけ実施し、入金・返金・解約を確認

## DBバックアップの現状

Supabase Proを有効化し、7日間保持の日次バックアップと初回Physicalバックアップを確認済みです。
`scripts/backup-supabase-production.mjs` と `SUPABASE_BACKUP_RUNBOOK.md` は、
月次の外部論理バックアップ用として維持します。

## ロールバック

1. `STRIPE_BILLING_ENABLED=false` で新規Checkoutを停止する。
2. 必要なら `MEMBERSHIP_BILLING_ENABLED=false` で会員DB連携を停止する。
3. LINE / LINE WORKSの既存回答機能は維持する。
4. StripeイベントID単位で未処理Webhookを再処理する。
5. Vercelの直前の正常Deploymentへロールバックする。

詳細は `OPERATIONS_RUNBOOK.md` と `STRIPE_PRODUCTION_RUNBOOK.md` を参照してください。
