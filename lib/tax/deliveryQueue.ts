import { createHash } from "node:crypto";
import { pushLineMessage } from "../line/client.ts";
import {
  claimTaxReviewDeliveryJobs,
  claimTaxReviewDeliveryJob,
  completeQueuedTaxReview,
  completeTaxReviewDeliveryJob,
  enqueueMissingPaidTaxReviewDeliveries,
  markExpiredTaxReviewPayments,
  markTaxReviewDeliveryStep,
  retryTaxReviewDeliveryJob,
} from "../membership/store.ts";
import type { TaxReviewDeliveryJob } from "../membership/types.ts";
import { sendStaffChannelMessage } from "../lineworks/client.ts";
import {
  prepareTaxProfessionalReview,
  savePreparedReviewConversation,
  sendPreparedReviewReceipt,
  sendPreparedReviewToStaff,
} from "./consultationService.ts";

function deterministicRetryKey(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

async function processJob(
  job: TaxReviewDeliveryJob,
): Promise<"completed" | "pending" | "failed"> {
  try {
    if (
      job.paymentStatus === "canceled" ||
      job.paymentStatus === "refunded"
    ) {
      throw new Error("Tax review payment is no longer eligible for delivery");
    }
    const prepared = await prepareTaxProfessionalReview({
      eventId: job.eventId,
      userId: job.lineUserId,
      customerText: job.questionSummary,
    });
    if (!job.staffSentAt) {
      await sendPreparedReviewToStaff(prepared);
      await markTaxReviewDeliveryStep(job.id, "staff");
      job.staffSentAt = new Date().toISOString();
    }
    if (!job.customerSentAt) {
      await sendPreparedReviewReceipt(prepared);
      await markTaxReviewDeliveryStep(job.id, "customer");
      job.customerSentAt = new Date().toISOString();
    }
    if (!job.conversationSavedAt) {
      await savePreparedReviewConversation(prepared);
      await markTaxReviewDeliveryStep(job.id, "conversation");
      job.conversationSavedAt = new Date().toISOString();
    }
    await completeQueuedTaxReview(job);
    await completeTaxReviewDeliveryJob(job.id);
    return "completed";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delivery error";
    const status = await retryTaxReviewDeliveryJob(job.id, message);
    if (status === "failed") {
      await Promise.allSettled([
        sendStaffChannelMessage(
          [
            "【要確認】税理士相談の自動受付を完了できませんでした。",
            `受付ジョブID: ${job.id}`,
            "決済状況とLINE WORKS通知状況を管理台帳で確認してください。",
          ].join("\n"),
        ),
        pushLineMessage(
          job.lineUserId,
          [
            "税理士相談のお支払い又は受付情報は記録されていますが、",
            "自動受付を完了できませんでした。",
            "重複してお支払いせず、info@abtax.jpまでお問い合わせください。",
          ].join("\n"),
          deterministicRetryKey(`tax-review-delivery-failed:${job.id}`),
        ),
      ]);
      return "failed";
    }
    return "pending";
  }
}

export async function processQueuedTaxReviewDeliveries(
  limit = 10,
): Promise<{
  claimed: number;
  completedJobIds: string[];
  pendingJobIds: string[];
  failedJobIds: string[];
}> {
  const jobs = await claimTaxReviewDeliveryJobs(limit);
  const completedJobIds: string[] = [];
  const pendingJobIds: string[] = [];
  const failedJobIds: string[] = [];
  for (const job of jobs) {
    const result = await processJob(job);
    if (result === "completed") completedJobIds.push(job.id);
    else if (result === "pending") pendingJobIds.push(job.id);
    else failedJobIds.push(job.id);
  }
  return {
    claimed: jobs.length,
    completedJobIds,
    pendingJobIds,
    failedJobIds,
  };
}

export async function processTaxReviewDelivery(
  jobId: string,
): Promise<"completed" | "pending" | "failed" | "not_ready"> {
  const job = await claimTaxReviewDeliveryJob(jobId);
  return job ? processJob(job) : "not_ready";
}

export async function reconcileTaxReviewDeliveries(): Promise<{
  recoveredPayments: number;
  expiredPayments: number;
  claimed: number;
  completed: number;
  pending: number;
  failed: number;
}> {
  const recoveredPayments = await enqueueMissingPaidTaxReviewDeliveries();
  const expired = await markExpiredTaxReviewPayments();
  await Promise.allSettled(
    expired.map((payment) =>
      pushLineMessage(
        payment.lineUserId,
        [
          "税理士相談の決済ページの有効期限が切れました。",
          "ご請求は発生していません。",
          "相談する場合は、リッチメニューの［税理士に相談］からもう一度お進みください。",
        ].join("\n"),
        deterministicRetryKey(`tax-review-checkout-expired:${payment.id}`),
      ),
    ),
  );
  const processed = await processQueuedTaxReviewDeliveries(25);
  return {
    recoveredPayments,
    expiredPayments: expired.length,
    claimed: processed.claimed,
    completed: processed.completedJobIds.length,
    pending: processed.pendingJobIds.length,
    failed: processed.failedJobIds.length,
  };
}
