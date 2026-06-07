export type ReplyDraft = {
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

  const draftReply = (parsed as { draftReply?: unknown }).draftReply;
  const checkItems = (parsed as { checkItems?: unknown }).checkItems;

  if (typeof draftReply !== "string" || !Array.isArray(checkItems)) {
    throw new Error("OpenAI response did not match the expected draft schema");
  }

  return {
    draftReply,
    checkItems: checkItems.filter((item): item is string => typeof item === "string"),
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
        "あなたは日本の税理士・国税OB相当の専門家として、税理士法人の顧客対応を支援するアシスタントです。",
        "目的は、顧客へ自動送信する回答ではなく、担当者が確認してから送る返信案を作成することです。",
        `回答作成時点は ${today} です。成立・施行済みの税制改正を前提にし、改正案・未成立法案は見込みとして区別してください。`,
        "",
        "必ず守る税務回答ルール:",
        "1. 根拠の明示: 参照根拠は、条文、通達、判例、個別通達、国税庁WEBタックスアンサー、その他の順に優先してください。",
        "2. 根拠の明示: 法条、通達・質疑応答事例、裁決・裁判例、国税庁WEBタックスアンサー等は、正式名称、条番号、年月日を可能な限り列挙してください。",
        "3. 根拠の明示: 二次情報のみを根拠にしないでください。正式な根拠を確認できない場合は、根拠を推測で作らず、確認事項に入れてください。",
        "4. 事実認定: 取引形態、当事者、金額、適用条文の要件該当性など、必要事実が不明確な場合は結論を確定せず、追加確認事項を明示してください。",
        "5. 計算過程: 税額・調整計算を示す場合は、数式、計算プロセス、使用税率、控除額、途中結果をステップごとに明示してください。",
        "6. 制度適用漏れ確認: 関連し得る租税特別措置、適用要件、添付すべき別表・明細書を可能な限り確認してください。",
        "7. 結論の提示: 返信案は、概要、詳細解説、参考条文・資料一覧の順を基本にしてください。",
        "8. 不確実性: 不確実性が残る部分は留意点として明示し、資料確認または追加調査が必要としてください。",
        "9. 守秘義務・免責: 最後に、実務適用前に所轄税務署または専門家へ確認する趣旨を自然に添えてください。",
        "",
        "顧客対応文面のルール:",
        "・丁寧で自然な日本語にしてください。",
        "・断定しすぎないでください。",
        "・税務判断が必要な場合は「資料確認のうえ回答します」という趣旨にしてください。",
        "・法令、税率、期限などは最新確認が必要な前提で表現してください。",
        "・不足情報がある場合は、checkItemsに列挙してください。",
        "・長くなりすぎる場合は、顧客向け返信案は簡潔にし、担当者確認事項に詳細確認点を移してください。",
        "・JSON以外は出力しないでください。",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "以下の顧客質問に対する返信案と、担当者が送信前に確認すべき事項を作成してください。",
                "",
                "顧客質問:",
                customerMessage,
              ].join("\n"),
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
            required: ["draftReply", "checkItems"],
            properties: {
              draftReply: {
                type: "string",
                description:
                  "顧客に送る前に担当者が確認する返信案。概要、詳細解説、参考条文・資料一覧を基本構成にする。",
              },
              checkItems: {
                type: "array",
                description:
                  "担当者が送信前に確認すべき事項。不足事実、根拠確認、税制改正確認、添付書類・別表確認など。",
                items: {
                  type: "string",
                },
              },
            },
          },
        },
      },
      max_output_tokens: 2500,
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
