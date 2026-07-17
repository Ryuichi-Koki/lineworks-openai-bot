import { NextResponse } from "next/server";
import { getApproval, transitionApproval } from "@/lib/approvals/store";
import { pushLineMessage } from "@/lib/line/client";
import { sendStaffChannelMessage } from "@/lib/lineworks/client";
import { verifyLineWorksSignature } from "@/lib/lineworks/verifySignature";

export const runtime = "nodejs";

type LineWorksCallbackEvent = {
  type?: unknown;
  source?: { userId?: unknown; channelId?: unknown };
  data?: unknown;
  content?: { postback?: unknown };
};

type ApprovalAction = "approve" | "reject";

function getApprovalAction(
  event: LineWorksCallbackEvent,
): { approvalId: string; action: ApprovalAction; reviewerUserId: string } | null {
  const postback = event.type === "postback" ? event.data : event.content?.postback;
  const reviewerUserId = event.source?.userId;
  if (typeof postback !== "string" || typeof reviewerUserId !== "string") {
    return null;
  }

  const values = new URLSearchParams(postback);
  const approvalId = values.get("approvalId");
  const action = values.get("action");
  if (!approvalId || (action !== "approve" && action !== "reject")) {
    return null;
  }
  return { approvalId, action, reviewerUserId };
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
): Promise<{ status: string }> {
  const record = await getApproval(approvalId);
  if (!record) return { status: "not_found" };
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
): Promise<{ status: string }> {
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
  if (!approval) {
    return NextResponse.json({ ok: true, ignored: true });
  }
  if (!isAuthorizedApprover(approval.reviewerUserId)) {
    return NextResponse.json({ error: "Approver not allowed" }, { status: 403 });
  }

  try {
    const result =
      approval.action === "approve"
        ? await handleApproval(approval.approvalId, approval.reviewerUserId)
        : await handleRejection(approval.approvalId, approval.reviewerUserId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Approval processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
