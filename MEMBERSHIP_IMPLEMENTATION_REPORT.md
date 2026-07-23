# LINEメンバーシップ・利用回数管理 実装報告

作成日: 2026-07-23

## 公開状態

- 本番デプロイ: 未実施
- 本番課金: 未有効
- 本番DBマイグレーション: 未適用
- 既存顧客データ変更: 未実施
- 機能フラグ: `MEMBERSHIP_BILLING_ENABLED=false`

## 調査した既存構成

- Next.js 16 / TypeScript
- LINE Messaging API Webhook: `app/api/line/callback/route.ts`
- LINE WORKS Webhook: `app/api/lineworks/callback/route.ts`
- OpenAI回答: `lib/openai/generateReplyDraft.ts`
- 税務回答ポリシー: `lib/tax/*` と `prompts/*`
- 会話・承認・監査: Upstash Redis
- 本番デプロイ先: GitHub連携先（今回コミット・push・deployは未実施）

既存のOpenAIモデル、検索、税務回答プロンプトは変更せず、LINE WebhookのAI生成前後へ
会員・回数処理を接続した。

## 採用した課金方式

LINE公式アカウント メンバーシップを採用した。Messaging APIで加入状況、プラン、
次回課金日を取得し、加入・継続課金・退会Webhookを処理する。

LINE公式APIは「退会予約中」と「決済失敗」を個別の状態として公開していない。
そのため、LINE方式では期間中を`active`、退会イベント受信後を`free`として扱う。
DBは`cancel_at_period_end`と`past_due`を保持できるが、自動反映には別の情報源が必要。

Stripeへ切り替える場合は、LINE userIdそのものをStripeへ露出させず、内部user UUIDを
Checkout metadata/client_reference_idへ設定し、DBのStripe Customer IDと対応させる。
Checkout、Customer Portal、invoice.paid、invoice.payment_failed、
customer.subscription.updated/deleted、署名検証、イベント冪等性が追加で必要。

## 実装内容

- 初回メッセージで無料会員を自動登録
- 無料10回/月、あんしん100回/契約期間
- AI生成前の原子的予約
- LINE送信成功後だけ利用確定
- 確認質問・AI失敗・LINE失敗時の予約取消
- WebhookイベントIDによる重複処理防止
- 最終回答末尾の残り回数表示
- 上限到達時にAI APIを呼ばない分岐
- LINEメンバーシップ加入・更新・退会同期
- 税理士確認の「要約確認→この内容で依頼する→LINE WORKS通知」
- 税理士確認ボタンを押しただけでは非消費
- 認証・CSRF保護付き`/admin/members`
- 会員検索、プラン別人数、利用履歴、誤カウント取消、再同期
- 管理操作の監査ログ
- Stripe試作の撤去・退避

## データベース

`migrations/001_membership_billing.sql`に以下を定義した。

- `plans`
- `users`
- `usage_events`
- `webhook_events`
- `review_requests`
- `admin_audit_logs`
- `reserve_usage()` 原子的予約関数
- `transition_usage()` 確定・取消関数

全テーブルでRLSを有効化し、ブラウザー向けポリシーは作成していない。
サーバー専用DBロールだけを利用する。

## 追加環境変数

- `MEMBERSHIP_BILLING_ENABLED`
- `LINE_MEMBERSHIP_ANSHIN_ID`
- `LINE_MEMBERSHIP_PREMIUM_ID`
- `LINE_MEMBERSHIP_JOIN_URL`
- `DATABASE_URL`
- `DATABASE_SSL_MODE`
- `ADMIN_DASHBOARD_USER`
- `ADMIN_DASHBOARD_PASSWORD`
- `ADMIN_SESSION_SECRET`

## 人間が行う設定

1. LINE公式アカウントがメンバーシップ利用条件を満たすか確認
2. 月額3,300円（税込）の「あんしん会員」を作成
3. 特定商取引法表示を登録し、プラン審査・公開
4. プランIDと加入URLを環境変数へ設定
5. Supabase/PostgreSQLのテストDBを作成
6. マイグレーションをテストDBへ適用
7. 管理画面の認証情報を設定
8. テストユーザーで加入・更新・退会・上限・税理士確認を確認
9. 人間の承認後にだけ本番デプロイと機能フラグ有効化

## テスト結果

- 自動テスト: 46件成功
- TypeScript: 成功
- ESLint: 成功
- Next.js本番ビルド: 成功
- 秘密情報スキャン: 埋め込み認証情報なし
- 実DB統合テスト: 未実施（Supabase/PostgreSQLアカウント未設定）
- LINEメンバーシップ実イベント試験: 未実施（プラン未作成）

## 利用者の操作

1. 友だち追加後に質問する
2. 無料会員は月10回までAI最終回答を利用
3. 上限案内の「あんしん会員に登録する」からLINE上で加入
4. 加入Webhook後、AI100回・税理士確認1案件を利用
5. 税理士確認が必要な回答で「税理士へ個別相談」を押す
6. 要約を確認して「この内容で依頼する」を押す
7. LINE WORKSへ通知され、受付完了メッセージを受信
8. LINE WORKSの職員回答を確認後、公式LINEへ送信
9. LINEメンバーシップを退会すると期間終了時の退会イベント後に無料会員へ戻る

## 制約

- LINE Messaging APIでは退会予約状態と決済失敗状態を取得できない。
- プロフィール情報取得に同意していない利用者は、メンバーシップWebhookにuserIdが含まれない場合がある。
- テストDBとLINEメンバーシッププランが未作成のため、本番機能は無効のまま。
