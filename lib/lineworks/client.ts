import { getLineWorksAccessToken } from "./auth";

const LINEWORKS_API_BASE_URL = "https://www.worksapis.com/v1.0";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function sendStaffChannelMessage(text: string): Promise<void> {
  const botId = requireEnv("LINEWORKS_BOT_ID");
  const channelId = requireEnv("LINEWORKS_STAFF_CHANNEL_ID");
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
    body: JSON.stringify({
      content: {
        type: "text",
        text,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`LINE WORKS message send failed with status ${response.status}`);
  }
}
