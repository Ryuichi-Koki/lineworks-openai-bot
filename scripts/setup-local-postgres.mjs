import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env.local");
const adminDatabase = "postgres";
const appDatabase = "apexbrain_test";
const appRole = "apexbrain_app";
const host = "127.0.0.1";
const port = 55432;

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

function removeEnvValue(source, key) {
  const matcher = new RegExp(`^\\s*${key}\\s*=.*(?:\\r?\\n|$)`, "gmu");
  return source.replace(matcher, "");
}

const envSource = await readFile(envPath, "utf8");
const env = parseEnv(envSource);
const adminPassword = env.get("POSTGRES_ADMIN_PASSWORD");

if (!adminPassword) {
  throw new Error("POSTGRES_ADMIN_PASSWORD is missing from .env.local");
}

const appPassword = randomBytes(32).toString("base64url");
const admin = postgres({
  host,
  port,
  database: adminDatabase,
  username: "postgres",
  password: adminPassword,
  ssl: false,
  max: 1,
});

try {
  const roleRows = await admin`
    select 1 from pg_roles where rolname = ${appRole}
  `;

  if (roleRows.length === 0) {
    await admin.unsafe(
      `create role ${appRole} login password '${appPassword.replaceAll("'", "''")}'`,
    );
  } else {
    await admin.unsafe(
      `alter role ${appRole} with login password '${appPassword.replaceAll("'", "''")}'`,
    );
  }

  const databaseRows = await admin`
    select 1 from pg_database where datname = ${appDatabase}
  `;

  if (databaseRows.length === 0) {
    await admin.unsafe(`create database ${appDatabase} owner ${appRole}`);
  } else {
    await admin.unsafe(`alter database ${appDatabase} owner to ${appRole}`);
  }
} finally {
  await admin.end({ timeout: 5 });
}

const app = postgres({
  host,
  port,
  database: appDatabase,
  username: appRole,
  password: appPassword,
  ssl: false,
  max: 1,
});

try {
  for (const filename of [
    "001_membership_billing.sql",
    "002_stripe_billing.sql",
  ]) {
    const migration = await readFile(
      path.join(projectRoot, "migrations", filename),
      "utf8",
    );
    await app.unsafe(migration);
  }

  const checks = await app`
    select
      to_regclass('public.users') is not null as users_ready,
      to_regclass('public.stripe_billing_objects') is not null as stripe_ready
  `;

  if (!checks[0]?.users_ready || !checks[0]?.stripe_ready) {
    throw new Error("Database migration verification failed");
  }
} finally {
  await app.end({ timeout: 5 });
}

const databaseUrl =
  `postgresql://${appRole}:${appPassword}@${host}:${port}/${appDatabase}`;
let nextEnv = removeEnvValue(envSource, "POSTGRES_ADMIN_PASSWORD");
nextEnv = replaceEnvValue(nextEnv, "DATABASE_URL", databaseUrl);
nextEnv = replaceEnvValue(nextEnv, "DATABASE_SSL_MODE", "disable");
await writeFile(envPath, nextEnv, { encoding: "utf8", mode: 0o600 });

console.log("Local PostgreSQL test database is ready.");
console.log(`Database: ${appDatabase}`);
console.log(`Role: ${appRole}`);
console.log(`Port: ${port}`);
