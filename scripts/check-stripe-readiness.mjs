import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r\n|\n|\r/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2] === "") continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}

const fileEnv = {
  ...parseEnvFile(resolve(root, ".env")),
  ...parseEnvFile(resolve(root, ".env.local")),
  ...parseEnvFile(resolve(root, ".env.test.local")),
};
const env = { ...fileEnv, ...process.env };

const checks = [
  {
    name: "DATABASE_URL",
    ok: /^(postgres|postgresql):\/\//.test(env.DATABASE_URL ?? ""),
    requirement: "test PostgreSQL connection URL",
  },
  {
    name: "STRIPE_SECRET_KEY",
    ok: (env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_"),
    requirement: "Stripe test-mode secret key",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    ok: (env.STRIPE_WEBHOOK_SECRET ?? "").startsWith("whsec_"),
    requirement: "test webhook signing secret",
  },
  {
    name: "STRIPE_PRICE_ANSHIN",
    ok: (env.STRIPE_PRICE_ANSHIN ?? "").startsWith("price_"),
    requirement: "sandbox recurring Price ID",
  },
  {
    name: "STRIPE_PORTAL_CONFIGURATION_ID",
    ok: (env.STRIPE_PORTAL_CONFIGURATION_ID ?? "").startsWith("bpc_"),
    requirement: "sandbox Customer Portal configuration",
  },
  {
    name: "STRIPE_APP_BASE_URL",
    ok:
      /^https:\/\//.test(env.STRIPE_APP_BASE_URL ?? "") ||
      /^http:\/\/localhost(?::\d+)?$/.test(env.STRIPE_APP_BASE_URL ?? ""),
    requirement: "HTTPS URL or localhost",
  },
  {
    name: "migration 001",
    ok: existsSync(resolve(root, "migrations", "001_membership_billing.sql")),
    requirement: "base ledger migration",
  },
  {
    name: "migration 002",
    ok: existsSync(resolve(root, "migrations", "002_stripe_billing.sql")),
    requirement: "Stripe ledger migration",
  },
  {
    name: "migration 003",
    ok: existsSync(resolve(root, "migrations", "003_tax_review_intakes.sql")),
    requirement: "tax-review intake state migration",
  },
];

if ((env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_")) {
  console.error("BLOCKED: a live-mode Stripe key is configured.");
  process.exitCode = 2;
} else {
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "MISSING"} ${check.name}: ${check.requirement}`);
  }
  const ready = checks.every((check) => check.ok);
  const billingEnabled =
    env.MEMBERSHIP_BILLING_ENABLED?.toLowerCase() === "true" &&
    env.STRIPE_BILLING_ENABLED?.toLowerCase() === "true";
  console.log(
    ready
      ? billingEnabled
        ? "READY: local test configuration is complete and billing feature flags are enabled."
        : "READY: test configuration is complete. Keep billing feature flags disabled until migrations and webhook tests pass."
      : "NOT READY: add only the missing test configuration; no values were printed.",
  );
  process.exitCode = ready ? 0 : 1;
}
