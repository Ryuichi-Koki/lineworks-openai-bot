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

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: [
        "あなたは税理士法人の顧客対応を支援するアシスタントです。",
        "返信案は丁寧で自然な日本語にしてください。",
        "断定しすぎず、税務判断が必要な場合は資料確認のうえ回答する前提にしてください。",
        "法令、税率、期限などは最新確認が必要な前提で表現してください。",
        "不足情報がある場合は確認事項として列挙してください。",
        "長すぎない文面にしてください。",
        "最終判断は担当者が行う前提です。",
        "JSON以外は出力しないでください。",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `以下の顧客質問に対する返信案と、担当者が確認すべき事項を作成してください。\n\n${customerMessage}`,
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
                description: "顧客にそのまま送れる自然な返信案",
              },
              checkItems: {
                type: "array",
                description: "担当者が送信前に確認すべき事項。不足情報がなければ空配列。",
                items: {
                  type: "string",
                },
              },
            },
          },
        },
      },
      max_output_tokens: 1200,
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
