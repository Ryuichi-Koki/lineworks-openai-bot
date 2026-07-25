import { createHash, timingSafeEqual } from "node:crypto";
import nodeFetch from "node-fetch";
import { NextRequest, NextResponse } from "next/server";
import { stripeClient } from "@/lib/stripe/client";
import {
  requireStripeEnv,
  stripePriceForPlan,
} from "@/lib/stripe/config";

export const runtime = "nodejs";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isAuthorized(request: NextRequest): boolean {
  const lineSecret = process.env.LINE_CHANNEL_SECRET?.trim();
  const provided = request.headers.get("x-diagnostic-token")?.trim();
  if (!lineSecret || !provided) return false;
  return timingSafeEqual(
    digest(provided),
    digest(`stripe-diagnostic:${lineSecret}`),
  );
}

function safeError(error: unknown): Record<string, unknown> {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    type?: unknown;
    statusCode?: unknown;
    raw?: {
      detail?: {
        name?: unknown;
        message?: unknown;
        code?: unknown;
        cause?: {
          name?: unknown;
          message?: unknown;
          code?: unknown;
        };
      };
    };
  };
  const clean = (value: unknown) =>
    typeof value === "string"
      ? value
          .replace(/sk_(?:test|live)_[A-Za-z0-9]+/gu, "[REDACTED]")
          .replace(/whsec_[A-Za-z0-9]+/gu, "[REDACTED]")
          .slice(0, 300)
      : undefined;
  return {
    name: clean(candidate.name),
    message: clean(candidate.message),
    type: clean(candidate.type),
    code: clean(candidate.code),
    statusCode:
      typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined,
    detailName: clean(candidate.raw?.detail?.name),
    detailMessage: clean(candidate.raw?.detail?.message),
    detailCode: clean(candidate.raw?.detail?.code),
    causeName: clean(candidate.raw?.detail?.cause?.name),
    causeMessage: clean(candidate.raw?.detail?.cause?.message),
    causeCode: clean(candidate.raw?.detail?.cause?.code),
  };
}

async function probeFetch(
  fetcher: typeof globalThis.fetch,
  priceId: string,
  secretKey: string,
) {
  try {
    const response = await fetcher(
      `https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`,
      {
        headers: { Authorization: `Bearer ${secretKey}` },
      },
    );
    return {
      ok: response.ok,
      status: response.status,
      requestId: response.headers.get("request-id"),
    };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  const secretKey = requireStripeEnv("STRIPE_SECRET_KEY");
  const priceId = stripePriceForPlan("anshin");
  const [nativeFetch, independentFetch, sdk] = await Promise.all([
    probeFetch(globalThis.fetch, priceId, secretKey),
    probeFetch(
      nodeFetch as unknown as typeof globalThis.fetch,
      priceId,
      secretKey,
    ),
    stripeClient()
      .prices.retrieve(priceId)
      .then((price) => ({
        ok: true,
        active: price.active,
        livemode: price.livemode,
      }))
      .catch((error) => ({ ok: false, error: safeError(error) })),
  ]);

  return NextResponse.json({
    nativeFetch,
    independentFetch,
    sdk,
  });
}
