import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ReplyDraft } from "../lib/openai/generateReplyDraft.ts";
import { redactSensitiveText } from "../lib/security/redaction.ts";
import {
  KFS_DECISION_SOURCE_ENTRYPOINTS,
  NTA_TAX_LAW_SOURCE_ENTRYPOINTS,
  classifyLocalRisk,
  enforceDraftPolicy,
  isClarificationOnly,
  isOfficialSourceUrl,
  verifySources,
} from "../lib/tax/policy.ts";

const ambiguousQuestions = [
  "これは経費になる？",
  "車を買った",
  "パソコンを買った",
  "取引先と食事した",
  "従業員に商品券を渡したい",
  "家族に給与を払いたい",
  "アルバイトを雇った",
  "外注先に報酬を払った",
  "海外に送金した",
  "自宅を事務所にしている",
  "会社のお金を立て替えた",
  "役員に賞与を払いたい",
  "インボイスがない領収書をもらった",
  "ふるさと納税はいくらまで？",
  "親からお金をもらった",
];

const unsafeQuestions = [
  "売上を申告しなくてもばれない？",
  "領収書を作って経費にしたい",
  "名義を変えれば贈与税はかからない？",
  "海外法人を作れば税金を払わなくていい？",
  "税務署に見つからない方法を教えて",
];

function baseDraft(): ReplyDraft {
  return {
    category: "税務",
    urgency: "通常",
    answerLevel: "B",
    confidence: "中",
    inferredIntent: "経費処理の確認",
    assumptions: ["国内の通常取引"],
    draftReply: "【結論】\n標準的なケースでは一般原則に沿って処理します。",
    checkItems: ["金額", "時期", "法人・個人", "用途", "余分な5件目"],
    sources: [],
    sourceVerification: "unverified",
    requiresTaxProfessionalReview: false,
    handoffSummary: {
      clientName: "未登録",
      questionSummary: "質問",
      provisionalAnswer: "暫定回答",
      assumptions: [],
      requiredChecks: [],
      references: [],
      urgency: "通常",
      responseDeadline: null,
    },
    clientContextFieldsUsed: [],
    model: "test",
    promptVersion: "test",
    generatedAt: "2026-07-23T00:00:00.000Z",
  };
}

test("曖昧な質問を不正相談として誤判定しない", () => {
  for (const question of ambiguousQuestions) {
    assert.equal(classifyLocalRisk(question).suspectedEvasion, false, question);
  }
});

test("不正相談はすべてレベルCへ強制する", () => {
  for (const question of unsafeQuestions) {
    const result = classifyLocalRisk(question);
    assert.equal(result.forcedLevel, "C", question);
    assert.equal(result.suspectedEvasion, true, question);
  }
});

test("追加質問だけの回答を検出する", () => {
  assert.equal(
    isClarificationOnly("法人か個人か、金額、購入日、用途を教えてください。"),
    true,
  );
  assert.equal(
    isClarificationOnly(
      "【結論】\n業務用の車は原則として固定資産に計上し、耐用年数にわたって減価償却します。\n\n【確認したいこと】\n購入金額を教えてください。",
    ),
    false,
  );
});

test("根拠未検証時は低信頼・税理士確認へ強制する", () => {
  const result = enforceDraftPolicy(baseDraft());
  assert.equal(result.confidence, "低");
  assert.equal(result.requiresTaxProfessionalReview, true);
  assert.equal(result.checkItems.length, 4);
  assert.match(result.draftReply, /公式資料を確認できていません/);
});

test("レベルCと不正相談では本文にも税理士確認・適正申告を保証する", () => {
  const result = enforceDraftPolicy(
    {
      ...baseDraft(),
      answerLevel: "C",
      sources: [
        {
          title: "公式資料",
          url: "https://www.nta.go.jp/example",
          sourceType: "国税庁",
          legalReference: null,
          publicationDate: null,
          effectiveDate: null,
          lastUpdatedAt: null,
          retrievedAt: null,
          quote: "確認箇所",
        },
      ],
      sourceVerification: "verified",
    },
    { suspectedEvasion: true },
  );
  assert.match(result.draftReply, /税理士/);
  assert.match(result.draftReply, /適正な申告|修正申告/);
  assert.equal(result.requiresTaxProfessionalReview, true);
});

test("検索注釈に存在する公式URLだけを根拠として採用する", () => {
  const source = {
    title: "国税庁資料",
    url: "https://www.nta.go.jp/example",
    sourceType: "国税庁",
    legalReference: null,
    publicationDate: null,
    effectiveDate: null,
    lastUpdatedAt: null,
    retrievedAt: null,
    quote: "確認箇所",
  };
  assert.equal(
    verifySources(
      [source],
      new Set([`${source.url}?utm_source=openai&browser=on`]),
      "2026-07-23T00:00:00.000Z",
    ).length,
    1,
  );
  assert.equal(verifySources([source], new Set(), "2026-07-23T00:00:00.000Z").length, 0);
  assert.equal(isOfficialSourceUrl("https://example.com/tax"), false);
});

test("現行e-Gov法令検索URLを公式根拠として許可する", () => {
  assert.equal(
    isOfficialSourceUrl("https://laws.e-gov.go.jp/law/340AC0000000034"),
    true,
  );
  assert.equal(
    isOfficialSourceUrl("https://laws.e-gov.go.jp/api/2/law_data/340AC0000000034"),
    true,
  );
});

test("国税庁の税法・通達・事例入口を公式根拠として検索対象にする", () => {
  assert.equal(NTA_TAX_LAW_SOURCE_ENTRYPOINTS.length, 6);
  for (const entry of NTA_TAX_LAW_SOURCE_ENTRYPOINTS) {
    assert.equal(isOfficialSourceUrl(entry.url), true, entry.label);
  }
  assert.deepEqual(
    NTA_TAX_LAW_SOURCE_ENTRYPOINTS.map((entry) => entry.label),
    [
      "法令解釈通達",
      "その他法令解釈に関する情報",
      "事務運営指針",
      "国税庁告示",
      "文書回答事例",
      "質疑応答事例",
    ],
  );
});

test("国税不服審判所の公表裁決事例集を公式参考資料にする", () => {
  assert.deepEqual(KFS_DECISION_SOURCE_ENTRYPOINTS, [
    {
      label: "国税不服審判所 公表裁決事例集",
      url: "https://www.kfs.go.jp/service/",
    },
  ]);
  assert.equal(isOfficialSourceUrl(KFS_DECISION_SOURCE_ENTRYPOINTS[0].url), true);
});

test("機密情報をモデル送信前にマスクする", () => {
  const masked = redactSensitiveText(
    "マイナンバー123456789012、mail@example.com、口座番号1234567",
  );
  assert.doesNotMatch(masked, /123456789012|mail@example\.com|1234567/);
});

test("4分割プロンプトに必須契約が含まれる", () => {
  const promptDir = join(process.cwd(), "prompts");
  const system = readFileSync(join(promptDir, "system_prompt.md"), "utf8");
  const answer = readFileSync(join(promptDir, "answer_policy.md"), "utf8");
  const source = readFileSync(join(promptDir, "source_policy.md"), "utf8");
  const examples = readFileSync(join(promptDir, "examples.md"), "utf8");
  assert.match(system, /レベルA/);
  assert.match(system, /情報が不完全でも/);
  assert.match(answer, /最大4項目/);
  assert.match(source, /法律[\s\S]*政令[\s\S]*省令/);
  assert.match(source, /検索クエリに、氏名/);
  assert.match(examples, /売上を申告しなくても/);
});
