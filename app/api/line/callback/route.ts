import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendConversationMessage,
  createApproval,
  getConversationHistory,
  type ApprovalRecord,
} from "@/lib/approvals/store";
import { verifyLineSignature } from "@/lib/line/verifySignature";
import { sendStaffApprovalMessage } from "@/lib/lineworks/client";
import { generateReplyDraft } from "@/lib/openai/generateReplyDraft";

export const runtime = "nodejs";

type LineEvent = {
  type?: unknown;
  webhookEventId?: unknown;
  source?: { type?: unknown; userId?: unknown };
  message?: { type?: unknown; text?: unknown };
};

type LineWebhookBody = { events?: unknown };

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

async function processTextEvent(event: ReturnType<typeof getTextEvent>): Promise<void> {
  if (!event) return;

  const id = createHash("sha256").update(event.eventId).digest("hex").slice(0, 32);
  const conversationHistory = await getConversationHistory(event.userId);
  const draft = await generateReplyDraft(event.text, conversationHistory);
  const now = new Date().toISOString();
  const record: ApprovalRecord = {
    id,
    sourceEventId: event.eventId,
    lineUserId: event.userId,
    customerMessage: event.text,
    lineRetryKey: randomUUID(),
    ...draft,
    revision: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  if (await createApproval(record)) {
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
    await sendStaffApprovalMessage(record);
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
  const textEvents = events.map(getTextEvent).filter((event) => event !== null);

  try {
    for (const event of textEvents) {
      await processTextEvent(event);
    }
    return NextResponse.json({ ok: true, accepted: textEvents.length });
  } catch (error) {
    console.error("LINE webhook processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
