import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBillingNotification,
  buildStatusMessage,
  resolveBillingNotification,
  type BillingNotificationKind,
} from "../lib/membership/messages.ts";
import type { MembershipStatus, UsageSummary } from "../lib/membership/types.ts";

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    lineUserId: "line-test-user",
    displayName: null,
    planCode: "anshin",
    membershipStatus: "active",
    membershipProvider: "stripe",
    membershipPlanId: "sub_test",
    periodStart: "2026-07-29",
    periodEnd: "2026-08-28",
    aiUsed: 0,
    aiRemaining: 100,
    taxReviewUsed: 0,
    taxReviewRemaining: 1,
    lastUsedAt: null,
    paymentFailed: false,
    ...overrides,
  };
}

test("新規契約は登録完了として通知する", () => {
  for (const previousStatus of [null, "free", "canceled"] as const) {
    assert.equal(
      resolveBillingNotification({ previousStatus, nextStatus: "active" }),
      "activated",
      `previousStatus=${previousStatus}`,
    );
  }
});

test("同じ状態を再受信しても通知しない（Webhook再配信・イベント重複対策）", () => {
  const statuses: MembershipStatus[] = [
    "free",
    "active",
    "past_due",
    "cancel_at_period_end",
    "canceled",
    "suspended",
  ];
  for (const status of statuses) {
    assert.equal(
      resolveBillingNotification({ previousStatus: status, nextStatus: status }),
      null,
      `status=${status}`,
    );
  }
});

test("退会予約・取り消し・支払い状態の変化をそれぞれ区別する", () => {
  assert.equal(
    resolveBillingNotification({
      previousStatus: "active",
      nextStatus: "cancel_at_period_end",
    }),
    "cancellation_scheduled",
  );
  assert.equal(
    resolveBillingNotification({
      previousStatus: "cancel_at_period_end",
      nextStatus: "active",
    }),
    "cancellation_reverted",
  );
  assert.equal(
    resolveBillingNotification({ previousStatus: "active", nextStatus: "past_due" }),
    "payment_failed",
  );
  assert.equal(
    resolveBillingNotification({ previousStatus: "past_due", nextStatus: "active" }),
    "payment_recovered",
  );
  assert.equal(
    resolveBillingNotification({
      previousStatus: "cancel_at_period_end",
      nextStatus: "canceled",
    }),
    "downgraded",
  );
});

test("有料契約を経ていない状態変化は通知しない", () => {
  assert.equal(
    resolveBillingNotification({ previousStatus: "free", nextStatus: "canceled" }),
    null,
  );
  assert.equal(
    resolveBillingNotification({ previousStatus: null, nextStatus: "canceled" }),
    null,
  );
  assert.equal(
    resolveBillingNotification({ previousStatus: "free", nextStatus: "past_due" }),
    null,
  );
});

test("登録完了通知にプラン・利用開始日・次回更新日・残数を含む", () => {
  const message = buildBillingNotification("activated", summary());
  assert.match(message, /あんしん会員のご登録が完了しました。/);
  assert.match(message, /月額3,300円 税込/);
  assert.match(message, /ご利用開始：2026年7月29日/);
  assert.match(message, /次回更新日：2026年8月29日/);
  assert.match(message, /AI回答：100回/);
  assert.match(message, /旧月額契約の税理士相談特典：1件/);
});

test("退会予約通知は利用期限と無料会員への切替日を明示する", () => {
  const message = buildBillingNotification(
    "cancellation_scheduled",
    summary({ membershipStatus: "cancel_at_period_end" }),
  );
  assert.match(message, /有料機能の利用期限：2026年8月28日/);
  assert.match(message, /2026年8月29日以降は自動的に無料会員へ切り替わります/);
  assert.match(message, /追加のご請求は発生しません/);
});

test("契約終了通知は無料会員として使える範囲を示す", () => {
  const message = buildBillingNotification(
    "downgraded",
    summary({ planCode: "free", membershipStatus: "canceled" }),
  );
  assert.match(message, /契約が終了しました/);
  assert.match(message, /AI回答：毎月100回まで/);
});

test("マイページは有料会員のプラン・残数・更新日を示す", () => {
  const message = buildStatusMessage(summary({ aiRemaining: 87 }));

  assert.match(message, /【現在のご契約・利用状況】/);
  assert.match(message, /あんしん会員（旧月額契約・月額3,300円 税込）/);
  assert.match(message, /ご契約状況：ご利用中/);
  assert.match(message, /次回更新日：2026年8月29日/);
  assert.match(message, /AI回答：87回 \/ 100回/);
  assert.match(message, /旧月額契約の税理士相談特典：1件 \/ 1件/);
  assert.match(message, /追加決済なし/);
  // 状態を確認するために回数を使う状態を解消したことを明示する
  assert.match(message, /このメッセージではAI回答の回数を消費していません。/);
});

test("マイページは無料会員に上位プランの案内を示す", () => {
  const message = buildStatusMessage(
    summary({
      planCode: "free",
      membershipStatus: "free",
      aiRemaining: 7,
      taxReviewRemaining: 0,
    }),
  );

  assert.match(message, /無料会員/);
  assert.match(message, /AI回答：7回 \/ 100回/);
  assert.match(message, /税理士相談：あんしん会員でご利用いただけます/);
  assert.doesNotMatch(message, /次回更新日/);
});

test("都度課金モードのマイページは基本無料を主表示し旧月額契約をプラン表示しない", () => {
  const previous = process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED;
  process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED = "true";
  try {
    const message = buildStatusMessage(summary({ aiRemaining: 87 }));

    assert.match(message, /【マイページ】/);
    assert.match(message, /ご利用プラン：基本無料/);
    assert.match(message, /AI回答：月100件まで（今月の残り 87件）/);
    assert.match(message, /料金：1回1,000円（税込）/);
    assert.match(message, /月額料金・自動更新はありません/);
    assert.match(message, /旧月額契約の未使用特典/);
    assert.match(message, /税理士相談：残り1件（利用時の追加決済なし）/);
    assert.doesNotMatch(message, /プラン：あんしん会員/);
  } finally {
    if (previous === undefined) {
      delete process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED;
    } else {
      process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED = previous;
    }
  }
});

test("都度課金モードの無料会員マイページには旧月額契約の特典を表示しない", () => {
  const previous = process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED;
  process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED = "true";
  try {
    const message = buildStatusMessage(
      summary({
        planCode: "free",
        membershipStatus: "free",
        taxReviewRemaining: 0,
      }),
    );

    assert.match(message, /ご利用プラン：基本無料/);
    assert.doesNotMatch(message, /あんしん会員/);
    assert.doesNotMatch(message, /旧月額契約の未使用特典/);
  } finally {
    if (previous === undefined) {
      delete process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED;
    } else {
      process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED = previous;
    }
  }
});

test("マイページは退会予約と支払い未確認を明示する", () => {
  const scheduled = buildStatusMessage(
    summary({ membershipStatus: "cancel_at_period_end" }),
  );
  assert.match(scheduled, /ご契約状況：退会予約済み/);
  assert.match(scheduled, /有料機能の利用期限：2026年8月28日/);
  assert.match(scheduled, /2026年8月29日以降は自動的に無料会員へ切り替わります/);

  const failed = buildStatusMessage(
    summary({ membershipStatus: "past_due", paymentFailed: true }),
  );
  assert.match(failed, /お支払いの確認ができていません/);
});

test("すべての通知種別が空でない本文を返す", () => {
  const kinds: BillingNotificationKind[] = [
    "activated",
    "cancellation_scheduled",
    "cancellation_reverted",
    "payment_failed",
    "payment_recovered",
    "downgraded",
  ];
  for (const kind of kinds) {
    const message = buildBillingNotification(kind, summary());
    assert.ok(message.trim().length > 0, `kind=${kind}`);
    assert.ok(message.length <= 4500, `kind=${kind} は分割なしで送れる長さであること`);
  }
});
