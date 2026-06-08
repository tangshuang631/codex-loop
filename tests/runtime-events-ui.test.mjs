import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("dashboard renders readable runtime events from snapshot", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /snapshot\?\.runtimeEvents/);
  assert.match(appSource, /运行记录/);
  assert.match(appSource, /runtime-event-list/);
  assert.match(appSource, /runtime-event-title/);
});

test("dashboard uses mobile process status as the primary runtime status source", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /mobileView\?\.processStatus/);
  assert.match(appSource, /processStatus\?\.headline/);
  assert.match(appSource, /processStatus\?\.detail/);
  assert.match(appSource, /processStatus\?\.stopLimit/);
  assert.match(appSource, /待合并补充/);
});

test("dashboard shows a compact Codex-style loop progress panel", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /function LoopProgressPanel/);
  assert.match(appSource, /buildLoopProgressItems/);
  assert.match(appSource, /<LoopProgressPanel/);
  assert.match(appSource, /进度/);
  assert.match(appSource, /当前轮/);
  assert.match(appSource, /补充引导/);
  assert.match(appSource, /停止条件/);
  assert.match(stylesSource, /\.loop-progress-panel/);
  assert.match(stylesSource, /\.loop-progress-dot/);
  assert.doesNotMatch(stylesSource, /\.loop-progress-panel[\s\S]{0,260}button/);
});

test("dashboard labels default ollama auto mode without turning it into strict mode", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /promptGeneratorEnabled: "auto"/);
  assert.match(appSource, /自动接入 Ollama/);
  assert.match(appSource, /enabled: settingsForm\.promptGeneratorEnabled/);
  assert.doesNotMatch(appSource, /settingsForm\.promptGeneratorEnabled === "auto"\s*\?\s*true/);
});
