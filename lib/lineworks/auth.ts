import { createSign } from "node:crypto";

const TOKEN_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const JWT_TTL_SECONDS = 60 * 60;

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: CachedToken | null = null;

function requireEnv(name: string): string {
  const value = process.env[name] || process.env[`\uFEFF${name}`];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function normalizePrivateKey(privateKey: string): string {
  let normalized = privateKey.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\\n/g, "\n").replace(/\r/g, "");
}

function createServiceAccountJwt(): string {
  const clientId = requireEnv("LINEWORKS_CLIENT_ID");
  const serviceAccount = requireEnv("LINEWORKS_SERVICE_ACCOUNT");
  const privateKey = normalizePrivateKey(requireEnv("LINEWORKS_PRIVATE_KEY"));
  const now = Math.floor(Date.now() / 1000);

  const header = {
    typ: "JWT",
    alg: "RS256",
  };

  const claims = {
    iss: clientId,
    sub: serviceAccount,
    iat: now,
    exp: now + JWT_TTL_SECONDS,
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(claims),
  )}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function getLineWorksAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    assertion: createServiceAccountJwt(),
    grant_type: GRANT_TYPE,
    client_id: requireEnv("LINEWORKS_CLIENT_ID"),
    client_secret: requireEnv("LINEWORKS_CLIENT_SECRET"),
    scope: "bot.message",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`LINE WORKS token request failed with status ${response.status}`);
  }

  const tokenResponse: unknown = await response.json();
  if (
    !tokenResponse ||
    typeof tokenResponse !== "object" ||
    typeof (tokenResponse as { access_token?: unknown }).access_token !== "string"
  ) {
    throw new Error("LINE WORKS token response did not include an access token");
  }

  const expiresIn =
    typeof (tokenResponse as { expires_in?: unknown }).expires_in === "number"
      ? (tokenResponse as { expires_in: number }).expires_in
      : Number((tokenResponse as { expires_in?: unknown }).expires_in ?? 3600);

  cachedToken = {
    accessToken: (tokenResponse as { access_token: string }).access_token,
    expiresAt: Date.now() + Math.max(1, expiresIn) * 1000,
  };

  return cachedToken.accessToken;
}
