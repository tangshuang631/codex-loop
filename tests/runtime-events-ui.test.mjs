import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { dedupeRuntimeEventsForDisplay } from "../app/web/src/runtime-events.mjs";

test("dashboard renders readable runtime events from snapshot", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /snapshot\?\.runtimeEvents/);
  assert.match(appSource, /运行记录/);
  assert.match(appSource, /runtime-event-list/);
  assert.match(appSource, /runtime-event-title/);
});

test("dashboard translates invalid context health issues to Chinese", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /context:not-file/);
  assert.match(appSource, /不是有效文件/);
  assert.match(appSource, /context:unreadable/);
  assert.match(appSource, /无法读取/);
});

test("dashboard translates invalid workspace health issues to Chinese", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /workspace:missing/);
  assert.match(appSource, /项目路径不存在/);
  assert.match(appSource, /workspace:not-directory/);
  assert.match(appSource, /项目路径不是目录/);
  assert.match(appSource, /workspace:unreadable/);
  assert.match(appSource, /项目路径无法读取/);
});

test("dashboard display dedupes repeated runtime records before rendering", () => {
  const events = [
    {
      at: "2026-06-08T06:25:59.953Z",
      type: "codex_conversation_mirror_synced",
      title: "已同步 Codex 对话",
      detail: "同一段 Codex 回复不应该在运行记录里重复出现。",
    },
    {
      at: "2026-06-08T06:25:59.468Z",
      type: "codex_conversation_mirror_synced",
      title: "已同步 Codex 对话",
      detail: "同一段 Codex 回复不应该在运行记录里重复出现。",
    },
    {
      at: "2026-06-08T06:25:58.793Z",
      type: "codex_followup_completed",
      title: "Codex 已完成一轮",
      detail: "同一段 Codex 回复不应该在运行记录里重复出现。",
    },
    {
      at: "2026-06-08T06:24:10.000Z",
      type: "codex_followup_dispatching",
      title: "正在发送下一轮指令",
      detail: "继续推进下一批可验证任务。",
    },
  ];

  const visibleEvents = dedupeRuntimeEventsForDisplay(events, 4);

  assert.deepEqual(
    visibleEvents.map((event) => event.detail),
    ["同一段 Codex 回复不应该在运行记录里重复出现。", "继续推进下一批可验证任务。"],
  );
});

test("dashboard uses mobile process status as the primary runtime status source", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /mobileView\?\.processStatus/);
  assert.match(appSource, /processStatus\?\.monitorLabel/);
  assert.match(appSource, /processStatus\?\.monitorTone/);
  assert.match(appSource, /processStatus\?\.headline/);
  assert.match(appSource, /processStatus\?\.detail/);
  assert.match(appSource, /processStatus\?\.holdReason/);
  assert.match(appSource, /processStatus\?\.nextAction/);
  assert.match(appSource, /判断/);
  assert.match(appSource, /下一步/);
  assert.match(stylesSource, /\.status-pill\.is-warning/);
  assert.match(stylesSource, /\.status-pill\.is-ready/);
  assert.match(appSource, /processStatus\?\.stopLimit/);
  assert.match(appSource, /待合并补充/);
});

test("dashboard shows loop controller status as one compact status row", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /controllerStatus/);
  assert.match(appSource, /requestJson\("\/controller-status"\)\.catch/);
  assert.match(appSource, /自动循环/);
  assert.match(appSource, /controllerStatus\?\.label/);
  assert.match(appSource, /controllerStatus\?\.detail/);
  assert.doesNotMatch(appSource, /controller-status-card/);
});

test("dashboard folds low-frequency status details by default", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /primaryRows/);
  assert.match(appSource, /detailRows/);
  assert.match(appSource, /status-detail-fold/);
  assert.match(appSource, /更多状态/);
  assert.match(appSource, /运行记录/);
  assert.match(stylesSource, /\.status-detail-fold/);
  assert.match(stylesSource, /\.status-detail-fold summary/);
});

test("dashboard keeps production status inside folded status details", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /productionStatus/);
  assert.match(appSource, /requestJson\("\/production-status"\)\.catch/);
  assert.match(appSource, /生产状态摘要/);
  assert.match(appSource, /最近生产检查/);
  assert.match(appSource, /下一步建议/);
  assert.match(appSource, /status-detail-fold/);
  assert.doesNotMatch(appSource, /production-status-card/);
});

test("dashboard surfaces supervisor review without adding noisy debug cards", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /processStatus\?\.hasSupervisorReview/);
  assert.match(appSource, /processStatus\?\.supervisorReview/);
  assert.match(appSource, /processStatus\?\.supervisorInstructionPreview/);
  assert.match(appSource, /监督复盘/);
  assert.match(appSource, /下一条指令/);
});

test("dashboard surfaces supervisor verification plan as compact status rows", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /processStatus\?\.needsIndependentVerification/);
  assert.match(appSource, /processStatus\?\.verificationCommands/);
  assert.match(appSource, /processStatus\?\.acceptanceFocusPreview/);
  assert.match(appSource, /验收建议/);
  assert.match(appSource, /验证命令/);
});

test("dashboard keeps independent verification and next action visible in primary status rows", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  const verificationRowIndex = appSource.indexOf('verificationText ? ["独立验收"');
  const holdReasonRowIndex = appSource.indexOf("processStatus?.holdReason");
  const nextActionRowIndex = appSource.indexOf("processStatus?.nextAction");
  const primaryRowsIndex = appSource.indexOf("const primaryRows = rows.slice(0, 7)");

  assert.notEqual(verificationRowIndex, -1);
  assert.notEqual(holdReasonRowIndex, -1);
  assert.notEqual(nextActionRowIndex, -1);
  assert.notEqual(primaryRowsIndex, -1);
  assert.ok(
    verificationRowIndex < holdReasonRowIndex,
    "独立验收结果要排在判断/下一步之前，避免默认折叠后看不到。",
  );
  assert.ok(
    holdReasonRowIndex < nextActionRowIndex,
    "下一步要保留在主要状态区，避免新增模型来源后被折叠。",
  );
});

test("dashboard exposes supervisor screenshot evidence inside compact status details", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /supervisorVerificationEvidencePreview/);
  assert.match(appSource, /supervisorVerificationEvidenceCount/);
  assert.match(appSource, /截图证据/);
  assert.match(appSource, /status-detail-fold/);
  assert.match(stylesSource, /\.status-detail-fold/);
  assert.doesNotMatch(appSource, /screenshot-evidence-card/);
});

test("dashboard and mobile status show the latest instruction source", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const mobileStart = appSource.indexOf("function MobileTaskApp");
  const mobileEnd = appSource.indexOf("function DesktopConsoleApp", mobileStart);
  const statusSource = appSource.slice(statusStart, statusEnd);
  const mobileSource = appSource.slice(mobileStart, mobileEnd);

  assert.notEqual(statusStart, -1);
  assert.notEqual(mobileStart, -1);
  assert.match(statusSource, /latestInstructionSourceLabel/);
  assert.match(statusSource, /最近指令/);
  assert.match(mobileSource, /latestInstructionSourceLabel/);
  assert.match(mobileSource, /最近指令/);
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

test("dashboard keeps detailed loop progress collapsed by default", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.doesNotMatch(appSource, /<details className="loop-progress-panel" open>/);
});

test("dashboard exposes mobile viewing as a folded product entry instead of noisy status data", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /function MobileAccessFold/);
  assert.match(appSource, /<MobileAccessFold/);
  assert.match(appSource, /手机查看/);
  assert.match(appSource, /remoteAccessStatus\?\.url \|\| remoteAccessStatus\?\.publicBaseUrl/);
  assert.match(appSource, /remoteAccessStatus\?\.statusText/);
  assert.match(appSource, /remoteAccessStatus\?\.nextAction/);
  assert.match(appSource, /remoteAccessStatus\?\.mobileUrlHint/);
  assert.match(appSource, /remoteAccessStatus\?\.candidateUrls/);
  assert.match(appSource, /推荐手机地址/);
  assert.match(stylesSource, /\.mobile-access-fold/);
  assert.match(stylesSource, /\.mobile-access-steps/);
  assert.match(stylesSource, /\.mobile-access-candidates/);
});

test("dashboard can create a reusable mobile app pairing session from the mobile access fold", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /const \[devicePairingSession,\s*setDevicePairingSession\]/);
  assert.match(appSource, /async function createDevicePairingSession/);
  assert.match(appSource, /requestJson\("\/device-pairing\/session"/);
  assert.match(appSource, /remoteAccessStatus\?\.primaryMobileUrl\s*\|\|\s*remoteAccessStatus\?\.url/);
  assert.match(appSource, /onCreateDevicePairingSession=\{createDevicePairingSession\}/);
  assert.match(appSource, /remoteAccessStatus\?\.devicePairing\?\.summary/);
  assert.match(appSource, /remoteAccessStatus\?\.pairingAction/);
  assert.match(appSource, /生成扫码绑定/);
  assert.match(appSource, /长期绑定/);
  assert.match(appSource, /重启后不用重复扫码/);
  assert.match(appSource, /pairingSession\?\.pairingCode/);
  assert.match(appSource, /pairingSession\?\.qrPayload/);
  assert.match(appSource, /QRCode\.toDataURL/);
  assert.match(appSource, /pairingQrDataUrl/);
  assert.match(appSource, /alt="手机扫码绑定"/);
  assert.match(appSource, /复制配对码/);
  assert.match(appSource, /复制扫码内容/);
  assert.match(stylesSource, /\.mobile-pairing-panel/);
  assert.match(stylesSource, /\.mobile-pairing-qr-image/);
  assert.match(stylesSource, /\.mobile-pairing-code/);
});

test("dashboard lets users revoke paired phones and see pairing audit hints", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /async function revokePairedDevice/);
  assert.match(appSource, /requestJson\("\/device-pairing\/device",\s*\{\s*method:\s*"DELETE"/);
  assert.match(appSource, /devicePairing\.devices/);
  assert.match(appSource, /devicePairing\.auditEvents/);
  assert.match(appSource, /撤销绑定/);
  assert.match(appSource, /最近绑定记录/);
  assert.match(appSource, /onRevokePairedDevice=\{revokePairedDevice\}/);
  assert.match(stylesSource, /\.mobile-pairing-devices/);
  assert.match(stylesSource, /\.mobile-pairing-audit/);
});

test("dashboard labels default ollama auto mode without turning it into strict mode", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /promptGeneratorEnabled: "auto"/);
  assert.match(appSource, /自动接入 Ollama/);
  assert.match(appSource, /enabled: settingsForm\.promptGeneratorEnabled/);
  assert.doesNotMatch(appSource, /settingsForm\.promptGeneratorEnabled === "auto"\s*\?\s*true/);
});

test("dashboard treats supervisor reviewing as its own non-dispatching wait state", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /reviewing:\s*"监督复盘中"/);
  assert.match(appSource, /isReviewing\s*=\s*snapshot\?\.thread\?\.continuationStatus === "reviewing"/);
  assert.match(appSource, /本地模型正在监督复盘，完成前不发送下一条/);
  assert.match(appSource, /正在监督复盘，等待本地模型决定下一步。/);
  assert.match(appSource, /Codex 已完成，正在等待本地监督复盘。/);
});

test("dashboard loads core loop data even when auxiliary status endpoints fail", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /const \[\s*nextSnapshot,\s*nextLoops,\s*\] = await Promise\.all/);
  assert.match(appSource, /requestJson\("\/automation"\)\.catch/);
  assert.match(appSource, /requestJson\("\/mobile"\)\.catch/);
  assert.match(appSource, /requestJson\("\/launcher-status"\)\.catch/);
  assert.match(appSource, /requestJson\("\/remote-access"\)\.catch/);
  assert.match(appSource, /requestJson\("\/loop-creation-assistant"\)\.catch/);
});

test("dashboard keeps mobile first screen compact and conversation readable", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /function shouldOpenConversationEntry/);
  assert.match(appSource, /function dedupeConversationEntries/);
  assert.match(appSource, /function resolveLauncherPhaseText/);
  assert.match(appSource, /getInitialSidebarOpen/);
  assert.match(appSource, /workspace-more-actions/);
  assert.match(appSource, /更多操作/);
  assert.match(stylesSource, /@media \(max-width: 720px\)/);
  assert.match(stylesSource, /\.workspace-sidebar\.is-collapsed \.sidebar-collapsed-list/);
  assert.match(stylesSource, /\.workspace-more-actions/);
  assert.match(stylesSource, /\.mobile-only-label/);
});

test("dashboard uses task wording for primary creation and status surfaces", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const guideSource = await fs.readFile("app/web/src/dashboard-guide.mjs", "utf8");
  const dashboardStart = appSource.indexOf("function DashboardHome");
  const dashboardEnd = appSource.indexOf("export function App");
  const dashboardSource = appSource.slice(dashboardStart, dashboardEnd);

  assert.match(appSource, /创建任务/);
  assert.match(appSource, /新建任务/);
  assert.match(appSource, /当前任务/);
  assert.match(guideSource, /先新建任务/);
  assert.match(guideSource, /当前任务正在推进/);
  assert.doesNotMatch(dashboardSource, /新建 loop|当前 loop/);
}
);

test("sidebar uses compact project navigation instead of task tab cards", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");
  const sidebarStart = appSource.indexOf("<aside className={`workspace-sidebar");
  const sidebarEnd = appSource.indexOf("</aside>", sidebarStart);
  const sidebarSource = appSource.slice(sidebarStart, sidebarEnd);
  const footerStart = sidebarSource.indexOf("sidebar-footer");
  const footerSource = sidebarSource.slice(footerStart);

  assert.match(sidebarSource, /sidebar-action-grid/);
  assert.match(sidebarSource, /新建项目/);
  assert.match(sidebarSource, /新建任务/);
  assert.doesNotMatch(sidebarSource, /\["loops", "任务"\]/);
  assert.doesNotMatch(sidebarSource, /sidebar-pane-tab/);
  assert.match(sidebarSource, /sidebar-project-title/);
  assert.match(sidebarSource, /sidebar-loop-name/);
  assert.doesNotMatch(sidebarSource, /formatValue\(loop\.branch,\s*"dev"\)/);
  assert.doesNotMatch(sidebarSource, />管理</);
  assert.match(sidebarSource, /aria-label=\{`管理任务 \$\{loop\.name\}`\}/);
  assert.ok(footerSource.indexOf("帮助") >= 0);
  assert.ok(footerSource.indexOf("设置") >= 0);
  assert.ok(footerSource.indexOf("帮助") < footerSource.indexOf("设置"));
  assert.match(stylesSource, /\.sidebar-action-grid/);
  assert.match(stylesSource, /\.sidebar-footer-button/);
  assert.match(stylesSource, /\.sidebar-loop-name/);
});

test("sidebar groups tasks from persisted projects so empty projects remain visible", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const sidebarStart = appSource.indexOf("<aside className={`workspace-sidebar");
  const sidebarEnd = appSource.indexOf("</aside>", sidebarStart);
  const sidebarSource = appSource.slice(sidebarStart, sidebarEnd);

  assert.match(appSource, /function groupLoopsByProject\(loops = \[\], projects = \[\]\)/);
  assert.match(appSource, /loopRegistry\.projects/);
  assert.match(sidebarSource, /project\.isEmpty/);
  assert.match(sidebarSource, /还没有任务/);
});

test("create project entry submits a real project before tasks are added", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /function ProjectCreationPanel/);
  assert.match(appSource, /requestJson\("\/projects"/);
  assert.match(appSource, /项目名称/);
  assert.match(appSource, /创建项目/);
});

test("create task entry resets stale completed assistant state before opening", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const openCreatePaneStart = appSource.indexOf("async function openCreatePane");
  const openCreatePaneEnd = appSource.indexOf("async function handleDashboardAction", openCreatePaneStart);
  const openCreatePaneSource = appSource.slice(openCreatePaneStart, openCreatePaneEnd);

  assert.notEqual(openCreatePaneStart, -1);
  assert.match(openCreatePaneSource, /nextCreationMode === "task"/);
  assert.match(openCreatePaneSource, /requestJson\("\/loop-creation-assistant\/reset"/);
  assert.match(openCreatePaneSource, /setAssistantAnswer\(""\)/);
  assert.match(appSource, /onClick=\{\(\) => void openCreatePane\("task"\)\}/);
  assert.match(appSource, /onClick=\{\(\) => void openCreatePane\("project"\)\}/);
});

test("create task entry is an explicit new-task action and does not wait for full dashboard refresh", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const sidebarStart = appSource.indexOf("<aside className={`workspace-sidebar");
  const sidebarEnd = appSource.indexOf("</aside>", sidebarStart);
  const sidebarSource = appSource.slice(sidebarStart, sidebarEnd);
  const actionGridStart = sidebarSource.indexOf("<div className=\"sidebar-action-grid\">");
  const actionGridEnd = sidebarSource.indexOf("</div>", actionGridStart);
  const actionGridSource = sidebarSource.slice(actionGridStart, actionGridEnd);
  const collapsedStart = sidebarSource.indexOf("<div className=\"sidebar-collapsed-list\">");
  const collapsedSource = sidebarSource.slice(collapsedStart);
  const openCreatePaneStart = appSource.indexOf("async function openCreatePane");
  const openCreatePaneEnd = appSource.indexOf("async function handleDashboardAction", openCreatePaneStart);
  const openCreatePaneSource = appSource.slice(openCreatePaneStart, openCreatePaneEnd);

  assert.notEqual(sidebarStart, -1);
  assert.notEqual(actionGridStart, -1);
  assert.notEqual(collapsedStart, -1);
  assert.match(actionGridSource, /aria-label="新建任务"/);
  assert.match(actionGridSource, /新建任务/);
  assert.doesNotMatch(actionGridSource, />创建任务</);
  assert.match(collapsedSource, /aria-label="新建任务"/);
  assert.match(collapsedSource, />新建</);
  assert.match(appSource, /handleDashboardAction\("open-create"\)/);
  assert.doesNotMatch(appSource, /onClick=\{\(\) => setActiveSidebarPane\("create"\)\}/);
  assert.match(sidebarSource, /正在新建任务/);
  assert.doesNotMatch(openCreatePaneSource, /await withSubmit/);
});

test("create task back and reset actions replace stale assistant state", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const createViewStart = appSource.indexOf("<CreateWorkspaceView");
  const createViewEnd = appSource.indexOf("{activeSidebarPane === \"help\"", createViewStart);
  const createViewSource = appSource.slice(createViewStart, createViewEnd);

  assert.notEqual(createViewStart, -1);
  assert.match(createViewSource, /const nextAssistantState = await requestJson\("\/loop-creation-assistant\/back"/);
  assert.match(createViewSource, /const nextAssistantState = await requestJson\("\/loop-creation-assistant\/reset"/);
  assert.match(createViewSource, /setAssistantState\(nextAssistantState\)/);
});

test("create task view does not show previously created tasks as the creation entry", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const paneStart = appSource.indexOf("function LoopCreationAssistantPane");
  const paneEnd = appSource.indexOf("function ManagePane", paneStart);
  const paneSource = appSource.slice(paneStart, paneEnd);
  const workspaceStart = appSource.indexOf("<CreateWorkspaceView");
  const workspaceEnd = appSource.indexOf("{activeSidebarPane === \"help\"", workspaceStart);
  const workspaceSource = appSource.slice(workspaceStart, workspaceEnd);

  assert.notEqual(paneStart, -1);
  assert.notEqual(workspaceStart, -1);
  assert.doesNotMatch(paneSource, /assistant-result/);
  assert.doesNotMatch(paneSource, /createdLoop\.name/);
  assert.match(paneSource, /开始新建任务/);
  assert.match(workspaceSource, /nextAssistantState\?\.status === "completed"/);
  assert.match(workspaceSource, /setActiveSidebarPane\("loops"\)/);
});

test("create pane hides historical task navigation and keeps creation entry available", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const sidebarStart = appSource.indexOf("<aside className={`workspace-sidebar");
  const sidebarEnd = appSource.indexOf("</aside>", sidebarStart);
  const sidebarSource = appSource.slice(sidebarStart, sidebarEnd);
  const collapsedStart = sidebarSource.indexOf("<div className=\"sidebar-collapsed-list\">");
  const collapsedSource = sidebarSource.slice(collapsedStart);

  assert.notEqual(sidebarStart, -1);
  assert.notEqual(collapsedStart, -1);
  assert.match(appSource, /const showingCreationPane\s*=\s*activeSidebarPane === "create"/);
  assert.match(sidebarSource, /\{!showingCreationPane \? \(/);
  assert.match(sidebarSource, /正在新建任务/);
  assert.match(collapsedSource, /\{!showingCreationPane \? \(\s*<>\s*\{visibleLoops\.map/);
  assert.match(collapsedSource, /openCreatePane\("project"\)/);
  assert.match(collapsedSource, /openCreatePane\("task"\)/);
  assert.match(collapsedSource, />项目</);
  assert.match(collapsedSource, />新建</);
});

test("dashboard avoids long thread ids stretching the mobile home header", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /function shortThreadId/);
  assert.match(appSource, /heroThreadLabel/);
  assert.match(appSource, /statusLine\s*=\s*`\$\{runningHeadline\} · \$\{heroThreadLabel\}`/);
  assert.match(stylesSource, /\.compact-actions > strong[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(stylesSource, /\.workspace-hero-copy[\s\S]*min-width:\s*0/);
});

test("mobile route renders a protected task app with durable pairing credentials", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /function MobileTaskApp/);
  assert.match(appSource, /window\.location\.pathname === "\/mobile"/);
  assert.match(appSource, /CODEX_LOOP_MOBILE_DEVICE/);
  assert.match(appSource, /localStorage\.setItem\(MOBILE_DEVICE_STORAGE_KEY/);
  assert.match(appSource, /requestJson\("\/mobile\/view"/);
  assert.match(appSource, /requestJson\("\/device-pairing\/confirm"/);
  assert.match(appSource, /deviceId:\s*mobileDevice\?\.deviceId/);
  assert.match(appSource, /deviceToken:\s*mobileDevice\?\.deviceToken/);
  assert.match(appSource, /移动端任务/);
  assert.match(appSource, /手机已绑定/);
  assert.match(appSource, /补充你要说的话/);
  assert.match(appSource, /发送引导/);
  assert.match(appSource, /MobileConversationTimeline/);
  assert.match(stylesSource, /\.mobile-task-shell/);
  assert.match(stylesSource, /\.mobile-task-composer/);
  assert.match(stylesSource, /\.mobile-task-pairing/);
});

test("mobile guidance uses server dispatch result instead of a fixed saved message", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const mobileStart = appSource.indexOf("function MobileTaskApp");
  const mobileEnd = appSource.indexOf("function DesktopConsoleApp", mobileStart);
  const mobileSource = appSource.slice(mobileStart, mobileEnd);

  assert.notEqual(mobileStart, -1);
  assert.match(mobileSource, /const guidanceResult = await requestJson\("\/mobile\/guidance"/);
  assert.match(mobileSource, /guidanceResult\?\.message/);
  assert.match(mobileSource, /guidanceResult\?\.dispatch === "sent"/);
  assert.doesNotMatch(mobileSource, /setStatusText\("已保存补充引导，会等 Codex 完成后合并。"\)/);
});

test("mobile guidance can be recalled before it is merged", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");
  const mobileStart = appSource.indexOf("function MobileTaskApp");
  const mobileEnd = appSource.indexOf("function DesktopConsoleApp", mobileStart);
  const mobileSource = appSource.slice(mobileStart, mobileEnd);

  assert.notEqual(mobileStart, -1);
  assert.match(mobileSource, /async function clearMobileGuidance/);
  assert.match(mobileSource, /requestJson\("\/mobile\/guidance",\s*\{\s*method:\s*"DELETE"/);
  assert.match(mobileSource, /撤回/);
  assert.match(mobileSource, /mobileView\?\.pendingGuidance\?\.hasPending/);
  assert.match(mobileSource, /clearMobileGuidance/);
  assert.match(stylesSource, /\.mobile-task-pending-actions/);
});
