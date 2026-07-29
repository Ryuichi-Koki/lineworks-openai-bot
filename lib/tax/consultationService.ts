import { createHash, randomUUID } from "node:crypto";
import {
  appendConversationMessage,
  createConsultation,
  deleteConsultation,
  getConversationHistory,
} from "../approvals/store.ts";
import { pushLineMessage } from "../line/client.ts";
import { sendStaffConsultationMessage } from "../lineworks/client.ts";
import { redactSensitiveText } from "../security/redaction.ts";
import { buildReviewRequestReceipt } from "./hybridService.ts";

export async function dispatchTaxProfessionalReview(input: {
  eventId: string;
  userId: string;
  customerText: string;
}): Promise<void> {
  const conversationHistory = await getConversationHistory(input.userId);
  const id = createHash("sha256").update(input.eventId).digest("hex").slice(0, 32);
  const now = new Date().toISOString();
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
  if (!(await createConsultation(consultation))) return;

  try {
    await sendStaffConsultationMessage(consultation);
    const receipt = buildReviewRequestReceipt();
    await pushLineMessage(input.userId, receipt, randomUUID());
    await Promise.all([
      appendConversationMessage(input.userId, {
        role: "customer",
        text: input.customerText,
        createdAt: now,
      }),
      appendConversationMessage(input.userId, {
        role: "assistant",
        text: receipt,
        createdAt: now,
      }),
    ]);
  } catch (error) {
    await deleteConsultation(id);
    throw error;
  }
}
