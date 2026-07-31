import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  TAX_REVIEW_PROMO_PRICE_JPY,
  TAX_REVIEW_STANDARD_PRICE_JPY,
} from "../../lib/stripe/consultationPricing.ts";
import {
  cleanupLineUser,
  closeTestSql,
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

async function store() {
  return import("../../lib/membership/store.ts");
}

test(
  "I-1: 現在の価格で決済レコードを作成できる（C-01の回帰防止）",
  { skip },
  async () => {
    // migration 006 は `check (amount in (1000, 3000))` を定義していたため、
    // 価格改定後（1,100 / 3,300）はこのINSERTが必ず失敗していた。
    // 表示価格の定数をそのまま使い、DB制約との乖離を検出する。
    const { createReviewDraft, createOrGetTaxReviewPayment } = await store();

    for (const [priceCode, amount] of [
      ["promo_2026", TAX_REVIEW_PROMO_PRICE_JPY],
      ["standard", TAX_REVIEW_STANDARD_PRICE_JPY],
    ] as const) {
      const lineUserId = testLineUserId("price");
      try {
        const reviewRequestId = await createReviewDraft({
          lineUserId,
          conversationId: `conv-${priceCode}`,
          summary: "簡易課税の選択について相談したいです。",
        });
        const payment = await createOrGetTaxReviewPayment({
          lineUserId,
          reviewRequestId,
          priceCode,
          amount,
        });
        assert.equal(payment.amount, amount);
        assert.equal(payment.priceCode, priceCode);
        assert.equal(payment.status, "pending");
      } finally {
        await cleanupLineUser(lineUserId);
      }
    }
  },
);

test("I-1b: 0円・負値の決済レコードは作成できない", { skip }, async () => {
  const { createReviewDraft, createOrGetTaxReviewPayment } = await store();
  const lineUserId = testLineUserId("badprice");
  try {
    const reviewRequestId = await createReviewDraft({
      lineUserId,
      conversationId: "conv-bad",
      summary: "金額検証",
    });
    await assert.rejects(
      createOrGetTaxReviewPayment({
        lineUserId,
        reviewRequestId,
        priceCode: "standard",
        amount: 0,
      }),
    );
  } finally {
    await cleanupLineUser(lineUserId);
  }
});

test(
  "I-6: 決済完了から配送ジョブ登録・受付確定まで状態が遷移する",
  { skip },
  async () => {
    const {
      createReviewDraft,
      createOrGetTaxReviewPayment,
      attachTaxReviewCheckout,
      markTaxReviewPaymentPaid,
      enqueueTaxReviewDelivery,
      completePaidTaxReview,
    } = await store();
    const sql = testSql();
    const lineUserId = testLineUserId("flow");
    try {
      const reviewRequestId = await createReviewDraft({
        lineUserId,
        conversationId: "conv-flow",
        summary: "中古車の減価償却について",
      });
      const payment = await createOrGetTaxReviewPayment({
        lineUserId,
        reviewRequestId,
        priceCode: "promo_2026",
        amount: TAX_REVIEW_PROMO_PRICE_JPY,
      });
      await attachTaxReviewCheckout({
        paymentId: payment.id,
        checkoutSessionId: `cs_test_${payment.id}`,
        checkoutUrl: "https://checkout.stripe.com/c/pay/test",
        checkoutExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });

      const awaiting = await sql`
        select status from review_requests where id = ${reviewRequestId}
      `;
      assert.equal(String(awaiting[0].status), "awaiting_payment");

      const paid = await markTaxReviewPaymentPaid({
        paymentId: payment.id,
        lineUserId,
        reviewRequestId,
        checkoutSessionId: `cs_test_${payment.id}`,
        paymentIntentId: `pi_test_${payment.id}`,
        amount: TAX_REVIEW_PROMO_PRICE_JPY,
        currency: "jpy",
      });
      assert.equal(paid.status, "paid");

      const jobId = await enqueueTaxReviewDelivery({
        eventId: `stripe:cs_test_${payment.id}:tax_review`,
        lineUserId,
        reviewRequestId,
        paymentId: payment.id,
      });
      assert.ok(jobId);

      assert.equal(await completePaidTaxReview(payment.id), true);
      // 冪等: 2回目は何も変えない
      assert.equal(await completePaidTaxReview(payment.id), false);

      const finished = await sql`
        select r.status as review_status, p.status as payment_status
        from review_requests r
        join tax_review_payments p on p.review_request_id = r.id
        where r.id = ${reviewRequestId}
      `;
      assert.equal(String(finished[0].review_status), "submitted");
      assert.equal(String(finished[0].payment_status), "consumed");
    } finally {
      await cleanupLineUser(lineUserId);
    }
  },
);

test("I-6b: 金額が一致しない決済完了通知は拒否する", { skip }, async () => {
  const {
    createReviewDraft,
    createOrGetTaxReviewPayment,
    markTaxReviewPaymentPaid,
  } = await store();
  const lineUserId = testLineUserId("amountguard");
  try {
    const reviewRequestId = await createReviewDraft({
      lineUserId,
      conversationId: "conv-guard",
      summary: "金額照合",
    });
    const payment = await createOrGetTaxReviewPayment({
      lineUserId,
      reviewRequestId,
      priceCode: "promo_2026",
      amount: TAX_REVIEW_PROMO_PRICE_JPY,
    });
    await assert.rejects(
      markTaxReviewPaymentPaid({
        paymentId: payment.id,
        lineUserId,
        reviewRequestId,
        checkoutSessionId: "cs_test_mismatch",
        paymentIntentId: "pi_test_mismatch",
        amount: 100,
        currency: "jpy",
      }),
      /amount or currency does not match/,
    );
  } finally {
    await cleanupLineUser(lineUserId);
  }
});

test("I-9: 他人の相談に対して決済レコードを作れない", { skip }, async () => {
  const { createReviewDraft, createOrGetTaxReviewPayment, cancelReviewRequest } =
    await store();
  const owner = testLineUserId("owner");
  const attacker = testLineUserId("attacker");
  try {
    const reviewRequestId = await createReviewDraft({
      lineUserId: owner,
      conversationId: "conv-owner",
      summary: "本人の相談",
    });
    // 他人のIDを付け替えても、結合条件で弾かれる。
    await assert.rejects(
      createOrGetTaxReviewPayment({
        lineUserId: attacker,
        reviewRequestId,
        priceCode: "promo_2026",
        amount: TAX_REVIEW_PROMO_PRICE_JPY,
      }),
      /Review request not found/,
    );
    assert.equal(await cancelReviewRequest(attacker, reviewRequestId), false);
    assert.equal(await cancelReviewRequest(owner, reviewRequestId), true);
  } finally {
    await cleanupLineUser(owner);
    await cleanupLineUser(attacker);
  }
});

test("I-8: 全額返金で決済と配送ジョブが取り消される", { skip }, async () => {
  const {
    createReviewDraft,
    createOrGetTaxReviewPayment,
    markTaxReviewPaymentPaid,
    enqueueTaxReviewDelivery,
    recordTaxReviewRefund,
  } = await store();
  const sql = testSql();
  const lineUserId = testLineUserId("refund");
  try {
    const reviewRequestId = await createReviewDraft({
      lineUserId,
      conversationId: "conv-refund",
      summary: "返金の検証",
    });
    const payment = await createOrGetTaxReviewPayment({
      lineUserId,
      reviewRequestId,
      priceCode: "promo_2026",
      amount: TAX_REVIEW_PROMO_PRICE_JPY,
    });
    const paymentIntentId = `pi_test_refund_${payment.id}`;
    await markTaxReviewPaymentPaid({
      paymentId: payment.id,
      lineUserId,
      reviewRequestId,
      checkoutSessionId: `cs_test_refund_${payment.id}`,
      paymentIntentId,
      amount: TAX_REVIEW_PROMO_PRICE_JPY,
      currency: "jpy",
    });
    await enqueueTaxReviewDelivery({
      eventId: `stripe:refund:${payment.id}`,
      lineUserId,
      reviewRequestId,
      paymentId: payment.id,
    });

    const partial = await recordTaxReviewRefund({
      refundId: `re_test_partial_${payment.id}`,
      paymentIntentId,
      amount: 100,
      currency: "jpy",
      status: "succeeded",
    });
    assert.equal(partial?.paymentStatus, "partially_refunded");

    const full = await recordTaxReviewRefund({
      refundId: `re_test_full_${payment.id}`,
      paymentIntentId,
      amount: TAX_REVIEW_PROMO_PRICE_JPY - 100,
      currency: "jpy",
      status: "succeeded",
    });
    assert.equal(full?.paymentStatus, "refunded");

    const job = await sql`
      select status from tax_review_delivery_jobs
      where review_request_id = ${reviewRequestId}
    `;
    assert.equal(String(job[0].status), "canceled");
  } finally {
    await cleanupLineUser(lineUserId);
  }
});
