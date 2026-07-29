import assert from "node:assert/strict";
import test from "node:test";
import {
  TAX_REVIEW_PROMO_END_EXCLUSIVE,
  taxReviewPriceAt,
  taxReviewPricingMessage,
} from "../lib/stripe/consultationPricing.ts";

test("2026年中は税理士相談のテスト価格1,000円を適用する", () => {
  const price = taxReviewPriceAt(new Date("2026-12-31T14:59:59.999Z"));
  assert.equal(price.code, "promo_2026");
  assert.equal(price.amount, 1000);
});

test("2027年1月1日00:00 JSTから通常価格3,000円を適用する", () => {
  assert.equal(TAX_REVIEW_PROMO_END_EXCLUSIVE, "2026-12-31T15:00:00.000Z");
  const price = taxReviewPriceAt(new Date(TAX_REVIEW_PROMO_END_EXCLUSIVE));
  assert.equal(price.code, "standard");
  assert.equal(price.amount, 3000);
});

test("価格案内は税込・期限・将来価格を明示する", () => {
  const message = taxReviewPricingMessage(new Date("2026-07-30T00:00:00Z"));
  assert.match(message, /月100件まで/);
  assert.match(message, /1回1,000円（税込）/);
  assert.match(message, /2026年12月31日まで/);
  assert.match(message, /2027年1月1日以降：1回3,000円（税込）/);
});
