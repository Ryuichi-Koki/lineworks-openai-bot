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
  const recentContext = conversationHistory
    .slice(-6)
    .map((message) => `${message.role === "customer" ? "顧客" : "AI"}: ${message.text}`)
    .join("\n\n");

  const consultation = {
    id,
    lineUserId: input.userId,
    staffContext: [
      `LINE利用者: ${createHash("sha256").update(input.userId).digest("hex").slice(0, 12)}`,
      "",
      redactSensitiveText(recentContext || input.customerText).slice(0, 1600),
    ].join("\n"),
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
