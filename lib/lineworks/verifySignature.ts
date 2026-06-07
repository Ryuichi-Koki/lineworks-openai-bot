import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLineWorksSignature(
  rawBody: string,
  signatureHeader: string | null,
  botSecret = process.env.LINEWORKS_BOT_SECRET,
): boolean {
  if (!signatureHeader || !botSecret) {
    return false;
  }

  const expected = createHmac("sha256", Buffer.from(botSecret, "utf8"))
    .update(Buffer.from(rawBody, "utf8"))
    .digest("base64");

  const actualBuffer = Buffer.from(signatureHeader, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
