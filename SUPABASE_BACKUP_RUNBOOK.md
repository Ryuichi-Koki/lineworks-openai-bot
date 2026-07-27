# Supabase本番DB バックアップ・復旧手順

更新日: 2026-07-27

## 現在の構成

- プロジェクト: `apexbrain-production`
- リージョン: 東京
- 接続: Supabase Transaction Pooler、TLS必須
- 現在のプラン: Free
- Supabase管理画面のScheduled backups: 対象外

## 当面のバックアップ

正式公開前、デプロイ前、DB migration前に次を実行する。

```powershell
$env:DATABASE_URL="<Vercel Productionと同じ接続文字列>"
pnpm exec node scripts/backup-supabase-production.mjs
```

バックアップは`.backups/`へPostgreSQL custom形式で保存される。同時に
SHA-256、作成日時、復旧コマンドを記載したmanifestを作成する。
`.backups/`はGit管理対象外とし、アクセス制限された事務所管理領域で保管する。

## 復旧試験

本番DBへ直接復元しない。空の検証用PostgreSQLを用意し、次の順に確認する。

1. manifestのSHA-256とdumpファイルのSHA-256を照合する。
2. 検証用DBの接続先であることを二名で確認する。
3. `pg_restore`で復元する。
4. `plans`、`users`、`usage_events`、`webhook_events`、
   `review_requests`、`stripe_billing_objects`、`tax_review_intakes`、
   `policy_acceptances`、`admin_audit_logs`の存在を確認する。
5. 本番値を変更せず、件数と外部キーの整合性だけを確認する。
6. 復旧試験の実施日時、担当者、結果を記録する。

## 正式公開前の推奨

Supabase Pro等の管理バックアップが利用できるプランへ変更し、
Scheduled backupsの保持期間とRestore to new projectを確認する。
プラン変更は追加費用が発生するため、事業責任者の承認後に行う。
