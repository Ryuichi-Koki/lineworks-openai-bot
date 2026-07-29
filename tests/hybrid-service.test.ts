import assert from "node:assert/strict";
import test from "node:test";
import type { ReplyDraft } from "../lib/openai/generateReplyDraft.ts";
import {
  AI_ANSWER_PROCESSING_MESSAGE,
  buildCustomerReply,
  buildReviewRequestReceipt,
  buildTaxReviewIntakePrompt,
  isMembershipCancellationInquiry,
  isPricingInquiry,
  isTaxProfessionalReviewPostback,
  markAsAiAutoReply,
  markAsReviewedAiReply,
  markAsTaxProfessionalReply,
  shouldAutoReply,
  TAX_AI_CHECKOUT_INTRO_MESSAGE,
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
  assert.equal(isPricingInquiry("料金を教えて"), true);
  assert.equal(isPricingInquiry("この取引の税金はいくらですか？"), false);
  assert.match(TAX_AI_PRICING_MESSAGE, /基本無料：毎月100件まで/);
  assert.match(TAX_AI_PRICING_MESSAGE, /テスト期間価格：1回1,000円（税込）/);
  assert.match(TAX_AI_PRICING_MESSAGE, /2027年1月1日以降：1回3,000円（税込）/);
});

test("税理士相談への回答は回答主体を明示し、AI回答と区別できる", () => {
  const marked = markAsTaxProfessionalReply("結論として損金算入できます。");

  assert.match(marked, /Apex Brain税理士法人からの回答/);
  assert.match(marked, /当法人の社員税理士又は所属税理士が確認しています。/);
  assert.match(marked, /結論として損金算入できます。/);
  // AI回答の目印は付かない（両者が混ざらないこと）
  assert.doesNotMatch(marked, /※AIによる自動回答です/);
  // 二重付与しない
  assert.equal(markAsTaxProfessionalReply(marked), marked);
});

test("承認モードのAI下書きにも作成主体を明示する", () => {
  const marked = markAsReviewedAiReply("一般的には対象になります。");

  assert.match(marked, /^※AIが作成し、当法人の担当者が確認のうえ送信した回答です/);
  assert.match(marked, /一般的には対象になります。/);
  assert.equal(markAsReviewedAiReply(marked), marked);

  // 自動回答の目印が付いていた場合は置き換える（二重表示を避ける）
  const fromAutoReply = markAsReviewedAiReply(
    markAsAiAutoReply("一般的には対象になります。"),
  );
  assert.match(fromAutoReply, /^※AIが作成し、当法人の担当者が確認のうえ送信した回答です/);
  assert.doesNotMatch(fromAutoReply, /※AIによる自動回答です/);
});

test("AI回答と税理士回答の目印が互いに衝突しない", () => {
  const ai = markAsAiAutoReply("回答本文");
  const professional = markAsTaxProfessionalReply("回答本文");
  assert.notEqual(ai, professional);
  assert.doesNotMatch(ai, /Apex Brain税理士法人からの回答/);
});

test("料金案内は決済が発生しないことを明示する", () => {
  assert.match(TAX_AI_PRICING_MESSAGE, /※このメッセージでは決済は発生しません。/);
  assert.match(TAX_AI_PRICING_MESSAGE, /月額料金や自動更新はありません/);
});

test("決済前の案内は金額・自動更新・完了通知・二重申込防止を伝える", () => {
  assert.match(TAX_AI_CHECKOUT_INTRO_MESSAGE, /相談1回分のみ（自動更新なし）/);
  assert.match(TAX_AI_CHECKOUT_INTRO_MESSAGE, /カード情報は当法人では保持しません/);
  assert.match(TAX_AI_CHECKOUT_INTRO_MESSAGE, /完了メッセージが届きます/);
  assert.match(TAX_AI_CHECKOUT_INTRO_MESSAGE, /もう一度お申し込みボタンを押さないでください/);
});

test("税理士個別相談ボタンのpostbackだけを受付対象にする", () => {
  assert.equal(
    isTaxProfessionalReviewPostback("action=tax_professional_review"),
    true,
  );
  assert.equal(isTaxProfessionalReviewPostback("action=other"), false);
});

test("会員契約の退会・解約依頼だけを契約管理導線として検出する", () => {
  assert.equal(isMembershipCancellationInquiry("退会したい"), true);
  assert.equal(
    isMembershipCancellationInquiry("あんしん会員を解約したいです"),
    true,
  );
  assert.equal(
    isMembershipCancellationInquiry("解約した取引の違約金は課税されますか"),
    false,
  );
});

test("契約・解約・料金を含む税務質問を会員導線へ誤って流さない", () => {
  // いずれも税務相談であり、Stripeの契約管理や料金案内を返してはならない
  const taxQuestions = [
    "契約の中途解約違約金の損金算入時期を教えてください",
    "顧問契約を解約した場合の消費税の取扱いを教えてください",
    "税理士報酬の料金は経費になりますか",
    "サブスクリプションの利用料金は全額損金算入できますか",
    "リース契約を中途解約したときの会計処理と税務処理を教えてください",
    "解約手数料に消費税は課税されますか",
  ];
  for (const question of taxQuestions) {
    assert.equal(
      isMembershipCancellationInquiry(question),
      false,
      `退会導線へ誤誘導: ${question}`,
    );
    assert.equal(
      isPricingInquiry(question),
      false,
      `料金案内へ誤誘導: ${question}`,
    );
  }
});

test("会員手続きの問い合わせは従来どおり検出する", () => {
  const cancellations = [
    "退会したい",
    "解約手続き",
    "あんしん会員を解約したいです",
    "有料会員をやめたいので退会したい",
    "サブスクを停止したい",
  ];
  for (const message of cancellations) {
    assert.equal(
      isMembershipCancellationInquiry(message),
      true,
      `退会導線を検出できない: ${message}`,
    );
  }

  const pricing = [
    "料金を教えて",
    "AI使い放題はいくらですか？",
    "あんしん会員の月額はいくら",
    "プラン",
    "サービスの料金プランを知りたい",
  ];
  for (const message of pricing) {
    assert.equal(
      isPricingInquiry(message),
      true,
      `料金案内を検出できない: ${message}`,
    );
  }
});

test("長文は会員手続きではなく税務相談として扱う", () => {
  const longMessage =
    "会員の件でお尋ねしたいのですが、そもそも当社の状況を前提にすると、" +
    "どのような対応が適切なのか判断がつかず、まずは全体像から相談したいと考えています。解約";
  assert.ok(longMessage.length > 60);
  assert.equal(isMembershipCancellationInquiry(longMessage), false);
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

test("AI回答の生成前に待ち時間を案内する", () => {
  assert.match(AI_ANSWER_PROCESSING_MESSAGE, /ご質問を受け付けました/);
  assert.match(AI_ANSWER_PROCESSING_MESSAGE, /AIが回答を作成しています/);
  assert.match(AI_ANSWER_PROCESSING_MESSAGE, /そのままお待ちください/);
});

test("個別相談の受付後は回答待ちを自動案内する", () => {
  const receipt = buildReviewRequestReceipt();
  assert.match(receipt, /税理士への個別相談を受け付けました/);
  assert.match(receipt, /回答まで、しばらくお待ちください/);
});

test("税理士相談の入力前に個人情報を送信しないよう注意する", () => {
  const prompt = buildTaxReviewIntakePrompt();
  assert.match(prompt, /氏名、住所、電話番号、メールアドレス/);
  assert.match(prompt, /マイナンバー、口座・カード情報/);
  assert.match(prompt, /個人を特定できる情報や機密情報は送信しないでください/);
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
  assert.match(review, /【税理士相談のご案内】/);
  assert.match(review, /回答下のボタン/);
  assert.doesNotMatch(review, /税理士確認を依頼/);
  assert.match(review, /1回1,000円/);
  assert.match(review, /2027年1月1日以降は1回3,000円/);
});
