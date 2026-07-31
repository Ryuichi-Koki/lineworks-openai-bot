# Codex 作業指示書：スグ税 Critical / High 修正の検証と本番反映

作成日: 2026-07-31
対象リポジトリ: `Ryuichi-Koki/lineworks-openai-bot`
対象ブランチ: `feat/suguzei-rich-menu`（基点コミット `60195bd`）
関連文書: `SUGUZEI_UI_UX_REVIEW.md` / `SUGUZEI_SYSTEM_FLOW_REVIEW.md`

---

## 0. この指示書の前提

**コード修正は適用済みです。** あなたの仕事は「新規実装」ではなく、
**適用済みの修正を実データベース・実環境で検証し、安全に本番へ反映すること**です。

### 未検証の事項（最重要）

| 事項 | 状態 |
|---|---|
| `pnpm test`（単体136件） | ✅ 全件PASS（実行済み） |
| `pnpm typecheck` | ✅ PASS（実行済み） |
| `pnpm lint` | ✅ PASS（実行済み） |
| **`migrations/008` のSQL実行** | ❌ **未実行。実DBに一度も当てていない** |
| **`pnpm test:integration`（結合13件）** | ❌ **未実行。全件skip状態でしか確認していない** |
| LINE / LINE WORKS / Stripe の実機動作 | ❌ 未実施 |

`.env.local` が作業クローンに存在せずDB接続情報が無かったため、
migration 008 と結合テストは**構文・型の検査までしか行えていません**。
**§2 を最初に実施してください。ここで失敗した場合、以降の手順に進まないでください。**

### 絶対に守ること

- 秘密鍵・APIキー・パスワード・接続文字列を、ログ・コミット・チャット・PR本文へ出力しない
- 本番決済を実行しない（実課金E2Eは事務所の個別の明示許可を得てから）
- 本番の顧客データを変更しない（返金・削除・状態変更を含む）
- Stripeの鍵を削除・ローテーションしない
- `git push` と本番デプロイは、§5 の確認がすべて通ってから行う
- 旧月額契約（`PLAN_CONFIG.anshin`、subscription 関連）はテスト登録分のみであり、事務所確認により削除可（2026-07-31）。
  ただし今回のCritical / High修正とは分離し、専用のDBマイグレーション・回帰テスト・コミットで削除する

---

## 1. 適用済みの修正内容

### C-01: 税理士相談の決済がDB制約違反で成立しない

**原因**: `migrations/006` が `check (amount in (1000, 3000))` を定義していたが、
コミット `a982e7a`（価格を 1,100 / 3,300 へ改定）に対応するマイグレーションが無かった。
`createOrGetTaxReviewPayment` の INSERT が制約違反となり、決済ページを作成できない。

**修正**: `migrations/008_pricing_constraint_and_stale_reservations.sql`
- `tax_review_payments_amount_check` を削除し `check (amount > 0 and amount <= 1000000)` へ置換
- 価格の正しさは Stripe Price の実値照合（`lib/stripe/billing.ts:182-193`）と
  決済完了時の金額照合（`markTaxReviewPaymentPaid`）で担保する方針に統一。
  **今後、価格をDBのCHECK制約へ埋め込まないこと。**

### C-02: 決済が通っても税理士が相談内容を読めない

**原因**: `lib/tax/consultationService.ts` が直近6件の会話履歴を連結して**先頭から**1,600字で切っていた。
会話履歴は古い順（RPUSH）のため、支払対象の相談本文（末尾）が丸ごと落ちていた。
さらに `lib/lineworks/client.ts` の button_template で1,000字へ再truncateされていた。

**修正**:
- `buildConsultationStaffContext()` を新設し、**相談本文を必ず先頭に全文配置**。
  参考情報（直近のやり取り）は**末尾を残す形**で400字に切り詰める。受付日時（JST）も追加
- `sendStaffConsultationMessage()` を2通構成へ変更。
  本文はテキストメッセージ（1,900字枠）で送り、ボタンは別メッセージにした

### C-03: DB・HTTP・E2Eテストがゼロ

**修正**:
- `tests/integration/` を新設（13件）。`TEST_DATABASE_URL` 未設定なら自動でskipするため、
  DBが無い環境でも `pnpm test` は従来どおり完走する
- `package.json` に `test:integration` と `test:all` を追加
- 単体テストも追加: `tests/consultation-context.test.ts`（7件）/ `tests/lineworks-approvers.test.ts`（4件）

### H-01: 宙に浮いた利用予約が月間枠を永久に消費する

**修正（二重に防御）**:
1. **集計から除外**: `reserve_usage`（migration 008）と `getUsageSummary`（`lib/membership/store.ts`）が、
   30分を超えた `ai_answer` の `reserved` を上限に算入しない。
   **回収バッチが遅延・停止しても利用者は枠を失わない**
2. **回収**: `expireStaleUsageReservations()` を新設し、Vercel Cron（5分毎）の
   `reconcileTaxReviewDeliveries()` から呼ぶ。戻り値に `expiredReservations` を追加

`tax_review` は配送キューの再試行で数時間 `reserved` が続くのが正常なため、**対象外**にしている。

### H-02: 承認者制限のフェイルオープン

**修正**:
- `lib/lineworks/approvers.ts` を新設し、`isAuthorizedApprover` を切り出してフェイルクローズ化。
  **`LINEWORKS_APPROVER_USER_IDS` が未設定なら誰も承認できない**
- `scripts/check-production-config.mjs` の必須検査へ追加（未設定なら本番ビルドが失敗する）
- `README.md` の記述を実装に合わせて更新

### 変更ファイル一覧

```
新規:
  migrations/008_pricing_constraint_and_stale_reservations.sql
  lib/lineworks/approvers.ts
  tests/consultation-context.test.ts
  tests/lineworks-approvers.test.ts
  tests/integration/harness.ts
  tests/integration/usage-ledger.test.ts
  tests/integration/tax-review-payment.test.ts
  SUGUZEI_UI_UX_REVIEW.md
  SUGUZEI_SYSTEM_FLOW_REVIEW.md
  CODEX_INSTRUCTIONS_CRITICAL_FIXES.md（本書）

変更:
  lib/tax/consultationService.ts
  lib/tax/deliveryQueue.ts
  lib/lineworks/client.ts
  lib/membership/store.ts
  app/api/lineworks/callback/route.ts
  scripts/check-production-config.mjs
  scripts/apply-local-migrations.mjs
  scripts/apply-supabase-test-migrations.mjs
  scripts/apply-supabase-production-migrations.mjs
  package.json
  README.md
```

---

## 2. 【必須・最初に実施】ローカルDBでの検証

**ここが通らない限り、他の手順へ進まないでください。**

### 2-1. ローカルPostgresの準備

ポート `55432` で稼働している必要があります（起動中なら再実行不要）。

```bash
pnpm setup:postgres:local
```

`.env.local` が無い場合は `.env.example` を基に作成し、`POSTGRES_ADMIN_PASSWORD` を設定してください。

### 2-2. migration 008 の適用

```bash
pnpm migrate:postgres:local
```

**期待結果**: エラーなく `Local test migrations are applied.` が出力される。

失敗した場合は、次を確認して**修正内容を報告してから**進めてください。
- 制約名が `tax_review_payments_amount_check` でない可能性
  ```sql
  select conname, pg_get_constraintdef(oid)
  from pg_constraint
  where conrelid = 'tax_review_payments'::regclass;
  ```
- `reserve_usage` の再定義で戻り値の型が衝突していないか

### 2-3. 制約が置き換わったことの確認

```bash
psql "$DATABASE_URL" -c "select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'tax_review_payments'::regclass and conname like '%amount%';"
```

**期待結果**: `CHECK ((amount > 0) AND (amount <= 1000000))` が返り、
`amount = ANY (ARRAY[1000, 3000])` が**存在しない**こと。

### 2-4. 結合テストの実行

```bash
TEST_DATABASE_URL="<ローカルapexbrain_testの接続文字列>" pnpm test:integration
```

**期待結果**: 13件すべてPASS。skipが1件でも残る場合は `TEST_DATABASE_URL` が読めていません。

特に重要な3件（これが落ちたら修正が不完全）:
- `I-1: 現在の価格で決済レコードを作成できる（C-01の回帰防止）`
- `I-2: 残り1回のとき20並列で予約しても成功は1件だけ`
- `I-3: 30分を過ぎた ai_answer の予約は上限へ算入しない（H-01の回帰防止）`

### 2-5. 全チェックの再実行

```bash
pnpm typecheck && pnpm lint && pnpm test
```

**期待結果**: typecheck・lintはエラー0、テストは136件PASS。

### 2-6. 報告

§2 の結果を、次の形式で報告してください（**接続文字列は書かないこと**）。

```
migration 008 適用: 成功 / 失敗（エラー要約）
制約確認: amount > 0 and amount <= 1000000 / 旧制約が残存
結合テスト: 13件中 N件PASS / 落ちたテスト名
typecheck / lint / test: 結果
```

---

## 3. Supabaseテスト環境での検証

ローカル検証が通ってから実施します。

```bash
DATABASE_URL="<Supabaseテストプロジェクトのプーラー接続>" \
SUPABASE_TEST_PROJECT_REF="<テストプロジェクトref>" \
ALLOW_SUPABASE_TEST_MIGRATIONS=yes \
pnpm migrate:supabase:test
```

`scripts/apply-supabase-test-migrations.mjs` は 006〜008 を追加済みです。
**このスクリプトは接続先がSupabaseテスト用プーラーであることを検証してから実行します。**
本番プーラーを指すとエラーで停止するので、そのまま実行して構いません。

続けて結合テストをテスト環境に対しても実行します。

```bash
TEST_DATABASE_URL="<同じテスト接続>" ALLOW_SUPABASE_TEST_MIGRATIONS=yes pnpm test:integration
```

---

## 4. テストモードでの実機E2E

**実課金は行いません。Stripeはテストモードで実施します。**

`ONE_TIME_CONSULTATION_BILLING_ENABLED=true` / `STRIPE_MODE=test` の環境で、
LINE実機（テストアカウント）から次を確認してください。

| # | 手順 | 合格条件 |
|---|---|---|
| E-1 | AI回答を3往復する | 残回数が正しく減る |
| E-2 | リッチメニュー「税理士相談」→相談内容を入力 | 内容確認カードに**入力した相談内容が全文表示される** |
| E-3 | 「この内容で依頼する」→決済ボタンが出る | **決済ページが作成される（C-01の実地確認）**。金額が1,100円 |
| E-4 | Stripeテストカード `4242...` で決済 | 受付完了メッセージがLINEに届く |
| E-5 | **LINE WORKSの通知本文を確認** | **E-2で入力した相談内容が全文読める（C-02の実地確認）**。AI雑談だけになっていない |
| E-6 | 「この相談に回答」→回答文入力→「公式LINEへ送信」 | 利用者に `👤 Apex Brain税理士法人からの回答` が届く |
| E-7 | 決済ボタンを連打する | 決済は1件のみ。「二重請求は発生しません」が出る |
| E-8 | `LINEWORKS_APPROVER_USER_IDS` から自分のIDを外して E-6 を再試行 | **403で拒否される（H-02の実地確認）**。確認後にIDを戻す |
| E-9 | リッチメニュー6アクション | すべて反応する |

**E-5 と E-8 は今回の修正の核心です。必ず実施してください。**

---

## 5. コミットとPR

§2〜§4 がすべて通ってから実施します。

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: repair tax consultation payments and staff handoff

税理士相談の決済と、税理士への相談内容の受け渡しを修正する。

- 決済金額のCHECK制約を実価格から切り離す（migration 008）。
  価格改定（1,100 / 3,300円）に対応するマイグレーションが無く、
  決済レコードのINSERTが必ず制約違反になっていた。
- 税理士へ渡す本文に相談内容を全文含める。会話履歴を先頭から
  切っていたため、支払対象の相談本文が落ちていた。
- 取り残された利用予約を上限計算から除外し、Cronで回収する。
  関数タイムアウトのたびに月間枠が永久に減っていた。
- 承認者リスト未設定時をフェイルクローズにし、本番設定検査へ追加する。
- 実データベースに対する結合テストを追加する。上記の不具合は
  すべて単体テストだけでは検出できなかった。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

PRを作成する場合は、本文に §1 の修正内容と §2〜§4 の検証結果を記載してください。
**接続文字列・鍵・顧客情報は書かないでください。**

---

## 6. 本番反映（事務所の承認が必要）

**この節は、事務所の明示的な承認を得てから実行してください。**

### 6-1. 事前バックアップ（必須）

```bash
pnpm backup:supabase:production
```

`SUPABASE_BACKUP_RUNBOOK.md` に従い、取得したバックアップが復元可能であることを確認します。

### 6-2. migration 008 の本番適用

```bash
pnpm migrate:supabase:production
```

**適用順序が重要です。migration を先に、コードのデプロイを後に行ってください。**

- 先にコードをデプロイすると、新しい `getUsageSummary` のSQLは旧スキーマでも動作しますが、
  決済は旧制約のままなので C-01 が解消しません
- 先に migration を当てても、旧コードは正常に動作します（制約が緩くなるだけ）
- したがって **migration → デプロイ** の順が安全です

適用後、次を確認します。

```sql
-- 制約が置き換わったこと
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'tax_review_payments'::regclass and conname like '%amount%';

-- reserve_usage が再定義されたこと
select prosrc like '%v_stale_before%' as updated
from pg_proc where proname = 'reserve_usage';
```

### 6-3. 環境変数の確認

**値は出力せず、存在と形式だけ確認してください。**

Vercel Production に `LINEWORKS_APPROVER_USER_IDS` が設定されていることを必ず確認します。
**未設定のまま本番ビルドすると、`check-production-config.mjs` がビルドを中止します**（意図した動作です）。

未設定だった場合は、承認可能な職員のLINE WORKS userIdをカンマ区切りで設定してください。

### 6-4. デプロイ

```bash
pnpm build   # check-production-config.mjs が全項目PASSすることを確認
```

Vercel Production へデプロイし、`pnpm check:production:public` で公開6ページのHTTP 200を確認します。

### 6-5. 反映後の確認

| # | 確認内容 | 方法 |
|---|---|---|
| 1 | Cronが `expiredReservations` を返す | `/api/internal/tax-review-deliveries` のログ |
| 2 | 税理士相談の決済ページが作成できる | **テストモードで再確認後、実課金は事務所の個別許可を得てから** |
| 3 | LINE WORKS通知に相談本文が全文出る | 実機 |
| 4 | 承認者リストの職員だけが回答送信できる | 実機 |

---

## 7. 積み残し（今回の修正に含まれていないもの）

`SUGUZEI_UI_UX_REVIEW.md` §D・§F を参照してください。特に次は**未対応**です。

| ID | 内容 | 対応時期 |
|---|---|---|
| H-10 | 配送ジョブ再投入時に `status` がリセットされない（`enqueueTaxReviewDelivery` の `on conflict`）。返金取消・再開時にジョブが復活しない | 公開前が望ましい |
| H-05 | 税理士側に未回答相談一覧が無い。規約の「5営業日以内」を守れているか把握できない | 公開後1か月以内 |
| H-07 | 退会・データ削除が未実装。プライバシーポリシーは削除権を明記している | 公開後1か月以内（法務判断が前提） |
| H-08 | 相談・監査記録がRedis（TTL付き）にしかなく、閲覧手段が無い | 公開後1か月以内 |
| H-03 | 管理画面がLINE userIdを `title` 属性と `?user=` に平文出力 | 公開後1か月以内 |
| H-06 | `shouldAutoReply()` が未使用。レベルC・低信頼の回答も自動送信される | 事務所の体制判断が必要 |
| M-04 | `CODEX_HANDOVER_SUGUZEI.md` と `docs/PRICING_CHANGE_2026-07-30.md` の価格が 1,000/3,000 のまま（正: 1,100/3,300） | 随時 |
| M-11 | 作業ツリーが `lineworks-openai-bot-dev`（git無し）と本クローンの2系統ある | 随時 |
| 運用 | Stripe本番Webhookが必要10イベントを全購読しているか未確認 | **公開前必須** |

### M-04 について

文書の価格記載が古いままです。運用者が誤った価格を案内する原因になるため、
§5 のコミットとは別に、次の2ファイルを 1,100円 / 3,300円へ修正することを推奨します。

- `CODEX_HANDOVER_SUGUZEI.md` の「税理士相談は通常1回3,000円（税込）、2026年12月31日までは1回1,000円（税込）」
- `docs/PRICING_CHANGE_2026-07-30.md` の料金節

**ただし、正しい価格が 1,100/3,300 であることを事務所に確認してから修正してください。**
逆に 1,000/3,300 が正なら、`lib/stripe/consultationPricing.ts` と法務文書・Stripe Price の側を直す必要があります
（`SUGUZEI_UI_UX_REVIEW.md` §G Q3）。

---

## 8. 作業中に判断が必要になった場合

次のいずれかに該当したら、**作業を止めて事務所へ確認してください。**

- migration 008 の適用で、想定外の制約名・依存関係が出た
- 結合テストが落ち、原因が今回の修正ではなく既存仕様にある
- 本番DBの `tax_review_payments` に既存行があり、新しい制約に違反する
  （`select * from tax_review_payments where amount <= 0 or amount > 1000000;` で事前確認）
- 実課金を伴う確認が必要になった
- 法務文書・価格・保存期間の変更が必要になった
