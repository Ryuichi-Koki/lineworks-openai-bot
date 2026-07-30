import assert from "node:assert/strict";
import test from "node:test";
import { billingStatusContent } from "../lib/stripe/billingStatusContent.ts";

test("税理士相談の決済完了画面は都度課金として案内する", () => {
  const content = billingStatusContent("success", "tax_review");
  const text = [
    content.title,
    content.description,
    content.note,
    ...content.steps,
  ].join("\n");

  assert.match(text, /税理士相談/);
  assert.match(text, /個別相談1回分/);
  assert.match(text, /月額料金や自動更新はありません/);
  assert.doesNotMatch(text, /次回更新日/);
  assert.doesNotMatch(text, /会員状態/);
});

test("税理士相談の決済中断画面は請求なしと正しい再開方法を示す", () => {
  const content = billingStatusContent("cancel", "tax_review");
  const text = [
    content.title,
    content.description,
    content.note,
    ...content.steps,
  ].join("\n");

  assert.match(text, /請求は発生しません/);
  assert.match(text, /お支払いへ進む/);
  assert.match(text, /税理士相談/);
  assert.doesNotMatch(text, /有料会員になる/);
});

test("既存の月額契約画面はpurchase指定なしで維持する", () => {
  const success = billingStatusContent("success", undefined);
  const cancel = billingStatusContent("cancel", undefined);

  assert.match(success.description, /会員状態/);
  assert.match(success.steps.join("\n"), /次回更新日/);
  assert.match(cancel.steps.join("\n"), /有料会員/);
});

test("purchaseが複数指定された場合は都度課金として扱わない", () => {
  const content = billingStatusContent("success", ["tax_review", "other"]);
  assert.match(content.description, /会員状態/);
});
