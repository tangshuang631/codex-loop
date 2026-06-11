import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("settings exposes loop stop conditions outside Ollama settings", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const manageStart = appSource.indexOf("function ManagePane");
  const manageEnd = appSource.indexOf("function ManageWorkspaceView");
  const manageSource = appSource.slice(manageStart, manageEnd);

  const stopSettingsIndex = manageSource.indexOf("循环停止条件");
  const ollamaSettingsIndex = manageSource.indexOf("Ollama 设置");
  const ollamaDetailsEnd = manageSource.indexOf("还没有检测到可用的本地模型");

  assert.ok(stopSettingsIndex > -1, "settings should show a dedicated loop stop conditions section");
  assert.ok(ollamaSettingsIndex > -1, "settings should keep the Ollama section");
  assert.ok(
    stopSettingsIndex > ollamaDetailsEnd || stopSettingsIndex < ollamaSettingsIndex,
    "loop stop conditions should not be nested inside the Ollama help block",
  );
  assert.match(manageSource, /最长运行时间/);
  assert.match(manageSource, /最大 token 预算/);
  assert.match(manageSource, /到达限制后不会再发送下一条指令/);
  assert.match(manageSource, /settings-note/);
  assert.match(manageSource, /未设置停止条件|当前：/);
});
