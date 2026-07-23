import { PLAN_CONFIG, type PlanCode } from "./plans.ts";
import { freePeriod } from "./periods.ts";
import type {
  MembershipStatus,
  UsageReservation,
  UsageStatus,
  UsageType,
} from "./types.ts";

type User = {
  lineUserId: string;
  planCode: PlanCode;
  status: MembershipStatus;
  periodStart: string;
  periodEnd: string;
};

type Event = {
  id: string;
  lineUserId: string;
  usageType: UsageType;
  status: UsageStatus;
  idempotencyKey: string;
  periodStart: string;
  periodEnd: string;
};

export class MemoryMembershipLedger {
  private users = new Map<string, User>();
  private events = new Map<string, Event>();
  private webhookEvents = new Map<string, string>();
  private sequence = 0;
  private queue = Promise.resolve();

  ensureUser(lineUserId: string, now = new Date()): User {
    const existing = this.users.get(lineUserId);
    if (existing) return existing;
    const period = freePeriod(now);
    const user: User = {
      lineUserId,
      planCode: "free",
      status: "free",
      periodStart: period.start,
      periodEnd: period.end,
    };
    this.users.set(lineUserId, user);
    return user;
  }

  syncPaidUser(
    lineUserId: string,
    planCode: PlanCode,
    periodStart: string,
    periodEnd: string,
    status: MembershipStatus = "active",
  ): void {
    this.users.set(lineUserId, {
      lineUserId,
      planCode,
      status,
      periodStart,
      periodEnd,
    });
  }

  endMembership(lineUserId: string, now = new Date()): void {
    const period = freePeriod(now);
    this.users.set(lineUserId, {
      lineUserId,
      planCode: "free",
      status: "free",
      periodStart: period.start,
      periodEnd: period.end,
    });
  }

  async reserve(
    lineUserId: string,
    usageType: UsageType,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<UsageReservation> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => turn);
    await previous;
    try {
      const user = this.ensureUser(lineUserId, now);
      const existing = [...this.events.values()].find(
        (event) => event.idempotencyKey === idempotencyKey,
      );
      const plan = PLAN_CONFIG[user.planCode];
      const limit =
        usageType === "ai_answer" ? plan.aiLimit : plan.taxReviewLimit;
      const active = [...this.events.values()].filter(
        (event) =>
          event.lineUserId === lineUserId &&
          event.usageType === usageType &&
          event.periodStart === user.periodStart &&
          event.periodEnd === user.periodEnd &&
          (event.status === "reserved" || event.status === "consumed"),
      );
      if (existing) {
        return {
          allowed: existing.status !== "canceled",
          usageEventId: existing.id,
          planCode: user.planCode,
          membershipStatus: user.status,
          usageLimit: limit,
          usedCount: active.length,
          remainingCount: Math.max(limit - active.length, 0),
          periodStart: user.periodStart,
          periodEnd: user.periodEnd,
        };
      }
      if (active.length >= limit) {
        return {
          allowed: false,
          usageEventId: null,
          planCode: user.planCode,
          membershipStatus: user.status,
          usageLimit: limit,
          usedCount: active.length,
          remainingCount: 0,
          periodStart: user.periodStart,
          periodEnd: user.periodEnd,
        };
      }
      const id = `usage-${++this.sequence}`;
      this.events.set(id, {
        id,
        lineUserId,
        usageType,
        status: "reserved",
        idempotencyKey,
        periodStart: user.periodStart,
        periodEnd: user.periodEnd,
      });
      return {
        allowed: true,
        usageEventId: id,
        planCode: user.planCode,
        membershipStatus: user.status,
        usageLimit: limit,
        usedCount: active.length + 1,
        remainingCount: Math.max(limit - active.length - 1, 0),
        periodStart: user.periodStart,
        periodEnd: user.periodEnd,
      };
    } finally {
      release();
    }
  }

  transition(id: string, status: "consumed" | "canceled"): boolean {
    const event = this.events.get(id);
    if (!event || event.status !== "reserved") return false;
    event.status = status;
    return true;
  }

  consumed(lineUserId: string, usageType: UsageType): number {
    return [...this.events.values()].filter(
      (event) =>
        event.lineUserId === lineUserId &&
        event.usageType === usageType &&
        event.status === "consumed",
    ).length;
  }

  beginWebhook(provider: string, eventId: string, hash: string): boolean {
    const key = `${provider}:${eventId}`;
    const existing = this.webhookEvents.get(key);
    if (existing && existing !== hash) throw new Error("Webhook payload mismatch");
    if (existing) return false;
    this.webhookEvents.set(key, hash);
    return true;
  }
}
