import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reconcileTaxReviewDeliveries } from "@/lib/tax/deliveryQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "Tax review reconciliation is not configured" },
      { status: 503 },
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !secureEqual(authorization.slice(7), secret)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await reconcileTaxReviewDeliveries();
  return NextResponse.json({ ok: true, ...result });
}
