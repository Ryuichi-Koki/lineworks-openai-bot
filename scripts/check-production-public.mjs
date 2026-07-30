const baseUrl = new URL(
  process.env.PRODUCTION_BASE_URL?.trim() || "https://bot.abtax.jp",
);

const checks = [
  ["/legal", "規約"],
  ["/terms", "利用規約"],
  ["/privacy", "プライバシー"],
  ["/tokusho", "特定商取引"],
  ["/cancellation", "解約"],
  ["/billing/cancel?purchase=tax_review", "税理士相談"],
];

let failed = false;

for (const [pathname, expectedText] of checks) {
  const url = new URL(pathname, baseUrl);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "ApexBrain-Production-Healthcheck/1.0" },
    });
    const body = await response.text();
    const securityHeadersPresent =
      response.headers.get("content-security-policy")?.includes("frame-ancestors 'none'") &&
      response.headers.get("x-content-type-options") === "nosniff" &&
      response.headers.get("referrer-policy") === "strict-origin-when-cross-origin";
    const ok = response.ok && body.includes(expectedText) && securityHeadersPresent;
    console.log(`${ok ? "OK" : "NG"} ${response.status} ${url.pathname}`);
    if (!ok) failed = true;
  } catch (error) {
    failed = true;
    console.error(`NG ${url.pathname}: ${error instanceof Error ? error.message : error}`);
  }
}

if (failed) process.exitCode = 1;
