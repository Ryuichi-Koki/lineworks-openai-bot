import type { ReplyDraft } from "../openai/generateReplyDraft.ts";

export const TAX_AI_PRICING_MESSAGE = [
  "【料金プラン】",
  "・完全AI：無料（月10回まで）",
  "・AI使い放題：月980円",
  "・AI＋税理士確認 月1件：月3,300円",
  "・AI＋税理士確認 月3件：月7,700円",
  "・追加の税理士確認：1件3,300円",
  "",
  "複雑な申告や継続的な対応が必要な場合は、申告契約・顧問契約をご案内します。",
  "税理士確認をご希望の場合は「税理士確認を依頼」と返信してください。",
].join("\n");

const PRICING_PATTERNS = [
  /(AI|税理士|確認|相談|利用|サービス).{0,12}(料金|価格|プラン|いくら|月額)/i,
  /(料金|価格|プラン|いくら|月額).{0,12}(AI|税理士|確認|相談|利用|サービス)/i,
  /使い放題/,
];

const REVIEW_REQUEST_PATTERNS = [
  /税理士確認を依頼/,
  /税理士.{0,8}(確認|相談).{0,8}(希望|依頼|お願い|申込)/,
  /(確認|相談).{0,8}(希望|依頼|お願い|申込).{0,8}税理士/,
];

export function isPricingInquiry(message: string): boolean {
  return PRICING_PATTERNS.some((pattern) => pattern.test(message));
}

export function isTaxProfessionalReviewRequest(message: string): boolean {
  return REVIEW_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

export function isTaxProfessionalReviewPostback(data: string): boolean {
  const params = new URLSearchParams(data);
  return params.get("action") === "tax_professional_review";
}

export function markAsAiAutoReply(reply: string): string {
  const trimmed = reply.trim();
  if (trimmed.startsWith("※AIによる自動回答です")) return trimmed;
  return `※AIによる自動回答です\n\n${trimmed}`;
}

export function shouldAutoReply(draft: ReplyDraft): boolean {
  return (
    draft.answerLevel !== "C" &&
    !draft.requiresTaxProfessionalReview &&
    draft.confidence !== "低" &&
    draft.sources.length > 0 &&
    draft.sourceVerification !== "unverified"
  );
}

function sourceLines(draft: ReplyDraft, replyText: string): string[] {
  const seen = new Set<string>();
  return draft.sources.flatMap((source) => {
    if (seen.has(source.url) || replyText.includes(source.url)) return [];
    seen.add(source.url);
    const reference = source.legalReference ? `（${source.legalReference}）` : "";
    return [`・${source.title}${reference}\n${source.url}`];
  });
}

export function buildCustomerReply(draft: ReplyDraft): string {
  const sections = [draft.draftReply.trim()];
  const sources = sourceLines(draft, draft.draftReply).slice(0, 3);
  if (sources.length > 0) {
    sections.push(["【主な根拠】", ...sources].join("\n"));
  }

  if (draft.requiresTaxProfessionalReview || draft.answerLevel === "C") {
    sections.push(
      [
        "【税理士確認のご案内】",
        "この相談は個別事情によって結論が変わるため、AIは税理士確認が必要と判定しました。",
        "確認をご希望の場合は「税理士確認を依頼」と返信してください。",
        "料金：月1件付き3,300円／月、月3件付き7,700円／月、追加1件3,300円",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

export function buildReviewRequestReceipt(): string {
  return [
    "税理士確認のご依頼を受け付けました。",
    "担当者が相談内容と必要資料を確認してご案内します。",
    "",
    "料金：月1件付き3,300円／月、月3件付き7,700円／月、追加1件3,300円",
    "複雑な申告・継続対応が必要な場合は、申告契約または顧問契約をご案内することがあります。",
  ].join("\n");
}
