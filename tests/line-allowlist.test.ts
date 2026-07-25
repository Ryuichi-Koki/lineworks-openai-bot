import assert from "node:assert/strict";
import test from "node:test";
import { isLineUserAllowed } from "../lib/line/allowlist.ts";

test("allows every LINE user when no allowlist is configured", () => {
  assert.equal(isLineUserAllowed("U-user", ""), true);
  assert.equal(isLineUserAllowed("U-user", " , "), true);
});

test("allows only exact LINE user IDs when an allowlist is configured", () => {
  const allowlist = "U-first, U-second";

  assert.equal(isLineUserAllowed("U-first", allowlist), true);
  assert.equal(isLineUserAllowed("U-second", allowlist), true);
  assert.equal(isLineUserAllowed("U-third", allowlist), false);
  assert.equal(isLineUserAllowed("u-first", allowlist), false);
});
