import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Stripe from "stripe";
import {
  createReviewDraft,
  registerMembershipUser,
} from "../lib/membership/store.ts";
import { createTaxReviewCheckoutSession } from "../lib/stripe/billing.ts";

const databaseUrl = process.env.DATABASE_URL;
const secretKey = process.env.STRIPE_SECRET_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!secretKey?.startsWith("sk_test_")) {
  throw new Error("This test requires a Stripe test-mode secret key");
}
const parsed = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
  parsed.port !== "55432" ||
  parsed.pathname !== "/apexbrain_test"
) {
  throw new Error("This integration test only runs against local apexbrain_test");
}

const sql = postgres(databaseUrl, { ssl: false, max: 1, prepare: false });
const stripe = new Stripe(secretKey);
const lineUserId = `U_codex_pricing_${randomUUID().replaceAll("-", "")}`;
let reviewRequestId;
let checkoutSessionId;

try {
  await registerMembershipUser(lineUserId, "Codex pricing test");
  reviewRequestId = await createReviewDraft({
    lineUserId,
    conversationId: `test:${randomUUID()}`,
    summary: "税理士相談のテスト内容",
  });
  const checkout = await createTaxReviewCheckoutSession({
    lineUserId,
    reviewRequestId,
    now: new Date(),
  });
  if (!checkout.url.startsWith("https://checkout.stripe.com/")) {
    throw new Error("Stripe Checkout URL is invalid");
  }
  if (checkout.amount !== 1000 || checkout.reused) {
    throw new Error("Unexpected sandbox Checkout result");
  }
  const rows = await sql`
    select stripe_checkout_session_id
    from tax_review_payments
    where review_request_id = ${reviewRequestId}
  `;
  checkoutSessionId = String(rows[0]?.stripe_checkout_session_id ?? "");
  if (!checkoutSessionId.startsWith("cs_test_")) {
    throw new Error("Checkout Session was not persisted");
  }
  const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
  if (
    session.mode !== "payment" ||
    session.amount_total !== 1000 ||
    session.currency !== "jpy" ||
    session.metadata?.purchase_type !== "tax_review"
  ) {
    throw new Error("Checkout Session does not match the tax-review contract");
  }
  console.log("PASS: one-time JPY 1,000 tax-review Checkout was created and verified.");
} finally {
  if (checkoutSessionId) {
    try {
      await stripe.checkout.sessions.expire(checkoutSessionId);
    } catch {
      // A completed/expired test session needs no cleanup.
    }
  }
  if (reviewRequestId) {
    await sql`delete from tax_review_payments where review_request_id = ${reviewRequestId}`;
    await sql`delete from review_requests where id = ${reviewRequestId}`;
  }
  await sql`delete from users where line_user_id = ${lineUserId}`;
  await sql.end({ timeout: 5 });
}
