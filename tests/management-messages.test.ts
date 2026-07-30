import assert from "node:assert/strict";
import test from "node:test";
import {
  BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE,
  billingDocumentsMessage,
  noActiveSubscriptionManagementMessage,
  oneTimeBillingManagementMessage,
} from "../lib/membership/managementMessages.ts";

const receipts = [
  {
    amount: 1100,
    currency: "jpy",
    hostedUrl: "https://invoice.stripe.com/i/acct_test/inv_1",
    occurredAt: "2026-07-30T02:15:00.000Z",
  },
  {
    amount: 3300,
    currency: "jpy",
    hostedUrl: "https://invoice.stripe.com/i/acct_test/inv_2",
    occurredAt: "2027-01-05T23:40:00.000Z",
  },
];

test("お支払いメニューは領収書を日付・金額・リンクで並べる", () => {
  const message = billingDocumentsMessage(receipts, {
    savedCardEnabled: true,
    invoiceIssuanceEnabled: true,
  });

  assert.match(message, /■ 領収書/);
  assert.match(message, /2026年7月30日 1,100円/);
  assert.match(message, /https:\/\/invoice\.stripe\.com\/i\/acct_test\/inv_1/);
  // UTC 23:40 は日本時間では翌日。JSTで表示すること
  assert.match(message, /2027年1月6日 3,300円/);
  assert.match(message, /登録済みカードの変更・削除ができます/);
});

test("カード未保存のときは変更ではなく毎回入力である旨を伝える", () => {
  const message = billingDocumentsMessage(receipts, {
    savedCardEnabled: false,
    invoiceIssuanceEnabled: true,
  });

  assert.match(message, /カード情報は保存していません/);
  assert.doesNotMatch(message, /登録済みカードの変更/);
});

test("支払い実績がないときは領収書欄を空で見せない", () => {
  const message = billingDocumentsMessage([], {
    savedCardEnabled: true,
    invoiceIssuanceEnabled: true,
  });

  assert.match(message, /まだお支払いの記録がありません/);
  assert.doesNotMatch(message, /■ 領収書/);
});

test("お支払いメニューは月額・自動更新がないことを明示する", () => {
  for (const savedCardEnabled of [true, false]) {
    const message = billingDocumentsMessage(receipts, {
      savedCardEnabled,
      invoiceIssuanceEnabled: true,
    });
    assert.match(message, /月額料金・自動更新はありません/);
    assert.doesNotMatch(message, /退会|解約/);
  }
});

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
