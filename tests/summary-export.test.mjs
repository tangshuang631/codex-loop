import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createLoop,
  ensureLoopArtifacts,
  exportMobileView,
  exportLoopSummary,
  markContinuationFailed,
  readLoopSnapshot,
  recordHeartbeat,
  reviewCodexMilestone,
  runLoopTurn,
  saveThreadBinding,
  savePendingGuidance,
  selectLoop,
  startRun,
  requestGracefulStop,
  updateBudgets,
  syncCodexThreadMirror,
} from "../app/server/lib/runtime-store.mjs";
import { saveUserOverrides } from "../app/server/lib/adapter-store.mjs";
import { writeLauncherStatus } from "../app/server/lib/launcher-status.mjs";

async function createWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-summary-"));
  const configRoot = path.join(tempRoot, "workspace");
  await fs.mkdir(path.join(configRoot, "codex_loop"), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      {
        projectName: "demo",
        branch: "dev",
        currentRunId: "run-summary",
        budgets: {
          maxMinutes: 120,
          maxTokens: 50000,
          finalizeLeadMinutes: 15,
          finalizeLeadTokens: 5000,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return configRoot;
}

test("exportLoopSummary writes mobile-friendly summary json", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "\u8bc4\u4f30\u957f\u65f6\u5f00\u53d1\u65b9\u6848",
    threadId: "thread-123",
    singleThreadMode: true,
  });
  await recordHeartbeat(configRoot, {
    activeTask: "Tighten summary export",
    note: "Focused verification green",
    progressSummary: "Added lightweight summary payload",
    consumedTokens: 4200,
  });

  const exported = await exportLoopSummary(configRoot);

  assert.equal(exported.workspaceName, "demo");
  assert.equal(exported.threadTitle, "\u8bc4\u4f30\u957f\u65f6\u5f00\u53d1\u65b9\u6848");
  assert.equal(exported.activeTask, "Tighten summary export");
  assert.equal(exported.recentSummary, "Added lightweight summary payload");
  assert.equal(exported.modeLabel, "\u8fd0\u884c\u4e2d");

  const summaryPath = path.join(
    snapshot.paths.runtimeDir,
    "summary.json",
  );
  const summaryText = await fs.readFile(summaryPath, "utf8");
  assert.match(summaryText, /"threadId": "thread-123"/);
});

test("exportMobileView returns recent transcript entries for mobile readers", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await writeLauncherStatus(configRoot, {
    phase: "ready",
    apiPort: 3000,
    webPort: 3001,
    apiBaseUrl: "http://127.0.0.1:3000/api",
    webUrl: "http://127.0.0.1:3001",
    serverReady: true,
    webReady: true,
    note: "launcher ready",
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "评估长时开发方案",
    threadId: "thread-123",
    singleThreadMode: true,
  });
  await recordHeartbeat(configRoot, {
    activeTask: "Review mobile transcript",
    note: "Verification still green",
    progressSummary: "Prepared a mobile-friendly activity feed",
    consumedTokens: 5200,
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.loop.id, "run-summary");
  assert.equal(mobile.thread.threadId, "thread-123");
  assert.equal(mobile.summary.recentSummary, "Prepared a mobile-friendly activity feed");
  assert.equal(mobile.transcriptEntries.length > 0, true);
  assert.equal(mobile.transcriptEntries[0].activeTask, "Review mobile transcript");
  assert.equal(mobile.launcher.phase, "ready");
  assert.equal(mobile.launcher.webUrl, "http://127.0.0.1:3001");
  assert.match(mobile.bindingNote, /thread-123/);
  assert.match(mobile.suggestedAction, /\u7b49\u5f85|\u7eed\u8dd1|\u7ed1\u5b9a/);
  assert.match(mobile.strategy.contextCard.whyContinue, /继续|Review mobile transcript|暂无/);
  assert.ok(mobile.strategy.guardrailCard.stopRule);
  assert.equal(Array.isArray(mobile.codexConversation.entries), true);
});

test("exportMobileView returns shared Codex-style conversation items with collapsed details", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端远程监控",
    threadId: "thread-shared-conversation",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await recordHeartbeat(configRoot, {
    activeTask: "实现移动端历史对话",
    progressSummary: "把网页端和移动端历史记录统一成 Codex 风格对话流。",
    note: "共享对话模型",
  });
  const threadMirror = JSON.parse(await fs.readFile(snapshot.paths.threadPath, "utf8"));
  await fs.writeFile(
    snapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...threadMirror,
        lastDispatchAt: "2026-06-10T10:09:00.000Z",
        lastDispatchPrompt: "请继续实现移动端历史对话，把网页端和 App 都改成 Codex 风格对话流。",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.appendFile(
    snapshot.paths.logPath,
    `${JSON.stringify({
      type: "codex_conversation_mirror_synced",
      at: "2026-06-10T10:10:00.000Z",
      latestAssistantPreview: "已修改 app/web/src/App.jsx，并运行 npm run build:mobile 验证通过。",
    })}\n${JSON.stringify({
      type: "heartbeat",
      at: "2026-06-10T10:11:00.000Z",
      activeTask: "验证历史对话",
      progressSummary: "命令输出：npm run build:mobile\n\n> build:mobile\n> vite build --config app/mobile/vite.config.mjs\n\n✓ built in 1.2s",
    })}\n`,
    "utf8",
  );

  const mobile = await exportMobileView(configRoot);

  assert.equal(Array.isArray(mobile.conversationItems), true);
  assert.equal(mobile.conversationItems.length >= 2, true);
  assert.ok(
    mobile.conversationItems.some((item) => item.role === "loop" && item.align === "right"),
    "codex-loop 发出的指令应该作为右侧对话项统一输出。",
  );
  assert.ok(
    mobile.conversationItems.some((item) => item.role === "codex" && item.align === "left"),
    "Codex 回复应该作为左侧对话项统一输出。",
  );
  const detailItem = mobile.conversationItems.find((item) => item.detailBlocks?.length);
  assert.ok(detailItem, "长命令、文件改动或测试日志应默认收纳成详情块。");
  assert.equal(detailItem.detailBlocks[0].collapsedByDefault, true);
  assert.match(detailItem.detailBlocks[0].kind, /command_output|file_change|test_log|runtime_detail/);
  assert.match(detailItem.detailBlocks[0].title, /已运行|已编辑|验证|运行详情|截图/);
  assert.match(detailItem.detailBlocks[0].countLabel, /\d+ 条命令|\d+ 个文件|\d+ 条日志|\d+ 张截图|\d+ 条详情/);
  assert.match(detailItem.detailBlocks[0].displayLabel, /已运行|已编辑|验证|运行详情|截图/);
  assert.match(detailItem.detailBlocks[0].summary, /命令|文件|验证|详情|日志/);
  assert.match(detailItem.detailBlocks[0].text, /npm run build:mobile|app\/web\/src\/App\.jsx/);
  assert.ok(
    detailItem.detailBlocks[0].copyTargets?.some((target) => target.kind === "command" && /npm run build:mobile/.test(target.value)),
    "详情块应该把运行命令提取成可复制操作，避免用户只能从大段日志里手动选择。",
  );
  assert.ok(
    detailItem.detailBlocks[0].copyTargets?.some((target) => target.kind === "file" && /app\/web\/src\/App\.jsx/.test(target.value)),
    "详情块应该把文件路径提取成可复制操作，接近 Codex 桌面端的文件引用体验。",
  );
});

test("exportMobileView collapses script snippets as Codex-style script details", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "脚本详情渲染",
    threadId: "thread-script-details",
    singleThreadMode: true,
  });
  await fs.appendFile(
    snapshot.paths.logPath,
    `${JSON.stringify({
      type: "codex_conversation_mirror_synced",
      at: "2026-06-10T10:20:00.000Z",
      latestAssistantPreview:
        "已补充脚本验证：```powershell\nnpm run build:mobile\nnode --test tests/summary-export.test.mjs\n```\n涉及 app/mobile/src/main.jsx 和 scripts/frontend-evidence-check.mjs。",
    })}\n`,
    "utf8",
  );

  const mobile = await exportMobileView(configRoot);
  const scriptItem = mobile.conversationItems.find((item) =>
    item.detailBlocks?.some((block) => block.kind === "script_snippet"),
  );

  assert.ok(scriptItem, "包含脚本片段的 Codex 回复应该默认折叠为脚本内容详情。");
  const scriptBlock = scriptItem.detailBlocks.find((block) => block.kind === "script_snippet");
  assert.equal(scriptBlock.collapsedByDefault, true);
  assert.equal(scriptBlock.title, "脚本内容");
  assert.match(scriptBlock.displayLabel, /脚本内容/);
  assert.match(scriptBlock.summary, /脚本内容/);
  assert.ok(
    scriptBlock.copyTargets.some((target) => target.kind === "command" && /npm run build:mobile/.test(target.value)),
    "脚本详情应保留可复制命令。",
  );
  assert.ok(
    scriptBlock.copyTargets.some((target) => target.kind === "file" && /app\/mobile\/src\/main\.jsx/.test(target.value)),
    "脚本详情应保留可复制文件路径。",
  );
});

test("exportMobileView splits mixed Codex details into file command and screenshot blocks", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "复杂历史渲染",
    threadId: "thread-mixed-details",
    singleThreadMode: true,
  });
  await fs.appendFile(
    snapshot.paths.logPath,
    `${JSON.stringify({
      type: "codex_conversation_mirror_synced",
      at: "2026-06-10T10:30:00.000Z",
      latestAssistantPreview: [
        "已完成移动端历史渲染优化。",
        "编辑文件：app/web/src/App.jsx、app/mobile/src/main.jsx。",
        "已运行命令：npm run build:mobile。",
        "截图证据：runtime/screenshots/mobile-history.png。",
      ].join("\n"),
    })}\n`,
    "utf8",
  );

  const mobile = await exportMobileView(configRoot);
  const detailItem = mobile.conversationItems.find((item) =>
    item.detailBlocks?.some((block) => /app\/web\/src\/App\.jsx/.test(block.text || "")),
  );

  assert.ok(detailItem, "混合回复应该保留为 Codex 对话项。");
  const kinds = detailItem.detailBlocks.map((block) => block.kind);
  assert.ok(kinds.includes("file_change"), "文件改动应该单独成为可展开详情块。");
  assert.ok(kinds.includes("command_output"), "已运行命令应该单独成为可展开详情块。");
  assert.ok(kinds.includes("screenshot"), "截图证据应该单独成为可展开详情块。");
  assert.ok(
    detailItem.detailBlocks.some((block) =>
      block.copyTargets?.some((target) => target.kind === "file" && target.value === "app/web/src/App.jsx"),
    ),
    "文件详情块应该提供可复制文件路径。",
  );
  assert.ok(
    detailItem.detailBlocks.some((block) =>
      block.copyTargets?.some((target) => target.kind === "command" && target.value === "npm run build:mobile"),
    ),
    "命令详情块应该提供可复制命令。",
  );
  assert.ok(
    detailItem.detailBlocks.every((block) => block.collapsedByDefault === true),
    "复杂详情默认折叠，避免移动端被日志刷屏。",
  );
});

test("exportMobileView returns readable runtime events for mobile monitoring", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "\u79fb\u52a8\u7aef\u76d1\u63a7\u7ebf\u7a0b",
    threadId: "thread-readable-events",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await savePendingGuidance(configRoot, {
    text: "\u4e0b\u4e00\u8f6e\u4f18\u5148\u68c0\u67e5\u79fb\u52a8\u7aef\u72b6\u6001\u6458\u8981\u3002",
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(Array.isArray(mobile.runtimeEvents), true);
  assert.equal(mobile.runtimeEvents.length >= 2, true);
  assert.match(
    mobile.runtimeEvents.map((event) => event.title).join("\n"),
    /\u5df2\u5f00\u59cb\u5faa\u73af/,
  );
  assert.match(
    mobile.runtimeEvents.map((event) => event.title).join("\n"),
    /\u5df2\u8bb0\u5f55\u4e0b\u4e00\u8f6e\u8865\u5145/,
  );
  assert.doesNotMatch(mobile.runtimeEvents[0].title, /_/);
});

test("exportMobileView backfills useful runtime records when recent log lines are duplicate sync noise", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "重复记录回看",
    threadId: "thread-runtime-backfill",
    singleThreadMode: true,
  });

  const oldUsefulEvent = {
    type: "heartbeat",
    at: "2026-06-09T00:00:00.000Z",
    progressSummary: "早一点的真实进展仍然应该能看到。",
  };
  const duplicateEvents = Array.from({ length: 50 }, (_, index) => ({
    type: "codex_conversation_mirror_synced",
    at: `2026-06-09T00:01:${String(index).padStart(2, "0")}.000Z`,
    threadId: "thread-runtime-backfill",
    latestAssistantAt: "2026-06-09T00:01:00.000Z",
    latestAssistantPreview: "重复同步内容不应该挤掉更早的唯一记录。",
  }));

  await fs.appendFile(
    snapshot.paths.logPath,
    [oldUsefulEvent, ...duplicateEvents].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const mobile = await exportMobileView(configRoot);
  const details = mobile.runtimeEvents.map((event) => event.detail).join("\n");

  assert.match(details, /早一点的真实进展/);
  assert.equal(
    mobile.runtimeEvents.filter((event) => /重复同步内容/.test(event.detail)).length,
    1,
  );
});

test("exportMobileView returns a direct process status for production monitoring", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "\u79fb\u52a8\u7aef\u8fdb\u7a0b\u76d1\u63a7",
    threadId: "thread-process-status",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await savePendingGuidance(configRoot, {
    text: "\u4e0b\u4e00\u8f6e\u5148\u68c0\u67e5\u79fb\u52a8\u7aef\u8fdb\u7a0b\u72b6\u6001\u5c55\u793a\u3002",
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.state, "waiting_next_turn");
  assert.equal(mobile.processStatus.monitorLevel, "ready");
  assert.equal(mobile.processStatus.monitorLabel, "可继续");
  assert.equal(mobile.processStatus.monitorTone, "ready");
  assert.equal(mobile.processStatus.canSendNextTurn, true);
  assert.equal(mobile.processStatus.waitingForCodex, false);
  assert.equal(mobile.processStatus.hasPendingGuidance, true);
  assert.match(mobile.processStatus.headline, /\u7b49\u5f85\u4e0b\u4e00\u8f6e/);
  assert.match(mobile.processStatus.detail, /\u53ef\u4ee5.*\u53d1\u9001|\u4e0b\u4e00\u8f6e/);
  assert.match(mobile.processStatus.pendingGuidancePreview, /\u79fb\u52a8\u7aef\u8fdb\u7a0b\u72b6\u6001/);
  assert.equal(mobile.processStatus.pendingGuidanceMergeTiming, "codex_completed");
  assert.equal(mobile.processStatus.pendingGuidanceMergeProcessor, "ollama_npc");
  assert.match(mobile.processStatus.pendingGuidanceMergeLabel, /本地模型|NPC|Ollama/);
  assert.match(mobile.processStatus.pendingGuidanceMergeDetail, /Codex.*完成|合并/);
  assert.match(mobile.processStatus.stopLimit, /\u6700\u957f.*\u5206\u949f/);
  assert.match(mobile.processStatus.stopLimit, /token/);
  assert.match(
    mobile.runtimeEvents.map((event) => `${event.title} ${event.detail}`).join("\n"),
    /等待本地模型|NPC|合并/,
  );
  assert.match(
    mobile.runtimeEvents.map((event) => `${event.title} ${event.detail}`).join("\n"),
    /补充：.*移动端进程状态/,
  );
});

test("exportMobileView blocks next turn when stop limits are already reached", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端停止条件",
    threadId: "thread-process-budget",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await recordHeartbeat(configRoot, {
    activeTask: "检查移动端停止条件",
    note: "已消耗一批 token",
    progressSummary: "当前任务仍在推进，但预算已经接近或达到限制。",
    consumedTokens: 4200,
  });
  await updateBudgets(configRoot, {
    maxMinutes: 120,
    maxTokens: 4200,
    finalizeLeadMinutes: 0,
    finalizeLeadTokens: 0,
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.state, "budget_blocked");
  assert.equal(mobile.processStatus.monitorLabel, "已到限制");
  assert.equal(mobile.processStatus.monitorTone, "warning");
  assert.equal(mobile.processStatus.canSendNextTurn, false);
  assert.match(mobile.processStatus.holdReason, /停止条件|预算|token/);
  assert.match(mobile.processStatus.nextAction, /停止|调整.*设置|重新开始/);
});

test("exportMobileView shows when the latest instruction used Ollama", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端模型来源",
    threadId: "thread-process-ollama-source",
    singleThreadMode: true,
  });
  await startRun(configRoot);

  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () =>
      "本轮由本地模型整理 Codex 回复和用户补充后生成，请继续做移动端状态验收。",
    dispatchThreadMessage: async () => ({
      deliveryObserved: true,
      completionObserved: false,
      lastMessage: "",
    }),
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.latestInstructionSource, "ollama");
  assert.equal(mobile.processStatus.latestInstructionSourceLabel, "本地模型生成");
  assert.equal(mobile.processStatus.latestInstructionSourceTone, "ready");
  assert.match(mobile.processStatus.latestInstructionSourceDetail, /Ollama|NPC|本地模型/);
});

test("exportMobileView shows when Ollama auto mode fell back to template", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端模型降级",
    threadId: "thread-process-template-source",
    singleThreadMode: true,
  });
  await startRun(configRoot);

  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => {
      throw new Error("ollama unavailable");
    },
    dispatchThreadMessage: async () => ({
      deliveryObserved: true,
      completionObserved: false,
      lastMessage: "",
    }),
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.latestInstructionSource, "template");
  assert.equal(mobile.processStatus.latestInstructionSourceLabel, "模板降级");
  assert.equal(mobile.processStatus.latestInstructionSourceTone, "warning");
  assert.match(mobile.processStatus.latestInstructionSourceDetail, /Ollama.*不可用|降级/);
});

test("exportMobileView blocks next turn when required rule docs are missing", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const missingRuleDoc = path.join(configRoot, "docs", "RULES.md");
  await fs.mkdir(path.dirname(missingRuleDoc), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      {
        projectName: "demo",
        branch: "dev",
        currentRunId: "run-summary",
        workspaceRoot: configRoot,
        startContextPaths: [missingRuleDoc],
        budgets: {
          maxMinutes: 120,
          maxTokens: 50000,
          finalizeLeadMinutes: 15,
          finalizeLeadTokens: 5000,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "缺失规则文档线程",
    threadId: "thread-context-health",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await savePendingGuidance(configRoot, {
    text: "等当前轮完成后，请把移动端对话流再压缩一点。",
  });

  const mobile = await exportMobileView(configRoot);

  assert.match(mobile.health.issues.join(","), /context:missing/);
  assert.equal(mobile.processStatus.state, "health_blocked");
  assert.equal(mobile.processStatus.monitorLevel, "blocked");
  assert.equal(mobile.processStatus.monitorLabel, "需处理");
  assert.equal(mobile.processStatus.monitorTone, "warning");
  assert.equal(mobile.processStatus.canSendNextTurn, false);
  assert.match(mobile.processStatus.headline, /需要处理/);
  assert.match(mobile.processStatus.holdReason, /规则|文档/);
  assert.match(mobile.processStatus.nextAction, /恢复|重新配置/);
});

test("exportMobileView blocks next turn when project workspace is missing", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const missingWorkspaceRoot = path.join(configRoot, "missing-project");
  await createLoop(configRoot, {
    loopName: "缺失项目路径",
    runId: "missing-workspace-loop",
    threadTitle: "缺失项目路径线程",
    workspaceRoot: missingWorkspaceRoot,
  });
  await selectLoop(configRoot, { loopId: "missing-workspace-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "缺失项目路径线程",
    threadId: "thread-workspace-health",
    singleThreadMode: true,
  });
  await startRun(configRoot);

  const mobile = await exportMobileView(configRoot);

  assert.match(mobile.health.issues.join(","), /workspace:missing/);
  assert.equal(mobile.processStatus.state, "health_blocked");
  assert.equal(mobile.processStatus.canSendNextTurn, false);
  assert.match(mobile.processStatus.headline, /需要处理/);
  assert.match(mobile.processStatus.holdReason, /项目路径|工作区/);
  assert.match(mobile.processStatus.nextAction, /恢复|重新配置/);
  assert.equal(mobile.pendingGuidance.status, "blocked");
  assert.match(mobile.pendingGuidance.statusLabel, /暂不可发送/);
  assert.match(mobile.pendingGuidance.statusDetail, /项目路径|工作区/);
  assert.match(mobile.pendingGuidance.userMessage, /项目路径|工作区|暂不可发送/);
});

test("exportMobileView explains why the loop is waiting before sending again", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "等待 Codex 完成线程",
    threadId: "thread-hold-reason",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await savePendingGuidance(configRoot, {
    text: "等 Codex 完成后，请优先检查最新回复有没有遗漏验收。",
  });
  const runningSnapshot = await ensureLoopArtifacts(configRoot);
  await fs.writeFile(
    initialSnapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...runningSnapshot.thread,
        threadTitle: "等待 Codex 完成线程",
        threadId: "thread-hold-reason",
        continuationStatus: "dispatching",
        lastDispatchAt: "2026-06-09T08:00:00.000Z",
        latestEventType: "codex_followup_sent_waiting",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.state, "codex_working");
  assert.equal(mobile.processStatus.monitorLevel, "busy");
  assert.equal(mobile.processStatus.monitorLabel, "处理中");
  assert.equal(mobile.processStatus.monitorTone, "active");
  assert.equal(mobile.processStatus.canSendNextTurn, false);
  assert.match(mobile.processStatus.holdReason, /Codex.*当前轮|当前轮.*Codex/);
  assert.match(mobile.processStatus.nextAction, /等待.*完成|不要.*发送|查看.*记录/);
  assert.equal(mobile.pendingGuidance.status, "waiting_codex");
  assert.match(mobile.pendingGuidance.statusLabel, /等待 Codex 完成/);
  assert.match(mobile.pendingGuidance.statusDetail, /Codex.*当前轮|完成后.*本地模型|NPC/);
  assert.match(mobile.pendingGuidance.userMessage, /等待 Codex 完成|不会打断/);
  assert.match(
    mobile.runtimeEvents.map((event) => `${event.title} ${event.detail}`).join("\n"),
    /等待 Codex 完成/,
  );
});

test("exportMobileView explains the recovery action after continuation failure", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "失败恢复线程",
    threadId: "thread-failure-action",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  const failedSnapshot = await ensureLoopArtifacts(configRoot);
  await markContinuationFailed(configRoot, failedSnapshot, {
    message: "Codex 原生发送未确认送达。",
    latestSummary: "向 Codex 线程发送下一轮指令失败。",
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(snapshot.config.currentRunId, "run-summary");
  assert.equal(mobile.processStatus.state, "error");
  assert.equal(mobile.processStatus.monitorLevel, "error");
  assert.equal(mobile.processStatus.monitorLabel, "失败");
  assert.equal(mobile.processStatus.monitorTone, "danger");
  assert.equal(mobile.processStatus.failureCategory, "codex_dispatch");
  assert.equal(mobile.processStatus.headline, "Codex 发送失败");
  assert.match(mobile.processStatus.holdReason, /失败|未确认送达/);
  assert.match(mobile.processStatus.nextAction, /线程绑定|桌面端|重新开始/);
});

test("exportMobileView exposes supervisor review and next instruction for monitoring", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "\u76d1\u7763\u590d\u76d8\u7ebf\u7a0b",
    threadId: "thread-supervisor-mobile",
    singleThreadMode: true,
  });
  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "\u76d1\u7763\u590d\u76d8\uff1aCodex \u5df2\u5b8c\u6210\u9996\u9875\u72b6\u6001\u6536\u53e3\uff0c\u4e0b\u4e00\u8f6e\u5e94\u8be5\u505a\u79fb\u52a8\u7aef\u771f\u5b9e\u9a8c\u6536\u3002",
      nextInstruction:
        "\u5148\u4ee5\u771f\u5b9e\u7528\u6237\u89c6\u89d2\u68c0\u67e5\u79fb\u52a8\u7aef loop \u89c2\u5bdf\u9875\uff0c\u4fee\u590d\u6700\u5f71\u54cd\u5224\u65ad\u72b6\u6001\u7684\u95ee\u9898\u3002",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: ["npm run test", "npm run build:web"],
      acceptanceFocus: [
        "\u9996\u9875\u72b6\u6001\u662f\u5426\u4e00\u773c\u80fd\u5224\u65ad",
        "\u79fb\u52a8\u7aef\u89c2\u5bdf\u9875\u662f\u5426\u8db3\u591f\u6e05\u695a",
      ],
      risks: [],
    }),
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.hasSupervisorReview, true);
  assert.match(mobile.processStatus.supervisorReview, /\u76d1\u7763\u590d\u76d8/);
  assert.match(mobile.processStatus.supervisorInstructionPreview, /\u771f\u5b9e\u7528\u6237/);
  assert.equal(mobile.processStatus.supervisorSource, "ollama");
  assert.equal(mobile.processStatus.needsIndependentVerification, true);
  assert.deepEqual(mobile.processStatus.verificationCommands, ["npm run test", "npm run build:web"]);
  assert.match(mobile.processStatus.acceptanceFocusPreview, /\u9996\u9875\u72b6\u6001/);
});

test("exportMobileView exposes structured supervisor perspectives for overseer PM QA and picky user review", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "结构化监督视角",
    threadId: "thread-supervisor-perspectives",
    singleThreadMode: true,
  });
  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：Codex 已完成移动端历史对话，但还需要控制范围并补齐真实用户验收。",
      nextInstruction: "下一轮先修复移动端状态判断不清楚的问题，再补一条验证证据。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: ["npm run build:mobile"],
      acceptanceFocus: ["手机 10 秒内能判断当前任务是否健康", "历史对话和补充引导入口是否清楚"],
      risks: ["不要扩展到新功能", "避免在 Codex 未完成时追发"],
    }),
  });

  const mobile = await exportMobileView(configRoot);

  assert.deepEqual(
    mobile.processStatus.supervisorPerspectiveRows.map((row) => row.label),
    ["监工", "产品经理", "测试人员", "真实用户"],
  );
  assert.match(mobile.processStatus.supervisorPerspectiveRows[0].text, /下一轮|新功能|用户目标/);
  assert.match(mobile.processStatus.supervisorPerspectiveRows[1].text, /控制范围|新功能/);
  assert.match(mobile.processStatus.supervisorPerspectiveRows[2].text, /npm run build:mobile|验证证据/);
  assert.match(mobile.processStatus.supervisorPerspectiveRows[3].text, /10 秒|历史对话/);
  assert.match(mobile.processStatus.supervisorPerspectiveSummary, /监工|产品经理|测试人员|真实用户/);
});

test("exportMobileView exposes independent supervisor verification result", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端独立验收",
    threadId: "thread-mobile-verification",
    singleThreadMode: true,
  });

  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：需要独立验收移动端对话流。",
      nextInstruction: "下一轮根据独立验收结果继续修复移动端对话流。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: ["npm run test:mobile-flow"],
      acceptanceFocus: ["移动端能看到 codex-loop 指令和 Codex 回复"],
      risks: [],
    }),
    runVerificationCommand: async ({ command }) => ({
      command,
      ok: false,
      exitCode: 1,
      output: "mobile transcript missing loop prompt bubble",
    }),
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.supervisorVerificationStatus, "failed");
  assert.match(
    mobile.processStatus.supervisorVerificationSummary,
    /mobile transcript missing loop prompt bubble/,
  );
  assert.equal(mobile.processStatus.supervisorVerificationCommandCount, 1);
});

test("exportMobileView exposes screenshot evidence from independent verification", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端截图验收",
    threadId: "thread-mobile-screenshot-evidence",
    singleThreadMode: true,
  });

  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：需要截图验收移动端首页。",
      nextInstruction: "下一轮根据截图验收继续优化移动端。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: ["npm run visual:mobile"],
      acceptanceFocus: ["移动端首页是否清楚"],
      risks: [],
    }),
    runVerificationCommand: async ({ command }) => ({
      command,
      ok: true,
      exitCode: 0,
      output: "截图已保存 runtime/screenshots/mobile-home-2026-06-10.png",
    }),
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.supervisorVerificationStatus, "passed");
  assert.equal(mobile.processStatus.supervisorVerificationEvidenceCount, 1);
  assert.match(
    mobile.processStatus.supervisorVerificationEvidencePreview,
    /mobile-home-2026-06-10\.png/,
  );
});

test("exportMobileView labels missing independent verification evidence", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端缺少独立验收",
    threadId: "thread-mobile-verification-missing",
    singleThreadMode: true,
  });

  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：需要独立验收，但还没有找到可执行命令。",
      nextInstruction: "下一轮先补齐可验证证据，再继续推进。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: [],
      acceptanceFocus: ["移动端要能判断验收是否真的执行"],
      risks: [],
    }),
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.supervisorVerificationStatus, "skipped");
  assert.equal(mobile.processStatus.supervisorVerificationKind, "missing_evidence");
  assert.equal(mobile.processStatus.supervisorVerificationLabel, "未执行");
  assert.equal(mobile.processStatus.supervisorVerificationTone, "warning");
  assert.match(mobile.processStatus.supervisorVerificationAction, /补齐|说明可验证证据/);
});

test("exportMobileView labels reused independent verification as intentional", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端复用独立验收",
    threadId: "thread-mobile-verification-reused",
    singleThreadMode: true,
  });

  const review = {
    summary: "监督复盘：继续根据最近验收结果推进。",
    nextInstruction: "下一轮复用最近验收结论继续推进。",
    shouldContinue: true,
    needsIndependentVerification: true,
    verificationCommands: ["node --version"],
    acceptanceFocus: ["不要因为冷却期跳过验收而误判为缺证据"],
    risks: [],
  };
  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => review,
    runVerificationCommand: async ({ command }) => ({
      command,
      ok: true,
      exitCode: 0,
      output: "v24.0.0",
    }),
  });
  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => review,
    runVerificationCommand: async ({ command }) => {
      throw new Error(`不应该重复执行验收命令：${command}`);
    },
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.processStatus.supervisorVerificationStatus, "skipped");
  assert.equal(mobile.processStatus.supervisorVerificationKind, "reused_recent");
  assert.equal(mobile.processStatus.supervisorVerificationLabel, "复用最近验收");
  assert.equal(mobile.processStatus.supervisorVerificationTone, "soft");
  assert.match(mobile.processStatus.supervisorVerificationAction, /复用最近验收结论|等待新的 Codex 完成/);
});

test("exportMobileView gives clear mobile guidance while supervisor review is in progress", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端监督复盘中",
    threadId: "thread-mobile-reviewing",
    singleThreadMode: true,
  });
  await savePendingGuidance(configRoot, {
    text: "复盘完成后，请把用户补充合并成更短的下一轮指令。",
  });

  let releaseReview;
  const releaseReviewPromise = new Promise((resolve) => {
    releaseReview = resolve;
  });
  let generatorStarted;
  const generatorStartedPromise = new Promise((resolve) => {
    generatorStarted = resolve;
  });

  const reviewPromise = reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => {
      generatorStarted();
      await releaseReviewPromise;
      return {
        summary: "监督复盘：移动端状态清楚，可以继续。",
        nextInstruction: "下一轮继续做最小可验证改动。",
        shouldContinue: true,
        needsIndependentVerification: false,
        verificationCommands: [],
        acceptanceFocus: ["移动端状态清楚"],
        risks: [],
      };
    },
  });

  await generatorStartedPromise;
  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.thread.continuationStatus, "reviewing");
  assert.equal(mobile.processStatus.state, "supervisor_reviewing");
  assert.match(mobile.suggestedAction, /监督复盘中|本地模型|等待.*下一步/);
  assert.equal(mobile.pendingGuidance.status, "waiting_npc");
  assert.match(mobile.pendingGuidance.statusLabel, /等待 NPC 复盘/);
  assert.match(mobile.pendingGuidance.statusDetail, /本地模型|NPC|复盘/);
  assert.match(mobile.pendingGuidance.userMessage, /等待.*NPC|复盘后.*合并/);

  releaseReview();
  await reviewPromise;
});

test("exportMobileView exposes customized npc rules and pending mobile guidance", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      supervisor: {
        roleTraits: "像产品经理、测试人员和真实用户一样监督项目，不允许偏离用户目标。",
        testingRules: "每个移动端改动都要检查状态、历史记录和补充引导入口。",
        acceptanceCriteria: "用户在手机上 10 秒内能判断当前任务是否健康。",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端监督线程",
    threadId: "thread-mobile-npc",
    singleThreadMode: true,
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮请重点检查移动端实时引导是否清楚。",
  });

  const mobile = await exportMobileView(configRoot);

  assert.match(mobile.supervisor.roleTraits, /产品经理、测试人员和真实用户/);
  assert.match(mobile.supervisor.testingRules, /移动端改动/);
  assert.match(mobile.supervisor.acceptanceCriteria, /10 秒/);
  assert.equal(mobile.pendingGuidance.text, "下一轮请重点检查移动端实时引导是否清楚。");
  assert.match(mobile.pendingGuidance.at, /^20\d\d-/);
  assert.equal(mobile.pendingGuidance.mergeTiming, "codex_completed");
  assert.equal(mobile.pendingGuidance.mergeProcessor, "ollama_npc");
  assert.match(mobile.pendingGuidance.mergeProcessorLabel, /本地模型|NPC|Ollama/);
  assert.equal(mobile.pendingGuidance.status, "ready_to_merge");
  assert.match(mobile.pendingGuidance.statusLabel, /等待本地模型|NPC|合并/);
  assert.match(mobile.pendingGuidance.statusDetail, /Codex.*空闲|可以.*下一条|本地模型|NPC/);
  assert.match(mobile.pendingGuidance.actionLabel, /可发送|等待发送/);
  assert.match(mobile.pendingGuidance.userMessage, /Codex.*完成/);
  assert.match(mobile.pendingGuidance.userMessage, /本地模型|NPC|Ollama/);
  assert.ok(
    mobile.conversationItems.some(
      (item) =>
        item.role === "guidance" &&
        /下一轮请重点检查移动端实时引导是否清楚/.test(item.text || item.preview || ""),
    ),
  );
});

test("exportMobileView shows evidence after queued guidance is merged into the next Codex instruction", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端合并证据",
    threadId: "thread-mobile-guidance-evidence",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成移动端状态整理，等待下一轮指示。",
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮请优先检查 App 远程操控入口是否清楚。",
  });

  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => ({
      prompt: "请继续按清单推进移动端远程操控。",
      source: "ollama",
    }),
    dispatchThreadMessage: async ({ prompt }) => {
      assert.match(prompt, /下一轮请优先检查 App 远程操控入口是否清楚/);
      return {
        deliveryObserved: true,
        transport: "native-app",
      };
    },
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.pendingGuidance.hasPending, false);
  assert.equal(mobile.processStatus.lastMergedGuidanceStatus, "merged");
  assert.match(mobile.processStatus.lastMergedGuidanceLabel, /已合并/);
  assert.match(
    mobile.processStatus.lastMergedGuidancePreview,
    /App 远程操控入口是否清楚/,
  );
  assert.match(
    mobile.processStatus.lastMergedGuidanceDetail,
    /本次指令|Codex/,
  );
  assert.match(
    mobile.conversationItems.map((item) => item.preview || item.text).join("\n"),
    /用户补充|App 远程操控入口是否清楚/,
  );
});

test("exportMobileView keeps pending guidance stable after snapshot reload", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端恢复监督线程",
    threadId: "thread-mobile-pending-reload",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成当前轮，等待下一轮补充。",
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮请继续检查移动端恢复后的历史和待合并引导是否一致。",
  });

  const firstMobile = await exportMobileView(configRoot);
  const reloaded = await readLoopSnapshot(configRoot);
  const secondMobile = await exportMobileView(configRoot);

  assert.match(reloaded.thread.pendingUserGuidance, /恢复后的历史和待合并引导是否一致/);
  assert.equal(firstMobile.pendingGuidance.hasPending, true);
  assert.equal(
    firstMobile.pendingGuidance.text,
    "下一轮请继续检查移动端恢复后的历史和待合并引导是否一致。",
  );
  assert.equal(secondMobile.pendingGuidance.hasPending, true);
  assert.equal(secondMobile.pendingGuidance.text, firstMobile.pendingGuidance.text);
  assert.equal(secondMobile.pendingGuidance.at, firstMobile.pendingGuidance.at);
  assert.equal(
    secondMobile.processStatus.pendingGuidancePreview,
    firstMobile.processStatus.pendingGuidancePreview,
  );
  assert.equal(
    secondMobile.conversationItems.map((item) => item.preview || item.text).join("\n"),
    firstMobile.conversationItems.map((item) => item.preview || item.text).join("\n"),
  );
});

test("exportMobileView keeps guidance bubble readable when stored pending text has consecutive duplicates", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端重复补充展示",
    threadId: "thread-mobile-guidance-repeat-view",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成当前轮，等待下一轮补充。",
  });
  const threadPath = snapshot.paths.threadPath;
  const thread = JSON.parse(await fs.readFile(threadPath, "utf8"));
  thread.pendingUserGuidance =
    "下一轮请优先确认手机端撤回补充后历史区和待合并状态是否立即同步。\n下一轮请优先确认手机端撤回补充后历史区和待合并状态是否立即同步。";
  thread.pendingUserGuidanceAt = "2026-06-11T14:11:00.000Z";
  await fs.writeFile(threadPath, `${JSON.stringify(thread, null, 2)}\n`, "utf8");

  const mobile = await exportMobileView(configRoot);
  const guidanceItem = mobile.conversationItems.find((item) => item.role === "guidance");

  assert.equal(
    mobile.pendingGuidance.preview,
    "下一轮请优先确认手机端撤回补充后历史区和待合并状态是否立即同步。",
  );
  assert.equal(
    guidanceItem?.preview,
    "下一轮请优先确认手机端撤回补充后历史区和待合并状态是否立即同步。",
  );
});

test("exportMobileView keeps merged guidance evidence stable after snapshot reload", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端合并恢复线程",
    threadId: "thread-mobile-merged-reload",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成移动端主链路整理，等待下一轮指示。",
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮请确认服务重启后手机端看到的已合并补充仍然正确。",
  });

  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => ({
      prompt: "请继续收紧移动端恢复链路。",
      source: "ollama",
    }),
    dispatchThreadMessage: async ({ prompt }) => {
      assert.match(prompt, /服务重启后手机端看到的已合并补充仍然正确/);
      return {
        deliveryObserved: true,
        transport: "native-app",
      };
    },
  });

  const firstMobile = await exportMobileView(configRoot);
  const reloaded = await readLoopSnapshot(configRoot);
  const secondMobile = await exportMobileView(configRoot);

  assert.equal(reloaded.thread.pendingUserGuidance, "");
  assert.match(reloaded.thread.lastMergedGuidance, /服务重启后手机端看到的已合并补充仍然正确/);
  assert.equal(firstMobile.pendingGuidance.hasPending, false);
  assert.equal(secondMobile.pendingGuidance.hasPending, false);
  assert.equal(
    secondMobile.processStatus.lastMergedGuidanceStatus,
    firstMobile.processStatus.lastMergedGuidanceStatus,
  );
  assert.equal(
    secondMobile.processStatus.lastMergedGuidancePreview,
    firstMobile.processStatus.lastMergedGuidancePreview,
  );
  assert.equal(
    secondMobile.processStatus.lastMergedGuidanceAt,
    firstMobile.processStatus.lastMergedGuidanceAt,
  );
  assert.equal(
    secondMobile.conversationItems.map((item) => item.preview || item.text).join("\n"),
    firstMobile.conversationItems.map((item) => item.preview || item.text).join("\n"),
  );
});

test("exportMobileView tracks process state transitions for live mobile monitoring", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "移动端状态流转线程",
    threadId: "thread-mobile-process-flow",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已准备接收下一轮指令。",
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮请持续观察手机端对进程状态切换的提示是否及时。",
  });

  const readyMobile = await exportMobileView(configRoot);

  assert.equal(readyMobile.processStatus.state, "waiting_next_turn");
  assert.equal(readyMobile.processStatus.monitorLabel, "可继续");
  assert.match(readyMobile.processStatus.headline, /等待下一轮/);
  assert.equal(readyMobile.pendingGuidance.status, "ready_to_merge");

  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => ({
      prompt: "请继续完善移动端实时监控体验。",
      source: "ollama",
    }),
    dispatchThreadMessage: async () => ({
      deliveryObserved: true,
      completionObserved: false,
      lastMessage: "",
    }),
  });

  const workingMobile = await exportMobileView(configRoot);

  assert.equal(workingMobile.processStatus.state, "codex_working");
  assert.equal(workingMobile.processStatus.monitorLabel, "处理中");
  assert.match(workingMobile.processStatus.headline, /Codex 正在处理/);
  assert.equal(workingMobile.pendingGuidance.status, "waiting_codex");

  let releaseReview;
  const releaseReviewPromise = new Promise((resolve) => {
    releaseReview = resolve;
  });
  let reviewStarted;
  const reviewStartedPromise = new Promise((resolve) => {
    reviewStarted = resolve;
  });

  const reviewPromise = reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => {
      reviewStarted();
      await releaseReviewPromise;
      return {
        summary: "监督复盘：移动端状态切换清楚，可以继续下一轮。",
        nextInstruction: "下一轮继续优化手机端监控实时性。",
        shouldContinue: true,
        needsIndependentVerification: false,
        verificationCommands: [],
        acceptanceFocus: ["状态切换及时", "聊天记录更新及时"],
        risks: [],
      };
    },
  });

  await reviewStartedPromise;
  const reviewingMobile = await exportMobileView(configRoot);

  assert.equal(reviewingMobile.processStatus.state, "supervisor_reviewing");
  assert.equal(reviewingMobile.processStatus.monitorLabel, "复盘中");
  assert.match(reviewingMobile.processStatus.headline, /监督复盘中/);
  assert.equal(reviewingMobile.pendingGuidance.status, "waiting_npc");

  releaseReview();
  await reviewPromise;

  const monitoredMobile = await exportMobileView(configRoot);

  assert.equal(monitoredMobile.processStatus.state, "waiting_next_turn");
  assert.equal(monitoredMobile.processStatus.monitorLabel, "可继续");
  assert.match(monitoredMobile.processStatus.nextAction, /开始循环|等待下一次调度|发送|继续/);
  assert.equal(monitoredMobile.processStatus.latestEventType, "supervisor_review_completed");
});

test("exportMobileView suggests binding a visible thread before starting when thread is missing", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.thread.threadId, "");
  assert.match(mobile.bindingNote, /\u672a\u7ed1\u5b9a|\u7ebf\u7a0b/);
  assert.match(mobile.suggestedAction, /\u5148.*\u7ed1\u5b9a|\u542f\u52a8/);
});

test("exportMobileView shows a clear stopped action after stop completes", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "收尾线程",
    threadId: "thread-finish",
    singleThreadMode: true,
  });
  await startRun(configRoot);
  await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.loop.mode, "stopped");
  assert.match(mobile.suggestedAction, /\u67e5\u770b|\u786e\u8ba4|\u91cd\u65b0\u5f00\u59cb/);
});

test("exportMobileView keeps stopped guidance even when no thread is bound", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await startRun(configRoot);
  await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  const mobile = await exportMobileView(configRoot);

  assert.equal(mobile.loop.mode, "stopped");
  assert.match(mobile.suggestedAction, /\u7ed1\u5b9a|\u67e5\u770b|\u91cd\u65b0\u5f00\u59cb/);
});
