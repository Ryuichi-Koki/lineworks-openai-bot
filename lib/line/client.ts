import { maskLineOutput } from "../security/redaction.ts";
import {
  LEGAL_DOCUMENTS,
  legalDocumentUrl,
  legalIndexUrl,
} from "../legal/config.ts";
import { lineApiBaseUrl } from "./config.ts";

function requireEnv(name: string): string {
  const value = process.env[name] || process.env[`\uFEFF${name}`];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function pushLineMessage(
  userId: string,
  text: string,
  retryKey: string,
  options: {
    includeTaxReviewButton?: boolean;
    includeMembershipApplyButton?: boolean;
    includeMembershipJoinButton?: boolean;
    membershipJoinUrl?: string;
    includeTaxReviewPaymentButton?: boolean;
    taxReviewPaymentUrl?: string;
    taxReviewPaymentAmount?: number;
    taxReviewRequestId?: string;
    includeMembershipManagementButton?: boolean;
    membershipManagementUrl?: string;
    includeMembershipMenu?: boolean;
    includeLegalMenu?: boolean;
    includeLegalConsentButtons?: boolean;
    includeMembershipSelectionButtons?: boolean;
    legalPolicyVersion?: string;
    includePersistentMenuButton?: boolean;
  } = {},
): Promise<void> {
  // ボタン類を先に組み立て、本文には1回のpushの残り枠（最大5通）をすべて使う。
  // 先に本文を3通で固定すると、根拠や注意書きが末尾から静かに落ちる。
  const messagePayloads: Array<Record<string, unknown>> = [];
  if (options.includeTaxReviewButton) {
    messagePayloads.push({
      type: "template",
      altText: "税理士へ個別相談",
      template: {
        type: "buttons",
        text: "税理士への個別相談をご希望の場合は、下のボタンを押してください。",
        actions: [
          {
            type: "postback",
            label: "税理士へ個別相談",
            data: "action=tax_professional_review",
            displayText: "税理士へ個別相談",
          },
        ],
      },
    });
  }
  // 申し込みの意思表示ボタン。押した時点では決済ページを作らないため、
  // 料金の確認と申し込みを分離できる。
  if (options.includeMembershipApplyButton) {
    messagePayloads.push({
      type: "template",
      altText: "あんしん会員に申し込む",
      template: {
        type: "buttons",
        text: "あんしん会員では、AI回答100回と税理士相談1件をご利用いただけます。押しても決済は発生しません。",
        actions: [
          {
            type: "postback",
            label: "あんしん会員に申し込む",
            data: "action=select_paid_membership",
            displayText: "あんしん会員の申し込みへ進みます",
          },
        ],
      },
    });
  }
  const joinUrl =
    options.membershipJoinUrl?.trim() ||
    process.env.LINE_MEMBERSHIP_JOIN_URL?.trim();
  if (options.includeMembershipJoinButton && joinUrl) {
    messagePayloads.push({
      type: "template",
      altText: "決済画面へ進む",
      template: {
        type: "buttons",
        text: "Stripeの安全な決済画面でお手続きください。完了後、このトークに完了メッセージが届きます。",
        actions: [
          {
            type: "uri",
            label: "決済画面へ進む",
            uri: joinUrl,
          },
        ],
      },
    });
  }
  const taxReviewPaymentUrl = options.taxReviewPaymentUrl?.trim();
  if (options.includeTaxReviewPaymentButton && taxReviewPaymentUrl) {
    const amount = options.taxReviewPaymentAmount;
    const reviewRequestId = options.taxReviewRequestId?.trim();
    if (!Number.isInteger(amount) || Number(amount) < 1) {
      throw new Error(
        "taxReviewPaymentAmount is required when the payment button is included",
      );
    }
    messagePayloads.push({
      type: "template",
      altText: "税理士相談のお支払いへ進む",
      template: {
        type: "buttons",
        text: `相談1回分 ${Number(amount).toLocaleString("ja-JP")}円（税込）。支払完了後に受付を開始します。都度払いで自動更新はありません。返金条件は特商法表記をご確認ください。`,
        actions: [
          {
            type: "uri",
            label: "1回分を支払う",
            uri: taxReviewPaymentUrl,
          },
          {
            type: "uri",
            label: "特商法表記を確認",
            uri: legalDocumentUrl("tokusho"),
          },
          ...(reviewRequestId
            ? [
                {
                  type: "postback",
                  label: "内容を入力し直す",
                  data: `action=restart_tax_review&id=${encodeURIComponent(reviewRequestId)}`,
                  displayText: "相談内容を入力し直します",
                },
                {
                  type: "postback",
                  label: "支払いをやめる",
                  data: `action=cancel_tax_review&id=${encodeURIComponent(reviewRequestId)}`,
                  displayText: "税理士相談の支払いを中止します",
                },
              ]
            : []),
        ],
      },
    });
  }
  const managementUrl = options.membershipManagementUrl?.trim();
  if (options.includeMembershipManagementButton && managementUrl) {
    messagePayloads.push({
      type: "template",
      altText: "あんしん会員の契約を管理する",
      template: {
        type: "buttons",
        text: "Stripeの安全な契約管理画面で、退会予約、支払方法、請求履歴を確認できます。",
        actions: [
          {
            type: "uri",
            label: "退会・契約管理へ",
            uri: managementUrl,
          },
        ],
      },
    });
  }
  if (options.includeMembershipMenu) {
    messagePayloads.push({
      type: "template",
      altText: "会員メニュー",
      // 税理士相談・契約管理・規約はリッチメニューに常時表示されるため、
      // このカードは登録と状態確認に絞る（同じ項目を二重に出さない）。
      template: {
        type: "buttons",
        title: "会員メニュー",
        text: "ご希望の手続きを選択してください。",
        actions: [
          {
            type: "postback",
            label: "料金・プランを見る",
            data: "action=show_pricing",
            displayText: "料金プランを見ます",
          },
          {
            type: "postback",
            label: "無料会員で始める",
            data: "action=select_free_membership",
            displayText: "無料会員で始める",
          },
          {
            type: "postback",
            label: "マイページ",
            data: "action=show_status",
            displayText: "現在の会員状態を確認します",
          },
        ],
      },
    });
  }
  if (options.includeLegalMenu) {
    messagePayloads.push({
      type: "template",
      altText: "規約・各種情報",
      template: {
        type: "buttons",
        title: "規約・各種情報",
        text: "確認する文書を選択してください。",
        actions: LEGAL_DOCUMENTS.map((document) => ({
          type: "uri",
          label: document.title.slice(0, 20),
          uri: legalDocumentUrl(document.slug),
        })),
      },
    });
  }
  if (options.includeLegalConsentButtons) {
    const version = options.legalPolicyVersion?.trim();
    if (!version) {
      throw new Error(
        "legalPolicyVersion is required when legal consent buttons are included",
      );
    }
    // 「☐」は未チェックの記号に見え、「押す＝チェックを入れるだけ」と
    // 誤解される余地がある。押した時点で同意が記録されることを文言で明示する。
    messagePayloads.push({
      type: "template",
      altText: "規約等への確認と同意",
      template: {
        type: "buttons",
        title: "規約等への確認・同意",
        text: "下のボタンを押すと、利用規約とプライバシーポリシー（外国にある第三者への提供を含みます。）に同意した記録を保存します。",
        actions: [
          {
            type: "uri",
            label: "規約を読む",
            uri: legalIndexUrl(),
          },
          {
            type: "postback",
            label: "上記に同意して進む",
            data: `action=accept_policies&version=${encodeURIComponent(version)}`,
            displayText: "規約等に同意します",
          },
        ],
      },
    });
  }
  if (options.includeMembershipSelectionButtons) {
    messagePayloads.push({
      type: "template",
      altText: "無料利用を開始",
      template: {
        type: "buttons",
        title: "無料利用を開始",
        text: "☑ 規約等への同意を記録しました。AI回答は毎月100件まで無料です。",
        actions: [
          {
            type: "postback",
            label: "無料で始める",
            data: "action=select_free_membership",
            displayText: "無料で始めます",
          },
          {
            type: "postback",
            label: "料金を確認する",
            data: "action=show_pricing",
            displayText: "料金を確認します",
          },
        ],
      },
    });
  }
  const templatePayloads = messagePayloads.splice(0, messagePayloads.length);
  const textPayloads = splitLineMessages(
    maskLineOutput(text),
    LINE_TEXT_MAX_LENGTH,
    Math.max(LINE_MAX_MESSAGES_PER_PUSH - templatePayloads.length, 1),
  ).map((messageText) => ({ type: "text", text: messageText }));
  messagePayloads.push(...textPayloads, ...templatePayloads);

  if (options.includePersistentMenuButton === true) {
    const lastMessage = messagePayloads.at(-1);
    if (lastMessage) {
      lastMessage.quickReply = {
        items: [
          {
            type: "action",
            action: {
              type: "message",
              label: "会員メニュー",
              text: "メニュー",
            },
          },
          {
            type: "action",
            action: {
              type: "message",
              label: "規約・各種情報",
              text: "規約",
            },
          },
        ],
      };
    }
  }
  const response = await fetch(`${lineApiBaseUrl()}/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("LINE_CHANNEL_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": retryKey,
    },
    body: JSON.stringify({
      to: userId,
      messages: messagePayloads,
    }),
  });

  if (!response.ok && response.status !== 409) {
    const responseText = await response.text();
    throw new Error(
      `LINE push message failed with status ${response.status}: ${responseText.slice(0, 200)}`,
    );
  }
}

export async function pushLineLegalMenu(
  userId: string,
  retryKey: string,
): Promise<void> {
  await pushLineMessage(
    userId,
    "サービス利用規約、プライバシーポリシー、特定商取引法に基づく表記、解約・退会方法を確認できます。",
    retryKey,
    { includeLegalMenu: true },
  );
}

export async function pushLineLegalConsentPrompt(
  userId: string,
  policyVersion: string,
  retryKey: string,
): Promise<void> {
  // 規約4文書へは一覧ページ1リンクで誘導し、吹き出しを3通から2通に減らす。
  await pushLineMessage(
    userId,
    "スグ税へようこそ。\nご利用開始の前に、利用規約とプライバシーポリシーをご確認ください。",
    retryKey,
    {
      includeLegalConsentButtons: true,
      legalPolicyVersion: policyVersion,
    },
  );
}

export async function pushLineMembershipSelectionPrompt(
  userId: string,
  retryKey: string,
): Promise<void> {
  await pushLineMessage(
    userId,
    "規約等への同意が確認できました。",
    retryKey,
    { includeMembershipSelectionButtons: true },
  );
}

export async function pushLineReviewConfirmation(
  userId: string,
  summary: string,
  reviewRequestId: string,
  retryKey: string,
  options: {
    taxReviewRemaining: number;
    requiresPayment?: boolean;
    paymentAmount?: number;
  },
): Promise<void> {
  // 依頼内容は全文をテキストで再掲する。ボタンテンプレートのtextは160字までのため、
  // ここに相談内容を入れると利用者は自分が送った内容を確認できないまま枠を消費してしまう。
  const safeSummary = maskLineOutput(summary);
  const remaining = Math.max(options.taxReviewRemaining, 0);
  const afterSubmit = Math.max(remaining - 1, 0);
  const requiresPayment = options.requiresPayment === true;
  const paymentAmount = options.paymentAmount ?? 0;
  const bodyMessages = splitLineMessages(
    [
      "以下の内容で税理士へ依頼します。内容をご確認ください。",
      "",
      "──────────",
      safeSummary,
      "──────────",
    ].join("\n"),
  ).map((messageText) => ({ type: "text", text: messageText }));

  const response = await fetch(`${lineApiBaseUrl()}/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("LINE_CHANNEL_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": retryKey,
    },
    body: JSON.stringify({
      to: userId,
      messages: [
        ...bodyMessages,
        {
          type: "template",
          altText: "税理士相談の依頼内容をご確認ください",
          template: {
            type: "buttons",
            text: [
              "この内容で依頼しますか？",
              requiresPayment
                ? `次に相談1回分 ${paymentAmount.toLocaleString("ja-JP")}円（税込）の決済画面へ進みます。このボタンではまだ請求されません。`
                : `旧あんしん会員契約の特典を利用します。今回は追加のお支払いはありません（相談枠 ${remaining}件→${afterSubmit}件）。`,
            ]
              .join("\n")
              .slice(0, 160),
            actions: [
              {
                type: "postback",
                label: "この内容で依頼する",
                data: `action=submit_tax_review&id=${encodeURIComponent(reviewRequestId)}`,
                displayText: "この内容で依頼する",
              },
              {
                type: "postback",
                label: "入力し直す",
                data: `action=restart_tax_review&id=${encodeURIComponent(reviewRequestId)}`,
                displayText: "相談内容を入力し直します",
              },
              {
                type: "postback",
                label: "やめる",
                data: `action=cancel_tax_review&id=${encodeURIComponent(reviewRequestId)}`,
                displayText: "税理士相談をキャンセル",
              },
            ],
          },
          quickReply: {
            items: [
              {
                type: "action",
                action: {
                  type: "message",
                  label: "会員メニュー",
                  text: "メニュー",
                },
              },
            ],
          },
        },
      ],
    }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`LINE review confirmation failed: ${response.status}`);
  }
}

/** LINEのテキストメッセージ上限（5,000字）に対する安全側の値。 */
export const LINE_TEXT_MAX_LENGTH = 4500;
/** LINEの1リクエストあたりのメッセージ数上限。 */
export const LINE_MAX_MESSAGES_PER_PUSH = 5;

const TRUNCATION_NOTICE =
  "\n\n※回答が長いため、ここまでを表示しています。続きが必要な場合は、お手数ですが内容を分けてもう一度ご質問ください。";

export function splitLineMessages(
  text: string,
  maxLength = LINE_TEXT_MAX_LENGTH,
  maxMessages = 3,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return [trimmed];
  const sections = trimmed.split(/(?=【[^】]+】)/g).filter(Boolean);
  const messages: string[] = [];
  let current = "";
  for (const section of sections) {
    if (!current) {
      current = section;
      continue;
    }
    if (`${current}${section}`.length <= maxLength) {
      current += section;
    } else {
      messages.push(current.trim());
      current = section;
    }
  }
  if (current) messages.push(current.trim());
  const bounded = messages.flatMap((message) => {
    if (message.length <= maxLength) return [message];
    const parts: string[] = [];
    for (let index = 0; index < message.length; index += maxLength) {
      parts.push(message.slice(index, index + maxLength));
    }
    return parts;
  });
  if (bounded.length <= maxMessages) return bounded;
  // 枠に収まらない場合でも、末尾が黙って消えたように見えないよう理由を書く。
  const kept = bounded.slice(0, maxMessages - 1);
  const remainder = bounded
    .slice(maxMessages - 1)
    .join("\n")
    .slice(0, maxLength - TRUNCATION_NOTICE.length);
  return [...kept, `${remainder}${TRUNCATION_NOTICE}`];
}
