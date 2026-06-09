import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("new task flow explains how to get a Codex thread id", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const paneStart = appSource.indexOf("function LoopCreationAssistantPane");
  const paneEnd = appSource.indexOf("function ManagePane");
  const paneSource = appSource.slice(paneStart, paneEnd);

  assert.match(appSource, /获取线程号/);
  assert.match(appSource, /新窗口线程号/);
  assert.match(appSource, /在要接入的 Codex 窗口发送下面这句话/);
  assert.match(appSource, /复制 Codex 返回的 threadId/);
  assert.match(appSource, /粘贴到新任务的线程 ID/);
  assert.match(appSource, /这个指令只用于获取窗口编号，不会启动循环/);
  assert.match(paneSource, /<ThreadIdHelpCard compact \/>/);
  assert.match(appSource, /打开新的 Codex 窗口/);
  assert.match(appSource, /复制这句话发给 Codex/);
  assert.match(appSource, /粘贴到线程 ID/);
  assert.match(appSource, /只输出 threadId/);
  assert.ok(
    paneSource.indexOf("ThreadIdHelpCard") < paneSource.indexOf("assistant-reply-form"),
    "thread id helper should appear before the creation reply form",
  );
  assert.ok(
    paneSource.indexOf("ThreadIdHelpCard") < paneSource.indexOf("assistant-disclosure"),
    "thread id helper should be visible before lower-progress details",
  );
});
