import type {
  ApprovalRecord,
  ConsultationRecord,
} from "@/lib/approvals/store";
import { getLineWorksAccessToken } from "./auth.ts";

const LINEWORKS_API_BASE_URL = "https://www.worksapis.com/v1.0";

function requireEnv(name: string): string {
  const value = process.env[name] || process.env[`\uFEFF${name}`];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name] || process.env[`\uFEFF${name}`];
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

async function sendStaffContent(content: Record<string, unknown>): Promise<void> {
  const botId = requireEnv("LINEWORKS_BOT_ID");
  const channelId = requireFirstEnv(["LINEWORKS_STAFF_CHANNEL_ID", "LINEWORKS_CHANNEL_ID"]);
  const accessToken = await getLineWorksAccessToken();
  const url = `${LINEWORKS_API_BASE_URL}/bots/${encodeURIComponent(
    botId,
  )}/channels/${encodeURIComponent(channelId)}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `LINE WORKS message send failed with status ${response.status}: ${responseText.slice(0, 200)}`,
    );
  }
}

export async function sendStaffChannelMessage(text: string): Promise<void> {
  await sendStaffContent({ type: "text", text: truncate(text, 1900) });
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export async function sendStaffApprovalMessage(record: ApprovalRecord): Promise<void> {
  const revision = record.revision ?? 0;
  const checks =
    record.checkItems.length > 0
      ? record.checkItems.map((item) => `・${item}`).join("\n")
      : "・特になし";
  const contentText = truncate(
    [
      `【${record.category}／${record.urgency}】顧問先からの質問`,
      `内部判定: レベル${record.answerLevel}／信頼度${record.confidence}／根拠${record.sourceVerification}`,
      ...(revision > 0 ? [`（修正版 ${revision}）`] : []),
      record.customerMessage,
      "",
      "【GPT返信案】",
      record.draftReply,
      "",
      "【送信前の確認事項】",
      checks,
      ...(record.requiresTaxProfessionalReview
        ? ["", "⚠️ 税理士相談・引継ぎ対象です。"]
        : []),
      "",
      "内容を確認して操作してください。",
    ].join("\n"),
    1000,
  );

  await sendStaffContent({
    type: "button_template",
    contentText,
    actions: [
      {
        type: "message",
        label: "承認して送信",
        postback: `approvalId=${encodeURIComponent(record.id)}&action=approve&revision=${revision}`,
      },
      {
        type: "message",
        label: "修正依頼",
        postback: `approvalId=${encodeURIComponent(record.id)}&action=revise&revision=${revision}`,
      },
      {
        type: "message",
        label: "却下",
        postback: `approvalId=${encodeURIComponent(record.id)}&action=reject&revision=${revision}`,
      },
    ],
  });
}

export async function sendStaffConsultationMessage(
  record: ConsultationRecord,
): Promise<void> {
  await sendStaffContent({
    type: "button_template",
    contentText: truncate(
      [
        "【公式LINE・税理士個別相談】",
        `受付ID: ${record.id}`,
        "",
        record.staffContext,
      ].join("\n"),
      1000,
    ),
    actions: [
      {
        type: "message",
        label: "この相談に回答",
        postback: `consultationId=${encodeURIComponent(record.id)}&action=reply`,
      },
    ],
  });
}

export async function sendStaffConsultationConfirmation(
  record: ConsultationRecord,
): Promise<void> {
  await sendStaffChannelMessage(
    ["【公式LINEへ送信する回答全文】", record.replyText ?? ""].join("\n"),
  );
  await sendStaffContent({
    type: "button_template",
    contentText:
      "上記の回答全文を確認し、公式LINEへ送信する場合だけ送信ボタンを押してください。",
    actions: [
      {
        type: "message",
        label: "公式LINEへ送信",
        postback: `consultationId=${encodeURIComponent(record.id)}&action=send`,
      },
      {
        type: "message",
        label: "書き直す",
        postback: `consultationId=${encodeURIComponent(record.id)}&action=edit`,
      },
      {
        type: "message",
        label: "中止",
        postback: `consultationId=${encodeURIComponent(record.id)}&action=cancel`,
      },
    ],
  });
}
