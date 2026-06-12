import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { dedupeRuntimeEventsForDisplay } from "../app/web/src/runtime-events.mjs";

test("dashboard renders readable progress events from snapshot", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /snapshot\?\.runtimeEvents/);
  assert.match(appSource, /最近进展/);
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
  assert.match(appSource, /pendingGuidanceMergeLabel/);
  assert.match(appSource, /pendingGuidanceMergeDetail/);
  assert.match(appSource, /conversation-inline-status/);
  assert.match(appSource, /本地模型|NPC|Ollama/);
});

test("dashboard surfaces merged guidance evidence without adding a new card", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const statusSource = appSource.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.match(statusSource, /lastMergedGuidanceStatus/);
  assert.match(statusSource, /lastMergedGuidanceLabel/);
  assert.match(statusSource, /lastMergedGuidancePreview/);
  assert.match(statusSource, /已合并补充/);
  assert.match(statusSource, /status-detail-fold/);
  assert.doesNotMatch(appSource, /merged-guidance-card/);
});

test("dashboard conversation composer shows inline guidance feedback instead of a new card", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /presentPendingGuidanceStatus/);
  assert.match(appSource, /guidanceStatusMessage/);
  assert.match(appSource, /conversation-inline-status/);
  assert.match(stylesSource, /\.conversation-inline-status/);
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

test("dashboard folds low-frequency status details (legacy assertion kept for reference)", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /primaryRows/);
  assert.match(appSource, /buildProductionFocusSummary/);
  assert.match(appSource, /productionFocus\.summary/);
  assert.match(appSource, /rows\.filter\(\(\[label\]\) => primaryLabels\.has\(label\)\)/);
  assert.match(appSource, /detailRows/);
  assert.match(appSource, /status-detail-fold/);
  assert.match(appSource, /鏇村鐘舵€?|更多状态/);
  assert.match(appSource, /进展细节|最近进展/);
  assert.match(stylesSource, /\.status-detail-fold/);
  assert.match(stylesSource, /\.status-detail-fold summary/);
  return;

  assert.match(appSource, /primaryRows/);
  assert.match(appSource, /const primaryLabels = new Set\(\["当前", "说明", "下一步", "验证目标", "启动预检", "生产阶段", "生产观测"\]\)/);
  assert.match(appSource, /rows\.filter\(\(\[label\]\) => primaryLabels\.has\(label\)\)/);
  assert.match(appSource, /detailRows/);
  assert.match(appSource, /status-detail-fold/);
  assert.match(appSource, /更多状态/);
  assert.match(appSource, /进展细节|最近进展/);
  assert.match(stylesSource, /\.status-detail-fold/);
  assert.match(stylesSource, /\.status-detail-fold summary/);
});

test("dashboard keeps production status inside folded status details", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /productionStatus/);
  assert.match(appSource, /productionPreflight/);
  assert.match(appSource, /productionStatus\?\.target/);
  assert.match(appSource, /productionPreflight\?\.target/);
  assert.match(appSource, /验证目标/);
  assert.match(appSource, /requestJson\("\/production-status"\)\.catch/);
  assert.match(appSource, /requestJson\("\/production-preflight"\)\.catch/);
  assert.match(appSource, /readiness\?\.stage/);
  assert.match(appSource, /生产阶段/);
  assert.match(appSource, /启动预检/);
  assert.match(appSource, /可以启动|先别启动|等待中/);
  assert.match(appSource, /短时试用|可长跑|观察中|需处理/);
  assert.match(appSource, /生产观测/);
  assert.match(appSource, /真实运行观测/);
  assert.match(appSource, /真实闭环|长期运行基本证据/);
  assert.match(appSource, /生产成熟度/);
  assert.match(appSource, /最近生产检查/);
  assert.match(appSource, /下一步建议/);
  assert.match(appSource, /status-detail-fold/);
  assert.doesNotMatch(appSource, /production-status-card/);
});


test("dashboard and mobile compress production status rows while keeping detail folds", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const mobileSource = await fs.readFile("app/mobile/src/main.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const statusSource = appSource.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.match(statusSource, /productionStageSummary/);
  assert.match(statusSource, /productionObservationSummary/);
  assert.match(statusSource, /buildProductionFocusSummary/);
  assert.match(statusSource, /buildModelPipelineSummary/);
  assert.match(statusSource, /生产判断/);
  assert.match(statusSource, /模型链路/);
  assert.match(statusSource, /summarizeVisibleText\(/);
  assert.match(mobileSource, /productionStageSummary/);
  assert.match(mobileSource, /productionObservationSummary/);
  assert.match(mobileSource, /buildProductionFocusSummary/);
  assert.match(mobileSource, /buildModelPipelineSummary/);
  assert.match(mobileSource, /生产判断/);
  assert.match(mobileSource, /模型链路/);
  assert.match(mobileSource, /compactText\(/);
});

test("dashboard keeps production judgment in primary rows and leaves deeper evidence folded", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /buildProductionFocusSummary/);
  assert.match(appSource, /productionFocus\.summary/);
  assert.match(appSource, /\["生产判断", productionFocus\.summary\]/);
  assert.match(appSource, /productionFocus\.attention/);
  assert.match(appSource, /productionFocus\.nextAction/);
  assert.match(appSource, /const primaryLabels = new Set\(\["当前", "说明", "下一步"\]\)/);
  assert.match(appSource, /status-detail-fold/);
});

test("dashboard still keeps next action primary while independent verification stays in folded details", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  const nextActionRowIndex = appSource.indexOf('processStatus?.nextAction ? ["下一步", processStatus.nextAction] : null');
  const productionJudgmentRowIndex = appSource.indexOf('productionFocus.summary ? ["生产判断", productionFocus.summary] : null');
  const primaryLabelsIndex = appSource.indexOf('const primaryLabels = new Set(["当前", "说明", "下一步"])');
  const detailRowsIndex = appSource.indexOf("const detailRows = [");
  const modelPipelineRowIndex = appSource.indexOf('modelPipeline.headline ? ["模型链路", modelPipeline.headline] : null');
  const verificationRowIndex = appSource.indexOf('verificationText ? ["独立验收"');
  const holdReasonRowIndex = appSource.indexOf("processStatus?.holdReason");

  assert.notEqual(nextActionRowIndex, -1);
  assert.notEqual(productionJudgmentRowIndex, -1);
  assert.notEqual(modelPipelineRowIndex, -1);
  assert.notEqual(primaryLabelsIndex, -1);
  assert.notEqual(detailRowsIndex, -1);
  assert.notEqual(verificationRowIndex, -1);
  assert.notEqual(holdReasonRowIndex, -1);
  assert.ok(nextActionRowIndex < primaryLabelsIndex);
  assert.ok(primaryLabelsIndex < detailRowsIndex);
  assert.ok(detailRowsIndex < productionJudgmentRowIndex);
  assert.ok(detailRowsIndex < modelPipelineRowIndex);
  assert.ok(detailRowsIndex < verificationRowIndex && verificationRowIndex < holdReasonRowIndex);
});

test("dashboard and mobile use production nextAction when stale observation needs clearer evidence guidance", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const mobileSource = await fs.readFile("app/mobile/src/main.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const statusSource = appSource.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.match(
    statusSource,
    /productionObservation\?\.status === "stale"[\s\S]*productionStatus\?\.nextAction/,
  );
  assert.match(
    mobileSource,
    /productionObservation\?\.status === "stale"[\s\S]*productionStatus\?\.nextAction/,
  );
});

test("dashboard uses structured maturity instead of parsing production prose", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const statusSource = appSource.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.match(statusSource, /productionStatus\?\.maturity/);
  assert.match(statusSource, /maturity\?\.label/);
  assert.match(statusSource, /maturity\?\.percent/);
  assert.match(statusSource, /maturity\?\.canLongRun/);
  assert.match(statusSource, /生产成熟度/);
  assert.match(statusSource, /剩余缺口/);
});

test("dashboard shows closed-loop evidence progress before long-running use", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const statusSource = appSource.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.match(statusSource, /closedLoopCount/);
  assert.match(statusSource, /closedLoopTarget/);
  assert.match(statusSource, /productionStatus\?\.closedLoopEvidence/);
  assert.match(statusSource, /闭环证据/);
  assert.match(statusSource, /closed-loop-evidence/);
  assert.match(statusSource, /还差.*轮|已达到长期运行基本证据/);
  assert.match(stylesSource, /\.closed-loop-evidence/);
  assert.match(stylesSource, /\.closed-loop-evidence-bar/);
});

test("dashboard shows guidance merge evidence before long-running use", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const statusSource = appSource.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.match(statusSource, /productionStatus\?\.guidanceEvidence/);
  assert.match(statusSource, /guidanceEvidenceCount/);
  assert.match(statusSource, /guidanceEvidenceTarget/);
  assert.match(statusSource, /补充合并证据/);
  assert.match(statusSource, /用户补充|补充引导/);
});

test("dashboard folds the next real closed-loop evidence plan into status details", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const statusSource = appSource.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.match(statusSource, /closedLoopEvidence\.evidencePlan/);
  assert.match(statusSource, /evidencePlanSteps/);
  assert.match(statusSource, /下一轮验证/);
  assert.match(statusSource, /确认目标/);
  assert.match(statusSource, /发送一轮/);
  assert.match(statusSource, /等待 Codex 完成/);
  assert.match(statusSource, /NPC 复盘/);
  assert.match(statusSource, /重新检查/);
  assert.match(statusSource, /status-detail-fold/);
  assert.doesNotMatch(appSource, /closed-loop-plan-card/);
});

test("dashboard surfaces supervisor review without adding noisy debug cards", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /processStatus\?\.hasSupervisorReview/);
  assert.match(appSource, /processStatus\?\.supervisorReview/);
  assert.match(appSource, /processStatus\?\.supervisorInstructionPreview/);
  assert.match(appSource, /processStatus\?\.supervisorPerspectiveRows/);
  assert.match(appSource, /监督复盘/);
  assert.match(appSource, /NPC 视角/);
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

test("dashboard keeps next action primary and folds independent verification details (legacy assertion kept for reference)", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  const modernNextActionRowIndex = appSource.indexOf('processStatus?.nextAction ? ["下一步", processStatus.nextAction] : null');
  const modernProductionJudgmentRowIndex = appSource.indexOf('productionFocus.summary ? ["生产判断", productionFocus.summary] : null');
  const modernModelPipelineRowIndex = appSource.indexOf('modelPipeline.headline ? ["模型链路", modelPipeline.headline] : null');
  const modernPrimaryLabelsIndex = appSource.indexOf('const primaryLabels = new Set(["当前", "说明", "下一步"])');
  const modernDetailRowsIndex = appSource.indexOf("const detailRows = [");
  const modernVerificationRowIndex = appSource.indexOf('verificationText ? ["独立验收"');
  const modernHoldReasonRowIndex = appSource.indexOf("processStatus?.holdReason");

  assert.notEqual(modernNextActionRowIndex, -1);
  assert.notEqual(modernProductionJudgmentRowIndex, -1);
  assert.notEqual(modernModelPipelineRowIndex, -1);
  assert.notEqual(modernPrimaryLabelsIndex, -1);
  assert.notEqual(modernDetailRowsIndex, -1);
  assert.notEqual(modernVerificationRowIndex, -1);
  assert.notEqual(modernHoldReasonRowIndex, -1);
  assert.ok(modernNextActionRowIndex < modernPrimaryLabelsIndex);
  assert.ok(modernPrimaryLabelsIndex < modernDetailRowsIndex);
  assert.ok(modernDetailRowsIndex < modernProductionJudgmentRowIndex);
  assert.ok(modernDetailRowsIndex < modernModelPipelineRowIndex);
  assert.ok(modernDetailRowsIndex < modernVerificationRowIndex && modernVerificationRowIndex < modernHoldReasonRowIndex);
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

test("dashboard and mobile status show the latest Codex summary source", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const mobileAppSource = await fs.readFile("app/mobile/src/main.jsx", "utf8");
  const statusStart = appSource.indexOf("function StatusSummaryPanel");
  const statusEnd = appSource.indexOf("const StatusSummaryPanelV2", statusStart);
  const mobileStart = appSource.indexOf("function MobileTaskApp");
  const mobileEnd = appSource.indexOf("function DesktopConsoleApp", mobileStart);
  const statusSource = appSource.slice(statusStart, statusEnd);
  const mobileSource = appSource.slice(mobileStart, mobileEnd);

  assert.notEqual(statusStart, -1);
  assert.notEqual(mobileStart, -1);
  assert.match(statusSource, /latestCodexSummarySourceLabel/);
  assert.match(statusSource, /回复摘要/);
  assert.match(mobileSource, /latestCodexSummarySourceLabel/);
  assert.match(mobileSource, /回复摘要/);
  assert.match(mobileAppSource, /latestCodexSummarySourceLabel/);
  assert.match(mobileAppSource, /回复摘要/);
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
  assert.match(appSource, /移动端使用/);
  assert.match(appSource, /remoteAccessStatus\?\.mobileAppUrl\s*\|\|\s*remoteAccessStatus\?\.primaryMobileUrl/);
  assert.match(appSource, /remoteAccessStatus\?\.statusText/);
  assert.match(appSource, /remoteAccessStatus\?\.nextAction/);
  assert.match(appSource, /remoteAccessStatus\?\.mobileUrlHint/);
  assert.match(appSource, /remoteAccessStatus\?\.candidateUrls/);
  assert.match(appSource, /copyTextToClipboard\(candidate\.appUrl \|\| candidate\.url\)/);
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
  assert.match(appSource, /remoteAccessStatus\?\.mobileAppUrl\s*\|\|\s*remoteAccessStatus\?\.primaryMobileUrl/);
  assert.match(appSource, /onCreateDevicePairingSession=\{createDevicePairingSession\}/);
  assert.match(appSource, /onCreatePairingSession=\{onCreateDevicePairingSession\}/);
  assert.match(appSource, /remoteAccessStatus\?\.devicePairing\?\.summary/);
  assert.match(appSource, /remoteAccessStatus\?\.pairingAction/);
  assert.match(appSource, /移动端使用/);
  assert.match(appSource, /长期绑定/);
  assert.match(appSource, /重启后不用重复扫码/);
  assert.match(appSource, /pairingSession\?\.pairingCode/);
  assert.match(appSource, /pairingSession\?\.browserPairingUrl/);
  assert.match(appSource, /pairingSession\?\.qrPayload/);
  assert.match(appSource, /备用绑定方式/);
  assert.match(appSource, /手机扫码后会自动打开绑定页；如果扫码失败，可以展开备用方式。/);
  assert.match(appSource, /QRCode\.toDataURL/);
  assert.match(appSource, /pairingQrDataUrl/);
  assert.match(appSource, /alt="手机扫码绑定"/);
  assert.match(appSource, /复制配对码/);
  assert.match(appSource, /复制链接/);
  assert.match(appSource, /复制内容/);
  assert.match(stylesSource, /\.mobile-pairing-panel/);
  assert.match(stylesSource, /\.mobile-pairing-backup/);
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
  assert.match(appSource, /onRevokePairedDevice=\{onRevokePairedDevice\}/);
  assert.match(stylesSource, /\.mobile-pairing-devices/);
  assert.match(stylesSource, /\.mobile-pairing-audit/);
});

test("dashboard home uses passed-in pairing handlers and guidance status instead of outer-scope names", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /function DashboardHome\(\{[\s\S]*guidanceStatusMessage,/);
  assert.match(appSource, /function DashboardHome\(\{[\s\S]*onCreateDevicePairingSession,/);
  assert.match(appSource, /function DashboardHome\(\{[\s\S]*onRevokePairedDevice,/);
  assert.match(appSource, /guidanceStatusMessage=\{guidanceStatusMessage\}/);
  assert.match(appSource, /onCreatePairingSession=\{onCreateDevicePairingSession\}/);
  assert.match(appSource, /onRevokePairedDevice=\{onRevokePairedDevice\}/);
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

test("dashboard checks production preflight before starting a real loop", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const actionStart = appSource.indexOf('if (actionId === "start-loop")');
  const actionEnd = appSource.indexOf('if (actionId === "stop-loop")', actionStart);
  const actionSource = appSource.slice(actionStart, actionEnd);
  const preflightIndex = actionSource.indexOf('requestJson("/production-preflight")');
  const startIndex = actionSource.indexOf('requestJson("/start"');

  assert.notEqual(actionStart, -1);
  assert.notEqual(actionEnd, -1);
  assert.notEqual(preflightIndex, -1);
  assert.notEqual(startIndex, -1);
  assert.ok(
    preflightIndex < startIndex,
    "开始循环必须先刷新真实循环前预检，再调用真实启动接口。",
  );
  assert.match(actionSource, /setProductionPreflight/);
  assert.match(actionSource, /canDispatch/);
  assert.match(actionSource, /暂不建议启动真实循环/);
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

test("dashboard prefers shared conversation items and renders collapsible Codex details", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");
  const mobileSource = await fs.readFile("app/mobile/src/main.jsx", "utf8");
  const mobileStylesSource = await fs.readFile("app/mobile/src/styles.css", "utf8");

  assert.match(appSource, /from "\.\.\/\.\.\/shared\/conversation-format\.mjs"/);
  assert.match(appSource, /from "\.\.\/\.\.\/shared\/conversation-items\.mjs"/);
  assert.match(appSource, /splitMarkdownBlocks/);
  assert.match(appSource, /parseMarkdownTextBlock/);
  assert.match(appSource, /getConversationDetailLabel/);
  assert.match(appSource, /getConversationDetailMeta/);
  assert.match(appSource, /buildConversationItemsFromMobileView/);
  assert.doesNotMatch(appSource, /const detailLabel = \(block\) =>/);
  assert.doesNotMatch(appSource, /const detailMeta = \(block\) =>/);
  assert.match(appSource, /mobileView\?\.conversationItems/);
  assert.match(appSource, /detailBlocks/);
  assert.match(appSource, /conversation-detail-block/);
  assert.match(appSource, /collapsedByDefault/);
  assert.match(appSource, /block\.displayLabel \|\| block\.summary/);
  assert.match(appSource, /copyTargets/);
  assert.match(appSource, /countLabel/);
  assert.match(appSource, /conversation-detail-meta/);
  assert.match(appSource, /复制命令/);
  assert.match(appSource, /复制文件/);
  assert.match(appSource, /script_snippet/);
  assert.match(appSource, /脚本内容/);
  assert.match(mobileSource, /copyTargets/);
  assert.match(mobileSource, /countLabel/);
  assert.match(mobileSource, /conversation-detail-meta/);
  assert.match(mobileSource, /block\.displayLabel \|\| block\.summary/);
  assert.match(mobileSource, /复制命令/);
  assert.match(mobileSource, /复制文件/);
  assert.match(mobileSource, /script_snippet/);
  assert.match(mobileSource, /脚本内容/);
  assert.match(stylesSource, /\.conversation-detail-block/);
  assert.match(stylesSource, /\.conversation-detail-actions/);
  assert.match(stylesSource, /\.conversation-detail-body/);
  assert.match(mobileStylesSource, /\.conversation-detail-actions/);
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
  assert.match(sidebarSource, /aria-label=\{`管理项目 \$\{projectName\}`\}/);
  assert.match(sidebarSource, /sidebar-loop-name/);
  assert.doesNotMatch(sidebarSource, /formatValue\(loop\.branch,\s*"dev"\)/);
  assert.doesNotMatch(sidebarSource, />管理</);
  assert.match(sidebarSource, /aria-label=\{`管理任务 \$\{loop\.name\}`\}/);
  assert.ok(footerSource.indexOf("帮助") >= 0);
  assert.ok(footerSource.indexOf("设置") >= 0);
  assert.ok(footerSource.indexOf("帮助") < footerSource.indexOf("设置"));
  assert.match(stylesSource, /\.sidebar-action-grid/);
  assert.match(stylesSource, /\.sidebar-footer-button/);
  assert.match(stylesSource, /\.sidebar-project-row/);
  assert.match(stylesSource, /\.sidebar-project-tools/);
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
  assert.match(sidebarSource, /在这个项目下新建任务/);
  assert.match(sidebarSource, /删除这个项目/);
  assert.match(appSource, /requestJson\("\/projects\/delete"/);
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
  const openCreatePaneEnd = appSource.indexOf("async function openTaskCreationForProject", openCreatePaneStart);
  const openCreatePaneSource = appSource.slice(openCreatePaneStart, openCreatePaneEnd);

  assert.notEqual(sidebarStart, -1);
  assert.notEqual(actionGridStart, -1);
  assert.notEqual(collapsedStart, -1);
  assert.notEqual(openCreatePaneEnd, -1);
  assert.match(actionGridSource, /aria-label="新建任务"/);
  assert.match(actionGridSource, /创建任务/);
  assert.match(actionGridSource, /sidebar-action-icon/);
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
  assert.match(paneSource, /assistant-prefill-hint/);
  assert.match(workspaceSource, /nextAssistantState\?\.status === "completed"/);
  assert.match(workspaceSource, /setActiveSidebarPane\("loops"\)/);
});

test("project menu can open task creation with project context prefilled", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /async function openTaskCreationForProject/);
  assert.match(appSource, /setProjectCreationDraft\(\{/);
  assert.match(appSource, /projectName,/);
  assert.match(appSource, /workspaceRoot,/);
  assert.match(appSource, /requestJson\("\/loop-creation-assistant\/reset"/);
  assert.match(appSource, /body: JSON\.stringify\(\{\s*projectName,\s*workspaceRoot,\s*\}\)/);
  assert.match(appSource, /将直接在项目「\$\{projectCreationDraft\.projectName\}」下创建任务/);
});

test("manage workspace view is framed as current-task settings instead of generic global settings", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /workspace-focus-eyebrow">当前任务设置/);
  assert.match(appSource, /调整「\{currentLoopName\}」/);
  assert.match(appSource, /保存默认规则/);
  assert.match(appSource, /这里是工作区默认规则/);
  assert.match(appSource, /当前任务操作/);
  assert.match(appSource, /删除当前任务/);
});

test("run and safety fold keeps developer-style connection details collapsed by default", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /<Metric label="手机查看" value=\{remoteAccessStatus\?\.mobileReachable \? "已就绪" : "待确认"\} \/>/);
  assert.match(appSource, /<summary>连接细节<\/summary>/);
  assert.match(appSource, /<Metric label="连接方式" value=\{remoteTransport \|\| "未识别"\} \/>/);
  assert.match(appSource, /<Metric label="控制台地址" value=\{launcherWebUrl \|\| "未提供"\} \/>/);
  assert.doesNotMatch(appSource, /<Metric label="远程访问" value=\{remoteTransport\} \/>/);
});

test("loop deletion can switch away before removing the currently active task", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /async function switchLoop\(loopId\)/);
  assert.match(appSource, /async function deleteLoopFromSidebar\(loop = \{\}\)/);
  assert.match(appSource, /const alternativeLoop = visibleLoops\.find\(\(item\) => item\.id !== loopId\)/);
  assert.match(appSource, /if \(loopId === \(currentLoop\?\.id \|\| loopRegistry\.currentLoopId\)\) \{/);
  assert.match(appSource, /await switchLoop\(alternativeLoop\.id\)/);
});

test("dashboard stop and idle copy no longer imply automatic looping by default", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /"手动监控中"/);
  assert.match(appSource, /"等待启动"/);
  assert.match(appSource, /当前不会自动续跑；你可以先查看记录，或手动发送一条补充引导。/);
  assert.match(appSource, /"尚未绑定线程"/);
  assert.match(appSource, /const canStartAutomaticLoop = Boolean\(snapshot\?\.thread\?\.threadId\)/);
  assert.match(appSource, /title=\{canStartAutomaticLoop \? "开始自动循环" : "请先绑定线程，或等待当前状态结束后再启动自动循环"\}/);
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
  assert.match(appSource, /备用绑定入口/);
  assert.match(appSource, /绑定链接或二维码内容/);
  assert.match(appSource, /会话编号/);
  assert.match(appSource, /确认码/);
  assert.doesNotMatch(appSource, /placeholder="配对会话"/);
  assert.doesNotMatch(appSource, /placeholder="配对码"/);
  assert.match(appSource, /MobileConversationTimeline/);
  assert.match(stylesSource, /\.mobile-task-shell/);
  assert.match(stylesSource, /\.mobile-task-composer/);
  assert.match(stylesSource, /\.mobile-task-pairing/);
});

test("mobile route mirrors production judgment and model pipeline status", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");
  const mobileStart = appSource.indexOf("function MobileTaskApp");
  const mobileEnd = appSource.indexOf("function DesktopConsoleApp", mobileStart);
  const mobileSource = appSource.slice(mobileStart, mobileEnd);

  assert.notEqual(mobileStart, -1);
  assert.match(mobileSource, /requestJson\("\/production-status"\)\.catch/);
  assert.match(mobileSource, /requestJson\("\/production-preflight"\)\.catch/);
  assert.match(mobileSource, /mobileProductionStatus/);
  assert.match(mobileSource, /mobileProductionPreflight/);
  assert.match(mobileSource, /buildProductionFocusSummary/);
  assert.match(mobileSource, /buildModelPipelineSummary/);
  assert.match(mobileSource, /生产判断/);
  assert.match(mobileSource, /模型链路/);
  assert.match(mobileSource, /模型说明/);
  assert.match(stylesSource, /\.mobile-task-panel-details/);
  assert.match(stylesSource, /\.mobile-task-panel-detail-list/);
});

test("mobile guidance uses server dispatch result instead of a fixed saved message", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const mobileAppSource = await fs.readFile("app/mobile/src/main.jsx", "utf8");
  const mobileStart = appSource.indexOf("function MobileTaskApp");
  const mobileEnd = appSource.indexOf("function DesktopConsoleApp", mobileStart);
  const mobileSource = appSource.slice(mobileStart, mobileEnd);

  assert.notEqual(mobileStart, -1);
  assert.match(mobileSource, /const guidanceResult = await requestJson\("\/mobile\/guidance"/);
  assert.match(mobileSource, /guidanceResult\?\.message/);
  assert.match(mobileSource, /guidanceResult\?\.dispatch === "sent"/);
  assert.match(mobileSource, /pendingGuidance\.userMessage/);
  assert.match(mobileSource, /pendingGuidance\.statusLabel/);
  assert.match(mobileSource, /pendingGuidance\.statusDetail/);
  assert.match(mobileSource, /pendingGuidance\.actionLabel/);
  assert.match(mobileAppSource, /pending\.userMessage/);
  assert.match(mobileAppSource, /pending\.statusLabel/);
  assert.match(mobileAppSource, /pending\.statusDetail/);
  assert.match(mobileAppSource, /pending\.actionLabel/);
  assert.match(mobileAppSource, /本地模型|NPC/);
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
