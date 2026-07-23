# Stripe 本番移行・運用手順書

対象: abtax.jp の税務・会計サービス
対象製品: Stripe Payments / Billing / Invoicing / Tax
作成日: 2026-07-23

## 1. 現在の結論

Sandbox とローカル PostgreSQL を使った購入、Webhook、会員権反映、
Customer Portal からの期間末解約は確認済みです。

ただし、現在のコードは意図的に Stripe 本番モードを拒否します。

- `lib/stripe/config.ts` は `sk_test_` 以外の秘密鍵を拒否する。
- `app/api/stripe/webhook/route.ts` は `livemode=true` のイベントを拒否する。
- `scripts/check-stripe-readiness.mjs` は `sk_live_` を検出すると停止する。

したがって、現状をそのまま本番へ配置しても本番課金は開始できません。
これは事故防止のための正常な停止状態です。本番対応コードへの変更、本番用
Secrets、DB migration、デプロイ、実顧客への有効化、Git push は、それぞれ
明示承認後にだけ実施します。

## 2. 権限と承認

| 操作 | 必要な承認 |
| --- | --- |
| Sandbox のテスト、ローカル DB のテスト | 開発担当 |
| 本番用 Product / Price / Portal / Webhook の作成 | 事業責任者 |
| 税率、税込・税抜表示、適格請求書の記載 | 税務責任者 |
| 返金、Credit Note、請求書の取消 | 金額権限を持つ承認者 |
| `sk_live_` 等の本番 Secrets 登録 | システム責任者 |
| 本番 DB migration / deployment | システム責任者 |
| 実顧客を課金対象にする | 事業責任者とシステム責任者 |
| Git push | リポジトリ責任者 |

一人で「設定・実行・承認」を完結させず、特に返金と本番課金は操作記録と
承認記録を残します。

## 3. 本番化の前提条件

### 3.1 業務要件

- 商品名、価格、課金周期、税込・税抜表示を承認済みにする。
- 利用規約、解約時点、期間末までの利用権、日割りの有無を明示する。
- 返金方針と承認金額の上限を決める。
- 請求書の記載事項、適格請求書対応、保存期間を税務責任者が承認する。
- Stripe Tax の事業所在地、登録、Product tax code、tax behavior を確認する。

日本の税務・法務判断は Stripe の設定だけでは確定しません。責任者の承認を
本番開始の必須条件とします。

### 3.2 技術要件

- `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build` が成功する。
- 本番と同等のステージング環境で購入、更新、失敗、重複、順序逆転、
  期間末解約、解約完了を確認する。
- 本番 DB の暗号化接続、バックアップ、復旧試験、最小権限を確認する。
- 本番 URL は HTTPS とし、`/api/stripe/webhook` を外部から到達可能にする。
- Stripe Dashboard には実装済みのイベントだけを登録する。

対象イベント:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
invoice.voided
```

Stripe はイベントの重複や順序逆転があり得ます。本実装は
`webhook_events` の `(provider, event_id)` と payload hash で重複を抑止し、
必要な Subscription は Stripe API から再取得して反映します。Stripe の
[Webhook運用ガイド](https://docs.stripe.com/webhooks)も、重複処理対策、
必要イベントだけの購読、非同期処理を推奨しています。

## 4. 本番環境変数

値は Secrets 管理機能に登録し、`.env*`、ソース、チケット、チャット、
スクリーンショット、ログ、Git に保存しません。

```text
DATABASE_URL
DATABASE_SSL_MODE=require
MEMBERSHIP_BILLING_ENABLED=false
STRIPE_BILLING_ENABLED=false
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_ANSHIN
STRIPE_PRICE_PREMIUM
STRIPE_PORTAL_CONFIGURATION_ID
STRIPE_APP_BASE_URL=https://...
```

- `STRIPE_SECRET_KEY`: 本番では制限付きキーを優先し、必要権限だけを付与する。
- `STRIPE_WEBHOOK_SECRET`: API キーとは別の、対象 Endpoint 固有の署名Secret。
- Price、Portal configuration、Webhook Endpoint は test/live 間で別物として
  作成する。
- 公開可能キーは、現行の Stripe-hosted Checkout / Portal のサーバー統合では
  必須ではない。ブラウザで Stripe.js を使う機能を追加するときだけ
  `pk_live_` を公開側へ設定する。

Stripe の公式資料でも test/live のキーとオブジェクトは分離され、秘密鍵は
安全な環境に保存する必要があります。
[API keys](https://docs.stripe.com/keys) /
[Go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)

## 5. 本番対応コードの変更方針

明示承認を得た後、単純にガードを削除するのではなく環境を明示します。

1. `APP_ENV=production` など、デプロイ環境を一意に判定する値を導入する。
2. production では `sk_live_` と `livemode=true` だけを許可する。
3. non-production では `sk_test_` と `livemode=false` だけを許可する。
4. キーとイベントの mode が不一致なら起動またはWebhook処理を停止する。
5. 本番用 readiness check を別に用意し、値を一切表示しない。
6. 本番用 Price / Portal / Webhook IDs が test IDs と混在しないことを検査する。

## 6. 移行手順

### Phase A: 機能フラグ OFF で配置

1. 本番 DB のバックアップと復旧点を確保する。
2. migration をレビューし、トランザクション内で適用する。
3. 本番 Secrets を Secrets 管理機能へ登録する。
4. `MEMBERSHIP_BILLING_ENABLED=false`、
   `STRIPE_BILLING_ENABLED=false` のままデプロイする。
5. health check、DB接続、LINE既存回答、LINE WORKS相談が退行していないことを
   確認する。

### Phase B: Webhook のみ有効化

1. Stripe live mode に本番 Endpoint を作成する。
2. 上記7イベントだけを購読する。
3. Endpoint の Signing secret を本番 Secrets に設定する。
4. Stripe Dashboard からテスト配信し、HTTP 2xx と
   `webhook_events.processing_status=processed` を確認する。
5. 顧客向け Checkout はまだ表示しない。

### Phase C: 限定有効化

1. 社内または明示同意済みの少数アカウントだけを対象にする。
2. 価格、税、領収・請求表示、LINE案内、Portal解約を人が確認する。
3. Stripe Customer / Subscription / Invoice と PostgreSQL の対応を照合する。
4. 問題がなければ段階的に対象を広げる。

### Phase D: 通常運用

監視と日次照合が安定した後にのみ全対象へ展開します。一度に機能フラグを
全面開放しません。

## 7. Go / No-Go チェック

- [ ] 税務・価格・規約・解約・返金文言の承認
- [ ] 本番対応コードのレビューとテスト
- [ ] 本番 DB バックアップと migration 承認
- [ ] 本番 Secrets の登録とアクセス権確認
- [ ] live Product / Price / Portal / Tax の目視確認
- [ ] live Webhook の署名確認と疎通
- [ ] LINE、LINE WORKS、管理画面の退行テスト
- [ ] 限定ユーザーでの実額テスト承認
- [ ] 監視担当、障害連絡先、返金承認者の確定
- [ ] ロールバック手順の確認

一つでも未完了なら No-Go です。

## 8. 監視と日次照合

機密値や LINE user ID の原文を通常ログへ出しません。管理画面または限定した
DB セッションで次を確認します。

```sql
select processing_status, event_type, count(*)
from webhook_events
where provider = 'stripe'
  and created_at >= now() - interval '24 hours'
group by processing_status, event_type
order by processing_status, event_type;

select plan_code, membership_status, count(*)
from users
where membership_provider = 'stripe'
group by plan_code, membership_status
order by plan_code, membership_status;
```

アラート対象:

- Stripe Webhook の 400 / 500 増加
- `failed` または10分を超える `processing`
- `past_due` の急増
- Customer / Subscription の対応不能
- Stripe では有効だが PostgreSQL は free、またはその逆
- Checkout 作成失敗、Portal 作成失敗

Stripe live Webhook は失敗時に最大3日程度再試行されます。手動再送も可能です。
再送前に `webhook_events` を確認し、成功済みイベントを二重に業務処理しないで
ください。
[Webhook retries](https://docs.stripe.com/webhooks) /
[Process undelivered events](https://docs.stripe.com/webhooks/process-undelivered-events)

## 9. 障害対応

### 9.1 Webhook が 400

1. Endpoint URL と環境を確認する。
2. APIキーではなく、その Endpoint の Signing secret か確認する。
3. raw body を改変していないか確認する。
4. test/live の取り違えを確認する。
5. Secret 値は表示せず、prefix と存在有無だけで診断する。

### 9.2 Webhook が 500

1. Stripe Dashboard の event ID と event type を記録する。
2. `webhook_events.processing_result` とサーバー例外を確認する。
3. Stripe上のCustomer / Subscription / Invoiceの現在状態を確認する。
4. 原因修正後、同じ event を再送する。
5. `processed` になり、会員状態がStripeと一致したことを確認する。

### 9.3 重複または順序逆転

- 同じ event ID は再処理せず 2xx を返す。
- event ID が同じで payload hash が異なる場合は不正として停止する。
- 古いイベントだけを信頼せず、必要に応じて Stripe API から現状態を取得して
  再同期する。

### 9.4 Stripe と会員台帳が不一致

1. LINE user ID、Customer ID、Subscription ID の対応を限定権限で確認する。
2. Stripeを請求状態の正本とする。
3. 対象 Subscription の現状態から署名済み再同期を行う。
4. 修正前後の状態、操作者、承認者、event ID を監査記録に残す。
5. 直接SQL更新は最終手段とし、二者承認とバックアップを必須にする。

### 9.5 本番キーの漏えいまたは誤使用

1. Checkout と請求作成の機能フラグを OFF にする。
2. Stripe Dashboard で該当キーを直ちにローテーションまたは失効する。
3. ログ、Git履歴、CI、端末、チケットを調査する。
4. 不審なCustomer / Payment / Invoice / Refundを確認する。
5. 影響、対応、再発防止を記録する。

## 10. 解約

顧客導線:

```text
LINE「退会したい」
  → Stripe Customer Portal
  → 期間末解約を確定
  → customer.subscription.updated
  → PostgreSQL: cancel_at_period_end
  → 支払済み期間中は anshin の権利を維持
  → customer.subscription.deleted
  → PostgreSQL: canceled / free
```

- Stripe が `cancel_at_period_end=true` または将来の `cancel_at` を返した場合、
  ローカル状態は `cancel_at_period_end` とする。
- 解約予約時点では支払済み期間の権利を停止しない。
- 解約完了イベントで free に戻す。
- 解約、即時停止、返金は別の操作である。解約だけを理由に自動返金しない。
- 誤解約の復旧は、Stripe上の状態と規約を確認してから承認者が行う。

## 11. 支払失敗

`invoice.payment_failed` を受けるとローカルは `past_due` と支払失敗時刻を記録
します。

1. Stripe の再試行設定とCustomer Portalの支払方法更新を案内する。
2. 直ちに手動解約・返金・DB削除をしない。
3. Stripeの最終Subscription状態をWebhookで反映する。
4. 顧客への通知文は個人情報とカード情報を含めない。

## 12. 返金・Credit Note

返金は現在のLINE自動導線には実装しません。承認を伴う運用操作とします。

1. 顧客、Invoice / Payment、金額、理由、解約状態を特定する。
2. 承認者が全額・一部、返金方法、サービス権利への影響を決定する。
3. 確定済み請求書の減額は Credit Note を使用する。
4. 支払済み請求書では、返金、Customer balanceへの充当、または
   out-of-band credit の扱いを会計方針に合わせる。
5. 操作者、承認者、理由、金額、Stripe object ID、日時を監査記録へ残す。
6. 顧客へ処理内容と反映時期を通知する。
7. 返金後もSubscriptionが継続する場合があるため、解約要否を別に確認する。

Stripeでは確定済みInvoiceの訂正にCredit Noteを使い、Credit Note総額は
Invoice金額を超えられません。可能な限り対象line itemを指定します。
[Credit notes](https://docs.stripe.com/invoicing/dashboard/credit-notes) /
[Programmatic credit notes](https://docs.stripe.com/invoicing/integration/programmatic-credit-notes)

## 13. 請求書と Tax

- 専門業務の請求は、承認済み `engagementId` を冪等キーにする。
- `description`、金額、通貨、tax code、tax behavior、支払期限を承認する。
- Invoice Item作成後にInvoice作成が失敗した場合の孤立項目を照合する。
- Hosted Invoice Page の顧客表示を本番前に確認する。
- Stripe Tax の計算結果と会計処理をサンプル取引で照合する。
- 適格請求書の要件や帳簿保存は、責任税理士の承認を得る。

## 14. ロールバック

1. `STRIPE_BILLING_ENABLED=false` にして新規Checkoutを停止する。
2. 必要なら `MEMBERSHIP_BILLING_ENABLED=false` にして会員DB連携を停止する。
3. LINEの既存回答とLINE WORKS相談を維持する。
4. Webhookは、データ損失を避けるため原則停止せず受信・監査を継続する。
5. 修正後にStripeの未配信イベントを再送し、台帳を再同期する。
6. 既存Subscriptionを一括解約・返金しない。顧客影響を個別評価する。

## 15. 監査記録

最低限、次を改ざん困難な記録として保持します。

- 承認内容と承認者
- Stripe event ID / object ID
- 操作種別、理由、金額、実施日時、操作者
- 変更前後の状態
- Webhookの処理結果
- 障害の検知、復旧、顧客通知

カード番号、CVC、秘密鍵、Webhook secret は保存しません。
