import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import postgres from "postgres";

const projectRoot = process.cwd();
const appPort = 3100;
const lineMockPort = 3200;
const appOrigin = `http://127.0.0.1:${appPort}`;
const lineMockOrigin = `http://127.0.0.1:${lineMockPort}`;
const channelSecret =
  process.env.LINE_CHANNEL_SECRET || randomBytes(32).toString("base64url");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
  throw new Error("Stripe test-mode secret key is required");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "55432" ||
  parsedDatabaseUrl.pathname !== "/apexbrain_test"
) {
  throw new Error("The LINE/Stripe flow test only supports the local test database");
}

const pushedMessages = [];
const lineMock = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v2/bot/message/push") {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    pushedMessages.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
});

await new Promise((resolve, reject) => {
  lineMock.once("error", reject);
  lineMock.listen(lineMockPort, "127.0.0.1", resolve);
});

const nextPath = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const nextProcess = spawn(process.execPath, [nextPath, "dev", "-p", String(appPort)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "development",
    NEXT_DIST_DIR: ".next-line-stripe-e2e",
    LINE_API_BASE_URL: `${lineMockOrigin}/v2/bot`,
    LINE_CHANNEL_SECRET: channelSecret,
    LINE_CHANNEL_ACCESS_TOKEN: "local-test-token",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    MEMBERSHIP_BILLING_ENABLED: "true",
    STRIPE_BILLING_ENABLED: "true",
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let nextDiagnostics = "";
for (const stream of [nextProcess.stdout, nextProcess.stderr]) {
  stream.on("data", (chunk) => {
    nextDiagnostics = `${nextDiagnostics}${chunk.toString("utf8")}`
      .replace(/sk_(?:test|live)_[A-Za-z0-9]+/gu, "[REDACTED_STRIPE_KEY]")
      .replace(/whsec_[A-Za-z0-9]+/gu, "[REDACTED_WEBHOOK_SECRET]")
      .slice(-4_096);
  });
}

async function waitForApp() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (nextProcess.exitCode !== null) {
      throw new Error(`Next.js test server stopped early: ${nextDiagnostics.trim()}`);
    }
    try {
      const response = await fetch(`${appOrigin}/billing/cancel`);
      if (response.ok) return;
    } catch {
      // The server has not bound the local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Next.js test server did not become ready: ${nextDiagnostics.trim()}`);
}

const eventId = `codex-line-stripe-${randomUUID()}`;
const lineUserId = `Ucodex${randomUUID().replaceAll("-", "")}`;
const body = JSON.stringify({
  destination: "UcodexLocalDestination",
  events: [
    {
      type: "message",
      mode: "active",
      timestamp: Date.now(),
      source: { type: "user", userId: lineUserId },
      webhookEventId: eventId,
      deliveryContext: { isRedelivery: false },
      message: {
        id: `m-${randomUUID()}`,
        type: "text",
        text: "AIサービスの料金プランを教えてください",
      },
    },
  ],
});
const signature = createHmac("sha256", channelSecret).update(body).digest("base64");

let sql;
try {
  await waitForApp();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${appOrigin}/api/line/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Line-Signature": signature,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Synthetic LINE webhook failed with status ${response.status}: ${nextDiagnostics.trim()}`,
      );
    }
  }

  if (pushedMessages.length !== 1) {
    throw new Error(
      `Expected one LINE push after duplicate delivery; got ${pushedMessages.length}`,
    );
  }

  const messages = pushedMessages[0]?.messages;
  const registrationMessage = Array.isArray(messages) ? messages.at(-1) : null;
  const registrationAction = registrationMessage?.template?.actions?.[0];
  const checkoutUrl = new URL(String(registrationAction?.uri ?? ""));
  if (
    registrationAction?.type !== "uri" ||
    checkoutUrl.protocol !== "https:" ||
    !(
      checkoutUrl.hostname === "checkout.stripe.com" ||
      checkoutUrl.hostname.endsWith(".stripe.com")
    )
  ) {
    throw new Error("LINE registration button did not contain a Stripe Checkout URL");
  }

  sql = postgres(databaseUrl, {
    ssl: false,
    max: 1,
  });
  const webhookRows = await sql`
    select processing_status, processing_result
    from webhook_events
    where provider = 'line' and event_id = ${eventId}
  `;
  if (
    webhookRows[0]?.processing_status !== "processed" ||
    webhookRows[0]?.processing_result !== "ok"
  ) {
    throw new Error("Synthetic LINE webhook was not recorded as processed");
  }

  console.log(
    JSON.stringify(
      {
        lineWebhookAccepted: true,
        duplicateSuppressed: true,
        linePushCapturedLocally: true,
        checkoutHost: checkoutUrl.hostname,
        databaseStatus: webhookRows[0].processing_status,
      },
      null,
      2,
    ),
  );
} finally {
  if (sql) await sql.end({ timeout: 5 });
  nextProcess.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    nextProcess.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (nextProcess.exitCode === null) nextProcess.kill("SIGKILL");
  await new Promise((resolve) => lineMock.close(resolve));
}
