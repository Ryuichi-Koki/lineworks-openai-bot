import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import {
  appendAuditRecord,
  appendConversationMessage,
  createApproval,
  createConsultation,
  createConsultationReplySession,
  deleteConsultationReplySession,
  getApproval,
  getAuditRecords,
  getConsultation,
  getConsultationReplySession,
  getConversationHistory,
  transitionConsultation,
  transitionApproval,
  updateConsultationReplySession,
  type ApprovalRecord,
} from "../lib/approvals/store.ts";
import {
  pushLineLegalConsentPrompt,
  pushLineMessage,
  pushLineReviewConfirmation,
  splitLineMessages,
} from "../lib/line/client.ts";
import { lineApiBaseUrl } from "../lib/line/config.ts";
import { verifyLineSignature } from "../lib/line/verifySignature.ts";
import { verifyLineWorksSignature } from "../lib/lineworks/verifySignature.ts";

function signature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function approvalRecord(id: string): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id,
    sourceEventId: `source-${id}`,
    lineUserId: `line-${id}`,
    customerMessage: "パソコンを買った",
    lineRetryKey: randomUUID(),
    category: "税務",
    urgency: "通常",
    answerLevel: "B",
    confidence: "中",
    inferredIntent: "固定資産判定",
    assumptions: ["国内の通常取引"],
    draftReply: "【結論】\n標準ケースの回答です。",
    checkItems: ["金額"],
    sources: [],
    sourceVerification: "unverified",
    requiresTaxProfessionalReview: true,
    handoffSummary: {
      clientName: "未登録",
      questionSummary: "パソコン購入",
      provisionalAnswer: "金額により処理が変わる",
      assumptions: [],
      requiredChecks: ["金額"],
      references: [],
      urgency: "通常",
      responseDeadline: null,
    },
    clientContextFieldsUsed: [],
    model: "test",
    promptVersion: "test",
    generatedAt: now,
    revision: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

test("LINEとLINE WORKSの署名検証を維持する", () => {
  const body = JSON.stringify({ events: [] });
  const secret = "test-secret";
  const valid = signature(body, secret);
  assert.equal(verifyLineSignature(body, valid, secret), true);
  assert.equal(verifyLineSignature(body, "invalid", secret), false);
  assert.equal(verifyLineWorksSignature(body, valid, secret), true);
  assert.equal(verifyLineWorksSignature(body, "invalid", secret), false);
});

test("案件重複防止と承認状態遷移を維持する", async () => {
  const id = randomUUID();
  const record = approvalRecord(id);
  assert.equal(await createApproval(record), true);
  assert.equal(await createApproval(record), false);
  assert.equal((await getApproval(id))?.status, "pending");
  assert.equal((await transitionApproval(id, "pending", "sending", "reviewer"))?.status, "sending");
  assert.equal(await transitionApproval(id, "pending", "sent", "reviewer"), null);
});

test("会話履歴と監査履歴を保持する", async () => {
  const userId = `user-${randomUUID()}`;
  await appendConversationMessage(userId, {
    role: "customer",
    text: "質問",
    createdAt: new Date().toISOString(),
  });
  assert.equal((await getConversationHistory(userId)).at(-1)?.text, "質問");

  const approvalId = randomUUID();
  await appendAuditRecord({
    approvalId,
    eventType: "draft_generated",
    recordedAt: new Date().toISOString(),
    model: "test",
    promptVersion: "test",
  });
  assert.equal((await getAuditRecords(approvalId)).length, 1);
});

test("個別相談の回答作成・確認・送信状態を安全に遷移する", async () => {
  const id = randomUUID();
  const now = new Date().toISOString();
  assert.equal(
    await createConsultation({
      id,
      lineUserId: `line-${id}`,
      staffContext: "直近の相談内容",
      status: "waiting_reply",
      lineRetryKey: randomUUID(),
      createdAt: now,
      updatedAt: now,
    }),
    true,
  );
  assert.equal(
    (await transitionConsultation(id, "waiting_reply", "drafting", "reviewer"))
      ?.status,
    "drafting",
  );
  assert.equal(
    await createConsultationReplySession({
      consultationId: id,
      reviewerUserId: "reviewer",
      channelId: "channel",
      stage: "drafting",
      createdAt: now,
    }),
    true,
  );
  const session = await getConsultationReplySession("channel", "reviewer");
  assert.equal(session?.consultationId, id);
  if (!session) assert.fail("consultation session was not created");
  await updateConsultationReplySession({ ...session, stage: "confirming" });
  assert.equal(
    (await getConsultationReplySession("channel", "reviewer"))?.stage,
    "confirming",
  );
  assert.equal(
    (
      await transitionConsultation(
        id,
        "drafting",
        "awaiting_send",
        "reviewer",
        "税理士からの回答",
      )
    )?.replyText,
    "税理士からの回答",
  );
  assert.equal(
    (await transitionConsultation(id, "awaiting_send", "sending", "reviewer"))
      ?.status,
    "sending",
  );
  assert.equal(
    (await transitionConsultation(id, "sending", "sent", "reviewer"))?.status,
    "sent",
  );
  assert.equal((await getConsultation(id))?.status, "sent");
  assert.equal(
    await deleteConsultationReplySession("channel", "reviewer", id),
    true,
  );
});

test("長文回答をLINE最大3通へ安全に分割する", () => {
  const text = [
    "【結論】",
    "あ".repeat(4400),
    "【判断のポイント】",
    "い".repeat(4400),
    "【主な根拠】",
    "う".repeat(4400),
  ].join("\n");
  const messages = splitLineMessages(text);
  assert.ok(messages.length >= 2 && messages.length <= 3);
  assert.ok(messages.every((message) => message.length <= 4500));
});

test("枠に収まる長文は切り捨てずに全文を送る", () => {
  // 1回のpushで最大5通。ボタンがなければ本文に5通ぶん使える。
  const text = Array.from({ length: 5 }, (_, index) =>
    [`【見出し${index + 1}】`, "あ".repeat(4000)].join("\n"),
  ).join("\n");
  const messages = splitLineMessages(text, 4500, 5);

  assert.equal(messages.length, 5);
  assert.ok(messages.every((message) => message.length <= 4500));
  assert.ok(
    messages.some((message) => message.includes("【見出し5】")),
    "末尾の見出しまで届くこと",
  );
  assert.ok(
    messages.every((message) => !message.includes("※回答が長いため")),
    "収まる場合は省略の注記を付けない",
  );
});

test("枠を超える場合は省略した旨を明示する（無言で切り捨てない）", () => {
  const text = Array.from({ length: 6 }, (_, index) =>
    [`【見出し${index + 1}】`, "あ".repeat(4000)].join("\n"),
  ).join("\n");
  const messages = splitLineMessages(text, 4500, 3);

  assert.equal(messages.length, 3);
  assert.ok(messages.every((message) => message.length <= 4500));
  const last = messages.at(-1) ?? "";
  assert.match(last, /※回答が長いため、ここまでを表示しています/);
  assert.match(last, /内容を分けてもう一度ご質問ください/);
});

test("必要なAI回答の後に税理士個別相談のボタンテンプレートを付ける", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage("line-user", "回答本文", randomUUID(), {
      includeTaxReviewButton: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  assert.ok(requestBody && typeof requestBody === "object");
  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  const lastMessage = messages.at(-1);
  assert.equal(lastMessage?.type, "template");
  const template = lastMessage?.template as {
    type?: string;
    actions?: Array<Record<string, unknown>>;
  };
  assert.equal(template.type, "buttons");
  const action = template.actions?.[0] as Record<string, unknown>;
  assert.equal(action.type, "postback");
  assert.equal(action.label, "税理士へ個別相談");
  assert.equal(action.data, "action=tax_professional_review");
});

test("通常のAI回答には税理士個別相談ボタンを付けない", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage("line-user", "通常回答", randomUUID());
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  assert.ok(requestBody && typeof requestBody === "object");
  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "text");
});

test("初回登録用メニューに有料会員と無料会員の両方を表示する", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage(
      "line-user",
      "ご登録ありがとうございます。",
      randomUUID(),
      { includeMembershipMenu: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  const menu = messages.at(-1);
  assert.equal(menu?.type, "template");
  const template = menu?.template as {
    actions?: Array<Record<string, unknown>>;
  };
  // 税理士相談・契約管理・規約は常設リッチメニュー側にあるため、ここには出さない。
  assert.deepEqual(
    template.actions?.map((action) => action.label),
    ["料金・プランを見る", "無料会員で始める", "マイページ"],
  );
  // 料金の確認は申し込みと分離する。この操作では決済ページを作らない。
  assert.equal(template.actions?.[0]?.type, "postback");
  assert.equal(template.actions?.[0]?.data, "action=show_pricing");
  assert.equal(template.actions?.[0]?.displayText, "料金プランを見ます");
  assert.equal(template.actions?.[1]?.type, "postback");
  assert.equal(template.actions?.[1]?.data, "action=select_free_membership");
  assert.equal(template.actions?.[2]?.type, "postback");
  assert.equal(template.actions?.[2]?.data, "action=show_status");
  // 利用者の発言として残るmessage actionを使わない
  assert.ok(
    template.actions?.every((action) => action.type === "postback"),
    "会員メニューのボタンはすべてpostbackであること",
  );
});

test("税理士相談の確認では依頼内容を全文表示し、消費する枠数を示す", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  // 旧実装は160字で切り捨てていたため、利用者は内容を確認できないまま枠を消費していた。
  const longSummary = `相談の冒頭です。${"あ".repeat(900)}相談の末尾です。`;
  try {
    await pushLineReviewConfirmation(
      "line-user",
      longSummary,
      "review-request-1",
      randomUUID(),
      { taxReviewRemaining: 1 },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  assert.ok(messages.length >= 2, "全文用のテキストと確認カードを分けて送る");
  assert.ok(messages.length <= 5, "LINEの1回あたり最大5通に収める");

  const bodyText = messages
    .filter((message) => message.type === "text")
    .map((message) => String(message.text))
    .join("");
  assert.match(bodyText, /相談の冒頭です。/);
  assert.match(bodyText, /相談の末尾です。/, "末尾まで切り捨てずに表示する");

  const card = messages.at(-1);
  assert.equal(card?.type, "template");
  const template = card?.template as {
    text?: string;
    actions?: Array<Record<string, unknown>>;
  };
  assert.ok((template.text?.length ?? 0) <= 160, "ボタンテンプレートは160字以内");
  assert.match(String(template.text), /旧あんしん会員契約の特典/);
  assert.match(String(template.text), /追加のお支払いはありません/);
  assert.match(String(template.text), /1件→0件/);
  assert.deepEqual(
    template.actions?.map((action) => action.label),
    ["この内容で依頼する", "入力し直す", "やめる"],
  );
  assert.equal(
    template.actions?.[1]?.data,
    "action=restart_tax_review&id=review-request-1",
  );
});

test("常設リッチメニューと重複するクイック返信を通常回答に表示しない", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage("line-user", "通常回答", randomUUID());
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  assert.equal(messages.at(-1)?.quickReply, undefined);
});

test("必要な場合だけクイック返信の会員メニューを明示表示できる", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage("line-user", "通常回答", randomUUID(), {
      includePersistentMenuButton: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  const quickReply = messages.at(-1)?.quickReply as {
    items?: Array<{ action?: Record<string, unknown> }>;
  };
  assert.equal(quickReply.items?.[0]?.action?.label, "会員メニュー");
  assert.equal(quickReply.items?.[1]?.action?.label, "規約・各種情報");
});

test("LINEから規約4ページを確認し、チェック式で明示同意できる", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const originalLegalBaseUrl = process.env.LEGAL_APP_BASE_URL;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  process.env.LEGAL_APP_BASE_URL = "https://bot.abtax.jp";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    // 本番で実際に使う入口を検証する
    await pushLineLegalConsentPrompt("line-user", "2026-07-24-v1", randomUUID());
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
    if (originalLegalBaseUrl === undefined) {
      delete process.env.LEGAL_APP_BASE_URL;
    } else {
      process.env.LEGAL_APP_BASE_URL = originalLegalBaseUrl;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  // 規約4文書は一覧ページ1リンクへまとめ、初回の吹き出しを3通から2通に減らす。
  assert.equal(messages.length, 2);
  const consentTemplate = messages[1]?.template as {
    text?: string;
    actions?: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    consentTemplate.actions?.map((action) => action.label),
    ["規約を読む", "上記に同意して進む"],
  );
  assert.equal(consentTemplate.actions?.[0]?.type, "uri");
  assert.equal(consentTemplate.actions?.[0]?.uri, "https://bot.abtax.jp/legal");
  assert.equal(
    consentTemplate.actions?.[1]?.data,
    "action=accept_policies&version=2026-07-24-v1",
  );
  assert.equal(consentTemplate.actions?.[1]?.displayText, "規約等に同意します");
  // 「☐」は未チェックの記号に見え、押しただけでは確定しないと誤解される
  assert.doesNotMatch(
    String(consentTemplate.actions?.[1]?.label),
    /[☐☑✓]/,
  );
  // 押した時点で記録が保存されることを本文で明示する
  assert.match(String(consentTemplate.text), /同意した記録を保存します/);
});

test("規約等への同意後に無料利用開始か料金確認を選択できる", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage(
      "line-user",
      "規約等への同意が確認できました。",
      randomUUID(),
      { includeMembershipSelectionButtons: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  const selectionTemplate = messages.at(-1)?.template as {
    text?: string;
    actions?: Array<Record<string, unknown>>;
  };
  assert.match(selectionTemplate.text ?? "", /☑ 規約等への同意を記録/);
  assert.deepEqual(
    selectionTemplate.actions?.map((action) => action.label),
    ["無料で始める", "料金を確認する"],
  );
  assert.equal(
    selectionTemplate.actions?.[0]?.data,
    "action=select_free_membership",
  );
  assert.equal(
    selectionTemplate.actions?.[1]?.data,
    "action=show_pricing",
  );
});

test("料金案内には指定されたStripe Checkout URLだけを登録ボタンへ設定する", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage("line-user", "料金案内", randomUUID(), {
      includeMembershipJoinButton: true,
      membershipJoinUrl: "https://checkout.stripe.com/c/pay/test-session",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  const template = messages.at(-1)?.template as {
    actions?: Array<Record<string, unknown>>;
  };
  assert.equal(template.actions?.[0]?.type, "uri");
  assert.equal(
    template.actions?.[0]?.uri,
    "https://checkout.stripe.com/c/pay/test-session",
  );
});

test("税理士相談の確認画面は決済前であることと1回分の金額を示す", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response("", { status: 200 });
  };
  try {
    await pushLineReviewConfirmation(
      "U-payment-confirm",
      "消費税の課税区分を確認したい",
      "review-payment-1",
      randomUUID(),
      {
        taxReviewRemaining: 0,
        requiresPayment: true,
        paymentAmount: 1000,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
  }
  const messages = (requestBody as { messages: Array<Record<string, unknown>> })
    .messages;
  const template = messages.at(-1)?.template as {
    text?: string;
    actions?: Array<Record<string, unknown>>;
  };
  assert.match(template.text ?? "", /1,000円（税込）/);
  assert.match(template.text ?? "", /このボタンではまだ請求されません/);
  assert.equal(template.actions?.[0]?.data, "action=submit_tax_review&id=review-payment-1");
});

test("税理士相談の都度決済ボタンは金額・提供開始・自動更新・返金条件を示す", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const originalLegalBaseUrl = process.env.LEGAL_APP_BASE_URL;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  process.env.LEGAL_APP_BASE_URL = "https://bot.abtax.jp";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response("", { status: 200 });
  };
  try {
    await pushLineMessage("U-payment", "お支払いへ進みます。", randomUUID(), {
      includeTaxReviewPaymentButton: true,
      taxReviewPaymentUrl: "https://checkout.stripe.com/c/pay/test-tax-review",
      taxReviewPaymentAmount: 1000,
      taxReviewRequestId: "review-payment-actions",
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    if (originalLegalBaseUrl === undefined) {
      delete process.env.LEGAL_APP_BASE_URL;
    } else {
      process.env.LEGAL_APP_BASE_URL = originalLegalBaseUrl;
    }
  }
  const messages = (requestBody as { messages: Array<Record<string, unknown>> })
    .messages;
  const template = messages.at(-1)?.template as {
    text?: string;
    actions?: Array<Record<string, unknown>>;
  };
  assert.match(template.text ?? "", /1,000円（税込）/);
  assert.match(template.text ?? "", /支払完了後に受付を開始/);
  assert.match(template.text ?? "", /自動更新はありません/);
  assert.match(template.text ?? "", /返金条件は特商法表記/);
  assert.equal(
    template.actions?.[0]?.uri,
    "https://checkout.stripe.com/c/pay/test-tax-review",
  );
  assert.equal(template.actions?.[1]?.uri, "https://bot.abtax.jp/tokusho");
  assert.equal(
    template.actions?.[2]?.data,
    "action=restart_tax_review&id=review-payment-actions",
  );
  assert.equal(
    template.actions?.[3]?.data,
    "action=cancel_tax_review&id=review-payment-actions",
  );
});

test("LINE APIの差し替えはローカルテストURLだけを許可する", () => {
  const originalOverride = process.env.LINE_API_BASE_URL;
  try {
    process.env.LINE_API_BASE_URL = "http://127.0.0.1:3200/v2/bot";
    assert.equal(lineApiBaseUrl(), "http://127.0.0.1:3200/v2/bot");

    process.env.LINE_API_BASE_URL = "https://example.com/v2/bot";
    assert.throws(() => lineApiBaseUrl(), /local tests/);
  } finally {
    if (originalOverride === undefined) {
      delete process.env.LINE_API_BASE_URL;
    } else {
      process.env.LINE_API_BASE_URL = originalOverride;
    }
  }
});

test("退会案内にはStripe Customer Portalの契約管理ボタンを設定する", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let requestBody: unknown;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("", { status: 200 });
  };

  try {
    await pushLineMessage("line-user", "退会手続きのご案内", randomUUID(), {
      includeMembershipManagementButton: true,
      membershipManagementUrl:
        "https://billing.stripe.com/p/session/test_portal_session",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    } else {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    }
  }

  const messages = (requestBody as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >;
  const template = messages.at(-1)?.template as {
    actions?: Array<Record<string, unknown>>;
  };
  assert.equal(template.actions?.[0]?.type, "uri");
  assert.equal(template.actions?.[0]?.label, "退会・契約管理へ");
  assert.equal(
    template.actions?.[0]?.uri,
    "https://billing.stripe.com/p/session/test_portal_session",
  );
});
