import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("dashboard exposes a compact next-turn guidance entry", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /补充下一轮引导/);
  assert.match(appSource, /\/pending-guidance/);
  assert.match(appSource, /不会立刻打断 Codex/);
  assert.match(appSource, /已记录/);
});
