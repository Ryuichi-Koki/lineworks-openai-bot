export const LEGAL_DOCUMENTS = [
  {
    slug: "terms",
    title: "スグ税利用規約",
    description: "サービスの利用条件、禁止事項、責任範囲等",
  },
  {
    slug: "privacy",
    title: "プライバシーポリシー",
    description: "個人情報の利用目的、委託先、外国移転等",
  },
  {
    slug: "tokusho",
    title: "特定商取引法に基づく表記",
    description: "販売事業者、料金、支払時期、解約条件等",
  },
  {
    slug: "cancellation",
    title: "解約・退会方法",
    description: "解約手続、利用終了時期、返金条件等",
  },
] as const;

export type LegalDocumentSlug = (typeof LEGAL_DOCUMENTS)[number]["slug"];
export type MembershipSelection = "free" | "anshin";

export function legalConsentRequired(): boolean {
  return process.env.LEGAL_CONSENT_REQUIRED?.toLowerCase() === "true";
}

export function currentPolicyVersion(): string {
  const value = process.env.LEGAL_POLICY_VERSION?.trim();
  if (!value || value.toLowerCase() === "draft") {
    throw new Error(
      "LEGAL_POLICY_VERSION must be set to a published version when legal consent is required",
    );
  }
  return value;
}

export function legalAppBaseUrl(): string {
  const raw =
    process.env.LEGAL_APP_BASE_URL?.trim() ||
    process.env.STRIPE_APP_BASE_URL?.trim() ||
    "http://localhost:3000";
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("LEGAL_APP_BASE_URL must use http or https");
  }
  return url.origin;
}

export function legalDocumentUrl(slug: LegalDocumentSlug): string {
  return `${legalAppBaseUrl()}/${slug}`;
}

/** 規約類の一覧ページ。同意カードから4文書へまとめて誘導するために使う。 */
export function legalIndexUrl(): string {
  return `${legalAppBaseUrl()}/legal`;
}
