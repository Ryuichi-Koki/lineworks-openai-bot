import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  beginWebhookEvent,
  finishWebhookEvent,
} from "@/lib/membership/store";
import { stripeClient } from "@/lib/stripe/client";
import { requireStripeEnv } from "@/lib/stripe/config";
import { processStripeEvent } from "@/lib/stripe/webhooks";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });
  }

  let event;
  try {
    event = stripeClient().webhooks.constructEvent(
      rawBody,
      signature,
      requireStripeEnv("STRIPE_WEBHOOK_SECRET"),
    );
  } catch {
    return NextResponse.json({ error: "Invalid Stripe signature" }, { status: 400 });
  }
  if (event.livemode) {
    return NextResponse.json(
      { error: "Live-mode Stripe events are disabled" },
      { status: 400 },
    );
  }

  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  try {
    const shouldProcess = await beginWebhookEvent({
      provider: "stripe",
      eventId: event.id,
      eventType: event.type,
      payloadHash,
    });
    if (!shouldProcess) return NextResponse.json({ received: true, duplicate: true });
    const result = await processStripeEvent(event);
    await finishWebhookEvent(
      "stripe",
      event.id,
      result === "ignored" ? "ignored" : "processed",
      result,
    );
    return NextResponse.json({ received: true });
  } catch (error) {
    await finishWebhookEvent(
      "stripe",
      event.id,
      "failed",
      error instanceof Error ? error.message : "Unknown Stripe webhook error",
    ).catch(() => undefined);
    return NextResponse.json({ error: "Stripe webhook processing failed" }, { status: 500 });
  }
}
