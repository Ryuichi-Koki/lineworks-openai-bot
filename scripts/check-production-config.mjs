const productionCheckRequired =
  process.env.VERCEL_ENV === "production" ||
  process.env.REQUIRE_PRODUCTION_CONFIG_CHECK?.toLowerCase() === "true";

if (!productionCheckRequired) {
  console.log("SKIP production configuration check outside a production build.");
  process.exit(0);
}

const value = (name) => process.env[name]?.trim() ?? "";
const isTrue = (name) => value(name).toLowerCase() === "true";
const isHttps = (name) => /^https:\/\//u.test(value(name));
const checks = [
  ["DATABASE_URL", /^(postgres|postgresql):\/\//u.test(value("DATABASE_URL"))],
  ["MEMBERSHIP_BILLING_ENABLED", isTrue("MEMBERSHIP_BILLING_ENABLED")],
  ["STRIPE_BILLING_ENABLED", isTrue("STRIPE_BILLING_ENABLED")],
  ["ONE_TIME_CONSULTATION_BILLING_ENABLED", isTrue("ONE_TIME_CONSULTATION_BILLING_ENABLED")],
  ["STRIPE_MODE", value("STRIPE_MODE") === "live"],
  ["STRIPE_LIVE_MODE_ENABLED", isTrue("STRIPE_LIVE_MODE_ENABLED")],
  [
    "STRIPE_SECRET_KEY",
    /^(sk_live_|rk_live_)/u.test(value("STRIPE_SECRET_KEY")),
  ],
  ["STRIPE_WEBHOOK_SECRET", value("STRIPE_WEBHOOK_SECRET").startsWith("whsec_")],
  [
    "STRIPE_PRICE_TAX_REVIEW_PROMO",
    value("STRIPE_PRICE_TAX_REVIEW_PROMO").startsWith("price_"),
  ],
  [
    "STRIPE_PRICE_TAX_REVIEW_STANDARD",
    value("STRIPE_PRICE_TAX_REVIEW_STANDARD").startsWith("price_"),
  ],
  ["STRIPE_APP_BASE_URL", isHttps("STRIPE_APP_BASE_URL")],
  ["LEGAL_APP_BASE_URL", isHttps("LEGAL_APP_BASE_URL")],
  ["LINE_CHANNEL_SECRET", value("LINE_CHANNEL_SECRET").length >= 16],
  ["LINE_CHANNEL_ACCESS_TOKEN", value("LINE_CHANNEL_ACCESS_TOKEN").length >= 40],
  ["LINEWORKS_CLIENT_ID", value("LINEWORKS_CLIENT_ID").length > 0],
  ["LINEWORKS_CLIENT_SECRET", value("LINEWORKS_CLIENT_SECRET").length > 0],
  ["LINEWORKS_SERVICE_ACCOUNT", value("LINEWORKS_SERVICE_ACCOUNT").length > 0],
  ["LINEWORKS_PRIVATE_KEY", value("LINEWORKS_PRIVATE_KEY").includes("PRIVATE KEY")],
  ["LINEWORKS_BOT_ID", value("LINEWORKS_BOT_ID").length > 0],
  [
    "LINEWORKS_STAFF_CHANNEL_ID",
    value("LINEWORKS_STAFF_CHANNEL_ID").length > 0 ||
      value("LINEWORKS_CHANNEL_ID").length > 0,
  ],
  // 承認者リストはフェイルクローズのため、未設定だと税理士が
  // 顧問先へ回答を送信できなくなる。本番ビルドの時点で検出する。
  [
    "LINEWORKS_APPROVER_USER_IDS",
    value("LINEWORKS_APPROVER_USER_IDS")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean).length > 0,
  ],
  ["UPSTASH_REDIS_REST_URL", isHttps("UPSTASH_REDIS_REST_URL")],
  ["UPSTASH_REDIS_REST_TOKEN", value("UPSTASH_REDIS_REST_TOKEN").length >= 20],
  ["OPENAI_API_KEY", value("OPENAI_API_KEY").startsWith("sk-")],
  ["CRON_SECRET", value("CRON_SECRET").length >= 32],
];

const adminValues = [
  value("ADMIN_DASHBOARD_USER"),
  value("ADMIN_DASHBOARD_PASSWORD"),
  value("ADMIN_SESSION_SECRET"),
];
const adminEnabled = adminValues.some(Boolean);
if (adminEnabled) {
  checks.push(
    ["ADMIN_DASHBOARD_USER", adminValues[0].length >= 4],
    ["ADMIN_DASHBOARD_PASSWORD", adminValues[1].length >= 16],
    ["ADMIN_SESSION_SECRET", adminValues[2].length >= 32],
  );
} else {
  console.log("SKIP ADMIN_DASHBOARD (all credentials are unset; route stays disabled).");
}

const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

if (missing.length > 0) {
  console.error(
    `BLOCKED production build: ${missing.length} required setting(s) are invalid or missing. No values were printed.`,
  );
  process.exit(1);
}

console.log("READY production configuration names and modes are consistent.");
