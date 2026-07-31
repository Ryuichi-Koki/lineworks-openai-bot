/**
 * 承認・回答送信を行える職員を限定する。
 *
 * 未設定のときは許可しない（フェイルクローズ）。
 * 以前は未設定を「全員許可」として扱っていたため、環境変数の設定漏れや
 * 削除で、Botのボタンを押せる任意のメンバーが顧問先への送信を実行できた。
 * 権限の境界を環境変数の存在有無に依存させない。
 *
 * 本番ビルドでは scripts/check-production-config.mjs が設定を検査するため、
 * 設定漏れはデプロイ前に検出される。
 */
export function parseApproverUserIds(
  configured = process.env.LINEWORKS_APPROVER_USER_IDS,
): string[] {
  return (configured ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isAuthorizedApprover(
  userId: string,
  configured = process.env.LINEWORKS_APPROVER_USER_IDS,
): boolean {
  const approvers = parseApproverUserIds(configured);
  if (approvers.length === 0) return false;
  return approvers.includes(userId);
}
