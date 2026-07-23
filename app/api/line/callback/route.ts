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
import { pushLineMessage } from "@/lib/line/client";
import { verifyLineSignature } from "@/lib/line/verifySignature";
import {
  sendStaffApprovalMessage,
  sendStaffChannelMessage,
} from "@/lib/lineworks/client";
import { generateReplyDraft } from "@/lib/openai/generateReplyDraft";
import { redactSensitiveText } from "@/lib/security/redaction";
import {
  buildCustomerReply,
  buildReviewRequestReceipt,
  isPricingInquiry,
  isTaxProfessionalReviewPostback,
  markAsAiAutoReply,
  TAX_AI_PRICING_MESSAGE,
} from "@/lib/tax/hybridService";

export const runtime = "nodejs";

type LineEvent = {
  type?: unknown;
  webhookEventId?: unknown;
  source?: { type?: unknown; userId?: unknown };
  message?: { type?: unknown; text?: unknown };
  postback?: { data?: unknown };
};

type LineWebhookBody = { events?: unknown };
type AcceptedLineEvent =
  | { kind: "review"; event: { eventId: string; userId: string } }
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

function getReviewPostbackEvent(
  event: LineEvent,
): { eventId: string; userId: string } | null {
  if (
    event.type !== "postback" ||
    typeof event.postback?.data !== "string" ||
    !isTaxProfessionalReviewPostback(event.postback.data) ||
    event.source?.type !== "user" ||
    typeof event.source.userId !== "string"
  ) {
    return null;
  }

  return {
    eventId:
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${event.source.userId}:${event.postback.data}`,
    userId: event.source.userId,
  };
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

  await sendStaffChannelMessage(
    [
      "【公式LINE・税理士個別相談】",
      `受付ID: ${id}`,
      `LINE利用者: ${createHash("sha256").update(event.userId).digest("hex").slice(0, 12)}`,
      "",
      redactSensitiveText(recentContext || customerText).slice(0, 3000),
    ].join("\n"),
  );

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
}

async function processTextEvent(event: ReturnType<typeof getTextEvent>): Promise<void> {
  if (!event) return;

  const id = createHash("sha256").update(event.eventId).digest("hex").slice(0, 32);
  const [conversationHistory, clientProfile] = await Promise.all([
    getConversationHistory(event.userId),
    getClientProfile(event.userId),
  ]);
  const now = new Date().toISOString();

  if (isPricingInquiry(event.text)) {
    await pushLineMessage(event.userId, TAX_AI_PRICING_MESSAGE, randomUUID());
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

  const generatedDraft = await generateReplyDraft(
    event.text,
    conversationHistory,
    clientProfile,
  );
  const autoReply = hybridAutoReplyEnabled();
  const customerReply = buildCustomerReply(generatedDraft);
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
        throw error;
      }
    } else {
      await sendStaffApprovalMessage(record);
    }
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
  for (const event of events) {
    const reviewPostback = getReviewPostbackEvent(event);
    if (reviewPostback) {
      acceptedEvents.push({ kind: "review", event: reviewPostback });
      continue;
    }
    const textEvent = getTextEvent(event);
    if (textEvent) acceptedEvents.push({ kind: "text", event: textEvent });
  }

  try {
    for (const accepted of acceptedEvents) {
      if (accepted.kind === "review") {
        const conversationHistory = await getConversationHistory(accepted.event.userId);
        await notifyTaxProfessionalReview(
          accepted.event,
          conversationHistory,
          "税理士へ個別相談（ボタン）",
        );
      } else {
        await processTextEvent(accepted.event);
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
