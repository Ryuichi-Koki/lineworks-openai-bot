import assert from "node:assert/strict";
import test from "node:test";
import { MemoryMembershipLedger } from "../lib/membership/memoryLedger.ts";
import {
  freePeriod,
  paidPeriodFromNextBillingDate,
} from "../lib/membership/periods.ts";

test("初回利用者は無料会員として登録される", () => {
  const ledger = new MemoryMembershipLedger();
  assert.equal(ledger.ensureUser("U1").planCode, "free");
});

test("無料会員は月100回まで利用でき、101回目は拒否される", async () => {
  const ledger = new MemoryMembershipLedger();
  for (let index = 0; index < 100; index += 1) {
    const reservation = await ledger.reserve("U1", "ai_answer", `answer-${index}`);
    assert.equal(reservation.allowed, true);
    ledger.transition(reservation.usageEventId!, "consumed");
  }
  const extra = await ledger.reserve("U1", "ai_answer", "answer-101");
  assert.equal(extra.allowed, false);
  assert.equal(ledger.consumed("U1", "ai_answer"), 100);
});

test("あんしん会員は1契約期間につき100回利用できる", async () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser("U1", "anshin", "2026-07-23", "2026-08-22");
  for (let index = 0; index < 100; index += 1) {
    const reservation = await ledger.reserve("U1", "ai_answer", `paid-${index}`);
    assert.equal(reservation.allowed, true);
    ledger.transition(reservation.usageEventId!, "consumed");
  }
  assert.equal((await ledger.reserve("U1", "ai_answer", "paid-101")).allowed, false);
});

test("確認質問では予約を取り消すため回数が減らない", async () => {
  const ledger = new MemoryMembershipLedger();
  const reservation = await ledger.reserve("U1", "ai_answer", "clarification");
  ledger.transition(reservation.usageEventId!, "canceled");
  assert.equal(ledger.consumed("U1", "ai_answer"), 0);
});

test("最終回答は送信成功後だけ消費する", async () => {
  const ledger = new MemoryMembershipLedger();
  const reservation = await ledger.reserve("U1", "ai_answer", "final");
  assert.equal(ledger.consumed("U1", "ai_answer"), 0);
  ledger.transition(reservation.usageEventId!, "consumed");
  assert.equal(ledger.consumed("U1", "ai_answer"), 1);
});

test("AI生成失敗時は予約を取り消す", async () => {
  const ledger = new MemoryMembershipLedger();
  const reservation = await ledger.reserve("U1", "ai_answer", "ai-error");
  ledger.transition(reservation.usageEventId!, "canceled");
  assert.equal(ledger.consumed("U1", "ai_answer"), 0);
});

test("LINE送信失敗時は予約を取り消す", async () => {
  const ledger = new MemoryMembershipLedger();
  const reservation = await ledger.reserve("U1", "ai_answer", "line-error");
  ledger.transition(reservation.usageEventId!, "canceled");
  assert.equal(ledger.consumed("U1", "ai_answer"), 0);
});

test("同時質問でも無料上限を超えない", async () => {
  const ledger = new MemoryMembershipLedger();
  const reservations = await Promise.all(
    Array.from({ length: 130 }, (_, index) =>
      ledger.reserve("U1", "ai_answer", `parallel-${index}`),
    ),
  );
  assert.equal(reservations.filter((item) => item.allowed).length, 100);
});

test("Webhook再送は二重処理されない", () => {
  const ledger = new MemoryMembershipLedger();
  assert.equal(ledger.beginWebhook("line", "event-1", "hash"), true);
  assert.equal(ledger.beginWebhook("line", "event-1", "hash"), false);
});

test("同じWebhook IDで異なる本文は拒否される", () => {
  const ledger = new MemoryMembershipLedger();
  ledger.beginWebhook("line", "event-1", "hash-a");
  assert.throws(() => ledger.beginWebhook("line", "event-1", "hash-b"));
});

test("加入時に有料プランへ変更される", () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser("U1", "anshin", "2026-07-23", "2026-08-22");
  assert.equal(ledger.ensureUser("U1").planCode, "anshin");
});

test("更新時に新しい契約期間が適用される", () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser("U1", "anshin", "2026-07-23", "2026-08-22");
  ledger.syncPaidUser("U1", "anshin", "2026-08-23", "2026-09-22");
  assert.equal(ledger.ensureUser("U1").periodStart, "2026-08-23");
});

test("退会予約中は期限まで有料会員として扱う", () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser(
    "U1",
    "anshin",
    "2026-07-23",
    "2026-08-22",
    "cancel_at_period_end",
  );
  assert.equal(ledger.ensureUser("U1").planCode, "anshin");
});

test("退会完了後は無料プランへ戻る", () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser("U1", "anshin", "2026-07-23", "2026-08-22");
  ledger.endMembership("U1", new Date("2026-08-23T00:00:00+09:00"));
  assert.equal(ledger.ensureUser("U1").planCode, "free");
});

test("決済失敗状態を保持できる", () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser("U1", "anshin", "2026-07-23", "2026-08-22", "past_due");
  assert.equal(ledger.ensureUser("U1").status, "past_due");
});

test("無料会員は税理士確認を依頼できない", async () => {
  const ledger = new MemoryMembershipLedger();
  assert.equal((await ledger.reserve("U1", "tax_review", "review-free")).allowed, false);
});

test("あんしん会員は税理士確認を1件利用できる", async () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser("U1", "anshin", "2026-07-23", "2026-08-22");
  const first = await ledger.reserve("U1", "tax_review", "review-1");
  assert.equal(first.allowed, true);
  ledger.transition(first.usageEventId!, "consumed");
  assert.equal((await ledger.reserve("U1", "tax_review", "review-2")).allowed, false);
});

test("税理士確認ボタンを押しただけでは消費しない", () => {
  const ledger = new MemoryMembershipLedger();
  ledger.syncPaidUser("U1", "anshin", "2026-07-23", "2026-08-22");
  assert.equal(ledger.consumed("U1", "tax_review"), 0);
});

test("利用履歴は利用者ごとに分離される", async () => {
  const ledger = new MemoryMembershipLedger();
  const reservation = await ledger.reserve("U1", "ai_answer", "user-1");
  ledger.transition(reservation.usageEventId!, "consumed");
  assert.equal(ledger.consumed("U2", "ai_answer"), 0);
});

test("無料期間は日本時間の月初から月末", () => {
  assert.deepEqual(freePeriod(new Date("2026-07-31T16:00:00Z")), {
    start: "2026-08-01",
    end: "2026-08-31",
  });
});

test("LINEの次回課金日から契約期間を計算する", () => {
  assert.deepEqual(paidPeriodFromNextBillingDate("2026-08-23"), {
    start: "2026-07-23",
    end: "2026-08-22",
  });
});

test("月末加入の契約期間は前月末へ丸める", () => {
  assert.deepEqual(paidPeriodFromNextBillingDate("2026-03-31"), {
    start: "2026-02-28",
    end: "2026-03-30",
  });
});
