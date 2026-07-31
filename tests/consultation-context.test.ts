import assert from "node:assert/strict";
import test from "node:test";
import { buildConsultationStaffContext } from "../lib/tax/consultationService.ts";

const CREATED_AT = "2026-07-31T02:30:00.000Z"; // JST 11:30

function longAiAnswer(marker: string): string {
  return `${marker}：${"公式資料に基づく一般的な取扱いの説明。".repeat(80)}`;
}

test("相談本文は会話履歴より先に全文を配置する", () => {
  const context = buildConsultationStaffContext({
    lineUserHash: "abc123def456",
    createdAt: CREATED_AT,
    customerText:
      "役員退職金の適正額の判定方法と、損金算入時期を教えてください。",
    conversationHistory: [
      { role: "customer", text: "インボイスについて" },
      { role: "assistant", text: longAiAnswer("AI回答1") },
    ],
  });

  const bodyIndex = context.indexOf("【相談内容（お支払い対象）】");
  const historyIndex = context.indexOf("【直近のやり取り（参考）】");
  assert.ok(bodyIndex >= 0, "相談内容の見出しが必要");
  assert.ok(historyIndex > bodyIndex, "相談内容は参考情報より前に置く");
  assert.match(context, /役員退職金の適正額の判定方法/);
  assert.match(context, /損金算入時期を教えてください/);
});

test("長いAI会話が先にあっても相談本文が切り落とされない（C-02の回帰防止）", () => {
  // 修正前は「直近6件を連結して先頭から1,600字」で切っていたため、
  // 古いAI回答だけが残り、末尾にある支払対象の相談本文が消えていた。
  const consultation =
    "先日購入した中古車の減価償却について、2年落ちの普通乗用車を事業専用で使う場合の耐用年数と初年度の償却限度額を知りたいです。";
  const context = buildConsultationStaffContext({
    lineUserHash: "abc123def456",
    createdAt: CREATED_AT,
    customerText: consultation,
    conversationHistory: [
      { role: "customer", text: "質問1" },
      { role: "assistant", text: longAiAnswer("AI回答1") },
      { role: "customer", text: "質問2" },
      { role: "assistant", text: longAiAnswer("AI回答2") },
      { role: "customer", text: consultation },
    ],
  });

  assert.ok(
    context.includes(consultation),
    "支払対象の相談本文は必ず全文が含まれること",
  );
});

test("参考情報は先頭ではなく直近を残して切り詰める", () => {
  // 目印を各メッセージの末尾へ置く。末尾を残す実装であれば
  // 新しい方の目印だけが残る。
  const context = buildConsultationStaffContext({
    lineUserHash: "abc123def456",
    createdAt: CREATED_AT,
    customerText: "消費税の簡易課税について教えてください。",
    conversationHistory: [
      { role: "assistant", text: `${longAiAnswer("回答")}【古い方の目印】` },
      { role: "assistant", text: `${longAiAnswer("回答")}【新しい方の目印】` },
    ],
  });

  assert.match(context, /【新しい方の目印】/);
  assert.doesNotMatch(context, /【古い方の目印】/);
  assert.match(context, /…/, "切り詰めたことが分かる記号を残す");
});

test("LINE WORKSのテキスト上限に収まる", () => {
  const context = buildConsultationStaffContext({
    lineUserHash: "abc123def456",
    createdAt: CREATED_AT,
    customerText: "あ".repeat(5000),
    conversationHistory: Array.from({ length: 20 }, () => ({
      role: "assistant" as const,
      text: longAiAnswer("回答"),
    })),
  });

  assert.ok(context.length <= 1900, `想定より長い: ${context.length}`);
});

test("受付日時を日本時間で表示する", () => {
  const context = buildConsultationStaffContext({
    lineUserHash: "abc123def456",
    createdAt: CREATED_AT,
    customerText: "質問",
    conversationHistory: [],
  });

  assert.match(context, /受付日時: 2026年7月31日 11:30/);
});

test("相談本文が空でも税理士に判断材料を残す", () => {
  const context = buildConsultationStaffContext({
    lineUserHash: "abc123def456",
    createdAt: CREATED_AT,
    customerText: "   ",
    conversationHistory: [],
  });

  assert.match(context, /相談本文を取得できませんでした/);
  assert.match(context, /管理台帳/);
});

test("個人情報はマスクしてから税理士へ渡す", () => {
  const context = buildConsultationStaffContext({
    lineUserHash: "abc123def456",
    createdAt: CREATED_AT,
    customerText: "氏名: 山田太郎\n連絡先は sample@example.com です。",
    conversationHistory: [],
  });

  assert.doesNotMatch(context, /山田太郎/);
  assert.doesNotMatch(context, /sample@example\.com/);
  assert.match(context, /\[氏名をマスク\]/);
  assert.match(context, /\[メールアドレスをマスク\]/);
});
