import type { ReplyDraft } from "../openai/generateReplyDraft.ts";
import {
  TAX_REVIEW_PROMO_PRICE_JPY,
  TAX_REVIEW_STANDARD_PRICE_JPY,
} from "../stripe/consultationPricing.ts";

export const TAX_AI_PRICING_MESSAGE = [
  "【料金】",
  "",
  "■ AIによる一般的な税務情報の回答",
  "　・基本無料：毎月100件まで",
  "",
  "■ 税理士へのLINE個別相談",
  `　・テスト期間価格：1回${TAX_REVIEW_PROMO_PRICE_JPY.toLocaleString("ja-JP")}円（税込）`,
  "　・適用期限：2026年12月31日まで",
  `　・2027年1月1日以降：1回${TAX_REVIEW_STANDARD_PRICE_JPY.toLocaleString("ja-JP")}円（税込）`,
  "",
  "相談内容を確認した後、1回分をStripe（クレジットカード）でお支払いいただきます。",
  "月額料金や自動更新はありません。",
  "",
  "複雑な申告や継続的な対応が必要な場合は、申告契約・顧問契約をご案内します。",
  "",
  "※このメッセージでは決済は発生しません。",
].join("\n");

export const TAX_AI_CHECKOUT_INTRO_MESSAGE = [
  "税理士へのLINE個別相談のお支払いに進みます。",
  "",
  "・相談1回分のみ（自動更新なし）",
  "・次の画面（Stripe）でカード情報を入力します",
  "・カード情報は当法人では保持しません",
  "・お支払いが完了すると、相談内容が税理士へ送信されます",
  "・このトークに受付完了メッセージが届きます",
  "",
  "⚠ 二重のお申し込みを防ぐため、完了メッセージが届くまで",
  "　もう一度お申し込みボタンを押さないでください。",
].join("\n");

export const TAX_AI_QUESTION_GUIDE_MESSAGE = [
  "ご質問は、このトークにそのまま送信してください。",
  "",
  "【質問の例】",
  "・インボイスの2割特例は使えますか",
  "・自宅兼事務所の家賃はどこまで経費にできますか",
  "・従業員に支給する通勤手当は非課税ですか",
  "",
  "状況（法人・個人、業種、金額の規模など）を書き添えていただくと、",
  "より具体的な回答ができます。",
  "",
  "⚠ 氏名、住所、電話番号、メールアドレス、マイナンバー、口座・カード情報は",
  "　送信しないでください。",
].join("\n");

export const TAX_AI_CHECKOUT_REUSED_MESSAGE = [
  "決済画面はすでに開いています。",
  "",
  "二重のお申し込みを防ぐため、新しい決済ページは作成していません。",
  "下のボタンから、先ほどの手続きの続きを行ってください。",
  "",
  "お申し込みが完了すると、このトークに完了メッセージが届きます。",
].join("\n");

export const AI_ANSWER_PROCESSING_MESSAGE = [
  "ご質問を受け付けました。",
  "AIが回答を作成しています。内容によっては少し時間がかかる場合がありますので、そのままお待ちください。",
].join("\n");

/**
 * 「契約」「解約」「料金」は税務相談の日常語でもある。
 * 税目・税務処理を示す語が含まれる場合は、会員手続きの問い合わせではなく
 * 税務そのものの質問とみなし、会員導線へ分岐させない。
 *
 * 例：「契約の中途解約違約金の損金算入時期」「税理士報酬の料金は経費になりますか」
 */
const TAX_DOMAIN_PATTERNS = [
  /経費|損金|益金|課税|非課税|軽減税率|税率|源泉|印紙/,
  /消費税|所得税|法人税|相続税|贈与税|住民税|事業税|固定資産税|復興特別/,
  /申告|年末調整|控除|仕訳|勘定科目|計上|償却|減価|棚卸|決算/,
  /インボイス|適格請求書|課税事業者|免税事業者|簡易課税|税務調査/,
];

export function mentionsTaxSubjectMatter(message: string): boolean {
  return TAX_DOMAIN_PATTERNS.some((pattern) => pattern.test(message));
}

// 会員手続きの問い合わせは短く完結する。長文は税務相談として扱う。
const SERVICE_INQUIRY_MAX_LENGTH = 60;

const PRICING_PATTERNS = [
  /^\s*(?:料金|価格|料金プラン|プラン|月額)(?:を)?(?:教えて|知りたい|見せて|案内して|確認したい|はいくら)?[。！!？?\s]*$/i,
  /使い放題/,
];

const PRICING_CONTEXT_PATTERNS = [
  /(AI|あんしん会員|有料会員|無料会員|会員|税理士確認|税理士相談|確認|相談|利用|サービス).{0,12}(料金|価格|プラン|いくら|月額|費用)/i,
  /(料金|価格|プラン|いくら|月額|費用).{0,12}(AI|あんしん会員|有料会員|無料会員|会員|税理士確認|税理士相談|確認|相談|利用|サービス)/i,
];

export function isPricingInquiry(message: string): boolean {
  if (mentionsTaxSubjectMatter(message)) return false;
  if (PRICING_PATTERNS.some((pattern) => pattern.test(message))) return true;
  if (message.trim().length > SERVICE_INQUIRY_MAX_LENGTH) return false;
  return PRICING_CONTEXT_PATTERNS.some((pattern) => pattern.test(message));
}

const MEMBERSHIP_CANCELLATION_PATTERNS = [
  /^\s*(退会|解約)(したい|します|したいです|手続き|方法|について)?[。！？!?\s]*$/i,
];

// 「契約」は顧問契約・売買契約など税務上の契約を指すことが多いため、
// 会員契約を特定できる語だけを手がかりにする。
const MEMBERSHIP_CANCELLATION_CONTEXT_PATTERNS = [
  /(あんしん会員|有料会員|無料会員|会員|サブスク|月額|本サービス|このサービス|プラン).{0,12}(退会|解約|停止|キャンセル)/i,
  /(退会|解約|停止|キャンセル).{0,12}(あんしん会員|有料会員|無料会員|会員|サブスク|月額|本サービス|このサービス|プラン)/i,
];

export function isMembershipCancellationInquiry(message: string): boolean {
  if (mentionsTaxSubjectMatter(message)) return false;
  if (
    MEMBERSHIP_CANCELLATION_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return true;
  }
  if (message.trim().length > SERVICE_INQUIRY_MAX_LENGTH) return false;
  return MEMBERSHIP_CANCELLATION_CONTEXT_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
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

/** 利用規約・プライバシーポリシーに記載の正式名称に合わせる。 */
export const TAX_FIRM_NAME = "Apex Brain税理士法人";

const AI_REVIEWED_REPLY_MARKER =
  "※AIが作成し、当法人の担当者が確認のうえ送信した回答です";

const TAX_PROFESSIONAL_REPLY_HEADER = [
  "━━━━━━━━━━━━━━━",
  `👤 ${TAX_FIRM_NAME}からの回答`,
  "━━━━━━━━━━━━━━━",
].join("\n");

// 文末の注記は利用規約の「当法人の社員税理士又は所属税理士が確認します」と表現を揃える。
const TAX_PROFESSIONAL_REPLY_FOOTER = [
  "────────────",
  "この回答は、当法人の社員税理士又は所属税理士が確認しています。",
  "追加のご質問がある場合は、このトークにメッセージをお送りください。",
].join("\n");

/**
 * 税理士相談への回答であることを明示する。
 * AI回答（※AIによる自動回答です）と視覚的にも文言的にも区別できるようにする。
 */
export function markAsTaxProfessionalReply(reply: string): string {
  const trimmed = reply.trim();
  if (trimmed.startsWith(TAX_PROFESSIONAL_REPLY_HEADER)) return trimmed;
  return [
    TAX_PROFESSIONAL_REPLY_HEADER,
    "",
    trimmed,
    "",
    TAX_PROFESSIONAL_REPLY_FOOTER,
  ].join("\n");
}

/**
 * 承認モードでは、AIが作成した下書きを担当者が確認してから送信する。
 * 無記名のまま送ると利用者はAI回答と人の回答を区別できないため、作成主体を明示する。
 */
export function markAsReviewedAiReply(reply: string): string {
  const trimmed = reply.trim();
  if (trimmed.startsWith(AI_REVIEWED_REPLY_MARKER)) return trimmed;
  const withoutAutoReplyMarker = trimmed.startsWith("※AIによる自動回答です")
    ? trimmed.slice("※AIによる自動回答です".length).trim()
    : trimmed;
  return `${AI_REVIEWED_REPLY_MARKER}\n\n${withoutAutoReplyMarker}`;
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
        "【税理士相談のご案内】",
        "このご相談は個別事情によって結論が変わるため、税理士への相談が必要とAIが判定しました。",
        "税理士への個別相談をおすすめします。ご希望の場合は、回答下のボタンを押してください。",
        `税理士へのLINE個別相談：1回${TAX_REVIEW_PROMO_PRICE_JPY.toLocaleString("ja-JP")}円（税込、2026年12月31日まで）。2027年1月1日以降は1回${TAX_REVIEW_STANDARD_PRICE_JPY.toLocaleString("ja-JP")}円（税込）です。`,
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
    "この受付について、月額料金や自動更新はありません。",
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
