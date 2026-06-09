import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("dashboard exposes a dedicated Help page for explanatory product guidance", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /function HelpWorkspaceView/);
  assert.match(appSource, /\["help", "帮助"\]/);
  assert.match(appSource, /activeSidebarPane === "help"/);
  assert.match(appSource, /loop 是什么/);
  assert.match(appSource, /如何创建任务/);
  assert.match(appSource, /如何绑定线程/);
  assert.match(appSource, /如何开启本地模型增强/);
  assert.match(appSource, /如何安全停止与关闭服务/);
  assert.match(appSource, /遇到异常时先看哪里/);
  assert.match(stylesSource, /\.help-guide-list/);
  assert.match(stylesSource, /\.help-guide-item/);
});

test("main dashboard keeps explanatory help copy out of the loop home", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const dashboardStart = appSource.indexOf("function DashboardHome");
  const dashboardEnd = appSource.indexOf("export function App");
  const dashboardSource = appSource.slice(dashboardStart, dashboardEnd);

  assert.doesNotMatch(dashboardSource, /loop 是什么/);
  assert.doesNotMatch(dashboardSource, /如何创建任务/);
  assert.doesNotMatch(dashboardSource, /如何开启本地模型增强/);
  assert.doesNotMatch(dashboardSource, /如何安全停止与关闭服务/);
});
