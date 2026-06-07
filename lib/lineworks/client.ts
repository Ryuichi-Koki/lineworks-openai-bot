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

export async function sendStaffChannelMessage(text: string): Promise<void> {
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
    body: JSON.stringify({
      content: {
        type: "text",
        text,
      },
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `LINE WORKS message send failed with status ${response.status}: ${responseText.slice(0, 200)}`,
    );
  }
}
