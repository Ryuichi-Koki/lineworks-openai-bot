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

export async function generateReplyDraft(customerMessage: string): Promise<ReplyDraft> {
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
        "あなたは日本の税理士法人で顧客対応を支援するアシスタントです。",
        "目的は自動回答ではなく、担当税理士が確認してから送る返信案を作ることです。",
        `本日は ${today} です。`,
        "質問を指定された分類から1つ選び、緊急度を判定してください。",
        "返信案は丁寧で簡潔な自然な日本語にしてください。",
        "税法、税率、期限、個別判断について確証がなければ断定せず、確認が必要だと明記してください。",
        "存在しない法令、通達、判例、国税庁資料を作らないでください。",
        "顧客名、対象期間、取引形態、金額など不足情報は確認事項に列挙してください。",
        "機密情報やマイナンバーをLINEで送るよう促さないでください。",
        "出力は指定されたJSONスキーマだけに従ってください。",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `次の顧客メッセージを分類し、返信案と担当者の確認事項を作成してください。\n\n顧客メッセージ:\n${customerMessage}`,
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
      max_output_tokens: 1800,
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
