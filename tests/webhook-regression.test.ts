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
import { pushLineMessage, splitLineMessages } from "../lib/line/client.ts";
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
  assert.deepEqual(
    template.actions?.map((action) => action.label),
    ["有料会員になる", "無料会員で始める", "税理士へ相談", "退会・契約管理"],
  );
  assert.equal(template.actions?.[0]?.type, "message");
  assert.equal(template.actions?.[0]?.text, "料金を教えて");
  assert.equal(template.actions?.[1]?.type, "postback");
  assert.equal(
    template.actions?.[1]?.data,
    "action=select_free_membership",
  );
  assert.equal(
    template.actions?.[2]?.data,
    "action=start_tax_review_intake",
  );
  assert.equal(template.actions?.[3]?.text, "退会したい");
});

test("通常返信からいつでも会員メニューを呼び出せる", async () => {
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
  const quickReply = messages.at(-1)?.quickReply as {
    items?: Array<{ action?: Record<string, unknown> }>;
  };
  assert.equal(quickReply.items?.[0]?.action?.label, "会員メニュー");
  assert.equal(quickReply.items?.[0]?.action?.text, "メニュー");
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
