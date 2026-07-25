import type { ReplyDraft } from "../openai/generateReplyDraft.ts";

export const TAX_AI_PRICING_MESSAGE = [
  "【料金プラン】",
  "・無料会員：月額0円（AI最終回答は毎月10回）",
  "・あんしん会員：月額3,300円（税込）",
  "　AI最終回答100回・税理士確認1案件／1契約期間",
  "",
  "複雑な申告や継続的な対応が必要な場合は、申告契約・顧問契約をご案内します。",
  "税理士確認が必要な回答では、個別相談ボタンをご案内します。",
].join("\n");

const PRICING_PATTERNS = [
  /^\s*(?:料金|価格|料金プラン|プラン|月額)(?:を)?(?:教えて|知りたい|見せて|案内して|確認したい|はいくら)?[。！!？?\s]*$/i,
  /(AI|税理士|確認|相談|利用|サービス).{0,12}(料金|価格|プラン|いくら|月額)/i,
  /(料金|価格|プラン|いくら|月額).{0,12}(AI|税理士|確認|相談|利用|サービス)/i,
  /使い放題/,
];

export function isPricingInquiry(message: string): boolean {
  return PRICING_PATTERNS.some((pattern) => pattern.test(message));
}

const MEMBERSHIP_CANCELLATION_PATTERNS = [
  /^\s*(退会|解約)(したい|します|したいです|手続き|方法|について)?[。！？!?\s]*$/i,
  /(あんしん会員|有料会員|会員|契約|サブスク|プラン).{0,12}(退会|解約|停止|キャンセル)/i,
  /(退会|解約).{0,12}(あんしん会員|有料会員|会員|契約|サブスク|プラン)/i,
];

export function isMembershipCancellationInquiry(message: string): boolean {
  return MEMBERSHIP_CANCELLATION_PATTERNS.some((pattern) => pattern.test(message));
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
        "税理士への個別相談をおすすめします。ご希望の場合は、回答下のボタンを押してください。",
        "あんしん会員：月額3,300円（税込）、税理士確認1案件／1契約期間",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

export function buildReviewRequestReceipt(): string {
  return [
    "税理士への個別相談を受け付けました。",
    "税理士からの回答まで、しばらくお待ちください。",
    "確認のため追加情報や資料をお願いする場合があります。",
    "",
    "あんしん会員：月額3,300円（税込）、税理士確認1案件／1契約期間",
    "複雑な申告・継続対応が必要な場合は、申告契約または顧問契約をご案内することがあります。",
  ].join("\n");
}

export function buildTaxReviewIntakePrompt(): string {
  return [
    "税理士への相談内容を入力してください。",
    "",
    "【ご注意】氏名、住所、電話番号、メールアドレス、マイナンバー、口座・カード情報など、個人を特定できる情報や機密情報は送信しないでください。",
    "",
    "次に送信する1通を相談内容として受け付けます。",
    "送信後に内容確認画面が表示されます。受付時間は30分です。",
    "中止する場合は「相談キャンセル」と送信してください。",
  ].join("\n");
}
