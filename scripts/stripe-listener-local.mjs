import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env.local");
const runtimeDirectory = path.join(projectRoot, ".tools", "stripe-cli");
const stripePath = path.join(runtimeDirectory, "stripe.exe");
const statusPath = path.join(runtimeDirectory, "listener-status.json");

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

async function writeStatus(status, details = {}) {
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(
    statusPath,
    `${JSON.stringify(
      {
        status,
        wrapperPid: process.pid,
        updatedAt: new Date().toISOString(),
        ...details,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const envSource = await readFile(envPath, "utf8");
const env = parseEnv(envSource);
const stripeSecretKey = env.get("STRIPE_SECRET_KEY");

if (!stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("A Stripe test-mode secret key is required");
}

const child = spawn(
  stripePath,
  ["listen", "--forward-to", "http://localhost:3000/api/stripe/webhook"],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      STRIPE_API_KEY: stripeSecretKey,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

await writeStatus("starting", { stripePid: child.pid });

let buffer = "";
let ready = false;
let diagnosticBuffer = "";

async function inspectChunk(chunk) {
  const text = chunk.toString("utf8");
  diagnosticBuffer = `${diagnosticBuffer}${text}`
    .replace(/sk_(?:test|live)_[A-Za-z0-9]+/gu, "[REDACTED_STRIPE_KEY]")
    .replace(/whsec_[A-Za-z0-9]+/gu, "[REDACTED_WEBHOOK_SECRET]")
    .slice(-4_096);
  if (ready) return;
  buffer = `${buffer}${text}`.slice(-16_384);
  const secret = buffer.match(/\bwhsec_[A-Za-z0-9]+\b/u)?.[0];
  if (!secret) return;

  ready = true;
  const currentEnv = await readFile(envPath, "utf8");
  const nextEnv = replaceEnvValue(currentEnv, "STRIPE_WEBHOOK_SECRET", secret);
  await writeFile(envPath, nextEnv, { encoding: "utf8", mode: 0o600 });
  buffer = "";
  await writeStatus("ready", { stripePid: child.pid });
}

child.stdout.on("data", (chunk) => {
  void inspectChunk(chunk);
});
child.stderr.on("data", (chunk) => {
  void inspectChunk(chunk);
});

child.on("error", (error) => {
  void writeStatus("failed", { error: error.message });
});

child.on("exit", (code, signal) => {
  void writeStatus("stopped", {
    code,
    signal,
    error: ready ? undefined : diagnosticBuffer.trim(),
  });
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
