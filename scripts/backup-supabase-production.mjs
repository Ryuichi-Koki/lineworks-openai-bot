import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const url = new URL(databaseUrl);
const allowedHosts = new Set([
  "aws-1-ap-northeast-1.pooler.supabase.com",
  "aws-0-ap-northeast-1.pooler.supabase.com",
]);
if (
  !allowedHosts.has(url.hostname) ||
  url.pathname.replace(/^\//, "") !== "postgres"
) {
  throw new Error(
    "Refusing backup: DATABASE_URL is not the approved Supabase production pooler",
  );
}

const pgDump =
  process.env.PG_DUMP_PATH?.trim() ||
  "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe";
if (!existsSync(pgDump)) throw new Error(`pg_dump not found: ${pgDump}`);

const now = new Date();
const stamp = now.toISOString().replaceAll(":", "").replaceAll("-", "").slice(0, 15);
const outputDir = path.resolve(process.cwd(), ".backups");
const outputFile = path.join(outputDir, `apexbrain-production-${stamp}.dump`);
const manifestFile = `${outputFile}.json`;
mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  pgDump,
  [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file",
    outputFile,
  ],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.replace(/^\//, ""),
      PGSSLMODE: "require",
    },
  },
);

if (result.status !== 0) {
  throw new Error(
    `pg_dump failed: ${(result.stderr || "unknown error").trim().slice(0, 500)}`,
  );
}

const bytes = readFileSync(outputFile);
const manifest = {
  createdAt: now.toISOString(),
  database: "apexbrain-production",
  format: "PostgreSQL custom",
  hostRegion: "ap-northeast-1",
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  restoreCommand:
    'pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$RESTORE_DATABASE_URL" "<dump-file>"',
};
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      created: true,
      file: path.relative(process.cwd(), outputFile),
      manifest: path.relative(process.cwd(), manifestFile),
      bytes: manifest.bytes,
      sha256: manifest.sha256,
    },
    null,
    2,
  ),
);
