const LINE_API_BASE_URL = "https://api.line.me/v2/bot";

function requireEnv(name: string): string {
  const value = process.env[name] || process.env[`\uFEFF${name}`];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function pushLineMessage(
  userId: string,
  text: string,
  retryKey: string,
): Promise<void> {
  const messageText = text.length <= 5000 ? text : `${text.slice(0, 4999)}…`;
  const response = await fetch(`${LINE_API_BASE_URL}/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("LINE_CHANNEL_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": retryKey,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: messageText }],
    }),
  });

  if (!response.ok && response.status !== 409) {
    const responseText = await response.text();
    throw new Error(
      `LINE push message failed with status ${response.status}: ${responseText.slice(0, 200)}`,
    );
  }
}
