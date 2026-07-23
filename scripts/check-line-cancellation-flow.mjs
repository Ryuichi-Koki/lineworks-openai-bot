import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import postgres from "postgres";
import Stripe from "stripe";

const projectRoot = process.cwd();
const appPort = 3100;
const lineMockPort = 3200;
const appOrigin = `http://127.0.0.1:${appPort}`;
const lineMockOrigin = `http://127.0.0.1:${lineMockPort}`;
const lineUserId = "UcodexPortalLocalProbe";
const channelSecret =
  process.env.LINE_CHANNEL_SECRET || randomBytes(32).toString("base64url");
const databaseUrl = process.env.DATABASE_URL;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const priceId = process.env.STRIPE_PRICE_ANSHIN;
const portalConfigurationId = process.env.STRIPE_PORTAL_CONFIGURATION_ID;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("Stripe test-mode secret key is required");
}
if (!priceId?.startsWith("price_")) throw new Error("STRIPE_PRICE_ANSHIN is required");
if (!portalConfigurationId?.startsWith("bpc_")) {
  throw new Error("STRIPE_PORTAL_CONFIGURATION_ID is required");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "55432" ||
  parsedDatabaseUrl.pathname !== "/apexbrain_test"
) {
  throw new Error("Cancellation flow check only supports the local test database");
}

const stripe = new Stripe(stripeSecretKey, {
  appInfo: {
    name: "ApexBrain LINE tax consultation",
    version: "0.1.0",
  },
  maxNetworkRetries: 2,
});
const customer = await stripe.customers.create(
  {
    name: "ApexBrain local portal probe",
    metadata: {
      apexbrain_environment: "local_test",
      line_user_id: lineUserId,
    },
  },
  {
    idempotencyKey: "apexbrain-local-portal-customer-v1",
  },
);
if (customer.deleted || customer.livemode) {
  throw new Error("Stripe returned an unsafe test Customer");
}

const subscriptions = await stripe.subscriptions.list({
  customer: customer.id,
  status: "all",
  limit: 100,
});
let subscription = subscriptions.data.find(
  (item) =>
    ["active", "trialing"].includes(item.status) &&
    item.metadata.apexbrain_environment === "local_test",
);
if (!subscription) {
  subscription = await stripe.subscriptions.create(
    {
      customer: customer.id,
      items: [{ price: priceId }],
      trial_period_days: 7,
      metadata: {
        apexbrain_environment: "local_test",
        line_user_id: lineUserId,
        plan_code: "anshin",
      },
    },
    {
      idempotencyKey: "apexbrain-local-portal-subscription-v1",
    },
  );
}
if (subscription.livemode || !["active", "trialing"].includes(subscription.status)) {
  throw new Error("Stripe returned an unsafe test Subscription");
}

const subscriptionItem = subscription.items.data[0];
if (!subscriptionItem) throw new Error("Test Subscription has no item");
const periodStart = new Date(subscriptionItem.current_period_start * 1000)
  .toISOString()
  .slice(0, 10);
const periodEnd = new Date(subscriptionItem.current_period_end * 1000)
  .toISOString()
  .slice(0, 10);

const sql = postgres(databaseUrl, {
  ssl: false,
  max: 1,
});
await sql`
  insert into users (
    line_user_id, display_name, plan_code, membership_provider,
    membership_plan_id, membership_status, current_period_start,
    current_period_end, stripe_customer_id, stripe_subscription_id
  ) values (
    ${lineUserId}, 'Portal probe', 'anshin', 'stripe',
    ${subscription.id}, 'active', ${periodStart}, ${periodEnd},
    ${customer.id}, ${subscription.id}
  )
  on conflict (line_user_id) do update set
    plan_code = 'anshin',
    membership_provider = 'stripe',
    membership_plan_id = excluded.membership_plan_id,
    membership_status = 'active',
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    updated_at = now()
`;

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

let nextProcess;
try {
  await new Promise((resolve, reject) => {
    lineMock.once("error", reject);
    lineMock.listen(lineMockPort, "127.0.0.1", resolve);
  });

  const nextPath = path.join(
    projectRoot,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  nextProcess = spawn(
    process.execPath,
    [nextPath, "dev", "-p", String(appPort)],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        NEXT_DIST_DIR: ".next-line-cancellation-e2e",
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
    },
  );

  let diagnostics = "";
  for (const stream of [nextProcess.stdout, nextProcess.stderr]) {
    stream.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk.toString("utf8")}`
        .replace(/sk_(?:test|live)_[A-Za-z0-9]+/gu, "[REDACTED_STRIPE_KEY]")
        .replace(/whsec_[A-Za-z0-9]+/gu, "[REDACTED_WEBHOOK_SECRET]")
        .slice(-4_096);
    });
  }

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (nextProcess.exitCode !== null) {
      throw new Error(`Next.js test server stopped early: ${diagnostics.trim()}`);
    }
    try {
      const response = await fetch(`${appOrigin}/billing/manage`);
      if (response.ok) break;
    } catch {
      // The server has not bound the local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const eventId = `codex-line-cancellation-${randomUUID()}`;
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
          text: "あんしん会員を退会したい",
        },
      },
    ],
  });
  const signature = createHmac("sha256", channelSecret).update(body).digest("base64");

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
        `Synthetic cancellation webhook failed with status ${response.status}: ${diagnostics.trim()}`,
      );
    }
  }

  if (pushedMessages.length !== 1) {
    throw new Error(
      `Expected one cancellation push after duplicate delivery; got ${pushedMessages.length}`,
    );
  }

  const messages = pushedMessages[0]?.messages;
  const managementMessage = Array.isArray(messages) ? messages.at(-1) : null;
  const managementAction = managementMessage?.template?.actions?.[0];
  const portalUrl = new URL(String(managementAction?.uri ?? ""));
  if (
    managementAction?.type !== "uri" ||
    portalUrl.protocol !== "https:" ||
    portalUrl.hostname !== "billing.stripe.com"
  ) {
    throw new Error("LINE management button did not contain a Stripe Portal URL");
  }

  const webhookRows = await sql`
    select processing_status, processing_result
    from webhook_events
    where provider = 'line' and event_id = ${eventId}
  `;
  if (
    webhookRows[0]?.processing_status !== "processed" ||
    webhookRows[0]?.processing_result !== "ok"
  ) {
    throw new Error("Synthetic cancellation webhook was not recorded as processed");
  }

  console.log(
    JSON.stringify(
      {
        cancellationWebhookAccepted: true,
        duplicateSuppressed: true,
        customerBoundToSyntheticLineUser: true,
        subscriptionBoundToSyntheticLineUser: true,
        portalHost: portalUrl.hostname,
        cancellationMode: "at_period_end",
        databaseStatus: webhookRows[0].processing_status,
      },
      null,
      2,
    ),
  );
} finally {
  if (nextProcess) {
    nextProcess.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      nextProcess.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (nextProcess.exitCode === null) nextProcess.kill("SIGKILL");
  }
  if (lineMock.listening) {
    await new Promise((resolve) => lineMock.close(resolve));
  }
  await sql`
    delete from users
    where line_user_id = ${lineUserId}
      and stripe_customer_id = ${customer.id}
      and stripe_subscription_id = ${subscription.id}
  `;
  await sql.end({ timeout: 5 });
}
