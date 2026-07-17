import type { ApprovalRecord } from "@/lib/approvals/store";
import { getLineWorksAccessToken } from "./auth";

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
  await sendStaffContent({ type: "text", text });
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export async function sendStaffApprovalMessage(record: ApprovalRecord): Promise<void> {
  const checks =
    record.checkItems.length > 0
      ? record.checkItems.map((item) => `・${item}`).join("\n")
      : "・特になし";
  const contentText = truncate(
    [
      `【${record.category}／${record.urgency}】顧問先からの質問`,
      record.customerMessage,
      "",
      "【GPT返信案】",
      record.draftReply,
      "",
      "【送信前の確認事項】",
      checks,
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
        postback: `approvalId=${encodeURIComponent(record.id)}&action=approve`,
      },
      {
        type: "message",
        label: "却下",
        postback: `approvalId=${encodeURIComponent(record.id)}&action=reject`,
      },
    ],
  });
}
