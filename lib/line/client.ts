import { maskLineOutput } from "../security/redaction.ts";

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
  const messages = splitLineMessages(maskLineOutput(text));
  const response = await fetch(`${LINE_API_BASE_URL}/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("LINE_CHANNEL_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": retryKey,
    },
    body: JSON.stringify({
      to: userId,
      messages: messages.map((messageText) => ({ type: "text", text: messageText })),
    }),
  });

  if (!response.ok && response.status !== 409) {
    const responseText = await response.text();
    throw new Error(
      `LINE push message failed with status ${response.status}: ${responseText.slice(0, 200)}`,
    );
  }
}

export function splitLineMessages(text: string, maxLength = 4500): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return [trimmed];
  const sections = trimmed.split(/(?=【[^】]+】)/g).filter(Boolean);
  const messages: string[] = [];
  let current = "";
  for (const section of sections) {
    if (!current) {
      current = section;
      continue;
    }
    if (`${current}${section}`.length <= maxLength) {
      current += section;
    } else {
      messages.push(current.trim());
      current = section;
    }
  }
  if (current) messages.push(current.trim());
  const bounded = messages.flatMap((message) => {
    if (message.length <= maxLength) return [message];
    const parts: string[] = [];
    for (let index = 0; index < message.length; index += maxLength) {
      parts.push(message.slice(index, index + maxLength));
    }
    return parts;
  });
  if (bounded.length <= 3) return bounded;
  const firstTwo = bounded.slice(0, 2);
  const remainder = bounded.slice(2).join("\n").slice(0, maxLength - 1);
  return [...firstTwo, `${remainder}…`];
}
