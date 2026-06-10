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
  recordHeartbeat,
  reviewCodexMilestone,
  saveThreadBinding,
  savePendingGuidance,
  selectLoop,
  startRun,
  requestGracefulStop,
  updateBudgets,
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
  assert.match(mobile.processStatus.stopLimit, /\u6700\u957f.*\u5206\u949f/);
  assert.match(mobile.processStatus.stopLimit, /token/);
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
  assert.equal(mobile.pendingGuidance.mergeTiming, "codex_completed");
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
