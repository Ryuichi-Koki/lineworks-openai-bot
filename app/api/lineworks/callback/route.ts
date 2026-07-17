import { NextResponse } from "next/server";
import {
  createRevisionSession,
  deleteRevisionSession,
  getApproval,
  getRevisionSession,
  transitionApproval,
  updateApprovalDraft,
} from "@/lib/approvals/store";
import { pushLineMessage } from "@/lib/line/client";
import { sendStaffApprovalMessage, sendStaffChannelMessage } from "@/lib/lineworks/client";
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

function getApprovalAction(event: LineWorksCallbackEvent): ApprovalActionEvent | null {
  const postback = event.type === "postback" ? event.data : event.content?.postback;
  const reviewerUserId = event.source?.userId;
  const channelId = event.source?.channelId;
  if (
    typeof postback !== "string" ||
    typeof reviewerUserId !== "string" ||
    typeof channelId !== "string"
  ) {
    return null;
  }

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

function getRevisionInstruction(
  event: LineWorksCallbackEvent,
): { reviewerUserId: string; channelId: string; instruction: string } | null {
  if (
    event.type !== "message" ||
    event.content?.type !== "text" ||
    typeof event.content.text !== "string" ||
    typeof event.source?.userId !== "string" ||
    typeof event.source.channelId !== "string" ||
    typeof event.content.postback === "string"
  ) {
    return null;
  }
  const instruction = event.content.text.trim();
  return instruction
    ? { reviewerUserId: event.source.userId, channelId: event.source.channelId, instruction }
    : null;
}

function isCurrentRevision(recordRevision: number | undefined, requestedRevision: number | null): boolean {
  const currentRevision = recordRevision ?? 0;
  return requestedRevision === null ? currentRevision === 0 : requestedRevision === currentRevision;
}

function isAuthorizedApprover(userId: string): boolean {
  const configured = process.env.LINEWORKS_APPROVER_USER_IDS;
  if (!configured) return true;
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
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

  try {
    await pushLineMessage(claimed.lineUserId, claimed.draftReply, claimed.lineRetryKey);
    await transitionApproval(approvalId, "sending", "sent", reviewerUserId);
    await sendStaffChannelMessage(
      `✅ 顧問先へ送信しました\n分類: ${claimed.category}\n案件ID: ${claimed.id}`,
    );
    return { status: "sent" };
  } catch (error) {
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
  await sendStaffChannelMessage(
    `⏸️ 返信案を却下しました。顧問先には送信していません。\n案件ID: ${rejected.id}`,
  );
  return { status: "rejected" };
}

async function handleRevisionRequest(event: ApprovalActionEvent): Promise<{ status: string }> {
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
  const revisionInstruction = approval ? null : getRevisionInstruction(event);
  const reviewerUserId = approval?.reviewerUserId ?? revisionInstruction?.reviewerUserId;
  if (!reviewerUserId) return NextResponse.json({ ok: true, ignored: true });
  if (!isAuthorizedApprover(reviewerUserId)) {
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
    } else if (revisionInstruction) {
      result = await handleRevisionInstruction(
        revisionInstruction.reviewerUserId,
        revisionInstruction.channelId,
        revisionInstruction.instruction,
      );
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
