import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const projectRoot = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const parsed = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
  parsed.port !== "55432" ||
  parsed.pathname !== "/apexbrain_test"
) {
  throw new Error("Local migrations can only target apexbrain_test on port 55432");
}

const sql = postgres(databaseUrl, {
  ssl: false,
  max: 1,
  onnotice: () => {},
});

try {
  for (const filename of [
    "001_membership_billing.sql",
    "002_stripe_billing.sql",
    "003_tax_review_intakes.sql",
    "004_policy_acceptances.sql",
    "005_pending_questions.sql",
    "006_one_time_tax_review.sql",
    "007_tax_review_delivery_and_refunds.sql",
    "008_pricing_constraint_and_stale_reservations.sql",
  ]) {
    const migration = await readFile(
      path.join(projectRoot, "migrations", filename),
      "utf8",
    );
    await sql.unsafe(migration);
  }
  console.log("Local test migrations are applied.");
} finally {
  await sql.end({ timeout: 5 });
}
