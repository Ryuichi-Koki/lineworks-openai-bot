import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TaxReviewRefundProjection } from "../lib/membership/types.ts";
import { buildTaxReviewRefundNotification } from "../lib/stripe/webhooks.ts";

function refund(
  overrides: Partial<TaxReviewRefundProjection> = {},
): TaxReviewRefundProjection {
  return {
    refundId: "re_test",
    lineUserId: "U-test",
    amount: 1100,
    currency: "jpy",
    refundStatus: "succeeded",
    paymentAmount: 1100,
    refundedAmount: 1100,
    paymentStatus: "refunded",
    ...overrides,
  };
}

test("返金通知は全額・一部・失敗を区別する", () => {
  assert.match(buildTaxReviewRefundNotification(refund()), /1,100円.*返金が完了/);
  assert.match(
    buildTaxReviewRefundNotification(
      refund({
        amount: 500,
        refundedAmount: 500,
        paymentStatus: "partially_refunded",
      }),
    ),
    /500円.*一部返金が完了/,
  );
  assert.match(
    buildTaxReviewRefundNotification(
      refund({
        refundStatus: "failed",
        refundedAmount: 0,
        paymentStatus: "consumed",
      }),
    ),
    /返金処理を完了できませんでした/,
  );
});

test("公開ページへ主要セキュリティヘッダーを付与する", async () => {
  const source = await readFile(
    new URL("../next.config.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /X-Content-Type-Options/);
  assert.match(source, /nosniff/);
  assert.match(source, /X-Frame-Options/);
  assert.match(source, /DENY/);
  assert.match(source, /strict-origin-when-cross-origin/);
});

test("返金・配送ジョブ・期限切れ決済・復旧処理を保持する", async () => {
  const [migration, webhook, vercel] = await Promise.all([
    readFile(
      new URL("../migrations/007_tax_review_delivery_and_refunds.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/stripe/webhooks.ts", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /create table if not exists tax_review_refunds/i);
  assert.match(migration, /create table if not exists tax_review_delivery_jobs/i);
  assert.match(webhook, /case "refund\.created"/);
  assert.match(webhook, /case "checkout\.session\.expired"/);
  assert.match(vercel, /tax-review-deliveries/);
});
