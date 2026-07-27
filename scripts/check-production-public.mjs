const baseUrl = new URL(
  process.env.PRODUCTION_BASE_URL?.trim() || "https://bot.abtax.jp",
);

const checks = [
  ["/legal", "規約"],
  ["/terms", "利用規約"],
  ["/privacy", "プライバシー"],
  ["/tokusho", "特定商取引"],
  ["/cancellation", "解約"],
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
    const ok = response.ok && body.includes(expectedText);
    console.log(`${ok ? "OK" : "NG"} ${response.status} ${url.pathname}`);
    if (!ok) failed = true;
  } catch (error) {
    failed = true;
    console.error(`NG ${url.pathname}: ${error instanceof Error ? error.message : error}`);
  }
}

if (failed) process.exitCode = 1;
