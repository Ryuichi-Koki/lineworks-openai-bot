import { randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const parsed = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
  parsed.port !== "55432" ||
  parsed.pathname !== "/apexbrain_test"
) {
  throw new Error("Membership DB flow check only supports the local test database");
}

const sql = postgres(databaseUrl, {
  ssl: false,
  max: 1,
});

class RollbackCheck extends Error {
  constructor(result) {
    super("Rollback successful membership flow check");
    this.result = result;
  }
}

let result;
try {
  await sql.begin(async (transaction) => {
    const lineUserId = `Umembership${randomUUID().replaceAll("-", "")}`;
    const idempotencyKey = `membership-db-check-${randomUUID()}`;
    const rows = await transaction`
      select * from reserve_usage(
        ${lineUserId},
        'ai_answer',
        ${idempotencyKey},
        'local-membership-check',
        null,
        now()
      )
    `;
    const reservation = rows[0];
    if (
      !reservation?.allowed ||
      reservation.plan_code !== "free" ||
      Number(reservation.usage_limit) !== 10 ||
      Number(reservation.remaining_count) !== 9
    ) {
      throw new Error("Membership reservation returned unexpected values");
    }

    const transitioned = await transaction`
      select transition_usage(${reservation.usage_event_id}, 'canceled') as changed
    `;
    if (!transitioned[0]?.changed) {
      throw new Error("Membership reservation could not be canceled");
    }

    throw new RollbackCheck({
      reservationAllowed: true,
      planCode: reservation.plan_code,
      usageLimit: Number(reservation.usage_limit),
      remainingAfterReservation: Number(reservation.remaining_count),
      cancellationVerified: true,
      transactionRolledBack: true,
    });
  });
} catch (error) {
  if (error instanceof RollbackCheck) {
    result = error.result;
  } else {
    throw error;
  }
} finally {
  await sql.end({ timeout: 5 });
}

console.log(JSON.stringify(result, null, 2));
