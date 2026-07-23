import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

function loadEnvFile() {
  if (!existsSync(".env.local")) {
    return;
  }

  for (const line of readFileSync(".env.local", "utf8").split(/\r\n|\n|\r/u)) {
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const [rawKey, ...valueParts] = line.split("=");
    const key = rawKey.replace(/^\uFEFF/, "");
    let value = valueParts.join("=");
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function normalizePrivateKey(value) {
  return value.replace(/\\n/g, "\n");
}

function createLineWorksJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "RS256" };
  const claims = {
    iss: requireEnv("LINEWORKS_CLIENT_ID"),
    sub: requireEnv("LINEWORKS_SERVICE_ACCOUNT"),
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(claims),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64UrlEncode(signer.sign(normalizePrivateKey(requireEnv("LINEWORKS_PRIVATE_KEY"))))}`;
}

async function testOpenAI() {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: "疎通確認です。短く返答してください。",
      max_output_tokens: 50,
      store: false,
    }),
  });

  console.log(`openai.status=${response.status}`);
  if (!response.ok) {
    const body = await response.text();
    console.log(`openai.error=${body.slice(0, 300)}`);
  }
}

async function testOpenAIJsonDraft() {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: [
        "あなたは税理士法人の顧客対応を支援するアシスタントです。",
        "JSON以外は出力しないでください。",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "役員報酬を変更する場合の注意点を教えてください。",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "tax_customer_reply_draft",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["draftReply", "checkItems"],
            properties: {
              draftReply: {
                type: "string",
              },
              checkItems: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
          },
        },
      },
      max_output_tokens: 500,
      store: false,
    }),
  });

  console.log(`openai.json.status=${response.status}`);
  if (!response.ok) {
    const body = await response.text();
    console.log(`openai.json.error=${body.slice(0, 500)}`);
  }
}

async function testLineWorksToken() {
  const body = new URLSearchParams({
    assertion: createLineWorksJwt(),
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: requireEnv("LINEWORKS_CLIENT_ID"),
    client_secret: requireEnv("LINEWORKS_CLIENT_SECRET"),
    scope: "bot.message",
  });

  const response = await fetch("https://auth.worksmobile.com/oauth2/v2.0/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  console.log(`lineworks.token.status=${response.status}`);
  const responseBody = await response.text();
  if (!response.ok) {
    console.log(`lineworks.token.error=${responseBody.slice(0, 300)}`);
    return null;
  }

  const parsed = JSON.parse(responseBody);
  console.log(`lineworks.token.hasAccessToken=${typeof parsed.access_token === "string"}`);
  return parsed.access_token;
}

async function testLineWorksMessage(accessToken) {
  if (!accessToken) {
    return;
  }

  const botId = requireEnv("LINEWORKS_BOT_ID");
  const channelId = requireEnv("LINEWORKS_STAFF_CHANNEL_ID");
  const response = await fetch(
    `https://www.worksapis.com/v1.0/bots/${encodeURIComponent(botId)}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: {
          type: "text",
          text: "LINE WORKS Bot API 疎通確認です。",
        },
      }),
    },
  );

  console.log(`lineworks.message.status=${response.status}`);
  if (!response.ok) {
    const body = await response.text();
    console.log(`lineworks.message.error=${body.slice(0, 300)}`);
  }
}

async function main() {
  loadEnvFile();
  await testOpenAI();
  await testOpenAIJsonDraft();
  const accessToken = await testLineWorksToken();
  await testLineWorksMessage(accessToken);
}

main().catch((error) => {
  console.error(`diagnose.error=${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
});
