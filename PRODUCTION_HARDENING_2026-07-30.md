# スグ税 本番強化記録

更新日: 2026-07-30

## 対象

- LINE公式アカウントの無料AI回答（月100件）
- 税理士へのLINE個別相談（1件ごとのStripe決済）
- 2026年中のテスト価格1,100円（税込）
- 2027年以降の通常価格3,300円（税込）
- 旧「あんしん会員」月額契約の経過措置

## 今回の変更

### 決済と相談受付

- 相談内容の確認後にStripe Checkoutへ進む順序を維持した。
- Checkout画面には、金額、自動更新ではないこと、提供開始時点、返金条件を表示する。
- 決済前に「内容を入力し直す」「支払いをやめる」を選べる。
- Checkoutの期限切れ・非同期決済失敗時は、相談を下書きへ戻してLINEへ再試行方法を通知する。
- 旧月額契約の相談枠は「旧契約の特典・追加決済なし」と明示し、都度課金と混同させない。

### 配送の信頼性

- Stripe Webhookで外部通知を直接完了扱いにせず、`tax_review_delivery_jobs`へ先に記録する。
- LINE WORKS通知、利用者への受付通知、会話履歴保存を個別の処理済み時刻で管理する。
- Vercel Cronが5分ごとに未完了ジョブ、停止した処理、決済済み未登録ジョブを照合・再送する。
- 最大8回失敗した案件は管理画面とLINE WORKSへ警告し、利用者には二重決済をしないよう案内する。
- 管理画面から失敗ジョブを監査ログ付きで再送できる。

### 返金

- `refund.created`、`refund.updated`、`refund.failed`を受信する。
- 全額返金、一部返金、返金失敗を台帳へ記録し、LINE通知を区別する。
- 全額返金済みで未配送の相談ジョブはキャンセルする。

### UIとセキュリティ

- リッチメニューの「契約管理」を「利用状況・退会」へ変更した。
- 料金プラン、マイページ、規約、相談、退会の案内を現行の都度課金へ統一した。
- CSP、HSTS、クリックジャッキング防止、MIMEスニッフィング防止等のヘッダーを追加した。
- Production build時に、秘密値を出力せず必須環境変数の形式とtest/live混在を検査する。

## DB

`migrations/007_tax_review_delivery_and_refunds.sql`で次を追加する。

- `tax_review_payments.refunded_amount`
- `tax_review_refunds`
- `tax_review_delivery_jobs`
- `canceled`、`partially_refunded`の決済状態

2026-07-30にSupabase本番プロジェクト
`jveigdwsnfimlyhkqgdv`へ適用し、2テーブルと1カラムの存在を確認済み。

## Vercel

- `CRON_SECRET`はVercelへSensitive値として登録済み。値はログ・Git・本文へ保存しない。
- `vercel.json`で`/api/internal/tax-review-deliveries`を5分間隔で起動する。
- 本番デプロイは`scripts/check-production-config.mjs`を通過した場合だけ成功させる。

## Stripe Webhook

本番Endpointは次のイベントを購読する。

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
refund.created
refund.updated
refund.failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
invoice.voided
```

`npm run sync:stripe:webhook:production -- --confirm-live`は、ライブ秘密鍵とEndpoint URLを
照合してから購読イベントを同期する。ライブキーをコマンド、ログ、Gitへ記載しない。

## 日次確認

1. Vercel Production DeploymentがReadyであること。
2. LINE、LINE WORKS、Stripe Webhook、Cronに5xxがないこと。
3. Stripe Workbenchに未配信イベントがないこと。
4. `/admin/members`で配送失敗が0件であること（管理画面を有効化している場合）。
5. Supabaseで長時間`processing`の配送ジョブがないこと。

```sql
select status, count(*)
from tax_review_delivery_jobs
group by status
order by status;

select processing_status, event_type, count(*)
from webhook_events
where provider = 'stripe'
  and created_at >= now() - interval '24 hours'
group by processing_status, event_type
order by processing_status, event_type;
```

## 障害時

1. 新規の税理士相談決済を止める場合は
   `ONE_TIME_CONSULTATION_BILLING_ENABLED=false`へ変更して再デプロイする。
2. 決済済み案件は削除せず、配送ジョブの状態・StripeイベントID・相談案件IDを確認する。
3. 配送失敗は管理画面から再送する。利用者に再決済を依頼しない。
4. 返金はStripe上で承認者が実施し、WebhookでDBとLINE通知へ反映させる。
5. アプリ障害は直前の正常なVercel Deploymentへロールバックする。

## リリース検証

- Node tests: 118件合格
- TypeScript: 合格
- ESLint: 合格
- Next.js production build: 合格（webpack）
- ローカルPostgreSQL migration 001〜007: 合格
- Supabase本番 migration 007: 適用・存在確認済み
