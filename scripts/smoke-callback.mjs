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

const callbackUrl = process.argv[2] ?? "http://localhost:3000/api/lineworks/callback";
const mode = process.argv[3] ?? "ignored";
const botSecret = process.env.LINEWORKS_BOT_SECRET;
if (!botSecret) {
  console.error("LINEWORKS_BOT_SECRET is required.");
  process.exit(1);
}

const payload = {
  type: "message",
  source:
    mode === "directRevision"
      ? { userId: "smoke-test-reviewer" }
      : { userId: "smoke-test-reviewer", channelId: "smoke-test-channel" },
  content:
    mode === "approval"
      ? { postback: "approvalId=missing&action=approve" }
      : mode === "directRevision"
        ? { type: "text", text: "修正依頼", postback: "approvalId=missing&action=revise&revision=0" }
        : { type: "text", text: "確認" },
};
const body = JSON.stringify(payload);
const signature =
  mode === "invalidSignature"
    ? "invalid-signature"
    : createHmac("sha256", Buffer.from(botSecret, "utf8"))
        .update(Buffer.from(body, "utf8"))
        .digest("base64");

const response = await fetch(callbackUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-WORKS-Signature": signature },
  body,
});
console.log(`status=${response.status}`);
console.log(await response.text());
