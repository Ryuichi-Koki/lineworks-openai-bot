import { createHash } from "node:crypto";
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

export type ConsultationStatus =
  | "waiting_reply"
  | "drafting"
  | "awaiting_send"
  | "sending"
  | "sent";

export type ConsultationRecord = {
  id: string;
  lineUserId: string;
  staffContext: string;
  status: ConsultationStatus;
  lineRetryKey: string;
  replyText?: string;
  reviewerUserId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ConsultationReplySession = {
  consultationId: string;
  reviewerUserId: string;
  channelId: string;
  stage: "drafting" | "confirming";
  createdAt: string;
};

export type ConversationMessage = {
  role: "customer" | "assistant";
  text: string;
  createdAt: string;
};

export type ClientProfile = {
  clientName?: string;
  entityType?: "法人" | "個人";
  fiscalYearEndMonth?: number;
  consumptionTaxStatus?: "課税" | "免税" | "不明";
  consumptionTaxMethod?: "本則" | "簡易" | "不明";
  invoiceRegistrationStatus?: "登録" | "未登録" | "不明";
  blueReturnStatus?: "青色" | "白色" | "不明";
  capitalYen?: number;
  industry?: string;
  officerInformation?: string;
  payrollOfficeStatus?: string;
  withholdingSpecialDueDateStatus?: string;
  filedNotifications?: string[];
  pastConsultationSummary?: string;
  assignedTaxProfessional?: string;
  assignedStaff?: string;
  updatedAt?: string;
};

export type AuditEventType =
  | "draft_generated"
  | "draft_revised"
  | "reply_sent"
  | "reply_rejected"
  | "processing_failed";

export type AuditRecord = {
  approvalId: string;
  eventType: AuditEventType;
  recordedAt: string;
  redactedQuestion?: string;
  answer?: string;
  answerLevel?: string;
  confidence?: string;
  model?: string;
  promptVersion?: string;
  sources?: Array<{
    title: string;
    url: string;
    legalReference: string | null;
    retrievedAt: string | null;
    quote: string;
  }>;
  assumptions?: string[];
  referencedClientFields?: string[];
  reviewerUserIdHash?: string;
  errorName?: string;
};

type RedisResponse<T> = { result?: T; error?: string };

const KEY_PREFIX = "apexbrain:line-approval:";
const REVISION_SESSION_KEY_PREFIX = "apexbrain:revision-session:";
const CONVERSATION_KEY_PREFIX = "apexbrain:line-conversation:";
const CLIENT_KEY_PREFIX = "apexbrain:line-client:";
const AUDIT_KEY_PREFIX = "apexbrain:audit:";
const CONSULTATION_KEY_PREFIX = "apexbrain:consultation:";
const CONSULTATION_SESSION_KEY_PREFIX = "apexbrain:consultation-session:";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14;
const REVISION_SESSION_TTL_SECONDS = 60 * 30;
const DEFAULT_CONVERSATION_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_CONVERSATION_MAX_MESSAGES = 20;
const AUDIT_TTL_SECONDS = 60 * 60 * 24 * 365 * 7;
const CONSULTATION_SESSION_TTL_SECONDS = 60 * 60;

declare global {
  var __lineApprovalMemoryStore: Map<string, ApprovalRecord> | undefined;
  var __lineRevisionSessionMemoryStore: Map<string, RevisionSession> | undefined;
  var __lineConversationMemoryStore: Map<string, ConversationMessage[]> | undefined;
  var __lineClientMemoryStore: Map<string, ClientProfile> | undefined;
  var __lineAuditMemoryStore: Map<string, AuditRecord[]> | undefined;
  var __lineConsultationMemoryStore: Map<string, ConsultationRecord> | undefined;
  var __lineConsultationSessionMemoryStore:
    | Map<string, ConsultationReplySession>
    | undefined;
}

const memoryStore = globalThis.__lineApprovalMemoryStore ?? new Map<string, ApprovalRecord>();
globalThis.__lineApprovalMemoryStore = memoryStore;
const revisionSessionMemoryStore =
  globalThis.__lineRevisionSessionMemoryStore ?? new Map<string, RevisionSession>();
globalThis.__lineRevisionSessionMemoryStore = revisionSessionMemoryStore;
const conversationMemoryStore =
  globalThis.__lineConversationMemoryStore ?? new Map<string, ConversationMessage[]>();
globalThis.__lineConversationMemoryStore = conversationMemoryStore;
const clientMemoryStore =
  globalThis.__lineClientMemoryStore ?? new Map<string, ClientProfile>();
globalThis.__lineClientMemoryStore = clientMemoryStore;
const auditMemoryStore =
  globalThis.__lineAuditMemoryStore ?? new Map<string, AuditRecord[]>();
globalThis.__lineAuditMemoryStore = auditMemoryStore;
const consultationMemoryStore =
  globalThis.__lineConsultationMemoryStore ?? new Map<string, ConsultationRecord>();
globalThis.__lineConsultationMemoryStore = consultationMemoryStore;
const consultationSessionMemoryStore =
  globalThis.__lineConsultationSessionMemoryStore ??
  new Map<string, ConsultationReplySession>();
globalThis.__lineConsultationSessionMemoryStore = consultationSessionMemoryStore;

function conversationKey(lineUserId: string): string {
  const userHash = createHash("sha256").update(lineUserId).digest("hex").slice(0, 32);
  return `${CONVERSATION_KEY_PREFIX}${userHash}`;
}

function clientKey(lineUserId: string): string {
  const userHash = createHash("sha256").update(lineUserId).digest("hex").slice(0, 32);
  return `${CLIENT_KEY_PREFIX}${userHash}`;
}

function reviewerHash(reviewerUserId: string | undefined): string | undefined {
  return reviewerUserId
    ? createHash("sha256").update(reviewerUserId).digest("hex").slice(0, 16)
    : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function conversationMaxMessages(): number {
  return positiveInteger(
    process.env.CONVERSATION_HISTORY_MAX_MESSAGES,
    DEFAULT_CONVERSATION_MAX_MESSAGES,
    50,
  );
}

function conversationTtlSeconds(): number {
  return positiveInteger(
    process.env.CONVERSATION_HISTORY_TTL_SECONDS,
    DEFAULT_CONVERSATION_TTL_SECONDS,
    60 * 60 * 24 * 90,
  );
}

function revisionSessionKey(channelId: string, reviewerUserId: string): string {
  return `${REVISION_SESSION_KEY_PREFIX}${channelId}:${reviewerUserId}`;
}

function consultationSessionKey(channelId: string, reviewerUserId: string): string {
  return `${CONSULTATION_SESSION_KEY_PREFIX}${channelId}:${reviewerUserId}`;
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

export async function getConversationHistory(lineUserId: string): Promise<ConversationMessage[]> {
  const key = conversationKey(lineUserId);
  if (!getRedisConfig()) {
    return (conversationMemoryStore.get(key) ?? []).slice(-conversationMaxMessages());
  }

  const values = await redisCommand<string[]>(["LRANGE", key, "0", "-1"]);
  return values.flatMap((value) => {
    try {
      const message = JSON.parse(value) as Partial<ConversationMessage>;
      return (message.role === "customer" || message.role === "assistant") &&
        typeof message.text === "string" &&
        typeof message.createdAt === "string"
        ? [message as ConversationMessage]
        : [];
    } catch {
      return [];
    }
  });
}

export async function appendConversationMessage(
  lineUserId: string,
  message: ConversationMessage,
): Promise<void> {
  const key = conversationKey(lineUserId);
  const maxMessages = conversationMaxMessages();
  if (!getRedisConfig()) {
    const messages = [...(conversationMemoryStore.get(key) ?? []), message].slice(-maxMessages);
    conversationMemoryStore.set(key, messages);
    return;
  }

  const script = [
    "redis.call('RPUSH', KEYS[1], ARGV[1])",
    "redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)",
    "redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))",
    "return 1",
  ].join("\n");
  await redisCommand<number>([
    "EVAL",
    script,
    "1",
    key,
    JSON.stringify(message),
    String(maxMessages),
    String(conversationTtlSeconds()),
  ]);
}

export async function getClientProfile(lineUserId: string): Promise<ClientProfile | null> {
  const key = clientKey(lineUserId);
  if (!getRedisConfig()) return clientMemoryStore.get(key) ?? null;
  const value = await redisCommand<string | null>(["GET", key]);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ClientProfile;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function appendAuditRecord(
  record: AuditRecord & { reviewerUserId?: string },
): Promise<void> {
  const key = `${AUDIT_KEY_PREFIX}${record.approvalId}`;
  const { reviewerUserId, ...safeRecord } = record;
  const stored: AuditRecord = {
    ...safeRecord,
    reviewerUserIdHash: reviewerHash(reviewerUserId),
  };
  if (!getRedisConfig()) {
    const records = [...(auditMemoryStore.get(key) ?? []), stored].slice(-100);
    auditMemoryStore.set(key, records);
    return;
  }
  const script = [
    "redis.call('RPUSH', KEYS[1], ARGV[1])",
    "redis.call('LTRIM', KEYS[1], -100, -1)",
    "redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))",
    "return 1",
  ].join("\n");
  await redisCommand<number>([
    "EVAL",
    script,
    "1",
    key,
    JSON.stringify(stored),
    String(AUDIT_TTL_SECONDS),
  ]);
}

export async function getAuditRecords(approvalId: string): Promise<AuditRecord[]> {
  const key = `${AUDIT_KEY_PREFIX}${approvalId}`;
  if (!getRedisConfig()) return auditMemoryStore.get(key) ?? [];
  const values = await redisCommand<string[]>(["LRANGE", key, "0", "-1"]);
  return values.flatMap((value) => {
    try {
      return [JSON.parse(value) as AuditRecord];
    } catch {
      return [];
    }
  });
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
  draft: ReplyDraft,
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
    "item.answerLevel = draft.answerLevel",
    "item.confidence = draft.confidence",
    "item.inferredIntent = draft.inferredIntent",
    "item.assumptions = draft.assumptions",
    "item.draftReply = draft.draftReply",
    "item.checkItems = draft.checkItems",
    "item.sources = draft.sources",
    "item.sourceVerification = draft.sourceVerification",
    "item.requiresTaxProfessionalReview = draft.requiresTaxProfessionalReview",
    "item.handoffSummary = draft.handoffSummary",
    "item.clientContextFieldsUsed = draft.clientContextFieldsUsed",
    "item.model = draft.model",
    "item.promptVersion = draft.promptVersion",
    "item.generatedAt = draft.generatedAt",
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

export async function createConsultation(record: ConsultationRecord): Promise<boolean> {
  if (!getRedisConfig()) {
    if (consultationMemoryStore.has(record.id)) return false;
    consultationMemoryStore.set(record.id, record);
    return true;
  }
  const result = await redisCommand<string | null>([
    "SET",
    `${CONSULTATION_KEY_PREFIX}${record.id}`,
    JSON.stringify(record),
    "EX",
    String(Number(process.env.APPROVAL_TTL_SECONDS) || DEFAULT_TTL_SECONDS),
    "NX",
  ]);
  return result === "OK";
}

export async function getConsultation(id: string): Promise<ConsultationRecord | null> {
  if (!getRedisConfig()) return consultationMemoryStore.get(id) ?? null;
  const value = await redisCommand<string | null>([
    "GET",
    `${CONSULTATION_KEY_PREFIX}${id}`,
  ]);
  return value ? (JSON.parse(value) as ConsultationRecord) : null;
}

export async function deleteConsultation(id: string): Promise<boolean> {
  if (!getRedisConfig()) return consultationMemoryStore.delete(id);
  return (
    (await redisCommand<number>(["DEL", `${CONSULTATION_KEY_PREFIX}${id}`])) === 1
  );
}

export async function transitionConsultation(
  id: string,
  expectedStatus: ConsultationStatus,
  nextStatus: ConsultationStatus,
  reviewerUserId: string,
  replyText?: string,
): Promise<ConsultationRecord | null> {
  const updatedAt = new Date().toISOString();
  if (!getRedisConfig()) {
    const current = consultationMemoryStore.get(id);
    if (!current || current.status !== expectedStatus) return null;
    const updated: ConsultationRecord = {
      ...current,
      status: nextStatus,
      reviewerUserId,
      updatedAt,
      ...(replyText === undefined ? {} : { replyText }),
    };
    consultationMemoryStore.set(id, updated);
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
    "if ARGV[5] ~= '' then item.replyText = ARGV[5] end",
    "local encoded = cjson.encode(item)",
    "redis.call('SET', KEYS[1], encoded, 'KEEPTTL')",
    "return encoded",
  ].join("\n");
  const value = await redisCommand<string | null>([
    "EVAL",
    script,
    "1",
    `${CONSULTATION_KEY_PREFIX}${id}`,
    expectedStatus,
    nextStatus,
    reviewerUserId,
    updatedAt,
    replyText ?? "",
  ]);
  return value ? (JSON.parse(value) as ConsultationRecord) : null;
}

export async function createConsultationReplySession(
  session: ConsultationReplySession,
): Promise<boolean> {
  const key = consultationSessionKey(session.channelId, session.reviewerUserId);
  if (!getRedisConfig()) {
    if (consultationSessionMemoryStore.has(key)) return false;
    consultationSessionMemoryStore.set(key, session);
    return true;
  }
  const result = await redisCommand<string | null>([
    "SET",
    key,
    JSON.stringify(session),
    "EX",
    String(CONSULTATION_SESSION_TTL_SECONDS),
    "NX",
  ]);
  return result === "OK";
}

export async function getConsultationReplySession(
  channelId: string,
  reviewerUserId: string,
): Promise<ConsultationReplySession | null> {
  const key = consultationSessionKey(channelId, reviewerUserId);
  if (!getRedisConfig()) return consultationSessionMemoryStore.get(key) ?? null;
  const value = await redisCommand<string | null>(["GET", key]);
  return value ? (JSON.parse(value) as ConsultationReplySession) : null;
}

export async function updateConsultationReplySession(
  session: ConsultationReplySession,
): Promise<void> {
  const key = consultationSessionKey(session.channelId, session.reviewerUserId);
  if (!getRedisConfig()) {
    consultationSessionMemoryStore.set(key, session);
    return;
  }
  await redisCommand<string>([
    "SET",
    key,
    JSON.stringify(session),
    "EX",
    String(CONSULTATION_SESSION_TTL_SECONDS),
  ]);
}

export async function deleteConsultationReplySession(
  channelId: string,
  reviewerUserId: string,
  consultationId: string,
): Promise<boolean> {
  const key = consultationSessionKey(channelId, reviewerUserId);
  if (!getRedisConfig()) {
    const current = consultationSessionMemoryStore.get(key);
    if (!current || current.consultationId !== consultationId) return false;
    return consultationSessionMemoryStore.delete(key);
  }
  const script = [
    "local raw = redis.call('GET', KEYS[1])",
    "if not raw then return 0 end",
    "local item = cjson.decode(raw)",
    "if item.consultationId ~= ARGV[1] then return 0 end",
    "return redis.call('DEL', KEYS[1])",
  ].join("\n");
  return (
    (await redisCommand<number>([
      "EVAL",
      script,
      "1",
      key,
      consultationId,
    ])) === 1
  );
}
