import { createHmac } from "node:crypto";

const callbackUrl = process.argv[2] ?? "http://localhost:3000/api/lineworks/callback";
const mode = process.argv[3] ?? "text";
const botSecret = process.env.LINEWORKS_BOT_SECRET;

if (!botSecret) {
  console.error("LINEWORKS_BOT_SECRET is required.");
  process.exit(1);
}

const payloads = {
  text: {
    type: "message",
    content: {
      type: "text",
      text: "役員報酬を変更する場合の注意点を教えてください。",
    },
  },
  nonText: {
    type: "message",
    content: {
      type: "image",
    },
  },
};

if (!(mode in payloads) && mode !== "invalidSignature") {
  console.error("Usage: node scripts/smoke-callback.mjs [url] [text|nonText|invalidSignature]");
  process.exit(1);
}

const body = JSON.stringify(mode === "invalidSignature" ? payloads.text : payloads[mode]);
const signature =
  mode === "invalidSignature"
    ? "invalid-signature"
    : createHmac("sha256", Buffer.from(botSecret, "utf8"))
        .update(Buffer.from(body, "utf8"))
        .digest("base64");

const response = await fetch(callbackUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-WORKS-Signature": signature,
  },
  body,
});

console.log(`status=${response.status}`);
console.log(await response.text());
