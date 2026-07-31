import { createHash } from "node:crypto";

/**
 * LINEの再送キーを、同じ業務レコード内の用途ごとに分離する。
 *
 * 元のキーから決定的に生成するため、同じ送信処理の再試行は重複せず、
 * 受付通知と税理士回答のような別メッセージはLINE APIに重複扱いされない。
 */
export function deriveLineRetryKey(
  baseRetryKey: string,
  purpose: string,
): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`line-retry-key:${purpose}:${baseRetryKey}`)
      .digest()
      .subarray(0, 16),
  );

  // RFC 4122のversion 4 / variant 1形式に整える。
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
