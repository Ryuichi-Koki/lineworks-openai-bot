const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(?:氏名|名前|お名前)\s*[:：]\s*[^\n、,]{1,40}/g, "[氏名をマスク]"],
  [/(?:住所|所在地)\s*[:：]\s*[^\n]{1,100}/g, "[住所をマスク]"],
  [/\b\d{12}\b/g, "[マイナンバー等をマスク]"],
  [/\b(?:\d[ -]?){16}\b/g, "[カード番号等をマスク]"],
  [/(?:口座番号|口座)\s*[:：]?\s*\d{5,12}\b/gi, "[口座番号をマスク]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[メールアドレスをマスク]"],
  [/\b0\d{1,4}[-(]?\d{1,4}[-)]?\d{3,4}\b/g, "[電話番号をマスク]"],
  [/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[APIキーをマスク]"],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[秘密鍵をマスク]"],
];

const HEALTH_PATTERNS = [
  /(病名|診断名|既往歴|障害名|健康状態)\s*[:：]\s*[^\n]{1,80}/g,
  /(服薬|投薬|処方薬)\s*[:：]\s*[^\n]{1,80}/g,
];

export function redactSensitiveText(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  for (const pattern of HEALTH_PATTERNS) {
    result = result.replace(pattern, "[健康情報をマスク]");
  }
  return result;
}

export function maskLineOutput(value: string): string {
  return redactSensitiveText(value).replace(
    /(password|token|secret|private[_ -]?key)\s*[:=]\s*\S+/gi,
    "$1=[機密情報をマスク]",
  );
}
