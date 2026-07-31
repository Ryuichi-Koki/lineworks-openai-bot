import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuthorizedApprover,
  parseApproverUserIds,
} from "../lib/lineworks/approvers.ts";

test("承認者リストが未設定なら誰も承認できない（H-02の回帰防止）", () => {
  // 以前は未設定を「全員許可」として扱っていた。
  // 環境変数の設定漏れが、そのまま顧問先への送信権限の開放になっていた。
  assert.equal(isAuthorizedApprover("staff-1", undefined), false);
  assert.equal(isAuthorizedApprover("staff-1", ""), false);
  assert.equal(isAuthorizedApprover("staff-1", "   "), false);
  assert.equal(isAuthorizedApprover("staff-1", ",,"), false);
});

test("リストに載っている職員だけを承認者として扱う", () => {
  const configured = "staff-1, staff-2 ,staff-3";
  assert.equal(isAuthorizedApprover("staff-1", configured), true);
  assert.equal(isAuthorizedApprover("staff-2", configured), true);
  assert.equal(isAuthorizedApprover("staff-3", configured), true);
  assert.equal(isAuthorizedApprover("staff-4", configured), false);
});

test("前方一致・部分一致では承認できない", () => {
  assert.equal(isAuthorizedApprover("staff", "staff-1"), false);
  assert.equal(isAuthorizedApprover("staff-10", "staff-1"), false);
  assert.equal(isAuthorizedApprover("STAFF-1", "staff-1"), false);
});

test("空要素を除いた承認者を返す", () => {
  assert.deepEqual(parseApproverUserIds(" a , , b ,"), ["a", "b"]);
  assert.deepEqual(parseApproverUserIds(undefined), []);
});
