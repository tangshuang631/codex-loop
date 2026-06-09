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

test("dashboard keeps independent verification result visible in primary status rows", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  const verificationRowIndex = appSource.indexOf('verificationText ? ["独立验收"');
  const holdReasonRowIndex = appSource.indexOf("processStatus?.holdReason");
  const primaryRowsIndex = appSource.indexOf("const primaryRows = rows.slice(0, 6)");

  assert.notEqual(verificationRowIndex, -1);
  assert.notEqual(holdReasonRowIndex, -1);
  assert.notEqual(primaryRowsIndex, -1);
  assert.ok(
    verificationRowIndex < holdReasonRowIndex,
    "独立验收结果要排在判断/下一步之前，避免默认折叠后看不到。",
  );
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

test("dashboard avoids long thread ids stretching the mobile home header", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /function shortThreadId/);
  assert.match(appSource, /heroThreadLabel/);
  assert.match(appSource, /statusLine\s*=\s*`\$\{runningHeadline\} · \$\{heroThreadLabel\}`/);
  assert.match(stylesSource, /\.compact-actions > strong[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(stylesSource, /\.workspace-hero-copy[\s\S]*min-width:\s*0/);
});
