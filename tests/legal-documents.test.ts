import assert from "node:assert/strict";
import test from "node:test";
import {
  privacyDocument,
  termsDocument,
  tokushoDocument,
  type LegalBlock,
} from "../lib/legal/documents.ts";

function allText(blocks: LegalBlock[]): string {
  return blocks
    .flatMap((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
          return [block.text];
        case "list":
          return block.items;
        case "table":
          return [...(block.headers ?? []), ...block.rows.flat()];
      }
    })
    .join("\n");
}

test("2026年7月30日改定版の正式名称と改定日を表示する", () => {
  assert.equal(termsDocument.title, "スグ税利用規約");
  assert.equal(termsDocument.enactedOn, "2026年7月24日");
  assert.equal(termsDocument.revisedOn, "2026年7月30日");
  assert.equal(privacyDocument.revisedOn, "2026年7月30日");
  assert.equal(tokushoDocument.office, "Apex Brain税理士法人 沖縄事務所");
});

test("利用規約に無料100件・都度課金・決済前確認・経過措置を定める", () => {
  const text = allText(termsDocument.blocks);
  assert.match(text, /月100件まで無料/);
  assert.match(text, /1回3,000円（税込）/);
  assert.match(text, /2026年12月31日まで.*1回1,000円（税込）/);
  assert.match(text, /月額料金又は自動更新はありません/);
  assert.match(text, /確認ボタンを押しただけでは料金は発生しません/);
  assert.match(text, /従前の利用条件を適用/);
  assert.match(text, /必要な同意・手続を経て確定/);
  assert.doesNotMatch(text, /月額利用料金は月額3,300円/);
});

test("プライバシーポリシーに主要委託先と外国移転・Cookie情報を保持する", () => {
  const text = allText(privacyDocument.blocks);
  for (const provider of [
    "LINEヤフー株式会社",
    "LINE WORKS株式会社",
    "OpenAI OpCo, LLC",
    "Stripe Japan株式会社",
    "Vercel Inc.",
    "Supabase, Inc.",
    "Upstash, Inc.",
  ]) {
    assert.match(text, new RegExp(provider.replace(".", "\\.")));
  }
  assert.match(text, /外国にある第三者への提供/);
  assert.match(text, /Stripe Checkout・Customer Portal/);
});

test("特商法表記に無料100件・相談価格・都度契約・返金条件を表示する", () => {
  const text = allText(tokushoDocument.blocks);
  assert.match(text, /AI回答：無料（月100件まで）/);
  assert.match(text, /税理士へのLINE個別相談：1回3,000円（税込）/);
  assert.match(text, /テスト期間価格：1回1,000円（税込、2026年12月31日まで/);
  assert.match(text, /月額料金及び自動更新はありません/);
  assert.match(text, /info@abtax.jp宛てのメール/);
  assert.match(text, /決済画面を閉じることで申込みを中止/);
  assert.match(text, /重複決済/);
});
