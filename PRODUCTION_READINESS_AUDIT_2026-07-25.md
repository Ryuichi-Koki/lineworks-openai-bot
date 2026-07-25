# 本番課金移行前監査

監査日: 2026-07-25

対象: Tax Hot Line / ApexBrain税理士法人

対象環境: Vercel Production `bot.abtax.jp`（Stripe・DBはテスト用）

## 判定

- テスト運用: **Go**
- Stripeライブ課金: **No-Go**

現在は、Vercel Production上でテスト用Stripeとテスト用Supabaseを利用する
検証環境です。コードは `sk_test_` 以外の秘密鍵と `livemode=true` のWebhookを
拒否するため、ライブ課金へ誤移行しない安全停止状態です。

## 確認済み

- 規約への明示同意後に無料・有料会員を選択できる。
- StripeテストCheckout、Webhook、会員権反映が正常に動作する。
- 税理士相談の受付、LINE WORKS通知、返信が正常に動作する。
- Customer Portalで期間末解約でき、期間終了まで有料権限を維持する。
- 退会予約中は「有料機能の利用期限」を表示する。
- 68件の自動テスト、型検査、Lint、本番ビルドが成功する。
- Vercelの必須環境変数はProduction限定・Sensitiveとして登録されている。
- 管理画面認証変数は未登録であり、管理画面は401で無効化される。
- Vercel直近30分のログは Error / Warning / Fatal が0件。
- Git追跡中102ファイルと全52コミットに、実Stripe秘密鍵、
  Webhook secret、OpenAI API keyの一致はない。
- PostgreSQL接続文字列の履歴一致は、ランダムなローカル接続文字列を
  実行時生成するスクリプトだけで、固定資格情報ではない。

## 今回の安全対策

- `.env.*` をGit除外対象にし、`.env.example` だけを追跡可能にした。
- readiness検査へmigration 004を追加した。
- `STRIPE_MODE` と `STRIPE_LIVE_MODE_ENABLED` の二重許可を追加し、
  APIキー、Checkout、Portal、Invoice、Webhookのmode不一致を拒否する。
- Customer Portal configuration IDはテストでは任意、ライブでは専用設定を
  必須候補として文書化した。
- 現在のVercel・Supabase・Stripeテスト構成に合わせて運用文書を更新した。

## ライブ課金までの必須残作業

1. ライブ専用SupabaseプロジェクトまたはDB、最小権限ロール、
   バックアップ、復旧試験を準備する。
2. Stripe Live modeでProduct、月額3,300円のPrice、Tax、
   Customer Portal専用設定、Webhookを作成して承認する。
3. test/liveを明示する実行環境フラグを導入し、環境ごとにキーとWebhook modeの
   一致を起動時に検証する。
4. ライブSecretsをVercelへ登録する際は機能フラグをOFFのままにする。
5. 管理画面を利用する場合は認証3変数を登録し、アクセス制限を追加する。
6. 監視通知先、一次対応者、返金承認者、インシデント記録先を決める。
7. 価格、税込表示、自動更新、返金、特商法・規約、Stripe Tax設定について
   事業・税務・法務責任者の承認を記録する。
8. 明示承認後、限定した社内テスト顧客でのみ実額決済を行う。

上記が完了するまではライブキーを登録せず、実顧客へCheckoutを案内しません。
