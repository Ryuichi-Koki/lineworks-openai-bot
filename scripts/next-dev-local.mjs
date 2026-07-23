import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env.local");
const runtimeDirectory = path.join(projectRoot, ".tools");
const statusPath = path.join(runtimeDirectory, "next-dev-status.json");
const nextPath = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");

function parseEnv(source) {
  const values = {};
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
    values[match[1]] = value;
  }
  return values;
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

const localEnv = parseEnv(await readFile(envPath, "utf8"));
const child = spawn(process.execPath, [nextPath, "dev"], {
  cwd: projectRoot,
  env: {
    ...localEnv,
    ...process.env,
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

await writeStatus("starting", { nextPid: child.pid });

let ready = false;
let diagnosticBuffer = "";

async function inspectChunk(chunk) {
  const text = chunk.toString("utf8");
  diagnosticBuffer = `${diagnosticBuffer}${text}`
    .replace(/sk_(?:test|live)_[A-Za-z0-9]+/gu, "[REDACTED_STRIPE_KEY]")
    .replace(/whsec_[A-Za-z0-9]+/gu, "[REDACTED_WEBHOOK_SECRET]")
    .slice(-4_096);

  if (!ready && /(?:Ready in|Local:\s+http:\/\/localhost:3000)/u.test(text)) {
    ready = true;
    diagnosticBuffer = "";
    await writeStatus("ready", { nextPid: child.pid, url: "http://localhost:3000" });
  }
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
  writeFileSync(
    statusPath,
    `${JSON.stringify(
      {
        status: "stopped",
        wrapperPid: process.pid,
        updatedAt: new Date().toISOString(),
        code,
        signal,
        error: ready ? undefined : diagnosticBuffer.trim(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
