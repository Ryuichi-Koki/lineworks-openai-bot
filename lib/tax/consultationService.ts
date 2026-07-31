import { createHash, randomUUID } from "node:crypto";
import {
  appendConversationMessage,
  createConsultation,
  getConsultation,
  getConversationHistory,
  type ConsultationRecord,
} from "../approvals/store.ts";
import { pushLineMessage } from "../line/client.ts";
import { sendStaffConsultationMessage } from "../lineworks/client.ts";
import { redactSensitiveText } from "../security/redaction.ts";
import { buildReviewRequestReceipt } from "./hybridService.ts";

export type PreparedTaxProfessionalReview = {
  consultation: ConsultationRecord;
  receipt: string;
  customerText: string;
  createdAt: string;
  wasCreated: boolean;
};

/** 相談本文に割り当てる字数。参考情報より常に優先する。 */
const CONSULTATION_BODY_MAX_LENGTH = 1200;
/** 参考として添える直近のやり取りの字数。相談本文を圧迫しない範囲に抑える。 */
const CONSULTATION_HISTORY_MAX_LENGTH = 400;
/** 参考として添える会話の件数。 */
const CONSULTATION_HISTORY_MESSAGES = 6;

function formatJstTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "不明";
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`,
    `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`,
  ].join(" ");
}

/**
 * 税理士へ提示する本文を組み立てる。
 *
 * 相談本文（お支払い対象）を必ず先頭に全文置く。
 * 従来は直近6件の会話履歴を連結して「先頭から」1,600字で切っていたため、
 * 会話履歴が古い順に並ぶ都合上、支払われた相談内容そのものが末尾から
 * 落ちていた（AIを1往復でも使った利用者で必ず発生する）。
 *
 * 参考情報は末尾を残す形で切り詰める。直近のやり取りほど価値が高いため。
 */
export function buildConsultationStaffContext(input: {
  lineUserHash: string;
  createdAt: string;
  customerText: string;
  conversationHistory: Array<{ role: "customer" | "assistant"; text: string }>;
}): string {
  const body = redactSensitiveText(input.customerText).trim();
  const consultationBody = body
    ? body.slice(0, CONSULTATION_BODY_MAX_LENGTH)
    : "（相談本文を取得できませんでした。管理台帳で受付IDを確認してください。）";

  const history = redactSensitiveText(
    input.conversationHistory
      .slice(-CONSULTATION_HISTORY_MESSAGES)
      .map(
        (message) =>
          `${message.role === "customer" ? "顧客" : "AI"}: ${message.text}`,
      )
      .join("\n\n"),
  ).trim();
  const historyExcerpt =
    history.length > CONSULTATION_HISTORY_MAX_LENGTH
      ? `…${history.slice(-CONSULTATION_HISTORY_MAX_LENGTH)}`
      : history;

  return [
    `LINE利用者: ${input.lineUserHash}`,
    `受付日時: ${formatJstTimestamp(input.createdAt)}`,
    "",
    "【相談内容（お支払い対象）】",
    consultationBody,
    ...(historyExcerpt
      ? ["", "【直近のやり取り（参考）】", historyExcerpt]
      : []),
  ].join("\n");
}

export async function prepareTaxProfessionalReview(input: {
  eventId: string;
  userId: string;
  customerText: string;
}): Promise<PreparedTaxProfessionalReview> {
  const conversationHistory = await getConversationHistory(input.userId);
  const id = createHash("sha256").update(input.eventId).digest("hex").slice(0, 32);
  const now = new Date().toISOString();
  const existing = await getConsultation(id);
  if (existing) {
    return {
      consultation: existing,
      receipt: buildReviewRequestReceipt(),
      customerText: input.customerText,
      createdAt: existing.createdAt,
      wasCreated: false,
    };
  }
  const consultation = {
    id,
    lineUserId: input.userId,
    staffContext: buildConsultationStaffContext({
      lineUserHash: createHash("sha256")
        .update(input.userId)
        .digest("hex")
        .slice(0, 12),
      createdAt: now,
      customerText: input.customerText,
      conversationHistory,
    }),
    status: "waiting_reply" as const,
    lineRetryKey: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  const created = await createConsultation(consultation);
  const persisted = created ? consultation : await getConsultation(id);
  if (!persisted) {
    throw new Error("Tax professional consultation could not be persisted");
  }
  return {
    consultation: persisted,
    receipt: buildReviewRequestReceipt(),
    customerText: input.customerText,
    createdAt: now,
    wasCreated: created,
  };
}

export async function sendPreparedReviewToStaff(
  prepared: PreparedTaxProfessionalReview,
): Promise<void> {
  await sendStaffConsultationMessage(prepared.consultation);
}

export async function sendPreparedReviewReceipt(
  prepared: PreparedTaxProfessionalReview,
): Promise<void> {
  await pushLineMessage(
    prepared.consultation.lineUserId,
    prepared.receipt,
    prepared.consultation.lineRetryKey,
  );
}

export async function savePreparedReviewConversation(
  prepared: PreparedTaxProfessionalReview,
): Promise<void> {
  await Promise.all([
    appendConversationMessage(prepared.consultation.lineUserId, {
      role: "customer",
      text: prepared.customerText,
      createdAt: prepared.createdAt,
    }),
    appendConversationMessage(prepared.consultation.lineUserId, {
      role: "assistant",
      text: prepared.receipt,
      createdAt: prepared.createdAt,
    }),
  ]);
}

export async function dispatchTaxProfessionalReview(input: {
  eventId: string;
  userId: string;
  customerText: string;
}): Promise<void> {
  const prepared = await prepareTaxProfessionalReview(input);
  if (!prepared.wasCreated) return;
  await sendPreparedReviewToStaff(prepared);
  await sendPreparedReviewReceipt(prepared);
  await savePreparedReviewConversation(prepared);
}
