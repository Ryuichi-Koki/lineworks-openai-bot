# ApexBrain LINE問い合わせ承認ボット

顧問先からLINE公式アカウントへ届いた質問をGPTが分類し、返信案をLINE WORKSへ送ります。担当者が「承認して送信」を押した場合だけ、顧問先へ返信します。

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
- LINE WORKS Callbackの署名検証
- 承認者の任意ホワイトリスト
- 承認後のLINE Push送信
- 二重送信を避ける案件ステータス遷移とLINEリトライキー
- Webhook再送時の重複案件防止
- Upstash Redis保存（本番）／メモリ保存（ローカル）

## エンドポイント

| 用途 | URL |
|---|---|
| LINE公式アカウント Webhook | `POST /api/line/callback` |
| LINE WORKS Bot Callback | `POST /api/lineworks/callback` |

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

Responses APIのStructured Outputsを使い、分類結果をJSONスキーマで固定しています。

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

`LINEWORKS_APPROVER_USER_IDS` に承認可能な職員のLINE WORKS userIdをカンマ区切りで設定できます。空欄の場合は、そのBotのボタンを押せる全メンバーを許可します。本番では設定を推奨します。

### 4. 案件保存

本番ではUpstash Redisを作成し、次を設定してください。

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

未設定の場合はプロセスメモリを使います。開発確認には使えますが、再起動やサーバーレスインスタンスの切替で案件が消えるため、本番運用には使用できません。

## 動作確認

```bash
npm run typecheck
npm run build
```

開発サーバーを起動した状態で、署名付きWebhookの入口だけを確認できます。

```bash
node scripts/smoke-line-webhook.mjs http://localhost:3000/api/line/callback empty
node scripts/smoke-line-webhook.mjs http://localhost:3000/api/line/callback invalidSignature
node scripts/smoke-callback.mjs http://localhost:3000/api/lineworks/callback invalidSignature
```

実際の質問テストはOpenAI、LINE WORKS、Redisの各設定が必要です。

## 運用上の注意

- AIの返信案は必ず担当者が確認し、税務判断を自動送信しません。
- マイナンバー、本人確認書類、口座情報などをLINEで依頼しない運用にしてください。
- 顧問先のLINE userId、質問本文、返信案は個人情報としてアクセス制御・保存期間を管理してください。
- LINEとLINE WORKSのWebhookはraw bodyのまま署名検証してからJSON解析します。
- ログにはAPIキー、アクセストークン、秘密鍵、顧客メッセージ本文を出しません。

## 次の拡張候補

- 返信案の編集画面
- 顧問先マスタとの紐付け
- 過去相談・契約範囲を検索するRAG
- 添付ファイルの安全な受付
- Teams承認への差し替え
- 監査ログと管理画面
