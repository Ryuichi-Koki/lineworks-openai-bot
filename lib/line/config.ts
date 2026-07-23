const OFFICIAL_LINE_API_BASE_URL = "https://api.line.me/v2/bot";

export function lineApiBaseUrl(): string {
  const override = process.env.LINE_API_BASE_URL?.trim();
  if (!override) return OFFICIAL_LINE_API_BASE_URL;

  const url = new URL(override);
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (process.env.NODE_ENV === "production" || !localHost) {
    throw new Error("LINE_API_BASE_URL override is allowed only for local tests");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("LINE_API_BASE_URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LINE_API_BASE_URL must not contain credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}
