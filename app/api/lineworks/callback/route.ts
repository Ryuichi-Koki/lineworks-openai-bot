import { NextResponse } from "next/server";
import { sendStaffChannelMessage } from "@/lib/lineworks/client";
import { verifyLineWorksSignature } from "@/lib/lineworks/verifySignature";
import { generateReplyDraft } from "@/lib/openai/generateReplyDraft";

export const runtime = "nodejs";

type LineWorksCallbackEvent = {
  type?: unknown;
  content?: {
    type?: unknown;
    text?: unknown;
  };
  message?: {
    type?: unknown;
    text?: unknown;
  };
};

function getTextMessage(event: LineWorksCallbackEvent): string | null {
  const content = event.content ?? event.message;
  if (event.type !== "message" || content?.type !== "text" || typeof content.text !== "string") {
    return null;
  }
  return content.text;
}

function formatStaffMessage(customerMessage: string, draftReply: string, checkItems: string[]): string {
  const formattedCheckItems =
    checkItems.length > 0 ? checkItems.map((item) => `・${item}`).join("\n") : "・特になし";

  return [
    "【顧客からの質問】",
    customerMessage,
    "",
    "【GPT返信案】",
    draftReply,
    "",
    "【確認事項】",
    formattedCheckItems,
    "",
    "【注意】",
    "この返信案はAI生成です。送信前に担当者が内容を確認してください。",
  ].join("\n");
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-works-signature");

  if (!verifyLineWorksSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let event: LineWorksCallbackEvent;
  try {
    event = JSON.parse(rawBody) as LineWorksCallbackEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const customerMessage = getTextMessage(event);
  if (!customerMessage) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    const draft = await generateReplyDraft(customerMessage);
    await sendStaffChannelMessage(
      formatStaffMessage(customerMessage, draft.draftReply, draft.checkItems),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("LINE WORKS callback processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
