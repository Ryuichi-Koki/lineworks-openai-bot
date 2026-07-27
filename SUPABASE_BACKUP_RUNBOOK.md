# Supabase本番DB バックアップ・復旧手順

更新日: 2026-07-28

## 現在の構成

- プロジェクト: `apexbrain-production`
- リージョン: 東京
- 組織プラン: Pro
- 日次Physicalバックアップ: 有効
- 保持期間: 7日
- 初回バックアップ確認日: 2026-07-28
- Spend Cap: 有効

バックアップはプロジェクトのリージョンで毎日深夜頃に作成されます。
DBバックアップにはStorage APIで保存した実ファイルは含まれず、メタデータだけが含まれます。
Storageを利用する場合は、オブジェクトの複製・保管を別途設定します。

## 月次の外部論理バックアップ

管理バックアップとは別に、月1回と大きなmigration前に次を実行します。

```powershell
$env:DATABASE_URL="<承認済みのSupabase Session Pooler接続文字列>"
pnpm backup:supabase:production
```

バックアップは`.backups/`へPostgreSQL custom形式で保存され、SHA-256、
作成日時、復旧コマンドを記録したmanifestも作成されます。`.backups/`はGit対象外です。

## 復旧演習

本番DBへ直接復元しません。空の検証用PostgreSQLまたは承認済みのSupabase検証プロジェクトを使用します。

1. manifestとdumpファイルのSHA-256を照合する。
2. 検証先が本番DBではないことを二名で確認する。
3. `pg_restore`で復元する。
4. 会員、利用回数、Webhook、相談受付、規約同意、監査ログの件数を確認する。
5. Stripe・LINE・LINE WORKSの外部ID整合性を確認する。
6. 実施日時、担当者、所要時間、問題点を監査記録へ残す。

`Restore to new project`は追加プロジェクト料金が発生する可能性があるため、実行前に費用を確認して承認を得ます。
