# LINE WORKS Bot + OpenAI Staff Review MVP

LINE WORKS Bot の Callback で顧客からの text メッセージを受信し、OpenAI Responses API で返信案を生成して、担当者確認用の LINE WORKS トークルームへ送信する Next.js App Router アプリです。

この MVP は顧客へ自動返信しません。担当者が LINE WORKS 上で返信案と確認事項を確認してから、最終判断して送信する前提です。

## 技術構成

- TypeScript
- Next.js App Router
- Node.js runtime
- `POST /api/lineworks/callback`
- LINE WORKS Callback 署名検証: `X-WORKS-Signature` + `LINEWORKS_BOT_SECRET` の HMAC-SHA256/Base64
- OpenAI Responses API
- LINE WORKS Service Account JWT 認証
- LINE WORKS Bot API channel message send
- Access Token のメモリキャッシュ

## セットアップ

```bash
npm install
cp .env.example .env.local
```

`.env.local` に以下を設定します。

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

LINEWORKS_CLIENT_ID=
LINEWORKS_CLIENT_SECRET=
LINEWORKS_SERVICE_ACCOUNT=
LINEWORKS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
LINEWORKS_BOT_ID=
LINEWORKS_BOT_SECRET=
LINEWORKS_STAFF_CHANNEL_ID=
```

`LINEWORKS_PRIVATE_KEY` は改行を `\n` として 1 行で設定できます。実行時に PEM 形式へ戻します。

## LINE WORKS 設定

1. Developer Console で Bot を作成します。
2. Bot Secret を取得し、`LINEWORKS_BOT_SECRET` に設定します。
3. Bot ID を `LINEWORKS_BOT_ID` に設定します。
4. Callback URL に以下を設定します。

```text
https://your-domain.example/api/lineworks/callback
```

`/lineworks/callback` で登録済みの場合も同じ処理へ転送されますが、基本のエンドポイントは `/api/lineworks/callback` です。

5. Client App で Service Account と Private Key を発行します。
6. Bot API 送信用に `bot.message` scope を利用できるようにします。
7. 担当者確認用トークルームの channelId を `LINEWORKS_STAFF_CHANNEL_ID` に設定します。

## 起動

```bash
npm run dev
```

ローカルでは `http://localhost:3000/api/lineworks/callback` が Callback エンドポイントです。LINE WORKS の Callback URL には HTTPS が必要なため、公開環境へデプロイするか、検証時は HTTPS トンネルを利用してください。

## 処理フロー

1. LINE WORKS Callback を raw body で受信します。
2. `X-WORKS-Signature` を検証します。
3. 署名検証に失敗した場合は `401` を返します。
4. text メッセージ以外は `200` で無視します。
5. 顧客質問文を OpenAI Responses API に渡します。
6. GPT が返信案と確認事項を JSON で返します。
7. 担当者用 LINE WORKS トークルームへ以下の形式で送信します。

```text
【顧客からの質問】
{customerMessage}

【GPT返信案】
{draftReply}

【確認事項】
{checkItems}

【注意】
この返信案はAI生成です。送信前に担当者が内容を確認してください。
```

## セキュリティとログ

- 顧客メッセージ本文はエラーログに出しません。
- OpenAI API キー、LINE WORKS Client Secret、Bot Secret、Private Key はログに出しません。
- LINE WORKS Access Token はプロセスメモリにのみキャッシュし、有効期限前に再取得します。
- 署名検証は timing-safe comparison で行います。
- Callback は必ず HTTPS で公開してください。

## 動作確認

```bash
npm run typecheck
npm run build
```

署名付き Callback の手動テストでは、送信する JSON 文字列と `LINEWORKS_BOT_SECRET` から HMAC-SHA256/Base64 の署名を作成し、`X-WORKS-Signature` ヘッダーに指定してください。

### Callback スモークテスト

開発サーバーを起動します。

```bash
npm run dev
```

別ターミナルで `.env.local` の `LINEWORKS_BOT_SECRET` を読み込める状態にして、署名 NG の確認をします。`401` が返れば正常です。

```bash
node scripts/smoke-callback.mjs http://localhost:3000/api/lineworks/callback invalidSignature
```

text 以外のメッセージが無視されることを確認します。`200` と `{"ok":true,"ignored":true}` が返れば正常です。

```bash
node scripts/smoke-callback.mjs http://localhost:3000/api/lineworks/callback nonText
```

text メッセージの処理を確認します。このテストは OpenAI API と LINE WORKS Bot API まで実際に呼び出します。`200` と `{"ok":true}` が返り、担当者用トークルームに通知が届けば正常です。

```bash
node scripts/smoke-callback.mjs http://localhost:3000/api/lineworks/callback text
```

本番の「LINE WORKS から Callback が届くか」は、公開 HTTPS URL を LINE WORKS Developer Console の Callback URL に設定し、Bot が参加しているトークルームから text メッセージを送って確認してください。
