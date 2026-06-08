import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  ensureLoopArtifacts,
  exportMobileView,
  exportLoopSummary,
  recordHeartbeat,
  reviewCodexMilestone,
  saveThreadBinding,
  savePendingGuidance,
  startRun,
  requestGracefulStop,
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
  assert.equal(mobile.processStatus.canSendNextTurn, true);
  assert.equal(mobile.processStatus.waitingForCodex, false);
  assert.equal(mobile.processStatus.hasPendingGuidance, true);
  assert.match(mobile.processStatus.headline, /\u7b49\u5f85\u4e0b\u4e00\u8f6e/);
  assert.match(mobile.processStatus.detail, /\u53ef\u4ee5.*\u53d1\u9001|\u4e0b\u4e00\u8f6e/);
  assert.match(mobile.processStatus.pendingGuidancePreview, /\u79fb\u52a8\u7aef\u8fdb\u7a0b\u72b6\u6001/);
  assert.match(mobile.processStatus.stopLimit, /\u6700\u957f.*\u5206\u949f/);
  assert.match(mobile.processStatus.stopLimit, /token/);
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

test("exportMobileView exposes customized npc rules and pending mobile guidance", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      supervisor: {
        roleTraits: "像产品经理、测试人员和真实用户一样监督项目，不允许偏离用户目标。",
        testingRules: "每个移动端改动都要检查状态、历史记录和补充引导入口。",
        acceptanceCriteria: "用户在手机上 10 秒内能判断当前 loop 是否健康。",
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
