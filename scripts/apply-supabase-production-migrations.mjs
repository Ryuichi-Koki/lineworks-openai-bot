import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const projectRoot = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
const projectRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF;
const explicitApproval = process.env.ALLOW_SUPABASE_PRODUCTION_MIGRATIONS;

const approvedProductionProjectRef = "jveigdwsnfimlyhkqgdv";
const knownTestProjectRef = "tiokqkiipedomzbjoqjr";

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!projectRef) throw new Error("SUPABASE_PRODUCTION_PROJECT_REF is required");
if (explicitApproval !== "yes") {
  throw new Error("ALLOW_SUPABASE_PRODUCTION_MIGRATIONS=yes is required");
}
if (projectRef !== approvedProductionProjectRef) {
  throw new Error(
    "Refusing to migrate: project ref is not the approved ApexBrain production project",
  );
}
if (projectRef === knownTestProjectRef) {
  throw new Error("Refusing to migrate: the supplied project is the test project");
}

const parsed = new URL(databaseUrl);
const expectedUser = `postgres.${projectRef}`;
const isSupabasePooler =
  /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/i.test(parsed.hostname);

if (
  parsed.protocol !== "postgresql:" ||
  !isSupabasePooler ||
  parsed.port !== "6543" ||
  parsed.pathname !== "/postgres" ||
  decodeURIComponent(parsed.username) !== expectedUser
) {
  throw new Error(
    "Refusing to migrate: DATABASE_URL is not the approved Supabase production transaction pooler",
  );
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,
  prepare: false,
  onnotice: () => {},
});

const migrations = [
  "001_membership_billing.sql",
  "002_stripe_billing.sql",
  "003_tax_review_intakes.sql",
  "004_policy_acceptances.sql",
  "005_pending_questions.sql",
];

try {
  for (const filename of migrations) {
    const migration = await readFile(
      path.join(projectRoot, "migrations", filename),
      "utf8",
    );
    await sql.unsafe(migration);
    console.log(`Applied ${filename}`);
  }

  const expectedTables = [
    "plans",
    "users",
    "review_requests",
    "usage_events",
    "webhook_events",
    "admin_audit_logs",
    "stripe_billing_objects",
    "tax_review_intakes",
    "policy_acceptances",
    "pending_questions",
  ];
  const tableRows = await sql`
    select tablename
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename in ${sql(expectedTables)}
    order by tablename
  `;
  const actualTables = tableRows.map(({ tablename }) => tablename);
  const missingTables = expectedTables.filter(
    (tableName) => !actualTables.includes(tableName),
  );
  if (missingTables.length > 0) {
    throw new Error(`Missing expected tables: ${missingTables.join(", ")}`);
  }

  console.log(`Verified ${actualTables.length} expected tables.`);
  console.log("Supabase production migrations are applied.");
} finally {
  await sql.end({ timeout: 5 });
}
