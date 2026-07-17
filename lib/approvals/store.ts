import type { ReplyDraft } from "@/lib/openai/generateReplyDraft";

export type ApprovalStatus =
  | "pending"
  | "revision_requested"
  | "revising"
  | "sending"
  | "sent"
  | "rejected";

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
  revision?: number;
};

export type RevisionSession = {
  approvalId: string;
  reviewerUserId: string;
  channelId: string;
  createdAt: string;
};

type RedisResponse<T> = { result?: T; error?: string };

const KEY_PREFIX = "apexbrain:line-approval:";
const REVISION_SESSION_KEY_PREFIX = "apexbrain:revision-session:";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;
const REVISION_SESSION_TTL_SECONDS = 60 * 30;

declare global {
  // eslint-disable-next-line no-var
  var __lineApprovalMemoryStore: Map<string, ApprovalRecord> | undefined;
  // eslint-disable-next-line no-var
  var __lineRevisionSessionMemoryStore: Map<string, RevisionSession> | undefined;
}

const memoryStore = globalThis.__lineApprovalMemoryStore ?? new Map<string, ApprovalRecord>();
globalThis.__lineApprovalMemoryStore = memoryStore;
const revisionSessionMemoryStore =
  globalThis.__lineRevisionSessionMemoryStore ?? new Map<string, RevisionSession>();
globalThis.__lineRevisionSessionMemoryStore = revisionSessionMemoryStore;

function revisionSessionKey(channelId: string, reviewerUserId: string): string {
  return `${REVISION_SESSION_KEY_PREFIX}${channelId}:${reviewerUserId}`;
}

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

export async function updateApprovalDraft(
  id: string,
  expectedStatus: ApprovalStatus,
  draft: Pick<ApprovalRecord, "category" | "urgency" | "draftReply" | "checkItems">,
  reviewerUserId: string,
): Promise<ApprovalRecord | null> {
  const updatedAt = new Date().toISOString();

  if (!getRedisConfig()) {
    const current = memoryStore.get(id);
    if (!current || current.status !== expectedStatus) return null;
    const updated: ApprovalRecord = {
      ...current,
      ...draft,
      revision: (current.revision ?? 0) + 1,
      status: "pending",
      reviewerUserId,
      updatedAt,
    };
    memoryStore.set(id, updated);
    return updated;
  }

  const script = [
    "local raw = redis.call('GET', KEYS[1])",
    "if not raw then return nil end",
    "local item = cjson.decode(raw)",
    "if item.status ~= ARGV[1] then return nil end",
    "local draft = cjson.decode(ARGV[2])",
    "item.category = draft.category",
    "item.urgency = draft.urgency",
    "item.draftReply = draft.draftReply",
    "item.checkItems = draft.checkItems",
    "item.revision = (item.revision or 0) + 1",
    "item.status = 'pending'",
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
    JSON.stringify(draft),
    reviewerUserId,
    updatedAt,
  ]);
  return value ? (JSON.parse(value) as ApprovalRecord) : null;
}

export async function createRevisionSession(session: RevisionSession): Promise<boolean> {
  const key = revisionSessionKey(session.channelId, session.reviewerUserId);
  if (!getRedisConfig()) {
    if (revisionSessionMemoryStore.has(key)) return false;
    revisionSessionMemoryStore.set(key, session);
    return true;
  }
  const result = await redisCommand<string | null>([
    "SET",
    key,
    JSON.stringify(session),
    "EX",
    String(REVISION_SESSION_TTL_SECONDS),
    "NX",
  ]);
  return result === "OK";
}

export async function getRevisionSession(
  channelId: string,
  reviewerUserId: string,
): Promise<RevisionSession | null> {
  const key = revisionSessionKey(channelId, reviewerUserId);
  if (!getRedisConfig()) return revisionSessionMemoryStore.get(key) ?? null;
  const value = await redisCommand<string | null>(["GET", key]);
  return value ? (JSON.parse(value) as RevisionSession) : null;
}

export async function deleteRevisionSession(
  channelId: string,
  reviewerUserId: string,
  approvalId: string,
): Promise<boolean> {
  const key = revisionSessionKey(channelId, reviewerUserId);
  if (!getRedisConfig()) {
    const current = revisionSessionMemoryStore.get(key);
    if (!current || current.approvalId !== approvalId) return false;
    return revisionSessionMemoryStore.delete(key);
  }
  const script = [
    "local raw = redis.call('GET', KEYS[1])",
    "if not raw then return 0 end",
    "local item = cjson.decode(raw)",
    "if item.approvalId ~= ARGV[1] then return 0 end",
    "return redis.call('DEL', KEYS[1])",
  ].join("\n");
  return (await redisCommand<number>(["EVAL", script, "1", key, approvalId])) === 1;
}
