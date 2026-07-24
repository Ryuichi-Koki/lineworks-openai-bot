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

test("2026年7月24日版の正式名称と施行情報を表示する", () => {
  assert.equal(termsDocument.title, "Tax Hot Line利用規約");
  assert.equal(termsDocument.enactedOn, "2026年7月24日");
  assert.equal(privacyDocument.revisedOn, "2026年7月24日");
  assert.equal(tokushoDocument.office, "Apex Brain税理士法人 沖縄事務所");
});

test("利用規約に料金・自動更新・解約・LINEブロック注意を保持する", () => {
  const text = allText(termsDocument.blocks);
  assert.match(text, /月額3,300円（税込）/);
  assert.match(text, /1か月ごとに自動更新/);
  assert.match(text, /次回決済日の前日まで/);
  assert.match(text, /ブロック又は友だち登録解除のみでは解約となりません/);
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

test("特商法表記に無料・有料プラン、追加料金、メール解約、返金条件を保持する", () => {
  const text = allText(tokushoDocument.blocks);
  assert.match(text, /無料会員：無料/);
  assert.match(text, /月額上限超過相談：1件3,300円（税込）/);
  assert.match(text, /info@abtax.jp宛てのメール/);
  assert.match(text, /日割返金は行いません/);
});
