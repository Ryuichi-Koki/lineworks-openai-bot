import { maskLineOutput } from "../security/redaction.ts";
import {
  LEGAL_DOCUMENTS,
  legalDocumentUrl,
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
    includeMembershipJoinButton?: boolean;
    membershipJoinUrl?: string;
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
  const messages = splitLineMessages(maskLineOutput(text));
  const messagePayloads: Array<Record<string, unknown>> = messages.map((messageText) => ({
    type: "text",
    text: messageText,
  }));
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
  const joinUrl =
    options.membershipJoinUrl?.trim() ||
    process.env.LINE_MEMBERSHIP_JOIN_URL?.trim();
  if (options.includeMembershipJoinButton && joinUrl) {
    messagePayloads.push({
      type: "template",
      altText: "あんしん会員に登録する",
      template: {
        type: "buttons",
        text: "あんしん会員では、AI回答100回と税理士確認1件をご利用いただけます。",
        actions: [
          {
            type: "uri",
            label: "あんしん会員に登録する",
            uri: joinUrl,
          },
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
      template: {
        type: "buttons",
        title: "会員メニュー",
        text: "ご希望の手続きを選択してください。",
        actions: [
          {
            type: "postback",
            label: "有料会員になる",
            data: "action=select_paid_membership",
            displayText: "有料会員の登録手続きへ進みます",
          },
          {
            type: "postback",
            label: "無料会員で始める",
            data: "action=select_free_membership",
            displayText: "無料会員で始める",
          },
          {
            type: "postback",
            label: "税理士へ相談",
            data: "action=start_tax_review_intake",
            displayText: "税理士へ相談",
          },
          {
            type: "message",
            label: "退会・契約管理",
            text: "退会したい",
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
    messagePayloads.push({
      type: "template",
      altText: "規約等への確認と同意",
      template: {
        type: "buttons",
        title: "規約等への確認・同意",
        text: "各規程と外国へのデータ移転に関する説明を確認し、同意する場合は下のチェックボタンを押してください。",
        actions: [
          {
            type: "postback",
            label: "☐ 規約等に同意する",
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
      altText: "無料会員または有料会員を選択",
      template: {
        type: "buttons",
        title: "会員種別を選択",
        text: "☑ 規約等への同意を記録しました。続けて会員種別を選択してください。",
        actions: [
          {
            type: "postback",
            label: "無料会員を選ぶ",
            data: "action=select_free_membership",
            displayText: "無料会員を選びます",
          },
          {
            type: "postback",
            label: "有料会員を選ぶ",
            data: "action=select_paid_membership",
            displayText: "有料会員を選びます",
          },
        ],
      },
    });
  }
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
  await pushLineMessage(
    userId,
    "登録前に各規程をご確認ください。ボタンを押すと、サービス利用規約、プライバシーポリシー（外国にある第三者への提供を含みます。）に同意した記録を保存します。",
    retryKey,
    {
      includeLegalMenu: true,
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
): Promise<void> {
  const safeSummary = maskLineOutput(summary).slice(0, 1500);
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
        {
          type: "template",
          altText: "税理士確認の依頼内容をご確認ください",
          template: {
            type: "buttons",
            text: `次の内容で税理士へ確認します。\n\n${safeSummary}`.slice(0, 160),
            actions: [
              {
                type: "postback",
                label: "この内容で依頼する",
                data: `action=submit_tax_review&id=${encodeURIComponent(reviewRequestId)}`,
                displayText: "この内容で依頼する",
              },
              {
                type: "postback",
                label: "キャンセル",
                data: `action=cancel_tax_review&id=${encodeURIComponent(reviewRequestId)}`,
                displayText: "税理士確認をキャンセル",
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

export function splitLineMessages(text: string, maxLength = 4500): string[] {
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
  if (bounded.length <= 3) return bounded;
  const firstTwo = bounded.slice(0, 2);
  const remainder = bounded.slice(2).join("\n").slice(0, maxLength - 1);
  return [...firstTwo, `${remainder}…`];
}
