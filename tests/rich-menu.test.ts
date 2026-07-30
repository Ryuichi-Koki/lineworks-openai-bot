import assert from "node:assert/strict";
import test from "node:test";
import { richMenuDefinition } from "../scripts/setup-line-rich-menu.mjs";

const { size, areas } = richMenuDefinition;

test("リッチメニューはLINEが受け付けるサイズと領域数に収まる", () => {
  assert.deepEqual(size, { width: 2500, height: 1686 });
  assert.ok(areas.length >= 1 && areas.length <= 20);
  assert.equal(areas.length, 6);
});

test("タップ領域が画像内に収まり、互いに重ならない", () => {
  for (const area of areas) {
    const { x, y, width, height } = area.bounds;
    assert.ok(x >= 0 && y >= 0, `領域が画像の外に出ている: ${area.action.label}`);
    assert.ok(
      x + width <= size.width && y + height <= size.height,
      `領域が画像からはみ出している: ${area.action.label}`,
    );
  }

  for (let i = 0; i < areas.length; i += 1) {
    for (let j = i + 1; j < areas.length; j += 1) {
      const a = areas[i].bounds;
      const b = areas[j].bounds;
      const overlaps =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      assert.ok(
        !overlaps,
        `領域が重複している: ${areas[i].action.label} / ${areas[j].action.label}`,
      );
    }
  }
});

test("注意表示の帯にはタップ領域を割り当てない", () => {
  for (const area of areas) {
    assert.ok(
      area.bounds.y >= 130,
      `個人情報の注意表示にタップ領域が重なっている: ${area.action.label}`,
    );
  }
});

test("すべてpostbackで、利用者の発言として残るmessage actionを使わない", () => {
  for (const area of areas) {
    assert.equal(
      area.action.type,
      "postback",
      `message actionが残っている: ${area.action.label}`,
    );
    assert.ok(area.action.data, `postback dataがない: ${area.action.label}`);
    assert.ok(
      area.action.displayText,
      `displayTextがない: ${area.action.label}`,
    );
  }
});

test("ラベルと実際の動作が一致している", () => {
  const byLabel = new Map(
    areas.map((area) => [area.action.label, area.action]),
  );

  // 「料金プラン」は料金表示であり、申し込み・決済を開始しない
  assert.equal(byLabel.get("料金プラン")?.data, "action=show_pricing");
  assert.equal(byLabel.get("料金プラン")?.displayText, "料金プランを見ます");

  // 都度課金利用者にも意味が通じ、押しただけで退会を確定しない
  assert.equal(
    byLabel.get("利用状況・退会")?.data,
    "action=open_billing_portal",
  );
  assert.equal(
    byLabel.get("利用状況・退会")?.displayText,
    "利用状況と退会方法を確認します",
  );

  assert.equal(byLabel.get("マイページ")?.data, "action=show_status");
  assert.equal(byLabel.get("質問する")?.data, "action=start_question");
  assert.equal(
    byLabel.get("税理士に相談")?.data,
    "action=start_tax_review_intake",
  );
  assert.equal(byLabel.get("規約・ヘルプ")?.data, "action=show_legal");
});

test("postbackのactionが重複しない", () => {
  const actions = areas.map((area) => String(area.action.data));
  assert.equal(new Set(actions).size, actions.length);
});
