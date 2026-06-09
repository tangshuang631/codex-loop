import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("new task flow explains automatic matching with Codex thread id fallback", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const paneStart = appSource.indexOf("function LoopCreationAssistantPane");
  const paneEnd = appSource.indexOf("function ManagePane");
  const paneSource = appSource.slice(paneStart, paneEnd);

  assert.match(appSource, /获取线程号/);
  assert.match(appSource, /新窗口线程号/);
  assert.match(appSource, /优先在创建任务里填写项目路径和 Codex 窗口名自动匹配/);
  assert.match(appSource, /自动匹配失败时，再在 Codex 窗口发送下面这句话/);
  assert.match(appSource, /复制 Codex 返回的 threadId/);
  assert.match(appSource, /粘贴到线程 ID 作为兜底/);
  assert.match(appSource, /这个指令只用于获取窗口编号，不会启动循环/);
  assert.match(paneSource, /<ThreadIdHelpCard compact \/>/);
  assert.match(appSource, /如果提示找不到或不唯一，再复制这句话发给目标 Codex 窗口/);
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

test("thread binding form offers automatic matching by project path and window name", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const manageStart = appSource.indexOf("function ManagePane");
  const manageEnd = appSource.indexOf("function ManageWorkspaceView");
  const manageSource = appSource.slice(manageStart, manageEnd);

  assert.match(manageSource, /项目路径/);
  assert.match(manageSource, /Codex 窗口名/);
  assert.match(manageSource, /线程 ID 可留空/);
  assert.match(manageSource, /自动匹配/);
  assert.match(manageSource, /threadForm\.workspaceRoot/);
  assert.match(manageSource, /threadForm\.windowTitle/);
});
