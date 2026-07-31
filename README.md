# スグ税 LINE税務情報・税理士相談サービス

顧問先からLINE公式アカウントへ届いた質問をGPTが分類し、返信案をLINE WORKSへ送ります。担当者が承認するか、修正指示を送って再作成してから承認した場合だけ、顧問先へ返信します。

```text
顧問先（LINE）
  → LINE公式アカウント Webhook
  → GPTで分類・返信案作成
  → LINE WORKSの職員トークルームへ承認ボタン付き通知
  → 担当者が承認
  → LINE Push APIで顧問先へ送信
```

## 実装済み機能

- LINE公式アカウントのWebhook署名検証
- テキスト質問の分類、緊急度判定、返信案、確認事項の構造化出力
- LINE WORKSへの承認・却下ボタン付き通知
- LINE WORKSからの修正指示による返信案の再作成と再承認
- LINE WORKS Callbackの署名検証
- 承認者の任意ホワイトリスト
- 承認後のLINE Push送信
- 二重送信を避ける案件ステータス遷移とLINEリトライキー
- Webhook再送時の重複案件防止
- Upstash Redis保存（本番）／メモリ保存（ローカル）
- 情報不足でも一般原則を先に返す回答レベルA/B/C判定
- 標準前提、条件分岐、最大4件の追加確認
- e-Gov・国税庁等の公式ドメインに限定したWeb検索
- 検索注釈と一致したURLだけを採用する出典検証
- 回答レベル、信頼度、出典、引用箇所、モデル、プロンプト版の監査保存
- 顧問先プロファイルの任意参照と参照項目ログ
- モデル送信前・LINE送信前の機密情報マスキング

## ハイブリッド回答モード

`LINE_HYBRID_AUTO_REPLY_ENABLED=true` の場合、AIの一次回答を公式LINEへ即時送信します。
回答には検証済みの法令・通達・国税庁資料のURLを最大3件表示します。
回答レベルCまたは税理士確認が必要な案件には料金と
「税理士へ個別相談」ボタンを表示します。顧問先がボタンを押した場合だけ、
直近の会話をマスキングしてLINE WORKSの職員トークルームへ引き継ぎます。
通常のAI回答には税理士確認の案内もボタンも表示しません。

税理士個別相談の回答フローは次のとおりです。

1. LINE WORKS通知の「この相談に回答」を押す
2. 同じトークルームへ回答文をテキストで送る
3. 表示された内容を確認し、「公式LINEへ送信」を押す
4. 必要に応じて「書き直す」または「中止」を選ぶ

回答文を入力しただけでは公式LINEへ送信されません。最終確認ボタンを押した場合だけ送信されます。

## 無料利用、税理士相談、旧月額契約

現在の料金体系は次のとおりです。

- AIによる一般的な税務情報の回答：無料、毎月100件まで
- 税理士へのLINE個別相談：1回ごとの都度払い
- 2026年12月31日まで：1回1,100円（税込）
- 2027年1月1日以降：1回3,300円（税込）

税理士相談は、相談内容を入力・確認した後にStripe Checkoutへ進みます。
支払完了後に受付を開始し、自動更新はありません。LINE WORKSとLINEへの通知は
PostgreSQLの配送ジョブへ記録し、一時障害時はVercel Cronが再送します。
返金はStripeの`refund.created`、`refund.updated`、`refund.failed`を台帳へ反映します。

料金改定前から存在する「あんしん会員」は旧月額契約として扱います。契約期間中は
従来のAI回答100回・税理士相談1件の特典を維持し、追加決済なしで利用できます。
新規の月額契約受付には使用しません。

モバイル版LINEのトーク画面下部へ常設する場合は、Messaging APIのデフォルト
リッチメニューを使用します。`assets/line-rich-menu.png` を用意したうえで、
`pnpm setup:line:rich-menu` は画像と操作定義をローカル検証します。
`pnpm setup:line:rich-menu -- --status` は対象アカウントを読み取り確認し、
`--apply --confirm-account-wide-change` はデフォルトリッチメニューを実際に
変更するため明示承認後だけ実行します。誤設定防止のため
`LINE_RICH_MENU_EXPECTED_BASIC_ID` と
アクセストークンのBasic IDが一致しなければ停止します。

Stripeの決済・返金・旧契約更新Webhookを受け、`line_user_id`を主キーとして状態を同期します。
WebhookイベントID、利用イベント、配送ジョブの冪等キーにより、再送時の二重処理を防ぎます。
AI利用枠は生成前に予約し、LINE送信成功後に確定します。確認質問・生成失敗・送信失敗は取消します。

会員・利用・決済・返金・配送台帳にはSupabase互換PostgreSQLを使います。
`migrations/001_membership_billing.sql`から
`migrations/007_tax_review_delivery_and_refunds.sql`までを順に適用してください。

- `DATABASE_URL`
- `DATABASE_SSL_MODE`（Supabaseでは`require`）
- `STRIPE_PRICE_TAX_REVIEW_PROMO`
- `STRIPE_PRICE_TAX_REVIEW_STANDARD`
- `STRIPE_WEBHOOK_SECRET`
- `CRON_SECRET`

管理画面は`GET /admin/members`です。HTTP Basic認証とCSRF検証を行うため、
`ADMIN_DASHBOARD_USER`、`ADMIN_DASHBOARD_PASSWORD`、`ADMIN_SESSION_SECRET`を設定します。
会員検索、利用状況、利用履歴、誤カウント取消、LINE会員情報の再同期を利用できます。
取消操作は変更者・日時・変更前後・理由を監査ログへ残します。

本番では`MEMBERSHIP_BILLING_ENABLED=true`、
`ONE_TIME_CONSULTATION_BILLING_ENABLED=true`を使用します。Vercel Production buildは
`scripts/check-production-config.mjs`でライブキー、Price ID、Webhook、DB、Redis、
LINE、LINE WORKS、Cronの設定名とモードを検査します。秘密値は出力しません。
配送・返金・障害対応と本番反映記録は
[`PRODUCTION_HARDENING_2026-07-30.md`](./PRODUCTION_HARDENING_2026-07-30.md)
を参照してください。

料金表はモデルに生成させず、`lib/tax/hybridService.ts` の固定文を使用します。
税理士相談は、相談ボタン→内容入力→内容確認→Stripe決済→配送ジョブ→
LINE WORKS通知・利用者受付通知の順です。決済前は内容の入力し直し又は中止ができます。

`LINE_HYBRID_AUTO_REPLY_ENABLED=false` の場合だけ、
従来どおり全件をLINE WORKSで承認してから送信します。未設定時はハイブリッド回答が有効です。

## エンドポイント

| 用途 | URL |
|---|---|
| LINE公式アカウント Webhook | `POST /api/line/callback` |
| LINE WORKS Bot Callback | `POST /api/lineworks/callback` |
| 会員管理画面 | `GET /admin/members` |

## セットアップ

```bash
npm install
copy .env.example .env.local
npm run dev
```

`.env.local` に `.env.example` の値を設定します。秘密情報をGitへコミットしないでください。

### 1. OpenAI

- `OPENAI_API_KEY`: OpenAI PlatformのProject API Key
- `OPENAI_MODEL`: 既定は `gpt-4.1-mini`
- `OPENAI_TAX_SEARCH_MODEL`: 公式ドメイン限定検索専用。既定は `gpt-5-mini`

Responses APIのStructured Outputsを使い、分類結果をJSONスキーマで固定しています。
税務根拠検索にはResponses APIのWeb検索を使い、`e-Gov法令検索（laws.e-gov.go.jp）`、国税庁、総務省、
裁判所、国税不服審判所および設定済み地方公共団体の公式ドメインだけを許可しています。
国税庁では、法令解釈通達、その他法令解釈情報、事務運営指針、告示、文書回答事例、
質疑応答事例の公式入口とその配下を検索モデルへ優先候補として渡します。
裁決事例が必要な場合は、国税不服審判所の公表裁決事例集 `https://www.kfs.go.jp/service/`
とその配下を参照します。裁決は個別事案の参考資料として扱い、法令・通達より優先しません。
`TAX_WEB_SEARCH_ENABLED=false` で検索を止められますが、その場合は根拠未検証として
信頼度「低」・税理士確認対象になります。

長文の指示はコードへ埋め込まず、次のファイルで管理します。

- `prompts/system_prompt.md`
- `prompts/answer_policy.md`
- `prompts/examples.md`
- `prompts/source_policy.md`

4ファイルの内容からプロンプトバージョンを自動計算し、監査ログへ保存します。

### 2. LINE公式アカウント

LINE Developers ConsoleでMessaging APIチャネルを準備します。

- `LINE_CHANNEL_SECRET`: Basic settingsのChannel secret
- `LINE_CHANNEL_ACCESS_TOKEN`: Messaging APIのChannel access token
- Webhook URL: `https://あなたのドメイン/api/line/callback`
- Webhookを有効化

顧問先への送信は、承認待ち時間を考慮してReply APIではなくPush APIを使います。

### 3. LINE WORKS

LINE WORKS Developers ConsoleでBot、Service Account、Private Keyを準備します。

- BotのCallback URL: `https://あなたのドメイン/api/lineworks/callback`
- Callbackイベントを有効化
- `bot.message` scopeを許可
- Botを職員のトークルームへ追加
- 対象トークルームのchannelIdを `LINEWORKS_STAFF_CHANNEL_ID` に設定
- Private Keyは改行を `\n` にした1行の値として設定可能

`LINEWORKS_APPROVER_USER_IDS` に承認可能な職員のLINE WORKS userIdをカンマ区切りで**必ず**設定してください。**空欄の場合は誰も承認・回答送信できません**（フェイルクローズ）。本番ビルドは `scripts/check-production-config.mjs` がこの設定を検査し、未設定ならビルドを中止します。

### 4. 案件保存

本番ではUpstash Redisを作成し、次を設定してください。

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

未設定の場合はプロセスメモリを使います。開発確認には使えますが、再起動やサーバーレスインスタンスの切替で案件が消えるため、本番運用には使用できません。

### 5. 顧問先プロファイルと監査ログ

顧問先プロファイルはRedisの
`apexbrain:line-client:<LINE userIdをSHA-256化した先頭32桁>` にJSONで保存します。
法人・個人、決算月、消費税区分、インボイス登録、資本金、業種、届出、担当者等のうち、
記録がある項目だけを回答生成時に渡します。使用した項目名は案件と監査ログに保存します。

監査ログは案件ごとに `apexbrain:audit:<案件ID>` へ保存します。質問はマスキング後の文面、
回答、出典URL、根拠引用、取得日時、モデル、プロンプト版、信頼度、担当者IDのハッシュを記録します。

### 6. 会員・決済DBとテスト公開

1. SupabaseまたはPostgreSQLでテスト用プロジェクトを作成
2. `migrations/001`から`007`までを番号順に適用
3. サーバー専用の`DATABASE_URL`を設定
4. Stripeテスト環境で1,100円・3,300円の1回限り税込Priceを作成
5. Checkout成功・中断・期限切れ・失敗・全額／一部返金Webhookを確認
6. LINE WORKS又はLINEを一時的に失敗させ、配送ジョブの再送を確認
7. 管理画面の認証・検索・誤カウント取消を確認
8. `check:production:config`、全テスト、型検査、lint、buildを完了

## 動作確認

```bash
npm run typecheck
npm run build
npm test
```

開発サーバーを起動した状態で、署名付きWebhookの入口だけを確認できます。

```bash
node scripts/smoke-line-webhook.mjs http://localhost:3000/api/line/callback empty
node scripts/smoke-line-webhook.mjs http://localhost:3000/api/line/callback invalidSignature
node scripts/smoke-callback.mjs http://localhost:3000/api/lineworks/callback invalidSignature
```

実際の質問テストはOpenAI、LINE WORKS、Redisの各設定が必要です。

## 運用上の注意

返信案を直したい場合は「修正依頼」を押し、Botの案内後に修正内容をテキストで送ります。再作成された返信案には新しい承認ボタンが表示されます。古い返信案のボタンは無効になるため、必ず最新の返信案を確認してください。
1:1トークではLINE WORKSのCallbackにchannelIdが含まれないため、職員のuserIdを修正セッションの会話識別子として使用します。

- AIの返信案は必ず担当者が確認し、税務判断を自動送信しません。
- マイナンバー、本人確認書類、口座情報などをLINEで依頼しない運用にしてください。
- 顧問先のLINE userId、質問本文、返信案は個人情報としてアクセス制御・保存期間を管理してください。
- LINEとLINE WORKSのWebhookはraw bodyのまま署名検証してからJSON解析します。
- ログにはAPIキー、アクセストークン、秘密鍵、顧客メッセージ本文を出しません。

## 次の拡張候補

- 複数の修正履歴を確認できる管理画面
- 顧問先マスタとの紐付け
- 過去相談・契約範囲を検索するRAG
- 添付ファイルの安全な受付
- Teams承認への差し替え
- 監査ログと管理画面
