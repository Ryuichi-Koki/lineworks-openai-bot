import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendAuditRecord,
  appendConversationMessage,
  createApproval,
  getClientProfile,
  getConversationHistory,
  transitionApproval,
  type ApprovalRecord,
} from "@/lib/approvals/store";
import {
  pushLineLegalConsentPrompt,
  pushLineLegalMenu,
  pushLineMembershipSelectionPrompt,
  pushLineMessage,
  pushLineReviewConfirmation,
} from "@/lib/line/client";
import { isLineUserAllowed } from "@/lib/line/allowlist";
import {
  currentPolicyVersion,
  legalConsentRequired,
} from "@/lib/legal/config";
import { verifyLineSignature } from "@/lib/line/verifySignature";
import {
  fetchLineDisplayName,
  fetchLineMembership,
} from "@/lib/membership/lineMembership";
import {
  appendUsageSummary,
  buildLimitMessage,
  buildPaidPeriodLine,
  buildStatusMessage,
} from "@/lib/membership/messages";
import {
  BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE,
  noActiveSubscriptionManagementMessage,
} from "@/lib/membership/managementMessages";
import {
  beginWebhookEvent,
  cancelTaxReviewIntake,
  cancelReviewRequest,
  cancelUsage,
  consumeUsage,
  createReviewDraft,
  endMembership,
  ensureMembershipUser,
  enqueueTaxReviewDelivery,
  finishWebhookEvent,
  getMembershipBillingState,
  getUsageSummary,
  hasPolicyAcceptance,
  membershipBillingEnabled,
  recordPolicyAcceptance,
  registerMembershipUser,
  reserveUsage,
  savePendingQuestion,
  submitReviewRequest,
  startTaxReviewIntake,
  takePendingQuestion,
  syncMembership,
  takeTaxReviewIntake,
  updateMembershipDisplayName,
} from "@/lib/membership/store";
import {
  sendStaffApprovalMessage,
} from "@/lib/lineworks/client";
import { generateReplyDraft } from "@/lib/openai/generateReplyDraft";
import { redactSensitiveText } from "@/lib/security/redaction";
import { isClarificationOnly } from "@/lib/tax/policy";
import {
  AI_ANSWER_PROCESSING_MESSAGE,
  buildCustomerReply,
  buildTaxReviewIntakePrompt,
  isMembershipCancellationInquiry,
  isPricingInquiry,
  isTaxProfessionalReviewPostback,
  markAsAiAutoReply,
  TAX_AI_CHECKOUT_INTRO_MESSAGE,
  TAX_AI_CHECKOUT_REUSED_MESSAGE,
  TAX_AI_PRICING_MESSAGE,
  TAX_AI_QUESTION_GUIDE_MESSAGE,
} from "@/lib/tax/hybridService";
import { dispatchTaxProfessionalReview } from "@/lib/tax/consultationService";
import { processTaxReviewDelivery } from "@/lib/tax/deliveryQueue";
import {
  cancelTaxReviewCheckout,
  createCustomerPortalSession,
  createSubscriptionCheckoutSession,
  createTaxReviewCheckoutSession,
} from "@/lib/stripe/billing";
import { stripeBillingEnabled } from "@/lib/stripe/config";
import {
  oneTimeConsultationBillingEnabled,
  taxReviewPriceAt,
} from "@/lib/stripe/consultationPricing";

export const runtime = "nodejs";

type LineEvent = {
  type?: unknown;
  webhookEventId?: unknown;
  source?: { type?: unknown; userId?: unknown };
  message?: { type?: unknown; text?: unknown };
  postback?: { data?: unknown };
  membership?: { type?: unknown; membershipId?: unknown };
};

type LineWebhookBody = { events?: unknown };
type AcceptedLineEvent =
  | {
      kind: "onboarding";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "free_membership";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "paid_membership";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "pricing";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "status";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "billing_portal";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "legal_menu";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "question_help";
      event: { eventId: string; userId: string };
    }
  | {
      kind: "legal_acceptance";
      event: {
        eventId: string;
        userId: string;
        policyVersion: string;
      };
    }
  | {
      kind: "review";
      event: {
        eventId: string;
        userId: string;
        action: "start" | "intake" | "submit" | "cancel" | "restart";
        reviewRequestId?: string;
      };
    }
  | {
      kind: "membership";
      event: {
        eventId: string;
        userId: string;
        membershipType: "joined" | "renewed" | "left";
        membershipId: string;
      };
    }
  | { kind: "text"; event: { eventId: string; userId: string; text: string } };

function hybridAutoReplyEnabled(): boolean {
  return process.env.LINE_HYBRID_AUTO_REPLY_ENABLED?.toLowerCase() !== "false";
}

function getTextEvent(event: LineEvent): { eventId: string; userId: string; text: string } | null {
  if (
    event.type !== "message" ||
    event.message?.type !== "text" ||
    typeof event.message.text !== "string" ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }

  const fallbackEventId = `${event.source.userId}:${event.message.text}`;
  return {
    eventId:
      typeof event.webhookEventId === "string" ? event.webhookEventId : fallbackEventId,
    userId: event.source.userId,
    text: event.message.text,
  };
}

function getFollowEvent(
  event: LineEvent,
): { eventId: string; userId: string } | null {
  if (
    event.type !== "follow" ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }
  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:follow`,
    userId: event.source.userId,
  };
}

function getFreeMembershipPostbackEvent(
  event: LineEvent,
): { eventId: string; userId: string } | null {
  const postbackData =
    typeof event.postback?.data === "string"
      ? new URLSearchParams(event.postback.data)
      : null;
  if (
    event.type !== "postback" ||
    postbackData?.get("action") !== "select_free_membership" ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }
  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:select_free_membership`,
    userId: event.source.userId,
  };
}

function getPaidMembershipPostbackEvent(
  event: LineEvent,
): { eventId: string; userId: string } | null {
  const postbackData =
    typeof event.postback?.data === "string"
      ? new URLSearchParams(event.postback.data)
      : null;
  if (
    event.type !== "postback" ||
    postbackData?.get("action") !== "select_paid_membership" ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }
  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:select_paid_membership`,
    userId: event.source.userId,
  };
}

/** 追加パラメータを持たないpostbackを共通に取り出す。 */
function getSimplePostbackEvent(
  event: LineEvent,
  action: string,
): { eventId: string; userId: string } | null {
  const postbackData =
    typeof event.postback?.data === "string"
      ? new URLSearchParams(event.postback.data)
      : null;
  if (
    event.type !== "postback" ||
    postbackData?.get("action") !== action ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }
  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:${action}`,
    userId: event.source.userId,
  };
}

function getLegalAcceptancePostbackEvent(
  event: LineEvent,
): {
  eventId: string;
  userId: string;
  policyVersion: string;
} | null {
  if (
    event.type !== "postback" ||
    typeof event.postback?.data !== "string" ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }
  const params = new URLSearchParams(event.postback.data);
  const policyVersion = params.get("version")?.trim();
  if (
    params.get("action") !== "accept_policies" ||
    !policyVersion
  ) {
    return null;
  }
  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:${event.postback.data}`,
    userId: event.source.userId,
    policyVersion,
  };
}

function isMembershipMenuInquiry(text: string): boolean {
  return /^\s*(?:メニュー|会員メニュー|各種手続き)\s*[。！!？?]?\s*$/.test(text);
}

function isLegalMenuInquiry(text: string): boolean {
  return /^\s*(?:規約|規約・各種情報|利用規約|プライバシーポリシー|特商法)\s*[。！!？?]?\s*$/.test(
    text,
  );
}

async function showMembershipMenu(
  userId: string,
  message = "会員メニューを表示します。",
): Promise<void> {
  await pushLineMessage(userId, message, randomUUID(), {
    includeMembershipMenu: true,
  });
}

async function sendMembershipStatus(
  userId: string,
  message: string,
): Promise<void> {
  await pushLineMessage(userId, message, randomUUID(), {
    includePersistentMenuButton: false,
  });
}

async function showLegalConsentPrompt(userId: string): Promise<void> {
  await pushLineLegalConsentPrompt(
    userId,
    currentPolicyVersion(),
    randomUUID(),
  );
}

async function showMembershipSelectionPrompt(userId: string): Promise<void> {
  await pushLineMembershipSelectionPrompt(userId, randomUUID());
}

async function hasActivePaidSubscription(userId: string): Promise<boolean> {
  if (!stripeBillingEnabled()) return false;
  const billingState = await getMembershipBillingState(userId);
  return Boolean(
    billingState?.provider === "stripe" &&
      ["active", "past_due", "cancel_at_period_end", "suspended"].includes(
        billingState.status,
      ),
  );
}

/**
 * 契約管理画面への導線。
 * intent が "cancel" のときだけStripeの解約フローを直接開く。
 * リッチメニューの「契約管理」から解約フローに落とさないための区別。
 */
async function showBillingManagement(
  userId: string,
  intent: "cancel" | "manage",
): Promise<string> {
  const billingState =
    membershipBillingEnabled() && stripeBillingEnabled()
      ? await getMembershipBillingState(userId)
      : null;
  const stripeMembership =
    billingState?.provider === "stripe" &&
    ["active", "past_due", "cancel_at_period_end", "suspended"].includes(
      billingState.status,
    );
  if (!stripeMembership) {
    const message =
      intent === "cancel"
        ? "有効なStripe契約はないため、有料会員の解約手続は不要です。無料会員の利用終了又は個人データの削除・利用停止を希望する場合は、info@abtax.jp又は当法人ウェブサイトのお問い合わせフォームからご連絡ください。LINEメンバーシップで加入している場合は、LINE内の会員設定から退会状況をご確認ください。"
        : noActiveSubscriptionManagementMessage(
            oneTimeConsultationBillingEnabled(),
          );
    await pushLineMessage(userId, message, randomUUID());
    return message;
  }

  const cancellationScheduled = billingState.status === "cancel_at_period_end";
  const portalUrl = await createCustomerPortalSession(userId, {
    cancellationFlow: intent === "cancel" && !cancellationScheduled,
  });
  const message = cancellationScheduled
    ? "退会予約済みです。現在の契約期間が終了するまでは、あんしん会員の機能をご利用いただけます。下のボタンから契約状況の確認や退会予約の取り消しができます。"
    : intent === "cancel"
      ? "退会はStripeの安全な契約管理画面で手続きできます。退会を確定すると次回更新が停止され、現在の契約期間が終了するまでは、あんしん会員の機能をご利用いただけます。"
      : "Stripeの安全な契約管理画面で、支払方法の確認・変更、請求履歴の確認、退会手続きができます。";
  await pushLineMessage(userId, message, randomUUID(), {
    includeMembershipManagementButton: true,
    membershipManagementUrl: portalUrl,
  });
  return message;
}

/**
 * 失敗を利用者に伝える。通知自体の失敗で元の例外を隠さないよう、
 * ここでの例外は握り潰してログに残す。
 */
async function notifyUserOfFailure(
  userId: string,
  message: string,
): Promise<void> {
  try {
    await pushLineMessage(userId, message, randomUUID());
  } catch (error) {
    console.error("Failed to notify the user of an error", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/** 会員状態の照会。AI回答の回数を消費しない。 */
async function showMembershipStatusSummary(userId: string): Promise<void> {
  if (!membershipBillingEnabled()) {
    await pushLineMessage(
      userId,
      "現在、会員状態の照会はご利用いただけません。",
      randomUUID(),
    );
    return;
  }
  await ensureMembershipUser(userId);
  const summary = await getUsageSummary(userId);
  await pushLineMessage(userId, buildStatusMessage(summary), randomUUID(), {
    includeMembershipApplyButton:
      summary.planCode === "free" && !oneTimeConsultationBillingEnabled(),
  });
}

/**
 * 料金の確認のみを行う。ここではStripe Checkout Sessionを作成しない。
 * 決済ページは「あんしん会員に申し込む」を押した後（select_paid_membership）に初めて作成する。
 */
async function showPricingInfo(userId: string): Promise<void> {
  if (oneTimeConsultationBillingEnabled()) {
    await pushLineMessage(userId, TAX_AI_PRICING_MESSAGE, randomUUID());
    return;
  }
  const alreadyPaid = await hasActivePaidSubscription(userId);
  await pushLineMessage(userId, TAX_AI_PRICING_MESSAGE, randomUUID(), {
    includeMembershipApplyButton: !alreadyPaid,
  });
}

function getReviewPostbackEvent(
  event: LineEvent,
): {
  eventId: string;
  userId: string;
  action: "start" | "intake" | "submit" | "cancel" | "restart";
  reviewRequestId?: string;
} | null {
  if (
    event.type !== "postback" ||
    typeof event.postback?.data !== "string" ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }
  const params = new URLSearchParams(event.postback.data);
  const rawAction = params.get("action");
  const action =
    isTaxProfessionalReviewPostback(event.postback.data)
      ? "start"
      : rawAction === "start_tax_review_intake"
        ? "intake"
      : rawAction === "submit_tax_review"
        ? "submit"
        : rawAction === "cancel_tax_review"
          ? "cancel"
          : rawAction === "restart_tax_review"
            ? "restart"
            : null;
  if (!action) return null;
  const reviewRequestId = params.get("id") ?? undefined;
  if (
    (action === "submit" || action === "cancel" || action === "restart") &&
    !reviewRequestId
  ) {
    return null;
  }

  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:${event.postback.data}`,
    userId: event.source.userId,
    action,
    reviewRequestId,
  };
}

function getMembershipEvent(event: LineEvent): {
  eventId: string;
  userId: string;
  membershipType: "joined" | "renewed" | "left";
  membershipId: string;
} | null {
  if (
    event.type !== "membership" ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string" ||
    !["joined", "renewed", "left"].includes(String(event.membership?.type)) ||
    typeof event.membership?.membershipId !== "number"
  ) {
    return null;
  }
  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:membership:${event.membership.type}:${event.membership.membershipId}`,
    userId: event.source.userId,
    membershipType: event.membership.type as "joined" | "renewed" | "left",
    membershipId: String(event.membership.membershipId),
  };
}

async function handleMembershipEvent(event: {
  userId: string;
  membershipType: "joined" | "renewed" | "left";
}): Promise<void> {
  if (event.membershipType === "left") {
    const remainingMembership = await fetchLineMembership(event.userId);
    if (remainingMembership) await syncMembership(remainingMembership);
    else await endMembership(event.userId);
    return;
  }
  const membership = await fetchLineMembership(event.userId);
  if (!membership) throw new Error("LINE membership event has no active subscription");
  await syncMembership(membership);
}

async function startTaxProfessionalReview(event: {
  eventId: string;
  userId: string;
}): Promise<void> {
  const summary = await getUsageSummary(event.userId);
  if (
    summary.taxReviewRemaining < 1 &&
    !oneTimeConsultationBillingEnabled()
  ) {
    const message =
      summary.planCode === "free"
        ? "税理士相談は、あんしん会員でご利用いただけます。"
        : `今期の税理士相談枠を使い切りました。\n${buildPaidPeriodLine(summary.membershipStatus, summary.periodEnd)}`;
    await pushLineMessage(event.userId, message, randomUUID(), {
      includeMembershipApplyButton: summary.planCode === "free",
    });
    return;
  }
  const history = await getConversationHistory(event.userId);
  const questionSummary =
    history
      .filter((message) => message.role === "customer")
      .slice(-3)
      .map((message) => message.text)
      .join("\n")
      .slice(0, 1200) || "直前の税務相談";
  const safeQuestionSummary = redactSensitiveText(questionSummary);
  const reviewRequestId = await createReviewDraft({
    lineUserId: event.userId,
    conversationId: event.eventId,
    summary: safeQuestionSummary,
  });
  await pushLineReviewConfirmation(
    event.userId,
    safeQuestionSummary,
    reviewRequestId,
    randomUUID(),
    {
      taxReviewRemaining: summary.taxReviewRemaining,
      requiresPayment: summary.taxReviewRemaining < 1,
      paymentAmount: taxReviewPriceAt().amount,
    },
  );
}

async function startTaxProfessionalReviewIntake(event: {
  userId: string;
}): Promise<void> {
  const summary = await getUsageSummary(event.userId);
  if (
    summary.taxReviewRemaining < 1 &&
    !oneTimeConsultationBillingEnabled()
  ) {
    const message =
      summary.planCode === "free"
        ? "税理士への個別相談は、あんしん会員でご利用いただけます。"
        : `今期の税理士相談枠を使い切りました。\n${buildPaidPeriodLine(summary.membershipStatus, summary.periodEnd)}`;
    await pushLineMessage(event.userId, message, randomUUID(), {
      includeMembershipApplyButton: summary.planCode === "free",
    });
    return;
  }
  await startTaxReviewIntake(event.userId);
  await pushLineMessage(
    event.userId,
    buildTaxReviewIntakePrompt(),
    randomUUID(),
  );
}

async function confirmTaxReviewIntake(
  event: { eventId: string; userId: string; text: string },
): Promise<void> {
  const safeCustomerText = redactSensitiveText(event.text).slice(0, 1200);
  const [reviewRequestId, summary] = await Promise.all([
    createReviewDraft({
      lineUserId: event.userId,
      conversationId: event.eventId,
      summary: safeCustomerText,
    }),
    getUsageSummary(event.userId),
  ]);
  await pushLineReviewConfirmation(
    event.userId,
    safeCustomerText,
    reviewRequestId,
    randomUUID(),
    {
      taxReviewRemaining: summary.taxReviewRemaining,
      requiresPayment: summary.taxReviewRemaining < 1,
      paymentAmount: taxReviewPriceAt().amount,
    },
  );
  await appendConversationMessage(event.userId, {
    role: "customer",
    text: safeCustomerText,
    createdAt: new Date().toISOString(),
  });
}

async function submitTaxProfessionalReview(event: {
  eventId: string;
  userId: string;
  reviewRequestId: string;
}): Promise<void> {
  const summary = await getUsageSummary(event.userId);
  if (
    summary.taxReviewRemaining < 1 &&
    oneTimeConsultationBillingEnabled()
  ) {
    try {
      const checkout = await createTaxReviewCheckoutSession({
        lineUserId: event.userId,
        reviewRequestId: event.reviewRequestId,
      });
      await pushLineMessage(
        event.userId,
        checkout.reused
          ? "先ほど作成した税理士相談の決済画面をご案内します。二重請求は発生しません。"
          : TAX_AI_CHECKOUT_INTRO_MESSAGE,
        randomUUID(),
        {
          includeTaxReviewPaymentButton: true,
          taxReviewPaymentUrl: checkout.url,
          taxReviewPaymentAmount: checkout.amount,
          taxReviewRequestId: event.reviewRequestId,
        },
      );
    } catch (error) {
      console.error("Tax review Checkout creation failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      });
      await notifyUserOfFailure(
        event.userId,
        [
          "税理士相談の決済ページを作成できませんでした。",
          "ご請求は発生していません。時間をおいて、もう一度お試しください。",
        ].join("\n"),
      );
    }
    return;
  }
  const reservation = await submitReviewRequest({
    lineUserId: event.userId,
    reviewRequestId: event.reviewRequestId,
    idempotencyKey: `line:${event.eventId}:tax_review`,
  });
  if (!reservation.allowed || !reservation.usageEventId) {
    await pushLineMessage(
      event.userId,
      `今期の税理士相談枠を使い切りました。\n${buildPaidPeriodLine(reservation.membershipStatus, reservation.periodEnd)}`,
      randomUUID(),
    );
    return;
  }
  const jobId = await enqueueTaxReviewDelivery({
    eventId: `line:${event.eventId}:tax_review`,
    lineUserId: event.userId,
    reviewRequestId: event.reviewRequestId,
    usageEventId: reservation.usageEventId,
  });
  const delivery = await processTaxReviewDelivery(jobId);
  if (delivery !== "completed") {
    await notifyUserOfFailure(
      event.userId,
      [
        "税理士相談の受付情報を記録しました。",
        "現在、税理士への通知を再試行しています。受付完了後にLINEでお知らせします。",
        "",
        "重複して操作せず、そのままお待ちください。",
      ].join("\n"),
    );
  }
}

/**
 * 登録前に届いた質問を預かる。従来はここで質問を捨てていたため、
 * 利用者は同意・会員選択を終えたあとに同じ質問を打ち直す必要があった。
 */
async function holdQuestionForRegistration(
  userId: string,
  question: string,
): Promise<void> {
  try {
    await savePendingQuestion(userId, question);
    await pushLineMessage(
      userId,
      "ご質問をお預かりしました。\nご登録が完了しましたら、そのまま回答をお送りします。",
      randomUUID(),
      { includePersistentMenuButton: false },
    );
  } catch (error) {
    // 預かりに失敗しても登録導線自体は続行する。
    console.error("Failed to hold a question for registration", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/** 会員登録が済んだ時点で、預かっていた質問をそのまま回答フローへ流す。 */
async function releasePendingQuestion(event: {
  eventId: string;
  userId: string;
}): Promise<void> {
  if (!membershipBillingEnabled()) return;
  try {
    const question = await takePendingQuestion(event.userId);
    if (!question) return;
    await processTextEvent({
      eventId: `${event.eventId}:pending`,
      userId: event.userId,
      text: question,
    });
  } catch (error) {
    console.error("Failed to answer a held question after registration", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function processTextEvent(event: ReturnType<typeof getTextEvent>): Promise<void> {
  if (!event) return;
  const safeCustomerText = redactSensitiveText(event.text).slice(0, 8000);

  if (isLegalMenuInquiry(event.text)) {
    await pushLineLegalMenu(event.userId, randomUUID());
    return;
  }

  const billingActive = membershipBillingEnabled();
  if (billingActive && legalConsentRequired()) {
    const acceptedCurrentPolicies = await hasPolicyAcceptance(
      event.userId,
      currentPolicyVersion(),
    );
    if (!acceptedCurrentPolicies) {
      await holdQuestionForRegistration(event.userId, safeCustomerText);
      await showLegalConsentPrompt(event.userId);
      return;
    }
    if (!(await getMembershipBillingState(event.userId))) {
      await holdQuestionForRegistration(event.userId, safeCustomerText);
      await showMembershipSelectionPrompt(event.userId);
      return;
    }
  }

  const id = createHash("sha256").update(event.eventId).digest("hex").slice(0, 32);
  const [conversationHistory, clientProfile] = await Promise.all([
    getConversationHistory(event.userId),
    getClientProfile(event.userId),
  ]);
  const now = new Date().toISOString();
  if (billingActive) {
    const registration = await registerMembershipUser(event.userId);
    if (!registration.displayName) {
      const fetchedName = await fetchLineDisplayName(event.userId);
      if (fetchedName) {
        await updateMembershipDisplayName(event.userId, fetchedName);
      }
    }
    if (registration.isNew) {
      await showMembershipMenu(
        event.userId,
        "ご登録ありがとうございます。AI回答を毎月100件まで無料でご利用いただけます。",
      );
    }
  }

  if (isMembershipMenuInquiry(event.text)) {
    if (billingActive) await cancelTaxReviewIntake(event.userId);
    if (!billingActive) {
      await showMembershipMenu(event.userId);
    } else if (!(await getMembershipBillingState(event.userId))) {
      await registerMembershipUser(event.userId);
      await showMembershipMenu(event.userId);
    } else {
      await showMembershipMenu(event.userId);
    }
    return;
  }

  if (
    billingActive &&
    /^\s*(?:相談キャンセル|税理士相談キャンセル)\s*[。！!]?\s*$/.test(
      event.text,
    )
  ) {
    const canceled = await cancelTaxReviewIntake(event.userId);
    await pushLineMessage(
      event.userId,
      canceled
        ? "税理士相談の入力をキャンセルしました。"
        : "入力待ちの税理士相談はありません。",
      randomUUID(),
    );
    return;
  }

  if (billingActive) {
    const intake = await takeTaxReviewIntake(event.userId);
    if (intake === "active") {
      await confirmTaxReviewIntake(event);
      return;
    }
    if (intake === "expired") {
      // 受付時間を過ぎた相談文をAI質問として処理すると、意図せず回数を消費する。
      await pushLineMessage(
        event.userId,
        [
          "税理士相談の受付時間（30分）を過ぎたため、いただいた内容は受け付けていません。",
          "AI回答の回数は消費していません。",
          "",
          "お手数ですが、もう一度［税理士に相談］からお願いします。",
        ].join("\n"),
        randomUUID(),
      );
      return;
    }
  }

  if (isMembershipCancellationInquiry(event.text)) {
    const message = await showBillingManagement(event.userId, "cancel");
    await Promise.all([
      appendConversationMessage(event.userId, {
        role: "customer",
        text: safeCustomerText,
        createdAt: now,
      }),
      appendConversationMessage(event.userId, {
        role: "assistant",
        text: message,
        createdAt: now,
      }),
    ]);
    return;
  }

  if (isPricingInquiry(event.text)) {
    await showPricingInfo(event.userId);
    await Promise.all([
      appendConversationMessage(event.userId, {
        role: "customer",
        text: safeCustomerText,
        createdAt: now,
      }),
      appendConversationMessage(event.userId, {
        role: "assistant",
        text: TAX_AI_PRICING_MESSAGE,
        createdAt: now,
      }),
    ]);
    return;
  }

  const reservation = billingActive
    ? await reserveUsage({
        lineUserId: event.userId,
        usageType: "ai_answer",
        idempotencyKey: `line:${event.eventId}:ai_answer`,
        conversationId: id,
      })
    : null;
  if (reservation && !reservation.allowed) {
    await pushLineMessage(event.userId, buildLimitMessage(reservation), randomUUID(), {
      includeMembershipApplyButton:
        reservation.planCode === "free" &&
        !oneTimeConsultationBillingEnabled(),
    });
    return;
  }

  const autoReply = hybridAutoReplyEnabled();
  if (autoReply) {
    await pushLineMessage(
      event.userId,
      AI_ANSWER_PROCESSING_MESSAGE,
      randomUUID(),
      { includePersistentMenuButton: false },
    );
  }

  let generatedDraft: Awaited<ReturnType<typeof generateReplyDraft>>;
  try {
    generatedDraft = await generateReplyDraft(
      safeCustomerText,
      conversationHistory,
      clientProfile,
    );
  } catch (error) {
    if (reservation?.usageEventId) await cancelUsage(reservation.usageEventId);
    // 受付メッセージを送った後に無言で終わると、利用者は回答を待ち続ける。
    // 失敗したこと、回数を消費していないことを必ず伝える。
    await notifyUserOfFailure(
      event.userId,
      [
        "申し訳ありません。回答の作成に失敗しました。",
        "今回の分はAI回答の回数を消費していません。",
        "",
        "お手数ですが、もう一度ご質問をお送りください。",
      ].join("\n"),
    );
    throw error;
  }
  const clarification = isClarificationOnly(generatedDraft.draftReply);
  if (clarification && reservation?.usageEventId) {
    await cancelUsage(reservation.usageEventId);
  }
  let customerReply = buildCustomerReply(generatedDraft);
  if (reservation && !clarification) {
    const summary = await getUsageSummary(event.userId);
    customerReply = appendUsageSummary(customerReply, {
      ...summary,
      aiRemaining: reservation.remainingCount,
    });
  }
  const draft = {
    ...generatedDraft,
    draftReply: autoReply ? markAsAiAutoReply(customerReply) : customerReply,
  };
  const record: ApprovalRecord = {
    id,
    sourceEventId: event.eventId,
    lineUserId: event.userId,
    customerMessage: safeCustomerText,
    lineRetryKey: randomUUID(),
    ...draft,
    revision: 0,
    status: autoReply ? "sending" : "pending",
    createdAt: now,
    updatedAt: now,
    usageEventId:
      !clarification && reservation?.usageEventId
        ? reservation.usageEventId
        : undefined,
    responseType: clarification ? "clarification" : "final_answer",
  };

  if (await createApproval(record)) {
    try {
      await appendAuditRecord({
        approvalId: id,
        eventType: "draft_generated",
        recordedAt: now,
        redactedQuestion: safeCustomerText,
        answer: draft.draftReply,
        answerLevel: draft.answerLevel,
        confidence: draft.confidence,
        model: draft.model,
        promptVersion: draft.promptVersion,
        sources: draft.sources.map((source) => ({
          title: source.title,
          url: source.url,
          legalReference: source.legalReference,
          retrievedAt: source.retrievedAt,
          quote: source.quote,
        })),
        assumptions: draft.assumptions,
        referencedClientFields: draft.clientContextFieldsUsed,
      });
    } catch (error) {
      console.error("Failed to save draft audit record", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        approvalId: id,
      });
    }
    try {
      await appendConversationMessage(event.userId, {
        role: "customer",
        text: safeCustomerText,
        createdAt: now,
      });
    } catch (error) {
      console.error("Failed to save customer conversation history", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      });
    }
    if (autoReply) {
      try {
        await pushLineMessage(record.lineUserId, record.draftReply, record.lineRetryKey, {
          includeTaxReviewButton:
            record.requiresTaxProfessionalReview || record.answerLevel === "C",
        });
        if (record.usageEventId) await consumeUsage(record.usageEventId);
        await transitionApproval(record.id, "sending", "sent", "hybrid-auto");
        await appendConversationMessage(record.lineUserId, {
          role: "assistant",
          text: record.draftReply,
          createdAt: new Date().toISOString(),
        });
        await appendAuditRecord({
          approvalId: record.id,
          eventType: "reply_sent",
          recordedAt: new Date().toISOString(),
          answer: record.draftReply,
          answerLevel: record.answerLevel,
          confidence: record.confidence,
          model: record.model,
          promptVersion: record.promptVersion,
        });
      } catch (error) {
        await transitionApproval(record.id, "sending", "pending", "hybrid-auto");
        if (record.usageEventId) await cancelUsage(record.usageEventId);
        throw error;
      }
    } else {
      await sendStaffApprovalMessage(record);
    }
  } else if (reservation?.usageEventId) {
    await cancelUsage(reservation.usageEventId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  if (!verifyLineSignature(rawBody, request.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? (body.events as LineEvent[]) : [];
  const acceptedEvents: AcceptedLineEvent[] = [];
  const eventPayloadHashes = new Map<string, string>();
  for (const event of events) {
    const sourceUserId =
      event.source && typeof event.source.userId === "string"
        ? event.source.userId
        : null;
    if (sourceUserId && !isLineUserAllowed(sourceUserId)) {
      continue;
    }
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(event))
      .digest("hex");
    const followEvent = getFollowEvent(event);
    if (followEvent) {
      if (membershipBillingEnabled()) {
        acceptedEvents.push({ kind: "onboarding", event: followEvent });
        eventPayloadHashes.set(followEvent.eventId, payloadHash);
      }
      continue;
    }
    const membershipEvent = getMembershipEvent(event);
    if (membershipEvent) {
      if (membershipBillingEnabled()) {
        acceptedEvents.push({ kind: "membership", event: membershipEvent });
        eventPayloadHashes.set(membershipEvent.eventId, payloadHash);
      }
      continue;
    }
    const freeMembershipEvent = getFreeMembershipPostbackEvent(event);
    const paidMembershipEvent = getPaidMembershipPostbackEvent(event);
    const legalAcceptanceEvent = getLegalAcceptancePostbackEvent(event);
    const simplePostbacks = [
      ["pricing", "show_pricing"],
      ["status", "show_status"],
      ["billing_portal", "open_billing_portal"],
      ["legal_menu", "show_legal"],
      ["question_help", "start_question"],
    ] as const;
    let matchedSimplePostback = false;
    for (const [kind, action] of simplePostbacks) {
      const simpleEvent = getSimplePostbackEvent(event, action);
      if (!simpleEvent) continue;
      acceptedEvents.push({ kind, event: simpleEvent });
      eventPayloadHashes.set(simpleEvent.eventId, payloadHash);
      matchedSimplePostback = true;
      break;
    }
    if (matchedSimplePostback) continue;
    if (legalAcceptanceEvent) {
      acceptedEvents.push({
        kind: "legal_acceptance",
        event: legalAcceptanceEvent,
      });
      eventPayloadHashes.set(legalAcceptanceEvent.eventId, payloadHash);
      continue;
    }
    if (freeMembershipEvent) {
      acceptedEvents.push({
        kind: "free_membership",
        event: freeMembershipEvent,
      });
      eventPayloadHashes.set(freeMembershipEvent.eventId, payloadHash);
      continue;
    }
    if (paidMembershipEvent) {
      acceptedEvents.push({
        kind: "paid_membership",
        event: paidMembershipEvent,
      });
      eventPayloadHashes.set(paidMembershipEvent.eventId, payloadHash);
      continue;
    }
    const reviewPostback = getReviewPostbackEvent(event);
    if (reviewPostback) {
      acceptedEvents.push({ kind: "review", event: reviewPostback });
      eventPayloadHashes.set(reviewPostback.eventId, payloadHash);
      continue;
    }
    const textEvent = getTextEvent(event);
    if (textEvent) {
      acceptedEvents.push({ kind: "text", event: textEvent });
      eventPayloadHashes.set(textEvent.eventId, payloadHash);
    }
  }

  try {
    for (const accepted of acceptedEvents) {
      const eventHash =
        eventPayloadHashes.get(accepted.event.eventId) ??
        createHash("sha256").update(accepted.event.eventId).digest("hex");
      if (
        membershipBillingEnabled() &&
        !(await beginWebhookEvent({
          provider: "line",
          eventId: accepted.event.eventId,
          eventType: accepted.kind,
          payloadHash: eventHash,
        }))
      ) {
        continue;
      }
      try {
        if (accepted.kind === "onboarding") {
          if (legalConsentRequired()) {
            await showLegalConsentPrompt(accepted.event.userId);
          } else {
            const registration = await registerMembershipUser(
              accepted.event.userId,
            );
            if (!registration.displayName) {
              const fetchedName = await fetchLineDisplayName(
                accepted.event.userId,
              );
              if (fetchedName) {
                await updateMembershipDisplayName(
                  accepted.event.userId,
                  fetchedName,
                );
              }
            }
            await showMembershipMenu(
              accepted.event.userId,
              "友だち追加ありがとうございます。AI回答は毎月100件まで無料です。",
            );
          }
        } else if (accepted.kind === "legal_acceptance") {
          if (!legalConsentRequired()) {
            await showMembershipMenu(
              accepted.event.userId,
              "規程本文は現在準備中のため、同意受付はまだ開始していません。",
            );
          } else {
            const expectedVersion = currentPolicyVersion();
            if (accepted.event.policyVersion !== expectedVersion) {
              await showLegalConsentPrompt(accepted.event.userId);
            } else {
              await recordPolicyAcceptance({
                lineUserId: accepted.event.userId,
                policyVersion: expectedVersion,
                idempotencyKey: accepted.event.eventId,
              });
              await showMembershipSelectionPrompt(accepted.event.userId);
            }
          }
        } else if (accepted.kind === "free_membership") {
          if (
            legalConsentRequired() &&
            !(await hasPolicyAcceptance(
              accepted.event.userId,
              currentPolicyVersion(),
            ))
          ) {
            await showLegalConsentPrompt(accepted.event.userId);
          } else {
            const registration = await registerMembershipUser(
              accepted.event.userId,
            );
            const billingState = await getMembershipBillingState(
              accepted.event.userId,
            );
            const hasPaidSubscription =
              billingState?.provider === "stripe" &&
              ["active", "past_due", "cancel_at_period_end", "suspended"].includes(
                billingState.status,
              );
            await sendMembershipStatus(
              accepted.event.userId,
              hasPaidSubscription
                ? "現在は旧月額契約をご利用中です。無料利用への変更は［利用状況・退会］から期間末解約を行ってください。"
                : registration.isNew
                  ? [
                      "無料会員として登録しました。",
                      "AI回答を毎月100件までご利用いただけます。",
                      "",
                      "さっそくご質問をどうぞ。このトークにそのままお送りください。",
                      "",
                      "【質問の例】",
                      "・インボイスの2割特例は使えますか",
                      "・自宅兼事務所の家賃はどこまで経費にできますか",
                    ].join("\n")
                  : "現在、無料会員としてご利用いただけます。ご質問はこのトークにそのままお送りください。",
            );
            await releasePendingQuestion(accepted.event);
          }
        } else if (accepted.kind === "status") {
          await showMembershipStatusSummary(accepted.event.userId);
        } else if (accepted.kind === "billing_portal") {
          try {
            await showBillingManagement(accepted.event.userId, "manage");
          } catch (error) {
            console.error("Stripe billing management creation failed", {
              errorName: error instanceof Error ? error.name : "UnknownError",
              errorMessage:
                error instanceof Error ? error.message : "Unknown error",
            });
            await pushLineMessage(
              accepted.event.userId,
              BILLING_MANAGEMENT_UNAVAILABLE_MESSAGE,
              randomUUID(),
            );
          }
        } else if (accepted.kind === "legal_menu") {
          await pushLineLegalMenu(accepted.event.userId, randomUUID());
        } else if (accepted.kind === "question_help") {
          await pushLineMessage(
            accepted.event.userId,
            TAX_AI_QUESTION_GUIDE_MESSAGE,
            randomUUID(),
          );
        } else if (accepted.kind === "pricing") {
          if (
            legalConsentRequired() &&
            !(await hasPolicyAcceptance(
              accepted.event.userId,
              currentPolicyVersion(),
            ))
          ) {
            await showLegalConsentPrompt(accepted.event.userId);
          } else {
            await showPricingInfo(accepted.event.userId);
          }
        } else if (accepted.kind === "paid_membership") {
          if (
            legalConsentRequired() &&
            !(await hasPolicyAcceptance(
              accepted.event.userId,
              currentPolicyVersion(),
            ))
          ) {
            await showLegalConsentPrompt(accepted.event.userId);
          } else if (oneTimeConsultationBillingEnabled()) {
            await registerMembershipUser(accepted.event.userId);
            await pushLineMessage(
              accepted.event.userId,
              `${TAX_AI_PRICING_MESSAGE}\n\n税理士相談をご希望の場合は、リッチメニューの「税理士相談」から相談内容を入力してください。`,
              randomUUID(),
            );
          } else {
            const registration = await registerMembershipUser(
              accepted.event.userId,
            );
            if (!registration.displayName) {
              const fetchedName = await fetchLineDisplayName(
                accepted.event.userId,
              );
              if (fetchedName) {
                await updateMembershipDisplayName(
                  accepted.event.userId,
                  fetchedName,
                );
              }
            }
            const billingState = await getMembershipBillingState(
              accepted.event.userId,
            );
            const alreadyPaid =
              billingState?.provider === "stripe" &&
              ["active", "past_due", "cancel_at_period_end", "suspended"].includes(
                billingState.status,
            );
            if (alreadyPaid) {
              await sendMembershipStatus(
                accepted.event.userId,
                "現在は有料契約中です。",
              );
            } else if (stripeBillingEnabled()) {
              try {
                const checkout = await createSubscriptionCheckoutSession({
                  lineUserId: accepted.event.userId,
                  planCode: "anshin",
                });
                await pushLineMessage(
                  accepted.event.userId,
                  checkout.reused
                    ? TAX_AI_CHECKOUT_REUSED_MESSAGE
                    : TAX_AI_CHECKOUT_INTRO_MESSAGE,
                  randomUUID(),
                  {
                    includeMembershipJoinButton: true,
                    membershipJoinUrl: checkout.url,
                  },
                );
                // 決済前でも無料枠で回答できるため、預かった質問はここで解放する。
                await releasePendingQuestion(accepted.event);
              } catch (error) {
                console.error("Stripe Checkout creation failed", {
                  errorName: error instanceof Error ? error.name : "UnknownError",
                  errorMessage:
                    error instanceof Error ? error.message : "Unknown error",
                });
                await sendMembershipStatus(
                  accepted.event.userId,
                  "決済ページの作成に失敗しました。ご請求は発生していません。時間をおいて、もう一度［あんしん会員に申し込む］を押してください。",
                );
              }
            } else {
              await sendMembershipStatus(
                accepted.event.userId,
                `${TAX_AI_PRICING_MESSAGE}\n\n現在、決済受付は準備中です。準備が整い次第ご案内します。`,
              );
            }
          }
        } else if (accepted.kind === "membership") {
          await handleMembershipEvent(accepted.event);
        } else if (accepted.kind === "review") {
          if (accepted.event.action === "intake") {
            if (membershipBillingEnabled()) {
              await startTaxProfessionalReviewIntake(accepted.event);
            } else {
              await pushLineMessage(
                accepted.event.userId,
                "税理士への相談内容をメッセージで送信してください。",
                randomUUID(),
              );
            }
          } else if (accepted.event.action === "start") {
            if (membershipBillingEnabled()) {
              await startTaxProfessionalReview(accepted.event);
            } else {
              await dispatchTaxProfessionalReview({
                eventId: accepted.event.eventId,
                userId: accepted.event.userId,
                customerText: "税理士へ個別相談（ボタン）",
              });
            }
          } else if (
            accepted.event.action === "submit" &&
            accepted.event.reviewRequestId
          ) {
            await submitTaxProfessionalReview({
              ...accepted.event,
              reviewRequestId: accepted.event.reviewRequestId,
            });
          } else if (
            accepted.event.action === "restart" &&
            accepted.event.reviewRequestId
          ) {
            // 下書きを取り消して入力受付をやり直す。枠は submit 時点まで予約しないため消費しない。
            let canceled = await cancelReviewRequest(
              accepted.event.userId,
              accepted.event.reviewRequestId,
            );
            if (!canceled && oneTimeConsultationBillingEnabled()) {
              try {
                canceled = await cancelTaxReviewCheckout({
                  lineUserId: accepted.event.userId,
                  reviewRequestId: accepted.event.reviewRequestId,
                });
              } catch (error) {
                console.error("Tax review Checkout cancellation failed", {
                  errorName: error instanceof Error ? error.name : "UnknownError",
                  errorMessage:
                    error instanceof Error ? error.message : "Unknown error",
                });
                await pushLineMessage(
                  accepted.event.userId,
                  "決済画面の安全な停止を確認できなかったため、入力内容を変更していません。決済画面を閉じ、時間をおいてもう一度お試しください。",
                  randomUUID(),
                );
                continue;
              }
            }
            if (!canceled) {
              await pushLineMessage(
                accepted.event.userId,
                "お支払い済み又は受付済みのため、この内容は入力し直せません。",
                randomUUID(),
              );
            } else if (membershipBillingEnabled()) {
              await startTaxProfessionalReviewIntake(accepted.event);
            } else {
              await pushLineMessage(
                accepted.event.userId,
                "税理士への相談内容をもう一度メッセージで送信してください。",
                randomUUID(),
              );
            }
          } else if (accepted.event.reviewRequestId) {
            let canceled = await cancelReviewRequest(
              accepted.event.userId,
              accepted.event.reviewRequestId,
            );
            if (!canceled && oneTimeConsultationBillingEnabled()) {
              try {
                canceled = await cancelTaxReviewCheckout({
                  lineUserId: accepted.event.userId,
                  reviewRequestId: accepted.event.reviewRequestId,
                });
              } catch (error) {
                console.error("Tax review Checkout cancellation failed", {
                  errorName: error instanceof Error ? error.name : "UnknownError",
                  errorMessage:
                    error instanceof Error ? error.message : "Unknown error",
                });
              }
            }
            await pushLineMessage(
              accepted.event.userId,
              canceled
                ? "税理士相談の依頼をキャンセルしました。相談枠は消費していません。"
                : "お支払い済み又は受付済みのため、この内容はキャンセルできません。確認が必要な場合はinfo@abtax.jpへご連絡ください。",
              randomUUID(),
            );
          }
        } else {
          await processTextEvent(accepted.event);
        }
        if (membershipBillingEnabled()) {
          await finishWebhookEvent(
            "line",
            accepted.event.eventId,
            "processed",
            "ok",
          );
        }
      } catch (error) {
        if (membershipBillingEnabled()) {
          await finishWebhookEvent(
            "line",
            accepted.event.eventId,
            "failed",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
        throw error;
      }
    }
    return NextResponse.json({ ok: true, accepted: acceptedEvents.length });
  } catch (error) {
    console.error("LINE webhook processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
