import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchLineMembership } from "@/lib/membership/lineMembership";
import {
  cancelErroneousUsage,
  endMembership,
  getAdminUsageHistory,
  getPlanCounts,
  listAdminUsers,
  recordAdminAction,
  syncMembership,
} from "@/lib/membership/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticate(request: Request): string | null {
  const expectedUser = process.env.ADMIN_DASHBOARD_USER;
  const expectedPassword = process.env.ADMIN_DASHBOARD_PASSWORD;
  if (!expectedUser || !expectedPassword) return null;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return null;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return secureEqual(user, expectedUser) && secureEqual(password, expectedPassword)
    ? user
    : null;
}

function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Membership Admin", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function maskUserId(value: string): string {
  return value.length <= 10
    ? `${value.slice(0, 2)}***`
    : `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function csrfToken(operator: string): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is required");
  const day = new Date().toISOString().slice(0, 10);
  return createHmac("sha256", secret).update(`${operator}:${day}`).digest("hex");
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return new URL(request.url).origin === origin;
}

export async function GET(request: Request): Promise<Response> {
  const operator = authenticate(request);
  if (!operator) return unauthorized();
  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";
  const selected = url.searchParams.get("user")?.trim() ?? "";
  const [users, history, planCounts] = await Promise.all([
    listAdminUsers(search),
    selected ? getAdminUsageHistory(selected) : Promise.resolve([]),
    getPlanCounts(),
  ]);
  const csrf = csrfToken(operator);
  const rows = users
    .map(
      (user) => `<tr>
        <td>${escapeHtml(user.displayName ?? "未取得")}</td>
        <td title="${escapeHtml(user.lineUserId)}">${escapeHtml(maskUserId(user.lineUserId))}</td>
        <td>${escapeHtml(user.planCode)}</td>
        <td>${escapeHtml(user.membershipStatus)}</td>
        <td>${escapeHtml(user.periodStart)} ～ ${escapeHtml(user.periodEnd)}</td>
        <td>${user.aiUsed} / 残${user.aiRemaining}</td>
        <td>${user.taxReviewUsed} / 残${user.taxReviewRemaining}</td>
        <td>${escapeHtml(user.lastUsedAt ?? "-")}</td>
        <td>${escapeHtml(user.membershipProvider)}</td>
        <td>${user.paymentFailed ? "要確認" : "-"}</td>
        <td>
          <a href="?user=${encodeURIComponent(user.lineUserId)}">履歴</a>
          <form method="post">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="resync">
            <input type="hidden" name="lineUserId" value="${escapeHtml(user.lineUserId)}">
            <button type="submit">再同期</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");
  const historyRows = history
    .map(
      (event) => `<tr>
        <td>${escapeHtml(event.createdAt)}</td><td>${escapeHtml(event.usageType)}</td>
        <td>${escapeHtml(event.status)}</td><td>${escapeHtml(event.periodStart)} ～ ${escapeHtml(event.periodEnd)}</td>
        <td>${event.status === "consumed" ? `<form method="post">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="action" value="cancel_usage">
          <input type="hidden" name="usageEventId" value="${escapeHtml(event.id)}">
          <input name="reason" required maxlength="500" placeholder="取消理由">
          <button type="submit">誤カウント取消</button>
        </form>` : ""}</td>
      </tr>`,
    )
    .join("");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>会員・利用状況</title>
    <style>body{font-family:system-ui;margin:24px;color:#172033}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #d8dee8;padding:8px;text-align:left;vertical-align:top}th{background:#f3f6fa}form{display:inline}input,button{padding:6px;margin:2px}.wrap{overflow:auto}.notice{background:#fff7d6;padding:10px;margin:12px 0}</style>
    </head><body><h1>会員・利用状況</h1>
    <div class="notice">管理者専用です。LINE userIdは通常マスク表示し、操作は監査ログへ記録します。</div>
    <p>${planCounts.map((item) => `${escapeHtml(item.planCode)}：${item.count}名`).join(" ／ ")}</p>
    <form method="get"><input name="q" value="${escapeHtml(search)}" placeholder="表示名またはLINE userId"><button>検索</button></form>
    <div class="wrap"><table><thead><tr><th>表示名</th><th>LINE userId</th><th>プラン</th><th>状態</th><th>契約期間</th><th>AI</th><th>税理士相談</th><th>最終利用</th><th>課金</th><th>決済失敗</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${selected ? `<h2>利用履歴：${escapeHtml(maskUserId(selected))}</h2><div class="wrap"><table><thead><tr><th>日時</th><th>種類</th><th>状態</th><th>期間</th><th>操作</th></tr></thead><tbody>${historyRows}</tbody></table></div>` : ""}
    </body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const operator = authenticate(request);
  if (!operator) return unauthorized();
  if (!validOrigin(request)) return new Response("Invalid origin", { status: 403 });
  const form = await request.formData();
  const submittedCsrf = String(form.get("csrf") ?? "");
  if (!secureEqual(submittedCsrf, csrfToken(operator))) {
    return new Response("Invalid CSRF token", { status: 403 });
  }
  const action = String(form.get("action") ?? "");
  if (action === "cancel_usage") {
    const usageEventId = String(form.get("usageEventId") ?? "");
    const reason = String(form.get("reason") ?? "").trim();
    if (!usageEventId || !reason) return new Response("Missing fields", { status: 400 });
    await cancelErroneousUsage({ usageEventId, operatorId: operator, reason });
  } else if (action === "resync") {
    const lineUserId = String(form.get("lineUserId") ?? "");
    if (!lineUserId) return new Response("Missing LINE userId", { status: 400 });
    const membership = await fetchLineMembership(lineUserId);
    if (membership) await syncMembership(membership);
    else await endMembership(lineUserId);
    await recordAdminAction({
      operatorId: operator,
      action: "resync_membership",
      targetType: "user",
      targetId: maskUserId(lineUserId),
      reason: "管理画面からLINEメンバーシップを再同期",
      afterValue: membership
        ? {
            planCode: membership.planCode,
            status: membership.status,
            periodStart: membership.periodStart,
            periodEnd: membership.periodEnd,
          }
        : { planCode: "free", status: "free" },
    });
  } else {
    return new Response("Unknown action", { status: 400 });
  }
  return Response.redirect(new URL("/admin/members", request.url), 303);
}
