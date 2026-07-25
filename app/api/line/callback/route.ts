import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendAuditRecord,
  appendConversationMessage,
  createApproval,
  createConsultation,
  deleteConsultation,
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
import {
  currentPolicyVersion,
  legalConsentRequired,
} from "@/lib/legal/config";
import { verifyLineSignature } from "@/lib/line/verifySignature";
import {
  fetchLineDisplayName,
  fetchLineMembership,
} from "@/lib/membership/lineMembership";
import { appendUsageSummary, buildLimitMessage } from "@/lib/membership/messages";
import {
  beginWebhookEvent,
  cancelTaxReviewIntake,
  cancelReviewRequest,
  cancelUsage,
  completeReviewRequest,
  consumeUsage,
  createReviewDraft,
  endMembership,
  ensureMembershipUser,
  failReviewRequest,
  finishWebhookEvent,
  getMembershipBillingState,
  getUsageSummary,
  hasPolicyAcceptance,
  membershipBillingEnabled,
  recordPolicyAcceptance,
  registerMembershipUser,
  reserveUsage,
  submitReviewRequest,
  startTaxReviewIntake,
  syncMembership,
  takeTaxReviewIntake,
  updateMembershipDisplayName,
} from "@/lib/membership/store";
import {
  sendStaffApprovalMessage,
  sendStaffConsultationMessage,
} from "@/lib/lineworks/client";
import { generateReplyDraft } from "@/lib/openai/generateReplyDraft";
import { redactSensitiveText } from "@/lib/security/redaction";
import { isClarificationOnly } from "@/lib/tax/policy";
import {
  buildCustomerReply,
  buildReviewRequestReceipt,
  buildTaxReviewIntakePrompt,
  isMembershipCancellationInquiry,
  isPricingInquiry,
  isTaxProfessionalReviewPostback,
  markAsAiAutoReply,
  TAX_AI_PRICING_MESSAGE,
} from "@/lib/tax/hybridService";
import {
  createCustomerPortalSession,
  createSubscriptionCheckoutSession,
} from "@/lib/stripe/billing";
import { stripeBillingEnabled } from "@/lib/stripe/config";

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
        action: "start" | "intake" | "submit" | "cancel";
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

function getReviewPostbackEvent(
  event: LineEvent,
): {
  eventId: string;
  userId: string;
  action: "start" | "intake" | "submit" | "cancel";
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
          : null;
  if (!action) return null;
  const reviewRequestId = params.get("id") ?? undefined;
  if (
    (action === "submit" || action === "cancel") &&
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

async function notifyTaxProfessionalReview(
  event: { eventId: string; userId: string },
  conversationHistory: Awaited<ReturnType<typeof getConversationHistory>>,
  customerText: string,
): Promise<void> {
  const id = createHash("sha256").update(event.eventId).digest("hex").slice(0, 32);
  const now = new Date().toISOString();
  const recentContext = conversationHistory
    .slice(-6)
    .map((message) => `${message.role === "customer" ? "顧客" : "AI"}: ${message.text}`)
    .join("\n\n");

  const consultation = {
    id,
    lineUserId: event.userId,
    staffContext: [
      `LINE利用者: ${createHash("sha256").update(event.userId).digest("hex").slice(0, 12)}`,
      "",
      redactSensitiveText(recentContext || customerText).slice(0, 1600),
    ].join("\n"),
    status: "waiting_reply" as const,
    lineRetryKey: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  if (!(await createConsultation(consultation))) return;

  try {
    await sendStaffConsultationMessage(consultation);
    const receipt = buildReviewRequestReceipt();
    await pushLineMessage(event.userId, receipt, randomUUID());
    await Promise.all([
      appendConversationMessage(event.userId, {
        role: "customer",
        text: customerText,
        createdAt: now,
      }),
      appendConversationMessage(event.userId, {
        role: "assistant",
        text: receipt,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    await deleteConsultation(id);
    throw error;
  }
}

async function startTaxProfessionalReview(event: {
  eventId: string;
  userId: string;
}): Promise<void> {
  const summary = await getUsageSummary(event.userId);
  if (summary.taxReviewRemaining < 1) {
    const message =
      summary.planCode === "free"
        ? "税理士確認は、あんしん会員でご利用いただけます。"
        : `今期の税理士確認枠を使い切りました。\n次回更新日：${summary.periodEnd}`;
    await pushLineMessage(event.userId, message, randomUUID(), {
      includeMembershipJoinButton: summary.planCode === "free",
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
  const reviewRequestId = await createReviewDraft({
    lineUserId: event.userId,
    conversationId: event.eventId,
    summary: redactSensitiveText(questionSummary),
  });
  await pushLineReviewConfirmation(
    event.userId,
    questionSummary,
    reviewRequestId,
    randomUUID(),
  );
}

async function startTaxProfessionalReviewIntake(event: {
  userId: string;
}): Promise<void> {
  const summary = await getUsageSummary(event.userId);
  if (summary.taxReviewRemaining < 1) {
    const message =
      summary.planCode === "free"
        ? "税理士への個別相談は、あんしん会員でご利用いただけます。"
        : `今期の税理士相談枠を使い切りました。\n次回更新日：${summary.periodEnd}`;
    await pushLineMessage(event.userId, message, randomUUID(), {
      includeMembershipJoinButton: summary.planCode === "free",
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
  const reviewRequestId = await createReviewDraft({
    lineUserId: event.userId,
    conversationId: event.eventId,
    summary: redactSensitiveText(event.text).slice(0, 1200),
  });
  await pushLineReviewConfirmation(
    event.userId,
    event.text,
    reviewRequestId,
    randomUUID(),
  );
  await appendConversationMessage(event.userId, {
    role: "customer",
    text: event.text,
    createdAt: new Date().toISOString(),
  });
}

async function submitTaxProfessionalReview(event: {
  eventId: string;
  userId: string;
  reviewRequestId: string;
}): Promise<void> {
  const reservation = await submitReviewRequest({
    lineUserId: event.userId,
    reviewRequestId: event.reviewRequestId,
    idempotencyKey: `line:${event.eventId}:tax_review`,
  });
  if (!reservation.allowed || !reservation.usageEventId) {
    await pushLineMessage(
      event.userId,
      `今期の税理士確認枠を使い切りました。\n次回更新日：${reservation.periodEnd}`,
      randomUUID(),
    );
    return;
  }
  const history = await getConversationHistory(event.userId);
  try {
    await notifyTaxProfessionalReview(
      event,
      history,
      "税理士確認依頼（内容確認済み）",
    );
    await completeReviewRequest(
      event.userId,
      event.reviewRequestId,
      reservation.usageEventId,
    );
  } catch (error) {
    await failReviewRequest(
      event.userId,
      event.reviewRequestId,
      reservation.usageEventId,
    );
    throw error;
  }
}

async function processTextEvent(event: ReturnType<typeof getTextEvent>): Promise<void> {
  if (!event) return;

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
      await showLegalConsentPrompt(event.userId);
      return;
    }
    if (!(await getMembershipBillingState(event.userId))) {
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
        "ご登録ありがとうございます。無料会員または有料のあんしん会員を選択できます。",
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

  if (billingActive && (await takeTaxReviewIntake(event.userId))) {
    await confirmTaxReviewIntake(event);
    return;
  }

  if (isMembershipCancellationInquiry(event.text)) {
    const billingState =
      membershipBillingEnabled() && stripeBillingEnabled()
        ? await getMembershipBillingState(event.userId)
        : null;
    const stripeMembership =
      billingState?.provider === "stripe" &&
      ["active", "past_due", "cancel_at_period_end", "suspended"].includes(
        billingState.status,
      );
    if (!stripeMembership) {
      const message =
        "有効なStripe契約はないため、有料会員の解約手続は不要です。無料会員の利用終了又は個人データの削除・利用停止を希望する場合は、info@abtax.jp又は当法人ウェブサイトのお問い合わせフォームからご連絡ください。LINEメンバーシップで加入している場合は、LINE内の会員設定から退会状況をご確認ください。";
      await pushLineMessage(event.userId, message, randomUUID());
      await Promise.all([
        appendConversationMessage(event.userId, {
          role: "customer",
          text: event.text,
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

    const cancellationScheduled = billingState.status === "cancel_at_period_end";
    const portalUrl = await createCustomerPortalSession(event.userId, {
      cancellationFlow: !cancellationScheduled,
    });
    const message = cancellationScheduled
      ? "退会予約済みです。現在の契約期間が終了するまでは、あんしん会員の機能をご利用いただけます。下のボタンから契約状況の確認や退会予約の取り消しができます。"
      : "退会はStripeの安全な契約管理画面で手続きできます。退会を確定すると次回更新が停止され、現在の契約期間が終了するまでは、あんしん会員の機能をご利用いただけます。";
    await pushLineMessage(event.userId, message, randomUUID(), {
      includeMembershipManagementButton: true,
      membershipManagementUrl: portalUrl,
    });
    await Promise.all([
      appendConversationMessage(event.userId, {
        role: "customer",
        text: event.text,
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
    const billingState = stripeBillingEnabled()
      ? await getMembershipBillingState(event.userId)
      : null;
    const alreadyPaid = Boolean(
      billingState &&
        ["active", "past_due", "cancel_at_period_end", "suspended"].includes(
          billingState.status,
        ),
    );
    const stripeJoinUrl =
      stripeBillingEnabled() && !alreadyPaid
        ? await createSubscriptionCheckoutSession({
            lineUserId: event.userId,
            planCode: "anshin",
            idempotencyKey: event.eventId,
          })
        : undefined;
    await pushLineMessage(event.userId, TAX_AI_PRICING_MESSAGE, randomUUID(), {
      includeMembershipJoinButton: !alreadyPaid,
      membershipJoinUrl: stripeJoinUrl,
    });
    await Promise.all([
      appendConversationMessage(event.userId, {
        role: "customer",
        text: event.text,
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
      includeMembershipJoinButton: reservation.planCode === "free",
    });
    return;
  }

  let generatedDraft: Awaited<ReturnType<typeof generateReplyDraft>>;
  try {
    generatedDraft = await generateReplyDraft(
      event.text,
      conversationHistory,
      clientProfile,
    );
  } catch (error) {
    if (reservation?.usageEventId) await cancelUsage(reservation.usageEventId);
    throw error;
  }
  const clarification = isClarificationOnly(generatedDraft.draftReply);
  if (clarification && reservation?.usageEventId) {
    await cancelUsage(reservation.usageEventId);
  }
  const autoReply = hybridAutoReplyEnabled();
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
    customerMessage: event.text,
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
        redactedQuestion: redactSensitiveText(event.text),
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
        text: event.text,
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
              "友だち追加ありがとうございます。無料会員または有料のあんしん会員を選択してください。",
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
                ? "現在は有料契約中です。無料会員への変更は「退会・契約管理」から期間末解約を行ってください。"
                : registration.isNew
                  ? "無料会員として登録しました。AI回答を毎月10回まで利用できます。"
                  : "現在、無料会員として利用できます。",
            );
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
              const checkoutUrl = await createSubscriptionCheckoutSession({
                lineUserId: accepted.event.userId,
                planCode: "anshin",
                idempotencyKey: accepted.event.eventId,
              });
              await pushLineMessage(
                accepted.event.userId,
                `${TAX_AI_PRICING_MESSAGE}\n\n有料会員を選択しました。下のボタンから決済へ進んでください。`,
                randomUUID(),
                {
                  includeMembershipJoinButton: true,
                  membershipJoinUrl: checkoutUrl,
                },
              );
            } else {
              await sendMembershipStatus(
                accepted.event.userId,
                `${TAX_AI_PRICING_MESSAGE}\n\n有料会員を選択しました。現在、決済受付は準備中です。`,
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
              const conversationHistory = await getConversationHistory(
                accepted.event.userId,
              );
              await notifyTaxProfessionalReview(
                accepted.event,
                conversationHistory,
                "税理士へ個別相談（ボタン）",
              );
            }
          } else if (
            accepted.event.action === "submit" &&
            accepted.event.reviewRequestId
          ) {
            await submitTaxProfessionalReview({
              ...accepted.event,
              reviewRequestId: accepted.event.reviewRequestId,
            });
          } else if (accepted.event.reviewRequestId) {
            await cancelReviewRequest(
              accepted.event.userId,
              accepted.event.reviewRequestId,
            );
            await pushLineMessage(
              accepted.event.userId,
              "税理士確認の依頼をキャンセルしました。",
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
