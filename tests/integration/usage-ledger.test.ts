import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  cleanupLineUser,
  closeTestSql,
  seedConsumedUsage,
  skipReason,
  testLineUserId,
  testSql,
  applyTestDatabaseEnv,
} from "./harness.ts";

applyTestDatabaseEnv();
const skip = skipReason();

after(async () => {
  if (!skip) await closeTestSql();
});

/** 実際の reserve_usage（PL/pgSQL）を直接呼ぶ。 */
async function reserve(
  lineUserId: string,
  usageType: "ai_answer" | "tax_review",
  idempotencyKey: string,
  now?: string,
) {
  const sql = testSql();
  const rows = now
    ? await sql`
        select * from reserve_usage(
          ${lineUserId}, ${usageType}, ${idempotencyKey}, null, null, ${now}::timestamptz
        )
      `
    : await sql`
        select * from reserve_usage(${lineUserId}, ${usageType}, ${idempotencyKey})
      `;
  return rows[0];
}

/** postgres.js が date を Date で返す場合も、DBのローカル日付として比較する。 */
function localDateString(value: unknown): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("I-2: 残り1回のとき20並列で予約しても成功は1件だけ", { skip }, async () => {
  const lineUserId = testLineUserId("concurrency");
  const sql = testSql();
  try {
    await reserve(lineUserId, "ai_answer", `${lineUserId}:warmup`);
    // warmup で1件消費されているので、残り1件になるよう98件を追加する。
    await seedConsumedUsage({ lineUserId, usageType: "ai_answer", count: 98 });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        reserve(lineUserId, "ai_answer", `${lineUserId}:race-${index}`),
      ),
    );

    const allowed = results.filter((row) => row.allowed === true);
    assert.equal(allowed.length, 1, "上限を超えて予約できてはいけない");

    const totals = await sql`
      select count(*)::int as active
      from usage_events e
      join users u on u.id = e.user_id
      where u.line_user_id = ${lineUserId}
        and e.usage_type = 'ai_answer'
        and e.status in ('reserved', 'consumed')
    `;
    assert.equal(Number(totals[0].active), 100, "合計が上限と一致すること");
  } finally {
    await cleanupLineUser(lineUserId);
  }
});

test("I-2b: 同じ冪等キーを並列で送っても利用イベントは1件", { skip }, async () => {
  const lineUserId = testLineUserId("idempotent");
  const sql = testSql();
  try {
    const key = `${lineUserId}:same-key`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(lineUserId, "ai_answer", key)),
    );
    for (const row of results) assert.equal(row.allowed, true);

    const rows = await sql`
      select count(*)::int as total
      from usage_events e
      join users u on u.id = e.user_id
      where u.line_user_id = ${lineUserId} and e.idempotency_key = ${key}
    `;
    assert.equal(Number(rows[0].total), 1);
  } finally {
    await cleanupLineUser(lineUserId);
  }
});

test(
  "I-3: 30分を過ぎた ai_answer の予約は上限へ算入しない（H-01の回帰防止）",
  { skip },
  async () => {
    const lineUserId = testLineUserId("stale");
    const sql = testSql();
    try {
      await reserve(lineUserId, "ai_answer", `${lineUserId}:seed`);
      await seedConsumedUsage({ lineUserId, usageType: "ai_answer", count: 99 });
      // ここで上限100件に到達している（consumed 99 + reserved 1）。
      const blocked = await reserve(lineUserId, "ai_answer", `${lineUserId}:blocked`);
      assert.equal(blocked.allowed, false, "予約中は上限として扱う");

      // 予約が取り残された状態を再現する。
      await sql`
        update usage_events e
        set created_at = now() - interval '31 minutes'
        from users u
        where u.id = e.user_id
          and u.line_user_id = ${lineUserId}
          and e.status = 'reserved'
      `;

      const recovered = await reserve(lineUserId, "ai_answer", `${lineUserId}:recovered`);
      assert.equal(
        recovered.allowed,
        true,
        "取り残された予約で枠が永久に減ってはいけない",
      );
    } finally {
      await cleanupLineUser(lineUserId);
    }
  },
);

test(
  "I-3b: tax_review の予約は時間が経っても上限へ算入し続ける",
  { skip },
  async () => {
    // 配送キューの再試行で数時間 'reserved' が続くのは正常な状態のため、
    // ai_answer と同じ扱いにしてはいけない。
    const lineUserId = testLineUserId("staletax");
    const sql = testSql();
    try {
      await sql`
        insert into users (
          line_user_id, plan_code, membership_provider, membership_status,
          current_period_start, current_period_end
        ) values (
          ${lineUserId}, 'anshin', 'stripe', 'active',
          date_trunc('month', now() at time zone 'Asia/Tokyo')::date,
          (date_trunc('month', now() at time zone 'Asia/Tokyo') + interval '1 month - 1 day')::date
        )
      `;
      const first = await reserve(lineUserId, "tax_review", `${lineUserId}:tr-1`);
      assert.equal(first.allowed, true);

      await sql`
        update usage_events e
        set created_at = now() - interval '6 hours'
        from users u
        where u.id = e.user_id
          and u.line_user_id = ${lineUserId}
          and e.status = 'reserved'
      `;

      const second = await reserve(lineUserId, "tax_review", `${lineUserId}:tr-2`);
      assert.equal(second.allowed, false, "配送待ちの相談枠を二重に使えてはいけない");
    } finally {
      await cleanupLineUser(lineUserId);
    }
  },
);

test("I-3c: 回収バッチが取り残された ai_answer の予約だけを取り消す", { skip }, async () => {
  const lineUserId = testLineUserId("reaper");
  const sql = testSql();
  try {
    const { expireStaleUsageReservations } = await import(
      "../../lib/membership/store.ts"
    );
    await reserve(lineUserId, "ai_answer", `${lineUserId}:old`);
    await sql`
      update usage_events e
      set created_at = now() - interval '45 minutes'
      from users u
      where u.id = e.user_id and u.line_user_id = ${lineUserId}
    `;
    const fresh = await reserve(lineUserId, "ai_answer", `${lineUserId}:fresh`);
    assert.equal(fresh.allowed, true);

    await expireStaleUsageReservations();

    const rows = await sql`
      select e.idempotency_key, e.status
      from usage_events e
      join users u on u.id = e.user_id
      where u.line_user_id = ${lineUserId}
      order by e.created_at
    `;
    const byKey = new Map(
      rows.map((row) => [String(row.idempotency_key), String(row.status)]),
    );
    assert.equal(byKey.get(`${lineUserId}:old`), "canceled");
    assert.equal(byKey.get(`${lineUserId}:fresh`), "reserved");
  } finally {
    await cleanupLineUser(lineUserId);
  }
});

test("I-4: 月をまたぐと利用枠がリセットされる（JST基準）", { skip }, async () => {
  const lineUserId = testLineUserId("period");
  try {
    // JST 2026-08-31 23:00 = UTC 2026-08-31 14:00
    const august = await reserve(
      lineUserId,
      "ai_answer",
      `${lineUserId}:aug`,
      "2026-08-31T14:00:00Z",
    );
    assert.equal(august.allowed, true);
    assert.equal(localDateString(august.period_start), "2026-08-01");
    assert.equal(localDateString(august.period_end), "2026-08-31");

    // JST 2026-09-01 00:30 = UTC 2026-08-31 15:30
    const september = await reserve(
      lineUserId,
      "ai_answer",
      `${lineUserId}:sep`,
      "2026-08-31T15:30:00Z",
    );
    assert.equal(localDateString(september.period_start), "2026-09-01");
    assert.equal(
      Number(september.used_count),
      1,
      "月が変われば利用数は1から数え直す",
    );
  } finally {
    await cleanupLineUser(lineUserId);
  }
});

test("I-9: 他人の利用履歴は集計に混ざらない", { skip }, async () => {
  const userA = testLineUserId("isolationa");
  const userB = testLineUserId("isolationb");
  try {
    const { getUsageSummary } = await import("../../lib/membership/store.ts");
    await reserve(userA, "ai_answer", `${userA}:1`);
    await seedConsumedUsage({ lineUserId: userA, usageType: "ai_answer", count: 5 });
    await reserve(userB, "ai_answer", `${userB}:1`);

    const summaryA = await getUsageSummary(userA);
    const summaryB = await getUsageSummary(userB);
    assert.equal(summaryA.aiRemaining, 100 - 6);
    assert.equal(summaryB.aiRemaining, 100 - 1);
  } finally {
    await cleanupLineUser(userA);
    await cleanupLineUser(userB);
  }
});
