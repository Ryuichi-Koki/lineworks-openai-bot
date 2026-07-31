import { NextResponse } from "next/server";
import {
  appendAuditRecord,
  appendConversationMessage,
  createConsultationReplySession,
  createRevisionSession,
  deleteConsultationReplySession,
  deleteRevisionSession,
  getApproval,
  getConsultation,
  getConsultationReplySession,
  getRevisionSession,
  transitionConsultation,
  transitionApproval,
  updateConsultationReplySession,
  updateApprovalDraft,
} from "@/lib/approvals/store";
import { pushLineMessage } from "@/lib/line/client";
import { deriveLineRetryKey } from "@/lib/line/retryKey";
import {
  markAsReviewedAiReply,
  markAsTaxProfessionalReply,
} from "@/lib/tax/hybridService";
import {
  cancelUsage,
  consumeUsage,
  membershipBillingEnabled,
} from "@/lib/membership/store";
import {
  sendStaffApprovalMessage,
  sendStaffChannelMessage,
  sendStaffConsultationConfirmation,
} from "@/lib/lineworks/client";
import {
  isAuthorizedApprover,
  parseApproverUserIds,
} from "@/lib/lineworks/approvers";
import { verifyLineWorksSignature } from "@/lib/lineworks/verifySignature";
import { reviseReplyDraft } from "@/lib/openai/generateReplyDraft";

export const runtime = "nodejs";

type LineWorksCallbackEvent = {
  type?: unknown;
  source?: { userId?: unknown; channelId?: unknown };
  data?: unknown;
  content?: { type?: unknown; text?: unknown; postback?: unknown };
};

type ApprovalAction = "approve" | "revise" | "reject";

type ApprovalActionEvent = {
  approvalId: string;
  action: ApprovalAction;
  reviewerUserId: string;
  channelId: string;
  revision: number | null;
};

type ConsultationAction = "reply" | "send" | "edit" | "cancel";

type ConsultationActionEvent = {
  consultationId: string;
  action: ConsultationAction;
  reviewerUserId: string;
  channelId: string;
};

function getConversationId(event: LineWorksCallbackEvent, reviewerUserId: string): string {
  return typeof event.source?.channelId === "string"
    ? event.source.channelId
    : `direct:${reviewerUserId}`;
}

function getApprovalAction(event: LineWorksCallbackEvent): ApprovalActionEvent | null {
  const postback = event.type === "postback" ? event.data : event.content?.postback;
  const reviewerUserId = event.source?.userId;
  if (typeof postback !== "string" || typeof reviewerUserId !== "string") {
    return null;
  }
  const channelId = getConversationId(event, reviewerUserId);

  const values = new URLSearchParams(postback);
  const approvalId = values.get("approvalId");
  const action = values.get("action");
  const revisionValue = values.get("revision");
  const revision = revisionValue !== null && /^\d+$/.test(revisionValue) ? Number(revisionValue) : null;
  if (!approvalId || (action !== "approve" && action !== "revise" && action !== "reject")) {
    return null;
  }
  return { approvalId, action, reviewerUserId, channelId, revision };
}

function getConsultationAction(
  event: LineWorksCallbackEvent,
): ConsultationActionEvent | null {
  const postback = event.type === "postback" ? event.data : event.content?.postback;
  const reviewerUserId = event.source?.userId;
  if (typeof postback !== "string" || typeof reviewerUserId !== "string") {
    return null;
  }
  const values = new URLSearchParams(postback);
  const consultationId = values.get("consultationId");
  const action = values.get("action");
  if (
    !consultationId ||
    (action !== "reply" &&
      action !== "send" &&
      action !== "edit" &&
      action !== "cancel")
  ) {
    return null;
  }
  return {
    consultationId,
    action,
    reviewerUserId,
    channelId: getConversationId(event, reviewerUserId),
  };
}

function getRevisionInstruction(
  event: LineWorksCallbackEvent,
): { reviewerUserId: string; channelId: string; instruction: string } | null {
  if (
    event.type !== "message" ||
    event.content?.type !== "text" ||
    typeof event.content.text !== "string" ||
    typeof event.source?.userId !== "string" ||
    typeof event.content.postback === "string"
  ) {
    return null;
  }
  const instruction = event.content.text.trim();
  const channelId = getConversationId(event, event.source.userId);
  return instruction
    ? { reviewerUserId: event.source.userId, channelId, instruction }
    : null;
}

function isCurrentRevision(recordRevision: number | undefined, requestedRevision: number | null): boolean {
  const currentRevision = recordRevision ?? 0;
  return requestedRevision === null ? currentRevision === 0 : requestedRevision === currentRevision;
}

async function handleApproval(
  approvalId: string,
  reviewerUserId: string,
  revision: number | null,
): Promise<{ status: string }> {
  const record = await getApproval(approvalId);
  if (!record) return { status: "not_found" };
  if (!isCurrentRevision(record.revision, revision)) return { status: "stale_revision" };
  if (record.status !== "pending") return { status: record.status };

  const claimed = await transitionApproval(approvalId, "pending", "sending", reviewerUserId);
  if (!claimed) return { status: "already_processed" };

  // 送信本文と保存本文を一致させる（利用者が見たものがそのまま履歴・監査に残る）。
  const sentReply = markAsReviewedAiReply(claimed.draftReply);
  try {
    await pushLineMessage(claimed.lineUserId, sentReply, claimed.lineRetryKey);
    if (membershipBillingEnabled() && claimed.usageEventId) {
      await consumeUsage(claimed.usageEventId);
    }
    await transitionApproval(approvalId, "sending", "sent", reviewerUserId);
    try {
      await appendAuditRecord({
        approvalId,
        eventType: "reply_sent",
        recordedAt: new Date().toISOString(),
        answer: sentReply,
        answerLevel: claimed.answerLevel,
        confidence: claimed.confidence,
        model: claimed.model,
        promptVersion: claimed.promptVersion,
        reviewerUserId,
      });
    } catch (auditError) {
      console.error("Failed to save sent audit record", {
        errorName: auditError instanceof Error ? auditError.name : "UnknownError",
        approvalId,
      });
    }
    try {
      await appendConversationMessage(claimed.lineUserId, {
        role: "assistant",
        text: sentReply,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Failed to save approved reply in conversation history", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        approvalId,
      });
    }
    await sendStaffChannelMessage(
      `✅ 顧問先へ送信しました\n分類: ${claimed.category}\n案件ID: ${claimed.id}`,
    );
    return { status: "sent" };
  } catch (error) {
    if (membershipBillingEnabled() && claimed.usageEventId) {
      await cancelUsage(claimed.usageEventId);
    }
    await transitionApproval(approvalId, "sending", "pending", reviewerUserId);
    throw error;
  }
}

async function handleRejection(
  approvalId: string,
  reviewerUserId: string,
  revision: number | null,
): Promise<{ status: string }> {
  const record = await getApproval(approvalId);
  if (!record) return { status: "not_found" };
  if (!isCurrentRevision(record.revision, revision)) return { status: "stale_revision" };
  const rejected = await transitionApproval(approvalId, "pending", "rejected", reviewerUserId);
  if (!rejected) {
    const current = await getApproval(approvalId);
    return { status: current?.status ?? "not_found" };
  }
  if (membershipBillingEnabled() && rejected.usageEventId) {
    await cancelUsage(rejected.usageEventId);
  }
  await sendStaffChannelMessage(
    `⏸️ 返信案を却下しました。顧問先には送信していません。\n案件ID: ${rejected.id}`,
  );
  try {
    await appendAuditRecord({
      approvalId,
      eventType: "reply_rejected",
      recordedAt: new Date().toISOString(),
      reviewerUserId,
    });
  } catch (auditError) {
    console.error("Failed to save rejection audit record", {
      errorName: auditError instanceof Error ? auditError.name : "UnknownError",
      approvalId,
    });
  }
  return { status: "rejected" };
}

async function handleRevisionRequest(event: ApprovalActionEvent): Promise<{ status: string }> {
  if (
    await getConsultationReplySession(event.channelId, event.reviewerUserId)
  ) {
    await sendStaffChannelMessage(
      "個別相談への回答を完了または中止してから、返信案の修正を開始してください。",
    );
    return { status: "consultation_session_exists" };
  }
  const record = await getApproval(event.approvalId);
  if (!record) return { status: "not_found" };
  if (!isCurrentRevision(record.revision, event.revision)) return { status: "stale_revision" };
  if (record.status === "revision_requested" && record.reviewerUserId === event.reviewerUserId) {
    const existingSession = await getRevisionSession(event.channelId, event.reviewerUserId);
    if (existingSession?.approvalId === event.approvalId) {
      await sendStaffChannelMessage(
        `この案件は修正指示を待っています。修正内容をテキストで送ってください。\n案件ID: ${event.approvalId}`,
      );
      return { status: "revision_requested" };
    }
    if (!existingSession) {
      const restored = await transitionApproval(
        event.approvalId,
        "revision_requested",
        "pending",
        event.reviewerUserId,
      );
      if (!restored) return { status: "already_processed" };
    } else {
      return { status: "revision_session_exists" };
    }
  } else if (record.status !== "pending") {
    return { status: record.status };
  }

  const claimed = await transitionApproval(
    event.approvalId,
    "pending",
    "revision_requested",
    event.reviewerUserId,
  );
  if (!claimed) return { status: "already_processed" };

  const sessionCreated = await createRevisionSession({
    approvalId: event.approvalId,
    reviewerUserId: event.reviewerUserId,
    channelId: event.channelId,
    createdAt: new Date().toISOString(),
  });
  if (!sessionCreated) {
    await transitionApproval(event.approvalId, "revision_requested", "pending", event.reviewerUserId);
    await sendStaffChannelMessage(
      "先に選択した案件の修正指示を送ってください。修正完了後に別の案件を選択できます。",
    );
    return { status: "revision_session_exists" };
  }

  try {
    await sendStaffChannelMessage(
      `✏️ 修正内容をこのトークルームにテキストで送ってください。\n例:「もっと簡潔にし、提出期限を明記してください」\n案件ID: ${event.approvalId}\n※次に送信するテキストを修正指示として使用します。`,
    );
    return { status: "revision_requested" };
  } catch (error) {
    await deleteRevisionSession(event.channelId, event.reviewerUserId, event.approvalId);
    await transitionApproval(event.approvalId, "revision_requested", "pending", event.reviewerUserId);
    throw error;
  }
}

async function handleRevisionInstruction(
  reviewerUserId: string,
  channelId: string,
  instruction: string,
): Promise<{ status: string }> {
  const session = await getRevisionSession(channelId, reviewerUserId);
  if (!session) return { status: "ignored" };
  if (instruction.length > 2000) {
    await sendStaffChannelMessage("修正指示は2,000文字以内で送ってください。案件は引き続き修正待ちです。");
    return { status: "instruction_too_long" };
  }

  const claimed = await transitionApproval(
    session.approvalId,
    "revision_requested",
    "revising",
    reviewerUserId,
  );
  if (!claimed) return { status: "already_processed" };

  let updated = false;
  try {
    const draft = await reviseReplyDraft(claimed.customerMessage, claimed, instruction);
    const revised = await updateApprovalDraft(session.approvalId, "revising", draft, reviewerUserId);
    if (!revised) throw new Error("Approval changed while applying the revised draft");
    updated = true;
    try {
      await appendAuditRecord({
        approvalId: session.approvalId,
        eventType: "draft_revised",
        recordedAt: new Date().toISOString(),
        answer: revised.draftReply,
        answerLevel: revised.answerLevel,
        confidence: revised.confidence,
        model: revised.model,
        promptVersion: revised.promptVersion,
        sources: revised.sources.map((source) => ({
          title: source.title,
          url: source.url,
          legalReference: source.legalReference,
          retrievedAt: source.retrievedAt,
          quote: source.quote,
        })),
        assumptions: revised.assumptions,
        referencedClientFields: revised.clientContextFieldsUsed,
        reviewerUserId,
      });
    } catch (auditError) {
      console.error("Failed to save revision audit record", {
        errorName: auditError instanceof Error ? auditError.name : "UnknownError",
        approvalId: session.approvalId,
      });
    }
    await sendStaffApprovalMessage(revised);
    await deleteRevisionSession(channelId, reviewerUserId, session.approvalId);
    return { status: "revised" };
  } catch (error) {
    await transitionApproval(
      session.approvalId,
      updated ? "pending" : "revising",
      "revision_requested",
      reviewerUserId,
    );
    await sendStaffChannelMessage(
      "⚠️ 返信案の再作成に失敗しました。案件は送信されていません。同じ修正指示をもう一度送ってください。",
    );
    console.error("Reply revision failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      approvalId: session.approvalId,
    });
    return { status: "revision_failed" };
  }
}

async function handleConsultationReplyStart(
  event: ConsultationActionEvent,
): Promise<{ status: string }> {
  if (await getRevisionSession(event.channelId, event.reviewerUserId)) {
    await sendStaffChannelMessage(
      "返信案の修正を完了してから、個別相談への回答を開始してください。",
    );
    return { status: "revision_session_exists" };
  }
  const existingSession = await getConsultationReplySession(
    event.channelId,
    event.reviewerUserId,
  );
  if (existingSession) {
    await sendStaffChannelMessage(
      "先に開始した個別相談の回答を完了または中止してから、別の相談を選択してください。",
    );
    return { status: "consultation_session_exists" };
  }

  const claimed = await transitionConsultation(
    event.consultationId,
    "waiting_reply",
    "drafting",
    event.reviewerUserId,
  );
  if (!claimed) {
    const current = await getConsultation(event.consultationId);
    return { status: current?.status ?? "not_found" };
  }

  const created = await createConsultationReplySession({
    consultationId: event.consultationId,
    reviewerUserId: event.reviewerUserId,
    channelId: event.channelId,
    stage: "drafting",
    createdAt: new Date().toISOString(),
  });
  if (!created) {
    await transitionConsultation(
      event.consultationId,
      "drafting",
      "waiting_reply",
      event.reviewerUserId,
    );
    return { status: "consultation_session_exists" };
  }

  try {
    await sendStaffChannelMessage(
      [
        "この相談への回答文をテキストで入力してください。",
        "入力した時点では公式LINEへ送信されません。",
        "入力後に表示される「公式LINEへ送信」ボタンで確定します。",
        `受付ID: ${event.consultationId}`,
      ].join("\n"),
    );
    return { status: "consultation_drafting" };
  } catch (error) {
    await deleteConsultationReplySession(
      event.channelId,
      event.reviewerUserId,
      event.consultationId,
    );
    await transitionConsultation(
      event.consultationId,
      "drafting",
      "waiting_reply",
      event.reviewerUserId,
    );
    throw error;
  }
}

async function handleConsultationReplyText(
  reviewerUserId: string,
  channelId: string,
  replyText: string,
): Promise<{ status: string }> {
  const session = await getConsultationReplySession(channelId, reviewerUserId);
  if (!session) return { status: "ignored" };
  if (session.stage !== "drafting") {
    await sendStaffChannelMessage(
      "現在は送信確認中です。「公式LINEへ送信」「書き直す」「中止」のいずれかを選択してください。",
    );
    return { status: "consultation_confirming" };
  }
  if (replyText.length > 1800) {
    await sendStaffChannelMessage("回答文は1,800文字以内で入力してください。");
    return { status: "reply_too_long" };
  }

  const updated = await transitionConsultation(
    session.consultationId,
    "drafting",
    "awaiting_send",
    reviewerUserId,
    replyText,
  );
  if (!updated) return { status: "already_processed" };

  await updateConsultationReplySession({ ...session, stage: "confirming" });
  try {
    await sendStaffConsultationConfirmation(updated);
    return { status: "consultation_confirming" };
  } catch (error) {
    await transitionConsultation(
      session.consultationId,
      "awaiting_send",
      "drafting",
      reviewerUserId,
    );
    await updateConsultationReplySession({ ...session, stage: "drafting" });
    throw error;
  }
}

async function handleConsultationSend(
  event: ConsultationActionEvent,
): Promise<{ status: string }> {
  const session = await getConsultationReplySession(
    event.channelId,
    event.reviewerUserId,
  );
  if (
    !session ||
    session.consultationId !== event.consultationId ||
    session.stage !== "confirming"
  ) {
    // 旧実装では受付通知と回答が同じ再送キーを使っていたため、LINE APIの
    // 409を成功扱いしてstatusだけsentになった案件がある。修正前に表示した
    // 「公式LINEへ送信」ボタンをもう一度押せば、回答専用キーで安全に復旧する。
    // 修正後に正常送信済みの案件では同じ専用キーが409になるため重複しない。
    const existing = await getConsultation(event.consultationId);
    if (existing?.status === "sent" && existing.replyText) {
      const sentReply = markAsTaxProfessionalReply(existing.replyText);
      await pushLineMessage(
        existing.lineUserId,
        sentReply,
        deriveLineRetryKey(existing.lineRetryKey, "tax-professional-reply"),
      );
      await appendAuditRecord({
        approvalId: existing.id,
        eventType: "reply_sent",
        recordedAt: new Date().toISOString(),
        answer: sentReply,
        reviewerUserId: event.reviewerUserId,
      });
      await sendStaffChannelMessage(
        `公式LINEへ税理士回答を再送しました。\n受付ID: ${event.consultationId}`,
      );
      return { status: "consultation_sent" };
    }
    return { status: "consultation_session_not_found" };
  }

  const claimed = await transitionConsultation(
    event.consultationId,
    "awaiting_send",
    "sending",
    event.reviewerUserId,
  );
  if (!claimed?.replyText) return { status: "already_processed" };

  // 税理士相談への回答であることを明示する。AI回答との混同を防ぐ。
  const sentReply = markAsTaxProfessionalReply(claimed.replyText);
  try {
    await pushLineMessage(
      claimed.lineUserId,
      sentReply,
      deriveLineRetryKey(claimed.lineRetryKey, "tax-professional-reply"),
    );
    await transitionConsultation(
      event.consultationId,
      "sending",
      "sent",
      event.reviewerUserId,
    );
    await appendConversationMessage(claimed.lineUserId, {
      role: "assistant",
      text: sentReply,
      createdAt: new Date().toISOString(),
    });
    await appendAuditRecord({
      approvalId: claimed.id,
      eventType: "reply_sent",
      recordedAt: new Date().toISOString(),
      answer: sentReply,
      reviewerUserId: event.reviewerUserId,
    });
    await deleteConsultationReplySession(
      event.channelId,
      event.reviewerUserId,
      event.consultationId,
    );
    await sendStaffChannelMessage(
      `公式LINEへ回答を送信しました。\n受付ID: ${event.consultationId}`,
    );
    return { status: "consultation_sent" };
  } catch (error) {
    await transitionConsultation(
      event.consultationId,
      "sending",
      "awaiting_send",
      event.reviewerUserId,
    );
    throw error;
  }
}

async function handleConsultationEdit(
  event: ConsultationActionEvent,
): Promise<{ status: string }> {
  const session = await getConsultationReplySession(
    event.channelId,
    event.reviewerUserId,
  );
  if (!session || session.consultationId !== event.consultationId) {
    return { status: "consultation_session_not_found" };
  }
  const updated = await transitionConsultation(
    event.consultationId,
    "awaiting_send",
    "drafting",
    event.reviewerUserId,
  );
  if (!updated) return { status: "already_processed" };
  await updateConsultationReplySession({ ...session, stage: "drafting" });
  await sendStaffChannelMessage("回答文を書き直して送信してください。");
  return { status: "consultation_drafting" };
}

async function handleConsultationCancel(
  event: ConsultationActionEvent,
): Promise<{ status: string }> {
  const session = await getConsultationReplySession(
    event.channelId,
    event.reviewerUserId,
  );
  if (!session || session.consultationId !== event.consultationId) {
    return { status: "consultation_session_not_found" };
  }
  const record = await getConsultation(event.consultationId);
  if (record?.status === "drafting" || record?.status === "awaiting_send") {
    await transitionConsultation(
      event.consultationId,
      record.status,
      "waiting_reply",
      event.reviewerUserId,
    );
  }
  await deleteConsultationReplySession(
    event.channelId,
    event.reviewerUserId,
    event.consultationId,
  );
  await sendStaffChannelMessage(
    `回答作成を中止しました。相談は未回答へ戻りました。\n受付ID: ${event.consultationId}`,
  );
  return { status: "consultation_cancelled" };
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  if (!verifyLineWorksSignature(rawBody, request.headers.get("x-works-signature"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let event: LineWorksCallbackEvent;
  try {
    event = JSON.parse(rawBody) as LineWorksCallbackEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const approval = getApprovalAction(event);
  const consultation = approval ? null : getConsultationAction(event);
  const revisionInstruction =
    approval || consultation ? null : getRevisionInstruction(event);
  const reviewerUserId =
    approval?.reviewerUserId ??
    consultation?.reviewerUserId ??
    revisionInstruction?.reviewerUserId;
  if (!reviewerUserId) return NextResponse.json({ ok: true, ignored: true });
  if (!isAuthorizedApprover(reviewerUserId)) {
    console.error("LINE WORKS approval request was rejected", {
      reason: parseApproverUserIds().length === 0
        ? "LINEWORKS_APPROVER_USER_IDS is not configured"
        : "reviewer is not on the approver list",
    });
    return NextResponse.json({ error: "Approver not allowed" }, { status: 403 });
  }

  try {
    let result: { status: string };
    if (approval?.action === "approve") {
      result = await handleApproval(approval.approvalId, approval.reviewerUserId, approval.revision);
    } else if (approval?.action === "reject") {
      result = await handleRejection(approval.approvalId, approval.reviewerUserId, approval.revision);
    } else if (approval?.action === "revise") {
      result = await handleRevisionRequest(approval);
    } else if (consultation?.action === "reply") {
      result = await handleConsultationReplyStart(consultation);
    } else if (consultation?.action === "send") {
      result = await handleConsultationSend(consultation);
    } else if (consultation?.action === "edit") {
      result = await handleConsultationEdit(consultation);
    } else if (consultation?.action === "cancel") {
      result = await handleConsultationCancel(consultation);
    } else if (revisionInstruction) {
      result = await handleConsultationReplyText(
        revisionInstruction.reviewerUserId,
        revisionInstruction.channelId,
        revisionInstruction.instruction,
      );
      if (result.status === "ignored") {
        result = await handleRevisionInstruction(
          revisionInstruction.reviewerUserId,
          revisionInstruction.channelId,
          revisionInstruction.instruction,
        );
      }
    } else {
      result = { status: "ignored" };
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Approval processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
