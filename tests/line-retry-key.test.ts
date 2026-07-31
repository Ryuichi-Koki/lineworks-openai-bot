import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { deriveLineRetryKey } from "../lib/line/retryKey.ts";

test("受付通知と税理士回答は異なるLINE再送キーを使う", () => {
  const receiptRetryKey = randomUUID();
  const replyRetryKey = deriveLineRetryKey(
    receiptRetryKey,
    "tax-professional-reply",
  );

  assert.notEqual(replyRetryKey, receiptRetryKey);
  assert.match(
    replyRetryKey,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test("同じ回答の再試行では同じLINE再送キーになる", () => {
  const baseRetryKey = randomUUID();

  assert.equal(
    deriveLineRetryKey(baseRetryKey, "tax-professional-reply"),
    deriveLineRetryKey(baseRetryKey, "tax-professional-reply"),
  );
});

test("用途または元キーが違えばLINE再送キーも変わる", () => {
  const baseRetryKey = randomUUID();

  assert.notEqual(
    deriveLineRetryKey(baseRetryKey, "tax-professional-reply"),
    deriveLineRetryKey(baseRetryKey, "receipt"),
  );
  assert.notEqual(
    deriveLineRetryKey(baseRetryKey, "tax-professional-reply"),
    deriveLineRetryKey(randomUUID(), "tax-professional-reply"),
  );
});
