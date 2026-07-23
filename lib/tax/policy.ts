import type { ReplyDraft, TaxSource } from "../openai/generateReplyDraft.ts";

export const answerLevels = ["A", "B", "C"] as const;
export const confidenceLevels = ["高", "中", "低"] as const;
export const sourceVerificationLevels = ["verified", "partial", "unverified"] as const;

export const OFFICIAL_SOURCE_DOMAINS = [
  "laws.e-gov.go.jp",
  "elaws.e-gov.go.jp",
  "nta.go.jp",
  "www.nta.go.jp",
  "soumu.go.jp",
  "www.soumu.go.jp",
  "courts.go.jp",
  "www.courts.go.jp",
  "kfs.go.jp",
  "www.kfs.go.jp",
  "tax.metro.tokyo.lg.jp",
  "pref.okinawa.jp",
  "www.pref.okinawa.jp",
  "city.naha.okinawa.jp",
  "www.city.naha.okinawa.jp",
] as const;

export const NTA_TAX_LAW_SOURCE_ENTRYPOINTS = [
  {
    label: "法令解釈通達",
    url: "https://www.nta.go.jp/law/tsutatsu/menu.htm",
  },
  {
    label: "その他法令解釈に関する情報",
    url: "https://www.nta.go.jp/law/joho-zeikaishaku/sonota/sonota.htm",
  },
  {
    label: "事務運営指針",
    url: "https://www.nta.go.jp/law/jimu-unei/jimu.htm",
  },
  {
    label: "国税庁告示",
    url: "https://www.nta.go.jp/law/kokuji/kokuji.htm",
  },
  {
    label: "文書回答事例",
    url: "https://www.nta.go.jp/law/bunshokaito/01.htm",
  },
  {
    label: "質疑応答事例",
    url: "https://www.nta.go.jp/law/shitsugi/01.htm",
  },
] as const;

export const KFS_DECISION_SOURCE_ENTRYPOINTS = [
  {
    label: "国税不服審判所 公表裁決事例集",
    url: "https://www.kfs.go.jp/service/",
  },
] as const;

const EVASION_PATTERNS = [
  /申告しなくても.*(ばれ|バレ)/i,
  /(架空|偽造).*(領収書|請求書|経費)/i,
  /領収書を作って.*経費/i,
  /名義を変えれば.*(贈与税|税金).*(かから|逃れ)/i,
  /(税務署|国税).*(見つから|ばれ|バレ)ない方法/i,
  /(?:税金を払わなくていい.*(?:海外|法人)|(?:海外|法人).*税金を払わなくていい)/i,
  /(売上|所得).*(隠す|除外|抜く)/i,
];

const COMPLEX_REVIEW_PATTERNS = [
  /組織再編|合併|会社分割|株式交換|株式移転/,
  /移転価格|タックスヘイブン|CFC|外国子会社合算/,
  /事業承継税制|納税猶予/,
  /税務調査|更正の請求|不服申立|審査請求/,
  /事前確定届出給与|過大役員給与|役員.*(賞与|ボーナス)/,
  /簡易課税.*(選択|届出)|課税事業者選択届出/,
];

export function classifyLocalRisk(message: string): {
  forcedLevel: "C" | null;
  reason: string | null;
  suspectedEvasion: boolean;
} {
  if (EVASION_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      forcedLevel: "C",
      reason: "不正申告・課税逃れを支援するおそれがある相談",
      suspectedEvasion: true,
    };
  }
  if (COMPLEX_REVIEW_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      forcedLevel: "C",
      reason: "個別判断、期限または税額影響の確認が必要な相談",
      suspectedEvasion: false,
    };
  }
  return { forcedLevel: null, reason: null, suspectedEvasion: false };
}

export function isOfficialSourceUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return OFFICIAL_SOURCE_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || key.toLowerCase() === "browser") {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function verifySources(
  sources: TaxSource[],
  citedUrls: ReadonlySet<string>,
  retrievedAt: string,
): TaxSource[] {
  const normalizedCitations = new Set([...citedUrls].map(normalizeUrl).filter(Boolean));
  return sources
    .filter((source) => {
      const normalized = normalizeUrl(source.url);
      return Boolean(normalized) && isOfficialSourceUrl(normalized) && normalizedCitations.has(normalized);
    })
    .map((source) => ({ ...source, retrievedAt }));
}

export function isClarificationOnly(text: string): boolean {
  const stripped = text
    .replace(/【確認したいこと】[\s\S]*/g, "")
    .replace(/[?？\s・\d①-⑨、,。．]/g, "");
  const hasConclusion = /【(結論|一般的な原則|一般的な取扱い)】/.test(text);
  const substantive = stripped.length >= 30;
  return !hasConclusion && !substantive;
}

export function enforceDraftPolicy(
  draft: ReplyDraft,
  options: { suspectedEvasion?: boolean } = {},
): ReplyDraft {
  const checkItems = draft.checkItems.slice(0, 4);
  let confidence = draft.confidence;
  let sourceVerification = draft.sourceVerification;
  let requiresTaxProfessionalReview = draft.requiresTaxProfessionalReview;
  let draftReply = draft.draftReply.trim();

  if (draft.sources.length === 0) {
    confidence = "低";
    sourceVerification = "unverified";
    requiresTaxProfessionalReview = true;
    if (!draftReply.includes("公式資料を確認できていません")) {
      draftReply +=
        "\n\n【注意】\n現時点で、結論を直接示す公式資料を確認できていません。一般原則に基づく暫定的な回答です。担当税理士へ確認してください。";
    }
  }
  if (draft.answerLevel === "C" || confidence === "低") {
    requiresTaxProfessionalReview = true;
  }
  if (draft.answerLevel === "C" && !/税理士/.test(draftReply)) {
    draftReply +=
      "\n\n【注意】\n個別事情によって判断が変わるため、実行前に担当税理士へ確認してください。";
  }
  if (options.suspectedEvasion && !/適正(?:な)?申告|修正申告/.test(draftReply)) {
    draftReply +=
      "\n\n不正な処理や発見回避は行わず、適正な申告・納税を行ってください。過去の処理に誤りがある場合は、担当税理士へ修正申告等を相談してください。";
  }

  return {
    ...draft,
    confidence,
    sourceVerification,
    requiresTaxProfessionalReview,
    draftReply,
    checkItems,
  };
}
