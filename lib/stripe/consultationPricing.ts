export const TAX_REVIEW_STANDARD_PRICE_JPY = 3000;
export const TAX_REVIEW_PROMO_PRICE_JPY = 1000;

/**
 * 「今年中」は日本時間の2026年12月31日23:59:59まで。
 * Date はUTCで比較するため、2027年1月1日00:00 JSTを排他的な終了時刻にする。
 */
export const TAX_REVIEW_PROMO_END_EXCLUSIVE =
  "2026-12-31T15:00:00.000Z";

export type TaxReviewPriceCode = "promo_2026" | "standard";

export type TaxReviewPrice = {
  code: TaxReviewPriceCode;
  amount: number;
  currency: "jpy";
  priceIdEnv: "STRIPE_PRICE_TAX_REVIEW_PROMO" | "STRIPE_PRICE_TAX_REVIEW_STANDARD";
};

export function oneTimeConsultationBillingEnabled(): boolean {
  return (
    process.env.ONE_TIME_CONSULTATION_BILLING_ENABLED?.toLowerCase() === "true"
  );
}

export function taxReviewPriceAt(now = new Date()): TaxReviewPrice {
  if (now.getTime() < Date.parse(TAX_REVIEW_PROMO_END_EXCLUSIVE)) {
    return {
      code: "promo_2026",
      amount: TAX_REVIEW_PROMO_PRICE_JPY,
      currency: "jpy",
      priceIdEnv: "STRIPE_PRICE_TAX_REVIEW_PROMO",
    };
  }
  return {
    code: "standard",
    amount: TAX_REVIEW_STANDARD_PRICE_JPY,
    currency: "jpy",
    priceIdEnv: "STRIPE_PRICE_TAX_REVIEW_STANDARD",
  };
}

export function taxReviewPriceId(price: TaxReviewPrice): string {
  const value = process.env[price.priceIdEnv]?.trim();
  if (!value?.startsWith("price_")) {
    throw new Error(`${price.priceIdEnv} must contain a Stripe Price ID`);
  }
  return value;
}

export function taxReviewPricingMessage(now = new Date()): string {
  const current = taxReviewPriceAt(now);
  const currentLine =
    current.code === "promo_2026"
      ? "・テスト期間価格：1回1,000円（税込）\n・適用期限：2026年12月31日まで"
      : "・税理士へのLINE個別相談：1回3,000円（税込）";
  return [
    "【料金】",
    "・AIによる一般的な税務情報の回答：無料（月100件まで）",
    currentLine,
    ...(current.code === "promo_2026"
      ? ["・2027年1月1日以降：1回3,000円（税込）"]
      : []),
    "",
    "税理士相談は、相談内容をご確認いただいた後に1回分をお支払いいただきます。",
  ].join("\n");
}
