import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const apply = args.includes("--apply");
const baseUrlArg = args.find((arg) => arg.startsWith("--base-url="));

function parseEnvFile(filename) {
  if (!existsSync(filename)) return {};
  const result = {};
  for (const line of readFileSync(filename, "utf8").split(/\r\n|\n|\r/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || match[2] === "") continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, "$2");
  }
  return result;
}

const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

function requireEnv(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function webhookEndpoint() {
  if (!baseUrlArg) throw new Error("--base-url=https://... is required");
  const url = new URL(baseUrlArg.slice("--base-url=".length));
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".trycloudflare.com")
  ) {
    throw new Error("Only an HTTPS trycloudflare.com test URL is allowed");
  }
  url.pathname = "/api/line/callback";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function lineRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${requireEnv("LINE_CHANNEL_ACCESS_TOKEN")}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `LINE API request failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

async function verifyTargetAccount() {
  const expectedBasicId = requireEnv("LINE_RICH_MENU_EXPECTED_BASIC_ID");
  const bot = await lineRequest("https://api.line.me/v2/bot/info");
  if (bot.basicId !== expectedBasicId) {
    throw new Error(
      `Target account mismatch: expected ${expectedBasicId}, received ${bot.basicId ?? "unknown"}`,
    );
  }
  return { basicId: bot.basicId, displayName: bot.displayName ?? "unknown" };
}

const endpoint = webhookEndpoint();
const account = await verifyTargetAccount();

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", account, endpoint }, null, 2));
} else {
  await lineRequest("https://api.line.me/v2/bot/channel/webhook/endpoint", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  const verification = await lineRequest(
    "https://api.line.me/v2/bot/channel/webhook/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    },
  );
  console.log(
    JSON.stringify(
      {
        applied: true,
        account,
        endpoint,
        verification: {
          success: verification.success === true,
          statusCode: verification.statusCode,
          reason: verification.reason,
        },
      },
      null,
      2,
    ),
  );
}
