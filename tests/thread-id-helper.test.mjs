import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("new loop flow explains how to get a Codex thread id", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /获取线程号/);
  assert.match(appSource, /打开新的 Codex 窗口/);
  assert.match(appSource, /复制这句话发给 Codex/);
  assert.match(appSource, /粘贴到线程 ID/);
  assert.match(appSource, /只输出 threadId/);
});
