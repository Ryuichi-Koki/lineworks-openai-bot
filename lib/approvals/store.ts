import type { ReplyDraft } from "@/lib/openai/generateReplyDraft";

export type ApprovalStatus = "pending" | "sending" | "sent" | "rejected";

export type ApprovalRecord = ReplyDraft & {
  id: string;
  sourceEventId: string;
  lineUserId: string;
  customerMessage: string;
  lineRetryKey: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  reviewerUserId?: string;
};

type RedisResponse<T> = { result?: T; error?: string };

const KEY_PREFIX = "apexbrain:line-approval:";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;

declare global {
  // eslint-disable-next-line no-var
  var __lineApprovalMemoryStore: Map<string, ApprovalRecord> | undefined;
}

const memoryStore = globalThis.__lineApprovalMemoryStore ?? new Map<string, ApprovalRecord>();
globalThis.__lineApprovalMemoryStore = memoryStore;

function getRedisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (Boolean(url) !== Boolean(token)) {
    throw new Error("Both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required");
  }
  if (!url || !token) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Upstash Redis is required in production");
    }
    return null;
  }
  return { url: url.replace(/\/$/, ""), token };
}

async function redisCommand<T>(command: unknown[]): Promise<T> {
  const config = getRedisConfig();
  if (!config) {
    throw new Error("Redis is not configured");
  }

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const body = (await response.json()) as RedisResponse<T>;
  if (!response.ok || body.error) {
    throw new Error(`Upstash Redis command failed: ${body.error || response.status}`);
  }
  return body.result as T;
}

export async function createApproval(record: ApprovalRecord): Promise<boolean> {
  if (!getRedisConfig()) {
    if (memoryStore.has(record.id)) {
      return false;
    }
    memoryStore.set(record.id, record);
    return true;
  }

  const result = await redisCommand<string | null>([
    "SET",
    `${KEY_PREFIX}${record.id}`,
    JSON.stringify(record),
    "EX",
    String(Number(process.env.APPROVAL_TTL_SECONDS) || DEFAULT_TTL_SECONDS),
    "NX",
  ]);
  return result === "OK";
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  if (!getRedisConfig()) {
    return memoryStore.get(id) ?? null;
  }

  const value = await redisCommand<string | null>(["GET", `${KEY_PREFIX}${id}`]);
  return value ? (JSON.parse(value) as ApprovalRecord) : null;
}

export async function transitionApproval(
  id: string,
  expectedStatus: ApprovalStatus,
  nextStatus: ApprovalStatus,
  reviewerUserId: string,
): Promise<ApprovalRecord | null> {
  const updatedAt = new Date().toISOString();

  if (!getRedisConfig()) {
    const current = memoryStore.get(id);
    if (!current || current.status !== expectedStatus) {
      return null;
    }
    const updated = { ...current, status: nextStatus, reviewerUserId, updatedAt };
    memoryStore.set(id, updated);
    return updated;
  }

  const script = [
    "local raw = redis.call('GET', KEYS[1])",
    "if not raw then return nil end",
    "local item = cjson.decode(raw)",
    "if item.status ~= ARGV[1] then return nil end",
    "item.status = ARGV[2]",
    "item.reviewerUserId = ARGV[3]",
    "item.updatedAt = ARGV[4]",
    "local encoded = cjson.encode(item)",
    "redis.call('SET', KEYS[1], encoded, 'KEEPTTL')",
    "return encoded",
  ].join("\n");
  const value = await redisCommand<string | null>([
    "EVAL",
    script,
    "1",
    `${KEY_PREFIX}${id}`,
    expectedStatus,
    nextStatus,
    reviewerUserId,
    updatedAt,
  ]);
  return value ? (JSON.parse(value) as ApprovalRecord) : null;
}
