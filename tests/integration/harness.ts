import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";

/**
 * 結合テスト用の接続。
 *
 * 実データベースに対して migration 001〜008 を適用したうえで実行する。
 * 単体テスト（tests/*.test.ts）と分離しているのは、DBが無い環境でも
 * `pnpm test` が常に完走できるようにするため。
 *
 * 誤って本番へ接続しないよう、接続先はローカルまたは
 * Supabaseのテストプロジェクトに限定する。
 */
export function integrationDatabaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) return null;

  const parsed = new URL(url);
  const isLocal = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  const isSupabaseTestPool =
    /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/i.test(parsed.hostname) &&
    process.env.ALLOW_SUPABASE_TEST_MIGRATIONS === "yes";
  if (!isLocal && !isSupabaseTestPool) {
    throw new Error(
      "TEST_DATABASE_URL must point at a local database or an approved Supabase test pooler",
    );
  }
  return url;
}

/** node:test の `skip` オプションへそのまま渡せる形で返す。 */
export function skipReason(): string | false {
  return integrationDatabaseUrl()
    ? false
    : "TEST_DATABASE_URL is not set. Run `pnpm setup:postgres:local && pnpm migrate:postgres:local` first.";
}

let client: Sql | null = null;

export function testSql(): Sql {
  if (client) return client;
  const url = integrationDatabaseUrl();
  if (!url) throw new Error("TEST_DATABASE_URL is required");
  client = postgres(url, {
    max: 10,
    ssl: new URL(url).hostname.includes("supabase.com") ? "require" : false,
    prepare: false,
    onnotice: () => {},
  });
  return client;
}

/**
 * アプリ側のモジュールは process.env.DATABASE_URL を読む。
 * 結合テストでは、import より前にテスト用の接続先を差し込む。
 */
export function applyTestDatabaseEnv(): void {
  const url = integrationDatabaseUrl();
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.MEMBERSHIP_BILLING_ENABLED = "true";
  if (!new URL(url).hostname.includes("supabase.com")) {
    process.env.DATABASE_SSL_MODE = "disable";
  }
}

export function testLineUserId(label: string): string {
  return `Utest_${label}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** テストで作成した利用者と、その関連行をすべて削除する。 */
export async function cleanupLineUser(lineUserId: string): Promise<void> {
  const sql = testSql();
  await sql.begin(async (tx) => {
    const users = await tx`
      select id from users where line_user_id = ${lineUserId}
    `;
    const userId = users[0]?.id;
    await tx`delete from tax_review_intakes where line_user_id = ${lineUserId}`;
    await tx`delete from pending_questions where line_user_id = ${lineUserId}`;
    await tx`delete from policy_acceptances where line_user_id = ${lineUserId}`;
    await tx`delete from tax_review_delivery_jobs where line_user_id = ${lineUserId}`;
    if (userId) {
      await tx`
        delete from tax_review_refunds
        where payment_id in (
          select id from tax_review_payments where user_id = ${userId}
        )
      `;
      await tx`delete from tax_review_payments where user_id = ${userId}`;
      await tx`delete from usage_events where user_id = ${userId}`;
      await tx`delete from review_requests where user_id = ${userId}`;
      await tx`delete from users where id = ${userId}`;
    }
  });
}

export async function closeTestSql(): Promise<void> {
  if (!client) return;
  await client.end({ timeout: 5 });
  client = null;
}

/**
 * 上限まであと `remaining` 件になるよう、消費済みの利用イベントを作る。
 * `reserve_usage` を経由せず直接投入することで、テストの意図を明確にする。
 */
export async function seedConsumedUsage(input: {
  lineUserId: string;
  usageType: "ai_answer" | "tax_review";
  count: number;
}): Promise<void> {
  if (input.count <= 0) return;
  const sql = testSql();
  await sql`
    insert into usage_events (
      user_id, usage_type, billing_period_start, billing_period_end,
      status, idempotency_key, consumed_at
    )
    select
      u.id, ${input.usageType}, u.current_period_start, u.current_period_end,
      'consumed', 'seed:' || ${input.lineUserId} || ':' || gs::text, now()
    from users u, generate_series(1, ${input.count}) as gs
    where u.line_user_id = ${input.lineUserId}
  `;
}
