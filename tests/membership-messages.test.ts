import assert from "node:assert/strict";
import test from "node:test";
import { buildPaidPeriodLine } from "../lib/membership/messages.ts";

test("契約中は次回更新日を表示する", () => {
  assert.equal(
    buildPaidPeriodLine("active", "2026-08-25"),
    "次回更新日：2026-08-25",
  );
});

test("退会予約中は有料機能の利用期限を表示する", () => {
  assert.equal(
    buildPaidPeriodLine("cancel_at_period_end", "2026-08-25"),
    "有料機能の利用期限：2026-08-25",
  );
});
