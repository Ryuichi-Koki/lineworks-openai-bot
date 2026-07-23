import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");

function parseEnv(source) {
  const values = new Map();
  for (const line of source.split(/\r\n|\n|\r/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function replaceEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^\\s*${key}\\s*=.*$`, "mu");
  return matcher.test(source)
    ? source.replace(matcher, line)
    : `${source.replace(/\s*$/u, "")}\n${line}\n`;
}

const source = await readFile(envPath, "utf8");
const env = parseEnv(source);
const databaseUrl = new URL(env.get("DATABASE_URL") ?? "");
const baseUrl = new URL(env.get("STRIPE_APP_BASE_URL") ?? "");

if (
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
  databaseUrl.port !== "55432" ||
  databaseUrl.pathname !== "/apexbrain_test"
) {
  throw new Error("Local billing can only use the apexbrain_test database on port 55432");
}
if (!env.get("STRIPE_SECRET_KEY")?.startsWith("sk_test_")) {
  throw new Error("Local billing requires a Stripe test-mode secret key");
}
if (!env.get("STRIPE_WEBHOOK_SECRET")?.startsWith("whsec_")) {
  throw new Error("Local billing requires a Stripe CLI webhook secret");
}
if (!env.get("STRIPE_PRICE_ANSHIN")?.startsWith("price_")) {
  throw new Error("Local billing requires the anshin Sandbox Price");
}
if (!env.get("STRIPE_PORTAL_CONFIGURATION_ID")?.startsWith("bpc_")) {
  throw new Error("Local billing requires the Sandbox Customer Portal configuration");
}
if (
  !["127.0.0.1", "localhost"].includes(baseUrl.hostname) ||
  baseUrl.port !== "3000"
) {
  throw new Error("Local billing requires a localhost:3000 application URL");
}

let nextSource = replaceEnvValue(source, "MEMBERSHIP_BILLING_ENABLED", "true");
nextSource = replaceEnvValue(nextSource, "STRIPE_BILLING_ENABLED", "true");
await writeFile(envPath, nextSource, { encoding: "utf8", mode: 0o600 });

console.log("Local membership and Stripe billing flags are enabled.");
