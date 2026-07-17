import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLineSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret = process.env.LINE_CHANNEL_SECRET,
): boolean {
  if (!signatureHeader || !channelSecret) {
    return false;
  }

  const expected = createHmac("sha256", Buffer.from(channelSecret, "utf8"))
    .update(Buffer.from(rawBody, "utf8"))
    .digest("base64");
  const actualBuffer = Buffer.from(signatureHeader, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
