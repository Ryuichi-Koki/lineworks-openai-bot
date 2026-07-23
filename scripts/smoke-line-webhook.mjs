import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function loadEnvFile() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r\n|\n|\r/u)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [rawKey, ...parts] = line.split("=");
    const key = rawKey.replace(/^\uFEFF/, "");
    let value = parts.join("=");
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const callbackUrl = process.argv[2] ?? "http://localhost:3000/api/line/callback";
const mode = process.argv[3] ?? "empty";
const channelSecret = process.env.LINE_CHANNEL_SECRET;
if (!channelSecret) {
  console.error("LINE_CHANNEL_SECRET is required.");
  process.exit(1);
}

if (!["empty", "text", "invalidSignature"].includes(mode)) {
  console.error("Usage: node scripts/smoke-line-webhook.mjs [url] [empty|text|invalidSignature]");
  process.exit(1);
}

const payload =
  mode === "empty"
    ? { destination: "U00000000000000000000000000000000", events: [] }
    : {
        destination: "U00000000000000000000000000000000",
        events: [
          {
            type: "message",
            webhookEventId: "smoke-test-event-1",
            source: { type: "user", userId: "U11111111111111111111111111111111" },
            message: { type: "text", id: "1", text: "役員報酬を変更する場合の注意点を教えてください。" },
          },
        ],
      };
const body = JSON.stringify(payload);
const signature =
  mode === "invalidSignature"
    ? "invalid-signature"
    : createHmac("sha256", Buffer.from(channelSecret, "utf8"))
        .update(Buffer.from(body, "utf8"))
        .digest("base64");

const response = await fetch(callbackUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Line-Signature": signature },
  body,
});
console.log(`status=${response.status}`);
console.log(await response.text());
