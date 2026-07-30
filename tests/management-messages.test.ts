import assert from "node:assert/strict";
import test from "node:test";
import {
  BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE,
  noActiveSubscriptionManagementMessage,
  oneTimeBillingManagementMessage,
} from "../lib/membership/managementMessages.ts";

test("都度課金利用者の契約管理は月額契約がないことと退会方法を案内する", () => {
  const message = noActiveSubscriptionManagementMessage(true);
  assert.match(message, /月額・自動更新の有料契約はありません/);
  assert.match(message, /1回ごとの都度払い/);
  assert.match(message, /https:\/\/bot\.abtax\.jp\/cancellation/);
  assert.doesNotMatch(message, /あんしん会員のお申し込み/);
});

test("都度課金移行後に旧契約記録があってもStripe契約管理へ誘導しない", () => {
  const message = oneTimeBillingManagementMessage(true);
  assert.match(message, /月額・自動更新の有料契約はありません/);
  assert.match(message, /旧月額契約の記録が残っています/);
  assert.match(message, /新たな請求や契約変更は行われません/);
  assert.match(message, /https:\/\/bot\.abtax\.jp\/cancellation/);
  assert.doesNotMatch(message, /Stripeの契約管理画面/);
});

test("旧月額プランの案内は従来設定で維持する", () => {
  const message = noActiveSubscriptionManagementMessage(false);
  assert.match(message, /現在、有料契約はありません/);
  assert.match(message, /あんしん会員のお申し込み/);
});

test("Stripe契約管理に失敗しても無反応にせず安全な代替導線を返す", () => {
  assert.match(
    BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE,
    /契約管理画面を開けません/,
  );
  assert.match(
    BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE,
    /請求や契約変更は発生していません/,
  );
  assert.match(
    BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE,
    /https:\/\/bot\.abtax\.jp\/cancellation/,
  );
});
