# 本番移行チェックリスト

更新日: 2026-07-29

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

## LINEアカウント取り違え防止

- [x] ApexBrain税理士法人の本番LINE公式アカウントで、Webhook疎通・規約同意・
      無料登録・AI回答・有料登録・税理士相談・退会の実機E2Eを確認
- [x] ローカル `.env.local` の `GPT-san` は開発用アカウントと識別
- [x] `scripts/setup-line-rich-menu.mjs` を `--env=<ファイル名>` で
      対象環境を明示できる方式へ変更
- [ ] 新リッチメニュー適用直前に `--status` で本番アカウントの
      `displayName` とベーシックIDを再確認
- [ ] 新リッチメニュー適用後に本番LINEで6アクションを実機確認

## 未反映の改善（2026-07-29 時点・要デプロイ）

UIレビューに基づく修正をコードへ反映済み。**いずれも本番未反映**。
適用順序を誤ると壊れるため、必ず次の順に行うこと。

1. [x] `migrations/005_pending_questions.sql` を本番Supabaseへ適用し、
   `pending_questions` テーブルを確認（2026-07-29）
2. [ ] Vercel Productionへコードをデプロイ
3. [ ] LINEへ新リッチメニュー（2500x1686・6分割）を適用

- 1を飛ばして2を行うと、未同意者の質問預かりが失敗する（同意導線自体は動作する）。
- 2を飛ばして3を行うと、新メニューの `show_pricing` / `show_status` /
  `open_billing_portal` / `show_legal` / `start_question` が無反応になる。
- 1と2の間は安全。新コードは旧リッチメニューのpostbackを引き続き処理する。

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
