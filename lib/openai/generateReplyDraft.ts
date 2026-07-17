export const inquiryCategories = [
  "税務",
  "会計",
  "給与・社会保険",
  "資料依頼",
  "日程調整",
  "その他",
] as const;

export const urgencyLevels = ["通常", "要確認", "至急"] as const;

export type ReplyDraft = {
  category: (typeof inquiryCategories)[number];
  urgency: (typeof urgencyLevels)[number];
  draftReply: string;
  checkItems: string[];
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function requireEnv(name: string): string {
  const value = process.env[name] || process.env[`\uFEFF${name}`];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getTodayInJapan(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function collectOutputText(responseBody: unknown): string {
  if (
    responseBody &&
    typeof responseBody === "object" &&
    typeof (responseBody as { output_text?: unknown }).output_text === "string"
  ) {
    return (responseBody as { output_text: string }).output_text;
  }

  const output = (responseBody as { output?: unknown })?.output;
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .flatMap((item) => {
      const content = (item as { content?: unknown })?.content;
      return Array.isArray(content) ? content : [];
    })
    .map((contentItem) => {
      if (
        contentItem &&
        typeof contentItem === "object" &&
        typeof (contentItem as { text?: unknown }).text === "string"
      ) {
        return (contentItem as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function parseDraftJson(text: string): ReplyDraft {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("OpenAI response was not an object");
  }

  const value = parsed as Record<string, unknown>;
  if (
    !inquiryCategories.includes(value.category as ReplyDraft["category"]) ||
    !urgencyLevels.includes(value.urgency as ReplyDraft["urgency"]) ||
    typeof value.draftReply !== "string" ||
    !Array.isArray(value.checkItems)
  ) {
    throw new Error("OpenAI response did not match the expected draft schema");
  }

  return {
    category: value.category as ReplyDraft["category"],
    urgency: value.urgency as ReplyDraft["urgency"],
    draftReply: value.draftReply,
    checkItems: value.checkItems.filter((item): item is string => typeof item === "string"),
  };
}

async function requestReplyDraft(inputText: string): Promise<ReplyDraft> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const today = getTodayInJapan();

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: [
        "あなたは日本の税理士・国税OB相当の専門知識を用いて、日本の税理士法人で顧客対応を支援するアシスタントです。",
        "目的は自動回答ではなく、担当税理士が確認してから送る返信案を作ることです。",
        `本日は ${today} です。`,
        "質問を指定された分類から1つ選び、緊急度を判定してください。",
        "返信案は丁寧で簡潔な自然な日本語にしてください。",
        "法人税、消費税、地方税その他の税目を判断するときは、以下の税務回答ルールを必ず適用してください。",
        "【根拠】参照した法令の正式名称と条番号、通達・質疑応答事例の正式名称と番号、裁決・裁判例の年月日、国税庁Web-TAX-TV・タックスアンサー等の正式名称と番号を列挙してください。二次情報だけを根拠にしてはいけません。検討の優先順位は、条文、通達、判例、個別通達、国税庁Web・タックスアンサー、その他の順です。",
        "【一般論を先に回答】顧客の質問に対しては、個別事情が不足していても、まず適用される一般的な制度、原則、規程、要件および判断の考え方を、一次資料の根拠とともに分かりやすく説明してください。一般論だけで回答できる質問には、不要な追加質問をしないでください。",
        "【短い質問への答え方】『社宅家賃の負担割合は？』のように一般的な基準を尋ねる短い質問には、質問返しから始めてはいけません。第1文で『一律に実際家賃の何％と決まるものではない』などの核心を答え、次に区分ごとの原則を比較表または簡潔な箇条書きで示し、最後に実務上よくある取扱いと誤解しやすい点を説明してください。",
        "【社宅家賃の回答例】社宅家賃の一般論を尋ねられた場合は、少なくとも、従業員は税法上の賃貸料相当額の50％以上、役員の小規模住宅は賃貸料相当額の全額以上、役員の小規模住宅以外の借上社宅は所定の算式による賃貸料相当額（一般に会社支払家賃の50％相当額との比較を含む）、豪華社宅は通常支払うべき市場家賃相当額、という区分を説明してください。『会社50％・本人50％』がすべての社宅に共通する基準ではないこと、および従業員社宅では実際家賃の50％ではなく税法上の賃貸料相当額の50％が基準であることを明示してください。個別の本人負担額の計算を求められた場合に限り、固定資産税課税標準額、床面積、会社支払家賃、入居者が役員か従業員か等を確認してください。",
        "【事実認定】取引形態、当事者、金額、対象期間、適用条文の要件該当性などが不足し、個別案件の確定的な結論を出せない場合でも、回答全体を質問だけにしないでください。まず『①一般的な取扱い』として説明できる範囲を示し、その後に『②個別判断に必要な確認事項』を必要最小限で列挙してください。個別結論は確定せず、同じ確認事項を担当者向けのcheckItemsにも列挙してください。",
        "【計算】税額や調整額を示す場合は、数式、計算プロセス、使用税率、控除額および途中結果をステップごとに示してください。",
        "【適用漏れ・添付漏れ】関連し得る租税特別措置（所得拡大促進税制、研究開発税制、沖縄振興特別措置法の特例等を含む）を検討し、適用要件と必要な申告書別表・明細書を漏れなく列挙してください。該当可能性がない制度を機械的に列挙せず、事実関係から関連し得る制度を網羅してください。",
        "【構成】事実が足りている場合、draftReplyは『①概要』『②詳細解説』『③参考条文・資料一覧』の順にしてください。不確実な点は『留意点』として明示し、追加調査を勧めてください。事実が足りない場合は『①一般的な取扱い』『②個別判断に必要な確認事項』『③参考条文・資料一覧』の順にし、一般論を先に回答してください。",
        "【法改正】回答作成日までに成立・施行済みの改正を反映してください。未施行の成立法は施行日を明示し、改正案・未成立法案は『見込み』として現行制度と明確に区別してください。",
        "このAPI呼出しでは外部の法令データベースを検索できません。最新性または根拠資料の正式名称・条番号・年月日に確証がない場合も、確実に説明できる一般的な原則まで回答せずに質問だけを返してはいけません。一般原則を先に説明したうえで、未検証の個別結論は確定せず、『要一次資料確認』と明記し、その確認対象をcheckItemsに具体的に列挙してください。条番号等を記憶で補ったり推測したりしてはいけません。",
        "存在しない法令、通達、判例、裁決、国税庁資料、条番号、文書番号、年月日を作らないでください。税法、税率、期限、個別判断について確証がなければ断定しないでください。",
        "機密情報やマイナンバーをLINEで送るよう促さないでください。",
        "出力は指定されたJSONスキーマだけに従ってください。",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: inputText,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "tax_customer_reply_draft",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["category", "urgency", "draftReply", "checkItems"],
            properties: {
              category: { type: "string", enum: inquiryCategories },
              urgency: { type: "string", enum: urgencyLevels },
              draftReply: { type: "string" },
              checkItems: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
      max_output_tokens: 4000,
      store: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI response generation failed with status ${response.status}`);
  }

  const responseBody: unknown = await response.json();
  const outputText = collectOutputText(responseBody);
  if (!outputText) {
    throw new Error("OpenAI response did not include output text");
  }

  return parseDraftJson(outputText);
}

export async function generateReplyDraft(customerMessage: string): Promise<ReplyDraft> {
  return requestReplyDraft(
    `次の顧客メッセージを分類し、返信案と担当者の確認事項を作成してください。\n\n顧客メッセージ:\n${customerMessage}`,
  );
}

export async function reviseReplyDraft(
  customerMessage: string,
  currentDraft: ReplyDraft,
  revisionInstruction: string,
): Promise<ReplyDraft> {
  return requestReplyDraft(
    [
      "次の返信案を、担当税理士の修正指示に従って作り直してください。",
      "修正指示に従う場合も、税務上の断定回避、機密情報の保護、確認事項の列挙などの安全要件を維持してください。",
      "分類と緊急度も必要に応じて見直してください。",
      "",
      "顧客メッセージ:",
      customerMessage,
      "",
      "現在の返信案:",
      currentDraft.draftReply,
      "",
      "現在の確認事項:",
      currentDraft.checkItems.length > 0 ? currentDraft.checkItems.join("\n") : "特になし",
      "",
      "担当税理士の修正指示:",
      revisionInstruction,
    ].join("\n"),
  );
}
