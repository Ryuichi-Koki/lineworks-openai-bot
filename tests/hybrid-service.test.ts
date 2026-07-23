import assert from "node:assert/strict";
import test from "node:test";
import type { ReplyDraft } from "../lib/openai/generateReplyDraft.ts";
import {
  buildCustomerReply,
  isPricingInquiry,
  isTaxProfessionalReviewPostback,
  markAsAiAutoReply,
  shouldAutoReply,
  TAX_AI_PRICING_MESSAGE,
} from "../lib/tax/hybridService.ts";

function draft(overrides: Partial<ReplyDraft> = {}): ReplyDraft {
  return {
    category: "税務",
    urgency: "通常",
    answerLevel: "A",
    confidence: "高",
    inferredIntent: "一般的な税務相談",
    assumptions: [],
    draftReply: "【結論】\n標準的なケースでは対象になります。",
    checkItems: [],
    sources: [
      {
        title: "国税庁 タックスアンサー",
        url: "https://www.nta.go.jp/example",
        sourceType: "国税庁",
        legalReference: "所得税法",
        publicationDate: null,
        effectiveDate: null,
        lastUpdatedAt: null,
        retrievedAt: "2026-07-23T00:00:00.000Z",
        quote: "根拠箇所",
      },
    ],
    sourceVerification: "verified",
    requiresTaxProfessionalReview: false,
    handoffSummary: {
      clientName: "未登録",
      questionSummary: "質問",
      provisionalAnswer: "暫定回答",
      assumptions: [],
      requiredChecks: [],
      references: [],
      urgency: "通常",
      responseDeadline: null,
    },
    clientContextFieldsUsed: [],
    model: "test",
    promptVersion: "test",
    generatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

test("料金の質問には固定された料金表を返す", () => {
  assert.equal(isPricingInquiry("AI使い放題はいくらですか？"), true);
  assert.equal(isPricingInquiry("この取引の税金はいくらですか？"), false);
  assert.match(TAX_AI_PRICING_MESSAGE, /無料（月10回まで）/);
  assert.match(TAX_AI_PRICING_MESSAGE, /月3件：月7,700円/);
  assert.match(TAX_AI_PRICING_MESSAGE, /追加の税理士確認：1件3,300円/);
});

test("税理士個別相談ボタンのpostbackだけを受付対象にする", () => {
  assert.equal(
    isTaxProfessionalReviewPostback("action=tax_professional_review"),
    true,
  );
  assert.equal(isTaxProfessionalReviewPostback("action=other"), false);
});

test("検証済みの一般回答は自動回答可能と判定する", () => {
  assert.equal(shouldAutoReply(draft()), true);
  assert.equal(
    shouldAutoReply(
      draft({
        answerLevel: "C",
        requiresTaxProfessionalReview: true,
      }),
    ),
    false,
  );
  assert.equal(shouldAutoReply(draft({ sources: [], sourceVerification: "unverified" })), false);
});

test("AI自動回答であることを文頭に一度だけ明示する", () => {
  const marked = markAsAiAutoReply("【結論】\n回答です。");
  assert.equal(
    marked,
    "※AIによる自動回答です\n\n【結論】\n回答です。",
  );
  assert.equal(markAsAiAutoReply(marked), marked);
});

test("回答本文に公式根拠を補い、個別判断には有料確認の導線を付ける", () => {
  const ordinary = buildCustomerReply(draft());
  assert.match(ordinary, /【主な根拠】/);
  assert.match(ordinary, /https:\/\/www\.nta\.go\.jp\/example/);

  const review = buildCustomerReply(
    draft({
      answerLevel: "C",
      requiresTaxProfessionalReview: true,
    }),
  );
  assert.match(review, /【税理士確認のご案内】/);
  assert.match(review, /回答下のボタン/);
  assert.doesNotMatch(review, /税理士確認を依頼/);
  assert.match(review, /追加1件3,300円/);
});
