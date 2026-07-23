import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import {
  appendAuditRecord,
  appendConversationMessage,
  createApproval,
  getApproval,
  getAuditRecords,
  getConversationHistory,
  transitionApproval,
  type ApprovalRecord,
} from "../lib/approvals/store.ts";
import { pushLineMessage, splitLineMessages } from "../lib/line/client.ts";
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

test("AI回答の最後に税理士個別相談のpostbackボタンを付ける", async () => {
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
  const quickReply = lastMessage?.quickReply as { items?: Array<Record<string, unknown>> };
  const action = quickReply.items?.[0]?.action as Record<string, unknown>;
  assert.equal(action.type, "postback");
  assert.equal(action.label, "税理士へ個別相談");
  assert.equal(action.data, "action=tax_professional_review");
});
