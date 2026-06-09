import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createLoop,
  deleteLoop,
  exportLoopSummary,
  exportMobileView,
  ensureLoopArtifacts,
  goBackLoopCreationAssistant,
  getLoopCreationAssistantState,
  listLoops,
  readLoopSnapshot,
  replyLoopCreationAssistant,
  restartLoopCreationAssistant,
  runLoopTurn,
  sendPendingGuidanceOnce,
  startRun,
  selectLoop,
  renameLoop,
  recordHeartbeat,
  reviewCodexMilestone,
  savePendingGuidance,
  requestGracefulStop,
  saveThreadBinding,
  clearPendingGuidance,
  syncCodexThreadMirror,
  updateBudgets,
  updateLoopSupervisor,
} from "../app/server/lib/runtime-store.mjs";
import { saveUserOverrides } from "../app/server/lib/adapter-store.mjs";
import {
  generateCodexSummaryWithOllama,
  generateMilestoneReviewWithOllama,
  generatePromptWithOllama,
} from "../app/server/lib/ollama-prompt-generator.mjs";

function buildConfig() {
  return {
    projectName: "demo",
    projectAdapter: "generic",
    branch: "dev",
    currentRunId: "run-a",
    budgets: {
      maxMinutes: 120,
      maxTokens: 50000,
      finalizeLeadMinutes: 15,
      finalizeLeadTokens: 5000,
    },
  };
}

async function createWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-store-"));
  const configRoot = path.join(tempRoot, "workspace");
  await fs.mkdir(path.join(configRoot, "codex_loop"), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(buildConfig(), null, 2)}\n`,
    "utf8",
  );
  return configRoot;
}

async function writeCodexSession(tempRoot, threadId, records) {
  const sessionDir = path.join(tempRoot, "sessions", "2026", "06", "07");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `rollout-${threadId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

test("ensureLoopArtifacts creates thread metadata and transcript mirror", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);

  assert.equal(snapshot.thread.threadTitle, "\u672a\u7ed1\u5b9a\u7ebf\u7a0b");
  assert.match(snapshot.paths.transcriptPath, /transcript\.md$/);
});

test("ensureLoopArtifacts uses the selected loop workspace when the console starts standalone", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-store-"));
  const loopRoot = path.join(tempRoot, "codex-loop");
  const staleWorkspace = path.join(tempRoot, "stale-project");
  const selectedWorkspace = path.join(tempRoot, "selected-project");
  await fs.mkdir(path.join(loopRoot, "settings"), { recursive: true });
  await fs.mkdir(staleWorkspace, { recursive: true });
  await fs.mkdir(selectedWorkspace, { recursive: true });
  const config = {
    ...buildConfig(),
    currentRunId: "selected-loop",
    loopName: "选中的循环",
    threadTitle: "选中的线程",
  };
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(loopRoot, "config.local.json"),
    `${JSON.stringify({ workspaceRoot: staleWorkspace }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(loopRoot, "settings", "loops.json"),
    `${JSON.stringify(
      {
        currentLoopId: "selected-loop",
        version: 1,
        generatedAt: "2026-06-09T00:00:00.000Z",
        loops: [
          {
            id: "selected-loop",
            runId: "selected-loop",
            name: "选中的循环",
            threadTitle: "选中的线程",
            branch: "dev",
            projectName: "选中的项目",
            projectAdapter: "generic",
            workspaceRoot: selectedWorkspace,
            budgets: config.budgets,
            startContextPaths: [],
            docs: null,
            git: null,
            threadBinding: {
              workspaceName: "选中的项目",
              threadTitle: "选中的线程",
              threadId: "thread-selected",
              currentRunId: "selected-loop",
              continuationEnabled: true,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const snapshot = await ensureLoopArtifacts(loopRoot);

  assert.equal(snapshot.paths.codexLoopRoot, loopRoot);
  assert.equal(snapshot.paths.workspaceRoot, selectedWorkspace);
  assert.equal(snapshot.loop.workspaceRoot, selectedWorkspace);
});

test("requestGracefulStop clears stop flags and enters stopped mode when no continuation is active", async () => {
  const configRoot = await createWorkspace();

  await ensureLoopArtifacts(configRoot);
  const nextSnapshot = await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  assert.equal(nextSnapshot.state.stopRequested, false);
  assert.equal(nextSnapshot.state.finalizeRequested, false);
  assert.equal(nextSnapshot.state.mode, "stopped");
});

test("requestGracefulStop appends a transcript entry for the stop request", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);

  await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  const transcriptText = await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /manual stop/);
});

test("saveThreadBinding persists project and title display metadata", async () => {
  const configRoot = await createWorkspace();

  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "\u8bc4\u4f30\u957f\u65f6\u5f00\u53d1\u65b9\u6848",
    threadId: "thread-123",
    singleThreadMode: true,
    note: "desktop primary thread",
  });

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(snapshot.thread.workspaceName, "demo");
  assert.equal(snapshot.thread.threadTitle, "\u8bc4\u4f30\u957f\u65f6\u5f00\u53d1\u65b9\u6848");
  assert.equal(snapshot.thread.latestMode, "running");
});

test("recordHeartbeat stores recent summary and appends transcript entry", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);

  const nextSnapshot = await recordHeartbeat(configRoot, {
    activeTask: "Refine adapter profile routing",
    note: "Focused verification is green",
    progressSummary: "Added heartbeat summary persistence",
    consumedTokens: 3200,
  });

  assert.equal(nextSnapshot.state.activeTask, "Refine adapter profile routing");
  assert.equal(nextSnapshot.state.recentSummary, "Added heartbeat summary persistence");
  assert.equal(nextSnapshot.state.lastNote, "Focused verification is green");
  assert.ok(nextSnapshot.state.lastHeartbeatAt);
  assert.equal(nextSnapshot.thread.latestActiveTask, "Refine adapter profile routing");
  assert.equal(
    nextSnapshot.thread.latestSummary,
    "Added heartbeat summary persistence",
  );
  assert.equal(nextSnapshot.thread.latestMode, nextSnapshot.state.mode);
  assert.ok(nextSnapshot.thread.latestHeartbeatAt);

  const transcriptText = await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /Added heartbeat summary persistence/);
});

test("requestGracefulStop updates thread mirror mode", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const snapshot = await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  assert.equal(snapshot.thread.latestMode, "stopped");
  assert.equal(snapshot.thread.latestModeLabel, "\u5df2\u505c\u6b62");
});

test("requestGracefulStop writes a visible finalizing summary for the UI", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const snapshot = await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  assert.match(snapshot.thread.latestSummary, /\u505c\u6b62/);
  assert.equal(snapshot.thread.latestEventType, "graceful_stop_completed");
});

test("requestGracefulStop stops immediately when no continuation is in flight", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await startRun(configRoot);

  const snapshot = await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  assert.equal(snapshot.state.mode, "stopped");
  assert.equal(snapshot.state.stopRequested, false);
  assert.equal(snapshot.state.finalizeRequested, false);
  assert.equal(snapshot.thread.latestMode, "stopped");
  assert.equal(snapshot.thread.continuationStatus, "idle");
});

test("exportMobileView gives user-facing next-step guidance for an unbound loop", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const mobileView = await exportMobileView(configRoot);

  assert.match(mobileView.bindingNote, /\u8fd8\u6ca1\u6709\u7ed1\u5b9a|\u7ebf\u7a0b/);
  assert.match(mobileView.suggestedAction, /\u5148.*\u7ed1\u5b9a.*\u7ebf\u7a0b/);
});

test("exportMobileView falls back to thread summaries when transcript mirror is still empty", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "fallback thread",
    threadId: "thread-fallback-mobile",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Completed a real visible batch for the current loop",
  });

  const mobileView = await exportMobileView(configRoot);

  assert.equal(mobileView.transcriptEntries.length > 0, true);
  assert.match(
    mobileView.transcriptEntries[0].summary,
    /Completed a real visible batch for the current loop/,
  );
  assert.match(
    await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8"),
    /本地对话记录/,
  );
});

test("startRun records a visible launch signal before the first heartbeat", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);

  const snapshot = await startRun(configRoot);

  assert.equal(snapshot.state.mode, "running");
  assert.ok(snapshot.state.startedAt);
  assert.equal(snapshot.state.lastHeartbeatAt, "");
  assert.equal(snapshot.thread.latestEventType, "run_started_from_console");
  assert.match(snapshot.thread.latestSummary, /循环已启动|Codex 线程结果/);

  const transcriptText = await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /run_started_from_console/);
});

test("readLoopSnapshot exposes readable runtime events for the dashboard", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await startRun(configRoot);
  await savePendingGuidance(configRoot, {
    text: "下一轮优先检查运行记录是否清楚。",
  });

  const snapshot = await readLoopSnapshot(configRoot);

  assert.equal(Array.isArray(snapshot.runtimeEvents), true);
  assert.match(
    snapshot.runtimeEvents.map((event) => event.title).join("\n"),
    /已开始循环/,
  );
  assert.match(
    snapshot.runtimeEvents.map((event) => event.title).join("\n"),
    /已记录下一轮补充/,
  );
  assert.doesNotMatch(snapshot.runtimeEvents[0].title, /_/);
});

test("readLoopSnapshot dedupes repeated Codex sync runtime events", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  const duplicateEvents = [
    {
      type: "codex_conversation_mirror_synced",
      at: "2026-06-08T06:25:58.133Z",
      threadId: "thread-duplicate-runtime",
      latestAssistantAt: "2026-06-08T06:25:55.677Z",
      latestAssistantPreview: "同一条 Codex 回复摘要不应该在运行记录里重复展示。",
    },
    {
      type: "codex_conversation_mirror_synced",
      at: "2026-06-08T06:25:58.793Z",
      threadId: "thread-duplicate-runtime",
      latestAssistantAt: "2026-06-08T06:25:55.677Z",
      latestAssistantPreview: "同一条 Codex 回复摘要不应该在运行记录里重复展示。",
    },
    {
      type: "codex_conversation_mirror_synced",
      at: "2026-06-08T06:25:59.468Z",
      threadId: "thread-duplicate-runtime",
      latestAssistantAt: "2026-06-08T06:25:55.677Z",
      latestAssistantPreview: "同一条 Codex 回复摘要不应该在运行记录里重复展示。",
    },
  ];
  await fs.appendFile(
    initialSnapshot.paths.logPath,
    duplicateEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const snapshot = await readLoopSnapshot(configRoot);
  const codexSyncEvents = snapshot.runtimeEvents.filter(
    (event) => event.type === "codex_conversation_mirror_synced",
  );

  assert.equal(codexSyncEvents.length, 1);
  assert.match(codexSyncEvents[0].detail, /不应该.*重复展示/);
});

test("readLoopSnapshot keeps only the latest Codex sync in runtime records", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  const events = [
    {
      type: "codex_followup_dispatching",
      at: "2026-06-08T06:24:10.000Z",
      threadId: "thread-runtime-latest-sync",
      promptPreview: "第一轮：先检查移动端运行记录是否清楚。",
    },
    {
      type: "codex_conversation_mirror_synced",
      at: "2026-06-08T06:25:10.000Z",
      threadId: "thread-runtime-latest-sync",
      latestAssistantAt: "2026-06-08T06:25:05.000Z",
      latestAssistantPreview: "旧的 Codex 回复不应该继续占用运行记录。",
    },
    {
      type: "codex_followup_dispatching",
      at: "2026-06-08T06:26:10.000Z",
      threadId: "thread-runtime-latest-sync",
      promptPreview: "第二轮：继续检查运行记录去重。",
    },
    {
      type: "codex_conversation_mirror_synced",
      at: "2026-06-08T06:27:10.000Z",
      threadId: "thread-runtime-latest-sync",
      latestAssistantAt: "2026-06-08T06:27:05.000Z",
      latestAssistantPreview: "最新 Codex 回复可以保留一条作为状态提示。",
    },
  ];
  await fs.appendFile(
    initialSnapshot.paths.logPath,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const snapshot = await readLoopSnapshot(configRoot);
  const codexSyncEvents = snapshot.runtimeEvents.filter(
    (event) => event.type === "codex_conversation_mirror_synced",
  );
  const dispatchEvents = snapshot.runtimeEvents.filter(
    (event) => event.type === "codex_followup_dispatching",
  );

  assert.equal(codexSyncEvents.length, 1);
  assert.match(codexSyncEvents[0].detail, /最新 Codex 回复/);
  assert.doesNotMatch(
    snapshot.runtimeEvents.map((event) => event.detail).join("\n"),
    /旧的 Codex 回复/,
  );
  assert.equal(dispatchEvents.length, 2);
});

test("readLoopSnapshot dedupes repeated visible runtime details across event types", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  const events = [
    {
      type: "codex_followup_completed",
      at: "2026-06-08T06:28:10.000Z",
      threadId: "thread-runtime-visible-dedupe",
      latestAssistantPreview: "同一段 Codex 回复只应该在运行记录里展示一次。",
    },
    {
      type: "codex_conversation_mirror_synced",
      at: "2026-06-08T06:28:11.000Z",
      threadId: "thread-runtime-visible-dedupe",
      latestAssistantAt: "2026-06-08T06:28:09.000Z",
      latestAssistantPreview: "同一段 Codex 回复只应该在运行记录里展示一次。",
    },
  ];
  await fs.appendFile(
    initialSnapshot.paths.logPath,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const snapshot = await readLoopSnapshot(configRoot);
  const repeatedVisibleDetails = snapshot.runtimeEvents.filter((event) =>
    event.detail.includes("同一段 Codex 回复只应该在运行记录里展示一次"),
  );

  assert.equal(repeatedVisibleDetails.length, 1);
});

test("readLoopSnapshot keeps runtime records useful and removes low-signal repeats", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  const events = [
    {
      type: "codex_followup_dispatching",
      at: "2026-06-08T05:54:14.033Z",
      threadId: "thread-runtime-useful",
      threadTitle: "按清单继续开发",
      promptPreview: "第一轮：先检查移动端状态是否清楚。",
    },
    {
      type: "codex_followup_completed",
      at: "2026-06-08T05:55:48.763Z",
      threadId: "thread-runtime-useful",
    },
    {
      type: "codex_followup_dispatching",
      at: "2026-06-08T05:55:52.027Z",
      threadId: "thread-runtime-useful",
      threadTitle: "按清单继续开发",
      promptPreview: "第二轮：继续修复运行记录重复展示。",
    },
    {
      type: "codex_followup_completed",
      at: "2026-06-08T05:56:48.763Z",
      threadId: "thread-runtime-useful",
    },
    {
      type: "codex_thread_mirror_synced",
      at: "2026-06-08T05:56:49.000Z",
      threadId: "thread-runtime-useful",
    },
    {
      type: "graceful_stop_completed",
      at: "2026-06-08T05:57:00.000Z",
      reason: "graceful stop completed",
    },
    {
      type: "graceful_stop_completed",
      at: "2026-06-08T05:57:01.000Z",
      reason: "graceful stop completed",
    },
  ];
  await fs.appendFile(
    initialSnapshot.paths.logPath,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const snapshot = await readLoopSnapshot(configRoot);
  const dispatchEvents = snapshot.runtimeEvents.filter(
    (event) => event.type === "codex_followup_dispatching",
  );
  const completedEvents = snapshot.runtimeEvents.filter(
    (event) => event.type === "codex_followup_completed",
  );
  const threadSyncEvents = snapshot.runtimeEvents.filter(
    (event) => event.type === "codex_thread_mirror_synced",
  );
  const stopEvents = snapshot.runtimeEvents.filter(
    (event) => event.type === "graceful_stop_completed",
  );

  assert.equal(dispatchEvents.length, 2);
  assert.match(dispatchEvents[0].detail, /第二轮/);
  assert.match(dispatchEvents[1].detail, /第一轮/);
  assert.doesNotMatch(
    dispatchEvents.map((event) => event.detail).join("\n"),
    /^按清单继续开发$/m,
  );
  assert.equal(completedEvents.length, 1);
  assert.equal(threadSyncEvents.length, 0);
  assert.equal(stopEvents.length, 1);
  assert.doesNotMatch(stopEvents[0].detail, /graceful/i);
});

test("readLoopSnapshot renders continuation failures as product recovery records", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "产品化失败记录线程",
    threadId: "thread-readable-failure-event",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "上一轮已完成，等待下一条指令。",
  });

  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        generateFollowupPrompt: async () => {
          throw new Error("ollama unavailable");
        },
      }),
    /本地模型生成续跑指令失败/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  const failureEvent = snapshot.runtimeEvents.find(
    (event) => event.type === "codex_followup_failed",
  );

  assert.equal(failureEvent.title, "本地模型生成失败");
  assert.match(failureEvent.detail, /Ollama|模型|设置|重新开始/);
  assert.doesNotMatch(failureEvent.detail, /ollama unavailable/i);
});

test("startRun preserves an active Codex dispatch instead of reopening it as idle", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "active dispatch thread",
    threadId: "thread-active-dispatch",
    singleThreadMode: true,
  });
  const boundSnapshot = await readLoopSnapshot(configRoot);
  await fs.writeFile(
    boundSnapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...boundSnapshot.thread,
        continuationStatus: "dispatching",
        continuationEnabled: true,
        latestEventType: "codex_followup_dispatched",
        latestSummary: "已发送到 Codex，等待回复",
        lastDispatchAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const snapshot = await startRun(configRoot);

  assert.equal(snapshot.thread.continuationStatus, "dispatching");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_dispatched");
  assert.match(snapshot.thread.latestSummary, /Codex|等待/);

  const transcriptText = await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /run_started_from_console/);
});

test("ensureLoopArtifacts auto-recovers stale finalize mode into stopped when nothing is dispatching", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  const forcedState = {
    ...initialSnapshot.state,
    mode: "finalize_after_current",
    stopRequested: true,
    finalizeRequested: true,
  };
  const forcedThread = {
    ...initialSnapshot.thread,
    latestMode: "finalize_after_current",
    continuationStatus: "idle",
  };

  await fs.writeFile(initialSnapshot.paths.statePath, `${JSON.stringify(forcedState, null, 2)}\n`, "utf8");
  await fs.writeFile(initialSnapshot.paths.threadPath, `${JSON.stringify(forcedThread, null, 2)}\n`, "utf8");

  const recovered = await ensureLoopArtifacts(configRoot);

  assert.equal(recovered.state.mode, "stopped");
  assert.equal(recovered.state.stopRequested, false);
  assert.equal(recovered.state.finalizeRequested, false);
  assert.equal(recovered.thread.latestMode, "stopped");
});

test("ensureLoopArtifacts keeps dispatching while Codex only has an in-progress reply", async () => {
  const configRoot = await createWorkspace();
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-home-"));
  process.env.CODEX_HOME = codexHome;

  try {
    const initialSnapshot = await ensureLoopArtifacts(configRoot);
    const threadId = "thread-commentary-only";
    await saveThreadBinding(configRoot, {
      workspaceName: "demo",
      threadTitle: "开发主线",
      threadId,
      singleThreadMode: true,
    });

    const forcedState = {
      ...initialSnapshot.state,
      mode: "running",
      stopRequested: false,
      finalizeRequested: false,
    };
    const forcedThread = {
      ...(await readLoopSnapshot(configRoot)).thread,
      continuationStatus: "dispatching",
      lastDispatchAt: new Date().toISOString(),
      lastCompletionAt: "",
    };

    await writeCodexSession(codexHome, threadId, [
      {
        timestamp: "2026-06-07T15:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "我正在验证这一批改动，还没完成。",
          phase: "commentary",
        },
      },
    ]);
    await fs.writeFile(initialSnapshot.paths.statePath, `${JSON.stringify(forcedState, null, 2)}\n`, "utf8");
    await fs.writeFile(initialSnapshot.paths.threadPath, `${JSON.stringify(forcedThread, null, 2)}\n`, "utf8");

    const snapshot = await ensureLoopArtifacts(configRoot);

    assert.equal(snapshot.thread.continuationStatus, "dispatching");
    assert.equal(snapshot.thread.lastCompletionAt, "");
    assert.equal(snapshot.codexConversation.latestAssistant.text, "我正在验证这一批改动，还没完成。");
    assert.equal(snapshot.codexConversation.latestCompletion, null);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("ensureLoopArtifacts stops after a requested stop once Codex writes task_complete", async () => {
  const configRoot = await createWorkspace();
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-home-"));
  process.env.CODEX_HOME = codexHome;

  try {
    const initialSnapshot = await ensureLoopArtifacts(configRoot);
    const threadId = "thread-final-complete";
    await saveThreadBinding(configRoot, {
      workspaceName: "demo",
      threadTitle: "开发主线",
      threadId,
      singleThreadMode: true,
    });

    const forcedState = {
      ...initialSnapshot.state,
      mode: "finalize_after_current",
      stopRequested: true,
      finalizeRequested: true,
    };
    const forcedThread = {
      ...(await readLoopSnapshot(configRoot)).thread,
      continuationStatus: "dispatching",
      lastDispatchAt: new Date().toISOString(),
      lastCompletionAt: "",
    };

    await writeCodexSession(codexHome, threadId, [
      {
        timestamp: "2026-06-07T15:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: "这一轮已完成，测试通过。",
        },
      },
    ]);
    await fs.writeFile(initialSnapshot.paths.statePath, `${JSON.stringify(forcedState, null, 2)}\n`, "utf8");
    await fs.writeFile(initialSnapshot.paths.threadPath, `${JSON.stringify(forcedThread, null, 2)}\n`, "utf8");

    const snapshot = await ensureLoopArtifacts(configRoot);

    assert.equal(snapshot.state.mode, "stopped");
    assert.equal(snapshot.state.stopRequested, false);
    assert.equal(snapshot.thread.continuationStatus, "idle");
    assert.equal(snapshot.thread.latestMode, "stopped");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("ensureLoopArtifacts records each Codex completion sync once during concurrent refreshes", async () => {
  const configRoot = await createWorkspace();
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-home-"));
  process.env.CODEX_HOME = codexHome;

  try {
    const initialSnapshot = await ensureLoopArtifacts(configRoot);
    const threadId = "thread-concurrent-complete";
    await saveThreadBinding(configRoot, {
      workspaceName: "demo",
      threadTitle: "并发同步线程",
      threadId,
      singleThreadMode: true,
    });

    const forcedState = {
      ...initialSnapshot.state,
      mode: "running",
      stopRequested: false,
      finalizeRequested: false,
    };
    const forcedThread = {
      ...(await readLoopSnapshot(configRoot)).thread,
      continuationStatus: "dispatching",
      lastDispatchAt: new Date().toISOString(),
      lastCompletionAt: "",
    };

    await writeCodexSession(codexHome, threadId, [
      {
        timestamp: "2026-06-07T15:03:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: "这一轮已完成，运行记录不能重复写入。",
        },
      },
    ]);
    await fs.writeFile(initialSnapshot.paths.statePath, `${JSON.stringify(forcedState, null, 2)}\n`, "utf8");
    await fs.writeFile(initialSnapshot.paths.threadPath, `${JSON.stringify(forcedThread, null, 2)}\n`, "utf8");

    await Promise.all([
      ensureLoopArtifacts(configRoot),
      ensureLoopArtifacts(configRoot),
      ensureLoopArtifacts(configRoot),
      ensureLoopArtifacts(configRoot),
    ]);

    const logText = await fs.readFile(initialSnapshot.paths.logPath, "utf8");
    const syncEvents = logText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "codex_conversation_mirror_synced");

    assert.equal(syncEvents.length, 1);
    assert.match(syncEvents[0].latestAssistantPreview, /运行记录不能重复写入/);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("runLoopTurn sends the next message to the bound Codex thread and stores visible status", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "持续开发主线",
    threadId: "thread-123",
    singleThreadMode: true,
    note: "desktop primary thread",
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "Continue from the current checklist and rules",
    lastAssistantActionSummary: "Finished the previous verification batch",
    latestCodexSummary: "Previous turn completed the launch feedback fix",
  });

  const snapshot = await runLoopTurn(configRoot, {
    dispatchThreadMessage: async ({ threadId, prompt }) => {
      assert.equal(threadId, "thread-123");
      assert.match(prompt, /下一步：Previous turn completed the launch feedback fix/);
      return {
        lastMessage:
          "Completed the next loop turn and prepared the following verified task.",
      };
    },
  });

  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.continuationCycleCount, 1);
  assert.equal(snapshot.thread.latestEventType, "codex_followup_completed");
  assert.match(snapshot.thread.lastDispatchPrompt, /下一步：Previous turn completed the launch feedback fix/);
  assert.match(snapshot.thread.lastDispatchPrompt, /Previous turn completed the launch feedback fix/);
  assert.match(snapshot.thread.latestCodexSummary, /Completed the next loop turn/);
  assert.ok(snapshot.thread.lastDispatchAt);
  assert.ok(snapshot.thread.lastCompletionAt);

  const transcriptText = await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /codex-loop 已发送指令|发送目标/);
  assert.match(transcriptText, /codex_followup_completed/);
});

test("runLoopTurn uses Chinese follow-up prompt by default", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "开发主线",
    threadId: "thread-zh",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "继续推进核心链路",
    lastAssistantActionSummary: "完成上一轮验证",
    latestCodexSummary: "上一轮已修复启动状态展示",
  });

  let dispatchedPrompt = "";
  await runLoopTurn(configRoot, {
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return { lastMessage: "已继续处理下一批任务" };
    },
  });

  assert.match(dispatchedPrompt, /继续在同一个 Codex 线程中推进。/u);
  assert.match(dispatchedPrompt, /下一步：/u);
  assert.match(dispatchedPrompt, /上一轮已修复启动状态展示/u);
  assert.doesNotMatch(
    dispatchedPrompt,
    /Continue the same Codex thread from its latest verified checkpoint\./,
  );
});

test("runLoopTurn switches to English follow-up prompt when configured", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "en",
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "English thread",
    threadId: "thread-en",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "Continue the current loop",
    lastAssistantActionSummary: "Finished the last verification batch",
    latestCodexSummary: "The launcher status fix is already complete",
  });

  let dispatchedPrompt = "";
  await runLoopTurn(configRoot, {
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return { lastMessage: "Completed the next loop turn" };
    },
  });

  assert.match(dispatchedPrompt, /Continue in this same Codex thread./);
  assert.match(dispatchedPrompt, /Next:/);
  assert.match(dispatchedPrompt, /launcher status fix|Continue the current loop/i);
});

test("runLoopTurn uses ollama-generated prompt when advanced continuation is enabled", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "高级续发线程",
    threadId: "thread-ollama",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "继续推进日志健康检查",
    lastAssistantActionSummary: "完成上一轮界面精简",
    latestCodexSummary: "上一轮已经修复自动化发送可见性",
  });

  let dispatchedPrompt = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt, snapshot: currentSnapshot }) => {
      assert.match(fallbackPrompt, /下一步：/u);
      assert.equal(
        currentSnapshot.profile.resolved.conversation.promptGenerator.enabled,
        true,
      );
      return "请基于上一轮已完成内容，继续推进日志健康检查，并先完成最小可验证批次。";
    },
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return { lastMessage: "已发送动态续发消息" };
    },
  });

  assert.equal(
    dispatchedPrompt,
    "请基于上一轮已完成内容，继续推进日志健康检查，并先完成最小可验证批次。",
  );
  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_completed");
});

test("runLoopTurn tries ollama by default as the global loop brain", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "默认模型线程",
    threadId: "thread-default-ollama",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "继续按产品规则推进",
    lastAssistantActionSummary: "Codex 已完成一批移动端监控",
    latestCodexSummary: "上一轮完成移动端状态展示，需要产品经理视角决定下一步。",
  });

  let generatorCalled = false;
  let dispatchedPrompt = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ snapshot: currentSnapshot }) => {
      generatorCalled = true;
      assert.equal(
        currentSnapshot.profile.resolved.conversation.promptGenerator.enabled,
        "auto",
      );
      return "以产品经理、测试人员和真实用户视角，先验证移动端状态是否清楚，再补齐最小问题清单。";
    },
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return { lastMessage: "已收到本地模型规划后的下一轮指令" };
    },
  });

  assert.equal(generatorCalled, true);
  assert.match(dispatchedPrompt, /产品经理、测试人员和真实用户视角/);
  assert.equal(snapshot.thread.latestEventType, "codex_followup_completed");
});

test("milestone review stores supervisor guidance that the next loop turn uses", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "监督复盘线程",
    threadId: "thread-supervisor-review",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "把 codex-loop 做成可长期使用的产品",
    latestCodexSummary: "Codex 已完成首页状态精简和移动端观察入口，需要决定下一批验收点。",
  });

  let reviewSawSummary = "";
  const reviewed = await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async ({ snapshot }) => {
      reviewSawSummary = snapshot.thread.latestCodexSummary;
      return {
        summary: "监督复盘：上一批可见状态已完成，下一轮要用真实用户视角做移动端验收。",
        nextInstruction:
          "先以真实用户和测试人员视角验收移动端 loop 观察页，修复最影响判断状态的问题；不要扩大到新功能。",
        shouldContinue: true,
        needsIndependentVerification: true,
        verificationCommands: ["npm run test", "npm run build:web"],
        acceptanceFocus: ["移动端状态是否一眼能判断", "首页是否仍然简洁"],
        risks: ["移动端信息过密"],
      };
    },
  });

  assert.match(reviewSawSummary, /移动端观察入口/);
  assert.match(reviewed.thread.lastSupervisorReview, /监督复盘/);
  assert.match(reviewed.thread.lastSupervisorInstruction, /真实用户和测试人员视角/);
  assert.equal(reviewed.thread.lastSupervisorSource, "ollama");
  assert.equal(reviewed.thread.supervisorNeedsIndependentVerification, true);
  assert.deepEqual(reviewed.thread.lastSupervisorVerificationCommands, [
    "npm run test",
    "npm run build:web",
  ]);
  assert.deepEqual(reviewed.thread.lastSupervisorAcceptanceFocus, [
    "移动端状态是否一眼能判断",
    "首页是否仍然简洁",
  ]);

  let dispatchedPrompt = "";
  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.match(dispatchedPrompt, /真实用户和测试人员视角/);
  assert.match(dispatchedPrompt, /不要扩大到新功能/);
});

test("milestone review auto-resolves ordinary product confirmation instead of stopping", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "普通确认复盘线程",
    threadId: "thread-supervisor-ordinary-confirmation",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "把历史对话展示做得更接近 Codex 桌面端",
    latestCodexSummary:
      "Codex 已完成一版对话流布局，现在询问如果没有偏好，是否等待用户确认浅灰分割线还是卡片式展示。",
  });

  const reviewed = await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：Codex 正在等待普通产品偏好确认。",
      nextInstruction: "如果没有偏好，请等待用户确认后再继续。",
      shouldContinue: false,
      needsIndependentVerification: false,
      verificationCommands: [],
      acceptanceFocus: [],
      risks: ["普通展示风格需要确认"],
    }),
  });

  assert.equal(reviewed.thread.latestEventType, "supervisor_review_completed");
  assert.equal(reviewed.thread.lastContinuationError, "");
  assert.doesNotMatch(
    reviewed.thread.lastSupervisorInstruction,
    /等待.*用户|用户确认|没有偏好/,
  );
  assert.match(reviewed.thread.lastSupervisorInstruction, /最安全|可验证|继续/);
});

test("milestone review still pauses for high-risk user confirmation", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "高风险确认复盘线程",
    threadId: "thread-supervisor-risk-confirmation",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "让 codex-loop 长期稳定运行",
    latestCodexSummary:
      "Codex 准备删除旧运行目录并清理凭证缓存，正在等待用户确认后再继续。",
  });

  const reviewed = await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：涉及删除运行目录和凭证缓存，需要用户确认。",
      nextInstruction: "涉及删除运行目录和凭证缓存，请等待用户确认后再继续。",
      shouldContinue: false,
      needsIndependentVerification: false,
      verificationCommands: [],
      acceptanceFocus: [],
      risks: ["删除运行目录", "清理凭证缓存"],
    }),
  });

  assert.equal(reviewed.thread.latestEventType, "supervisor_review_skipped");
  assert.match(reviewed.thread.lastContinuationError, /人工确认|暂停/);
  assert.match(reviewed.thread.lastSupervisorInstruction, /删除|凭证|用户确认/);
});

test("milestone review exposes an in-progress supervisor state before the next turn", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "监督复盘进行中线程",
    threadId: "thread-supervisor-reviewing",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成一批移动端状态展示，等待本地监督员复盘。",
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
        summary: "监督复盘：状态展示清晰，可以继续。",
        nextInstruction: "下一轮继续做最小可验证改动。",
        shouldContinue: true,
        needsIndependentVerification: false,
        verificationCommands: [],
        acceptanceFocus: ["状态清楚"],
        risks: [],
      };
    },
  });

  await generatorStartedPromise;
  const mobileDuringReview = await exportMobileView(configRoot);

  assert.equal(mobileDuringReview.processStatus.state, "supervisor_reviewing");
  assert.equal(mobileDuringReview.processStatus.canSendNextTurn, false);
  assert.match(mobileDuringReview.processStatus.headline, /监督复盘中/);
  assert.match(mobileDuringReview.processStatus.detail, /本地模型|NPC|产品经理|测试/);

  releaseReview();
  const reviewed = await reviewPromise;

  assert.equal(reviewed.thread.latestEventType, "supervisor_review_completed");
});

test("milestone review runs independent verification and injects failures into next turn", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "独立验收线程",
    threadId: "thread-supervisor-verify",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "让移动端能稳定观察 loop 进程",
    latestCodexSummary: "Codex 已完成移动端状态摘要和历史记录展示，等待监督验收。",
  });

  const executedCommands = [];
  const reviewed = await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：移动端进程展示已完成，需要独立验收页面是否能一眼判断状态。",
      nextInstruction:
        "如果验收通过，下一轮继续优化移动端引导；如果失败，优先修复验收暴露的问题。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: ["npm run test:mobile-flow"],
      acceptanceFocus: ["移动端 10 秒内判断 loop 是否健康"],
      risks: [],
    }),
    runVerificationCommand: async ({ command }) => {
      executedCommands.push(command);
      return {
        command,
        ok: false,
        exitCode: 1,
        output: "mobile flow missing latest codex-loop instruction bubble",
      };
    },
  });

  assert.deepEqual(executedCommands, ["npm run test:mobile-flow"]);
  assert.equal(reviewed.thread.lastSupervisorVerificationStatus, "failed");
  assert.match(
    reviewed.thread.lastSupervisorVerificationSummary,
    /mobile flow missing latest codex-loop instruction bubble/,
  );
  assert.match(
    reviewed.thread.lastSupervisorInstruction,
    /优先修复独立验收失败/,
  );
  assert.match(
    reviewed.thread.lastSupervisorInstruction,
    /npm run test:mobile-flow/,
  );

  let dispatchedPrompt = "";
  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.match(dispatchedPrompt, /独立验收失败/);
  assert.match(dispatchedPrompt, /instruction bubble/);
});

test("milestone review tells Codex when requested verification was skipped", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "缺少验收命令线程",
    threadId: "thread-supervisor-skipped-verification",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "把 codex-loop 做成可长期生产使用的 loop 软件",
    latestCodexSummary: "Codex 已完成监督复盘状态展示，需要独立验收但项目暂未配置命令。",
  });

  const reviewed = await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：状态展示已完成，但需要独立验收确认用户能否判断 loop 是否健康。",
      nextInstruction:
        "下一轮先补齐验收暴露的问题，再继续优化长期运行状态。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: [],
      acceptanceFocus: ["用户能否判断 loop 是否健康"],
      risks: [],
    }),
  });

  assert.equal(reviewed.thread.lastSupervisorVerificationStatus, "skipped");
  assert.match(reviewed.thread.lastSupervisorVerificationSummary, /没有可执行命令/);
  assert.match(reviewed.thread.lastSupervisorInstruction, /独立验收未执行/);
  assert.match(reviewed.thread.lastSupervisorInstruction, /没有可执行命令/);

  let dispatchedPrompt = "";
  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.match(dispatchedPrompt, /独立验收未执行/);
  assert.match(dispatchedPrompt, /没有可执行命令/);
});

test("milestone review avoids repeating independent verification inside the cooldown window", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "验收冷却线程",
    threadId: "thread-supervisor-verification-cooldown",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "让 codex-loop 稳定长期运行",
    latestCodexSummary: "Codex 已完成一批移动端状态改动，需要监督验收。",
  });

  const executedCommands = [];
  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：移动端状态改动已完成，需要独立验收。",
      nextInstruction: "下一轮继续优化移动端状态细节。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: ["node --test tests/runtime-store.test.mjs"],
      acceptanceFocus: ["移动端状态是否清楚"],
      risks: [],
    }),
    runVerificationCommand: async ({ command }) => {
      executedCommands.push(command);
      return {
        command,
        ok: true,
        exitCode: 0,
        output: "runtime-store verification passed",
      };
    },
  });

  const reviewedAgain = await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async () => ({
      summary: "监督复盘：Codex 又完成了一个小调整，但距离上次验收很近。",
      nextInstruction: "下一轮只修复一个最影响长期监控判断的小问题。",
      shouldContinue: true,
      needsIndependentVerification: true,
      verificationCommands: ["node --test tests/runtime-store.test.mjs"],
      acceptanceFocus: ["移动端状态是否清楚"],
      risks: [],
    }),
    runVerificationCommand: async ({ command }) => {
      executedCommands.push(command);
      return {
        command,
        ok: true,
        exitCode: 0,
        output: "should not run inside cooldown",
      };
    },
  });

  assert.deepEqual(executedCommands, ["node --test tests/runtime-store.test.mjs"]);
  assert.equal(reviewedAgain.thread.lastSupervisorVerificationStatus, "skipped");
  assert.match(reviewedAgain.thread.lastSupervisorVerificationSummary, /冷却期|近期已完成/);
  assert.match(reviewedAgain.thread.lastSupervisorInstruction, /最影响长期监控判断/);
  assert.match(reviewedAgain.thread.lastSupervisorInstruction, /独立验收未执行/);
  assert.match(reviewedAgain.thread.lastSupervisorInstruction, /冷却期|近期已完成/);
});

test("runLoopTurn degrades to compact template when default ollama is unavailable", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "默认降级线程",
    threadId: "thread-auto-fallback",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "继续优化核心链路",
    latestCodexSummary: "Codex 已完成上一批任务，等待下一轮。",
  });

  let dispatchedPrompt = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => {
      throw new Error("ollama unavailable");
    },
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return { lastMessage: "已通过精简模板继续推进" };
    },
  });

  assert.match(dispatchedPrompt, /继续在同一个 Codex 线程中推进。/u);
  assert.match(snapshot.thread.promptGenerationWarning, /Ollama/);
  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_completed");
});

test("runLoopTurn auto fallback keeps pending guidance in the sent prompt before clearing it", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "默认降级补充线程",
    threadId: "thread-auto-fallback-guidance",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "继续优化核心链路",
    latestCodexSummary: "Codex 已完成上一批任务，等待下一轮。",
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮必须优先检查移动端补充引导是否显示清楚。",
  });

  let dispatchedPrompt = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => {
      throw new Error("ollama unavailable");
    },
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.match(dispatchedPrompt, /用户临时补充/);
  assert.match(dispatchedPrompt, /移动端补充引导/);
  assert.match(snapshot.thread.promptGenerationWarning, /Ollama/);
  assert.equal(snapshot.thread.pendingUserGuidance, "");
  assert.equal(snapshot.thread.continuationStatus, "dispatching");
});

test("sendPendingGuidanceOnce sends queued guidance from monitor mode without starting automatic loop", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "监控模式线程",
    threadId: "thread-monitor-guidance",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成当前批次，等待下一条指令。",
  });
  await savePendingGuidance(configRoot, {
    text: "请先从真实用户角度检查首页状态是否够清楚。",
  });

  const beforeSend = await readLoopSnapshot(configRoot);
  assert.equal(beforeSend.state.mode, "running");
  await requestGracefulStop(configRoot, {
    reason: "enter monitor mode",
  });
  const stopped = await readLoopSnapshot(configRoot);
  assert.equal(stopped.state.mode, "stopped");
  assert.match(stopped.thread.pendingUserGuidance, /真实用户角度/);

  let dispatchedPrompt = "";
  const snapshot = await sendPendingGuidanceOnce(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.match(dispatchedPrompt, /用户临时补充/);
  assert.match(dispatchedPrompt, /真实用户角度/);
  assert.equal(snapshot.state.mode, "running");
  assert.equal(snapshot.state.monitorOnly, true);
  assert.equal(snapshot.thread.pendingUserGuidance, "");
  assert.equal(snapshot.thread.continuationStatus, "dispatching");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_sent_waiting");
});

test("savePendingGuidance appends multiple user notes instead of replacing earlier guidance", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "连续补充线程",
    threadId: "thread-guidance-append",
    singleThreadMode: true,
  });

  await savePendingGuidance(configRoot, {
    text: "先检查移动端能否看到当前状态。",
  });
  const snapshot = await savePendingGuidance(configRoot, {
    text: "再检查历史对话是否像 Codex 一样清楚。",
  });
  const mobile = await exportMobileView(configRoot);

  assert.match(snapshot.thread.pendingUserGuidance, /先检查移动端/);
  assert.match(snapshot.thread.pendingUserGuidance, /再检查历史对话/);
  assert.ok(
    snapshot.thread.pendingUserGuidance.indexOf("先检查移动端") <
      snapshot.thread.pendingUserGuidance.indexOf("再检查历史对话"),
  );
  assert.match(mobile.pendingGuidance.text, /先检查移动端/);
  assert.match(mobile.pendingGuidance.text, /再检查历史对话/);
});

test("clearPendingGuidance removes unsent user guidance without losing thread state", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "清空补充线程",
    threadId: "thread-guidance-clear",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成上一轮，等待下一轮补充。",
  });
  await savePendingGuidance(configRoot, {
    text: "这条补充写错了，需要撤销。",
  });

  const snapshot = await clearPendingGuidance(configRoot);
  const mobile = await exportMobileView(configRoot);

  assert.equal(snapshot.thread.threadId, "thread-guidance-clear");
  assert.equal(snapshot.thread.pendingUserGuidance, "");
  assert.equal(snapshot.thread.pendingUserGuidanceAt, "");
  assert.match(snapshot.thread.latestCodexSummary, /上一轮/);
  assert.equal(mobile.pendingGuidance.hasPending, false);
  assert.equal(mobile.pendingGuidance.text, "");
});

test("pending user guidance is saved for the next ollama continuation and cleared after dispatch", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "补充引导线程",
    threadId: "thread-guidance",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "上一轮已经完成移动端观察入口。",
  });

  const saved = await savePendingGuidance(configRoot, {
    text: "下一轮优先补移动端状态摘要，不要扩大范围。",
  });
  assert.equal(
    saved.thread.pendingUserGuidance,
    "下一轮优先补移动端状态摘要，不要扩大范围。",
  );

  let generatorSawGuidance = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ snapshot: currentSnapshot }) => {
      generatorSawGuidance = currentSnapshot.thread.pendingUserGuidance;
      return "已融合用户补充：下一轮优先补移动端状态摘要。";
    },
    dispatchThreadMessage: async ({ prompt }) => {
      assert.match(prompt, /移动端状态摘要/);
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.equal(generatorSawGuidance, "下一轮优先补移动端状态摘要，不要扩大范围。");
  assert.equal(snapshot.thread.continuationStatus, "dispatching");
  assert.equal(snapshot.thread.pendingUserGuidance, "");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_sent_waiting");
});

test("pending guidance added while Codex is working survives completion and is cleared only after next dispatch", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "工作中补充引导线程",
    threadId: "thread-guidance-during-codex-work",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已准备接收当前轮任务。",
  });

  await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => "当前轮先完成对话记录渲染收口。",
    dispatchThreadMessage: async () => ({
      deliveryObserved: true,
      completionObserved: false,
      lastMessage: "",
    }),
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮请优先按 Loop 工程原则检查停止条件和验证证据。",
  });

  const completed = await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成对话记录渲染，等待下一轮指示。",
  });

  assert.equal(completed.thread.continuationStatus, "idle");
  assert.match(completed.thread.pendingUserGuidance, /停止条件和验证证据/);

  let reviewSawGuidance = "";
  await reviewCodexMilestone(configRoot, {
    generateMilestoneReview: async ({ snapshot }) => {
      reviewSawGuidance = snapshot.thread.pendingUserGuidance;
      return {
        summary: "监督复盘：上一轮完成，需要把用户补充合并进下一轮。",
        nextInstruction:
          "下一轮按用户补充检查停止条件和验证证据，保持小步可验证。",
        shouldContinue: true,
        needsIndependentVerification: false,
        verificationCommands: [],
        acceptanceFocus: ["停止条件清楚", "验证证据可追踪"],
        risks: [],
      };
    },
  });

  assert.match(reviewSawGuidance, /停止条件和验证证据/);

  let generatorSawGuidance = "";
  let dispatchedPrompt = "";
  const sent = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ snapshot, fallbackPrompt }) => {
      generatorSawGuidance = snapshot.thread.pendingUserGuidance;
      return fallbackPrompt;
    },
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.match(generatorSawGuidance, /停止条件和验证证据/);
  assert.match(dispatchedPrompt, /用户临时补充/);
  assert.match(dispatchedPrompt, /停止条件和验证证据/);
  assert.equal(sent.thread.pendingUserGuidance, "");
  assert.equal(sent.thread.continuationStatus, "dispatching");
});

test("syncCodexThreadMirror uses ollama summary when advanced continuation is enabled", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "摘要线程",
    threadId: "thread-summary-ollama",
    singleThreadMode: true,
  });

  let summarizedText = "";
  const snapshot = await syncCodexThreadMirror(
    configRoot,
    {
      latestCodexSummary:
        "Codex wrote a long completion message with implementation details, verification notes, and follow-up risks.",
    },
    {
      generateCodexSummary: async ({ codexText }) => {
        summarizedText = codexText;
        return "已完成实现和验证，并整理了后续风险。";
      },
    },
  );

  assert.match(summarizedText, /long completion message/);
  assert.equal(snapshot.thread.latestCodexSummary, "已完成实现和验证，并整理了后续风险。");
});

test("ollama requests disable thinking output for dashboard summaries and prompts", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen3.5:9b",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "think false thread",
    threadId: "thread-think-false",
    singleThreadMode: true,
  });
  const snapshot = await readLoopSnapshot(configRoot);
  const requestBodies = [];
  const fetchImpl = async (_url, init) => {
    requestBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ response: "模型处理后的文本" }),
    };
  };

  await generatePromptWithOllama({
    snapshot,
    fallbackPrompt: "继续推进下一步。",
    fetchImpl,
  });
  await generateCodexSummaryWithOllama({
    snapshot,
    codexText: "Codex 完成了新的验证批次。",
    fetchImpl,
  });

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].think, false);
  assert.match(requestBodies[0].system, /产品经理 NPC|product-manager NPC/i);
  assert.match(requestBodies[0].prompt, /直接代表用户选择|Do not defer to the human/i);
  assert.match(requestBodies[0].prompt, /高风险删除|destructive/i);
  assert.equal(requestBodies[1].think, false);
});

test("ollama generated follow-up is cleaned before it is sent to Codex", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "清洗模型输出线程",
    threadId: "thread-clean-ollama",
    singleThreadMode: true,
  });
  const snapshot = await readLoopSnapshot(configRoot);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      response:
        '<think>先分析很多内部推理，不应该发给 Codex。</think>\n{"message":"继续按文档规则推进核心链路，只做下一批可验证的小改动，并在完成后给出验证结果。"}',
    }),
  });

  const generated = await generatePromptWithOllama({
    snapshot,
    fallbackPrompt: "继续推进下一步。",
    fetchImpl,
  });

  assert.equal(
    generated,
    "继续按文档规则推进核心链路，只做下一批可验证的小改动，并在完成后给出验证结果。",
  );
  assert.doesNotMatch(generated, /think|message|JSON|^\{/i);
});

test("ollama follow-up does not defer ordinary product choices back to the user", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "普通决策代理线程",
    threadId: "thread-product-decision",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 询问如果没有偏好，是否等待用户确认后再继续。",
  });
  const snapshot = await readLoopSnapshot(configRoot);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      response: "如果没有偏好，请等待用户确认后再继续。",
    }),
  });

  const generated = await generatePromptWithOllama({
    snapshot,
    fallbackPrompt: "继续推进下一步。",
    fetchImpl,
  });

  assert.doesNotMatch(generated, /等待.*用户|用户确认|没有偏好/);
  assert.match(generated, /最安全|可验证|继续/);
});

test("ollama follow-up keeps high-risk user confirmation requests", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "高风险确认线程",
    threadId: "thread-risk-confirmation",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 准备删除旧运行目录并清理凭证缓存，正在等待确认。",
  });
  const snapshot = await readLoopSnapshot(configRoot);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      response: "涉及删除运行目录和凭证缓存，请等待用户确认后再继续。",
    }),
  });

  const generated = await generatePromptWithOllama({
    snapshot,
    fallbackPrompt: "继续推进下一步。",
    fetchImpl,
  });

  assert.match(generated, /删除|凭证/);
  assert.match(generated, /等待.*用户|用户确认/);
  assert.doesNotMatch(generated, /最安全、最小、可验证的方案继续推进/);
});

test("ollama follow-up keeps confirmation when high-risk context is only in Codex summary", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "上下文风险确认线程",
    threadId: "thread-risk-context-confirmation",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 准备删除旧运行目录并清理凭证缓存。",
  });
  const snapshot = await readLoopSnapshot(configRoot);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      response: "请等待用户确认后再继续。",
    }),
  });

  const generated = await generatePromptWithOllama({
    snapshot,
    fallbackPrompt: "继续推进下一步。",
    fetchImpl,
  });

  assert.match(generated, /等待.*用户|用户确认/);
  assert.doesNotMatch(generated, /最安全、最小、可验证的方案继续推进/);
});

test("ollama prompt includes pending user guidance as next-turn context", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "补充引导线程",
    threadId: "thread-guidance-prompt",
    singleThreadMode: true,
  });
  await savePendingGuidance(configRoot, {
    text: "请优先根据文档补齐移动端状态摘要，不要扩大范围。",
  });
  const snapshot = await readLoopSnapshot(configRoot);
  let requestBody = null;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ response: "继续补齐移动端状态摘要。" }),
    };
  };

  await generatePromptWithOllama({
    snapshot,
    fallbackPrompt: "继续推进下一步。",
    fetchImpl,
  });

  assert.match(requestBody.prompt, /用户临时补充/);
  assert.match(requestBody.prompt, /移动端状态摘要/);
  assert.match(requestBody.prompt, /不要机械照抄|融合到下一条指令/);
});

test("ollama prompt includes selected loop rule docs as model context", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
  });
  const projectRoot = path.join(configRoot, "context-project");
  const docsRoot = path.join(projectRoot, "docs");
  await fs.mkdir(docsRoot, { recursive: true });
  const ruleDocPath = path.join(docsRoot, "PRODUCT_RULES.md");
  await fs.writeFile(
    ruleDocPath,
    "# 产品规则\n移动端必须能在 10 秒内判断 loop 是否健康。\n",
    "utf8",
  );

  const loops = await createLoop(configRoot, {
    loopName: "文档上下文任务",
    runId: "docs-context-loop",
    projectName: "文档上下文项目",
    workspaceRoot: projectRoot,
    branch: "dev",
    docs: {
      ruleDocs: [ruleDocPath],
      devDocs: [],
      notes: [],
    },
    startContextPaths: [ruleDocPath],
  });
  const createdLoop = loops.loops.find((loop) => loop.id === "docs-context-loop");
  assert.equal(createdLoop.startContextPaths.includes(ruleDocPath), true);

  await selectLoop(configRoot, { loopId: "docs-context-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "文档上下文项目",
    threadTitle: "文档上下文任务",
    threadId: "thread-doc-context",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成上一批状态展示，等待下一轮。",
  });
  const snapshot = await readLoopSnapshot(configRoot);
  let requestBody = null;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ response: "继续按产品规则验收移动端状态。" }),
    };
  };

  await generatePromptWithOllama({
    snapshot,
    fallbackPrompt: "继续推进下一步。",
    fetchImpl,
  });

  assert.deepEqual(snapshot.config.startContextPaths, [ruleDocPath]);
  assert.match(requestBody.prompt, /参考文档 PRODUCT_RULES\.md/);
  assert.match(requestBody.prompt, /10 秒内判断 loop 是否健康/);
});

test("readLoopSnapshot marks health issue when selected loop rule docs are missing", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const missingRuleDoc = path.join(configRoot, "missing-project", "docs", "PRODUCT_RULES.md");
  await fs.mkdir(path.dirname(missingRuleDoc), { recursive: true });

  await createLoop(configRoot, {
    loopName: "缺失文档任务",
    runId: "missing-doc-loop",
    projectName: "缺失文档项目",
    workspaceRoot: path.dirname(path.dirname(missingRuleDoc)),
    branch: "dev",
    docs: {
      ruleDocs: [missingRuleDoc],
      devDocs: [],
      notes: [],
    },
  });
  await selectLoop(configRoot, { loopId: "missing-doc-loop" });

  const snapshot = await readLoopSnapshot(configRoot);

  assert.match(snapshot.health.issues.join(","), /context:missing/);
  assert.equal(
    snapshot.health.checks.some(
      (check) => check.key === "context" && check.path === missingRuleDoc && check.ok === false,
    ),
    true,
  );
});

test("runLoopTurn blocks dispatch when configured rule docs are missing", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const missingRuleDoc = path.join(configRoot, "missing-project", "docs", "PRODUCT_RULES.md");
  await fs.mkdir(path.dirname(missingRuleDoc), { recursive: true });
  await createLoop(configRoot, {
    loopName: "缺失文档续跑",
    runId: "missing-doc-dispatch-loop",
    projectName: "缺失文档项目",
    workspaceRoot: path.dirname(path.dirname(missingRuleDoc)),
    branch: "dev",
    docs: {
      ruleDocs: [missingRuleDoc],
      devDocs: [],
      notes: [],
    },
  });
  await selectLoop(configRoot, { loopId: "missing-doc-dispatch-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "缺失文档项目",
    threadTitle: "缺失文档续跑",
    threadId: "thread-missing-doc",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成上一轮，等待下一条指令。",
  });

  let dispatchCount = 0;
  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
        dispatchThreadMessage: async () => {
          dispatchCount += 1;
          return {
            deliveryObserved: true,
            completionObserved: false,
            lastMessage: "",
          };
        },
      }),
    /文档|规则|缺失/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(dispatchCount, 0);
  assert.equal(snapshot.state.mode, "stopped");
  assert.equal(snapshot.thread.continuationStatus, "error");
  assert.match(snapshot.thread.lastContinuationError, /文档|规则|缺失/);
});

test("runLoopTurn blocks dispatch when configured rule doc path is not a file", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const ruleDocDirectory = path.join(configRoot, "docs", "RULES.md");
  await fs.mkdir(ruleDocDirectory, { recursive: true });
  await createLoop(configRoot, {
    loopName: "非法文档路径续跑",
    runId: "invalid-doc-dispatch-loop",
    projectName: "非法文档路径项目",
    workspaceRoot: configRoot,
    branch: "dev",
    docs: {
      ruleDocs: [ruleDocDirectory],
      devDocs: [],
      notes: [],
    },
  });
  await selectLoop(configRoot, { loopId: "invalid-doc-dispatch-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "非法文档路径项目",
    threadTitle: "非法文档路径续跑",
    threadId: "thread-invalid-doc",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成上一轮，等待下一条指令。",
  });

  let dispatchCount = 0;
  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
        dispatchThreadMessage: async () => {
          dispatchCount += 1;
          return {
            deliveryObserved: true,
            completionObserved: false,
            lastMessage: "",
          };
        },
      }),
    /文档|规则|不是文件|不可读取/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(dispatchCount, 0);
  assert.match(snapshot.health.issues.join(","), /context:not-file/);
  assert.equal(snapshot.state.mode, "stopped");
  assert.equal(snapshot.thread.continuationStatus, "error");
});

test("runLoopTurn blocks dispatch when configured workspace is missing", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const missingWorkspaceRoot = path.join(configRoot, "missing-project");
  await createLoop(configRoot, {
    loopName: "缺失项目续跑",
    runId: "missing-workspace-dispatch-loop",
    projectName: "缺失项目",
    workspaceRoot: missingWorkspaceRoot,
    branch: "dev",
    docs: {
      ruleDocs: [],
      devDocs: [],
      notes: [],
    },
  });
  await selectLoop(configRoot, { loopId: "missing-workspace-dispatch-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "缺失项目",
    threadTitle: "缺失项目续跑",
    threadId: "thread-missing-workspace",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成上一轮，等待下一条指令。",
  });

  let dispatchCount = 0;
  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
        dispatchThreadMessage: async () => {
          dispatchCount += 1;
          return {
            deliveryObserved: true,
            completionObserved: false,
            lastMessage: "",
          };
        },
      }),
    /项目路径|工作区|不存在|不可用/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(dispatchCount, 0);
  assert.match(snapshot.health.issues.join(","), /workspace:missing/);
  assert.equal(snapshot.state.mode, "stopped");
  assert.equal(snapshot.thread.continuationStatus, "error");
  assert.match(snapshot.thread.lastContinuationError, /项目路径|工作区|不存在|不可用/);
});

test("runLoopTurn blocks dispatch when configured workspace is not a directory", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const workspaceFile = path.join(configRoot, "workspace-as-file.txt");
  await fs.writeFile(workspaceFile, "not a directory", "utf8");
  await createLoop(configRoot, {
    loopName: "非法项目路径续跑",
    runId: "invalid-workspace-dispatch-loop",
    projectName: "非法项目路径",
    workspaceRoot: workspaceFile,
    branch: "dev",
    docs: {
      ruleDocs: [],
      devDocs: [],
      notes: [],
    },
  });
  await selectLoop(configRoot, { loopId: "invalid-workspace-dispatch-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "非法项目路径",
    threadTitle: "非法项目路径续跑",
    threadId: "thread-invalid-workspace",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Codex 已完成上一轮，等待下一条指令。",
  });

  let dispatchCount = 0;
  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
        dispatchThreadMessage: async () => {
          dispatchCount += 1;
          return {
            deliveryObserved: true,
            completionObserved: false,
            lastMessage: "",
          };
        },
      }),
    /项目路径|工作区|不是目录|不可用/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(dispatchCount, 0);
  assert.match(snapshot.health.issues.join(","), /workspace:not-directory/);
  assert.equal(snapshot.state.mode, "stopped");
  assert.equal(snapshot.thread.continuationStatus, "error");
});

test("ollama supervisor review includes user customized npc rules", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
      supervisor: {
        roleTraits:
          "像挑剔真实用户一样关注首次使用是否一眼看懂，同时像产品经理一样控制范围。",
        testingRules:
          "每次涉及移动端都要检查小屏状态、历史记录和补充引导是否清楚。",
        acceptanceCriteria:
          "只有当用户能在 10 秒内判断 loop 是否在工作，才认为移动端体验合格。",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "NPC 自定义线程",
    threadId: "thread-supervisor-custom",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "把 codex-loop 做成长期可用的 AI 编程助手",
    latestCodexSummary: "Codex 已完成移动端状态和对话记录初版。",
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮重点检查移动端是否能及时引导项目方向。",
  });
  const snapshot = await readLoopSnapshot(configRoot);
  let requestBody = null;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          summary: "监督复盘：移动端初版可用，但还要按自定义验收标准检查。",
          nextInstruction: "先按用户自定义测试规则验收移动端状态和补充引导。",
          shouldContinue: true,
          needsIndependentVerification: true,
          verificationCommands: ["npm run test"],
          acceptanceFocus: ["移动端 10 秒内判断状态"],
          risks: [],
        }),
      }),
    };
  };

  await generateMilestoneReviewWithOllama({
    snapshot,
    fallbackReview: {
      summary: "降级复盘",
      nextInstruction: "继续推进。",
      verificationCommands: ["npm run test"],
      acceptanceFocus: ["移动端状态"],
    },
    fetchImpl,
  });

  assert.match(requestBody.system, /产品经理|真实挑剔用户/);
  assert.match(requestBody.prompt, /像挑剔真实用户一样关注首次使用/);
  assert.match(requestBody.prompt, /每次涉及移动端都要检查小屏状态/);
  assert.match(requestBody.prompt, /10 秒内判断 loop 是否在工作/);
  assert.match(requestBody.prompt, /下一轮重点检查移动端/);
});

test("runLoopTurn falls back to template prompt when ollama generation fails", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "回退线程",
    threadId: "thread-fallback",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "继续推进移动端适配",
    latestCodexSummary: "上一轮已经补完主要接口",
  });

  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        generateFollowupPrompt: async () => {
          throw new Error("ollama unavailable");
        },
      }),
    /本地模型生成续跑指令失败，请检查 Ollama 和模型配置。/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.match(snapshot.thread.lastContinuationError, /ollama unavailable/);
  assert.equal(snapshot.thread.continuationStatus, "error");
  assert.equal(snapshot.thread.lastContinuationFailureCategory, "ollama_generation");
  assert.equal(snapshot.thread.lastContinuationFailureLabel, "本地模型生成失败");
  assert.match(snapshot.thread.lastContinuationFailureAction, /Ollama|模型|设置/);
});

test("runLoopTurn stops the visible run when desktop dispatch fails", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "visible thread",
    threadId: "thread-native-missing",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "上一轮已经完成，等待下一条指令。",
  });
  await startRun(configRoot);

  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        dispatchThreadMessage: async () => {
          throw new Error("没有找到目标 Codex 桌面线程");
        },
      }),
    /没有找到目标 Codex 桌面线程/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(snapshot.state.mode, "stopped");
  assert.equal(snapshot.state.modeLabel, "已停止");
  assert.equal(snapshot.state.stopRequested, false);
  assert.equal(snapshot.state.finalizeRequested, false);
  assert.equal(snapshot.thread.continuationStatus, "error");
  assert.equal(snapshot.thread.lastContinuationFailureCategory, "codex_dispatch");
  assert.equal(snapshot.thread.lastContinuationFailureLabel, "Codex 发送失败");
  assert.match(snapshot.thread.lastContinuationFailureAction, /线程绑定|桌面端|重新开始/);
  assert.match(snapshot.thread.latestSummary, /发送下一轮指令失败/);
});

test("syncCodexThreadMirror appends a transcript entry when a real Codex summary arrives", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);

  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "summary thread",
    threadId: "thread-summary",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Completed the latest verified Codex batch",
  });

  const transcriptText = await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /Completed the latest verified Codex batch/);
});

test("syncCodexThreadMirror keeps completion state after the next snapshot reload", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "completion thread",
    threadId: "thread-completion",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "previous verified result",
  });

  await runLoopTurn(configRoot, {
    dispatchThreadMessage: async () => ({ lastMessage: "dispatched" }),
  });

  const synced = await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "new verified result",
  });

  assert.equal(synced.thread.continuationStatus, "idle");
  assert.equal(synced.thread.latestEventType, "codex_followup_completed");
  assert.equal(synced.thread.continuationCycleCount, 1);
  assert.ok(synced.thread.lastCompletionAt);

  const reloaded = await readLoopSnapshot(configRoot);
  assert.equal(reloaded.thread.continuationStatus, "idle");
  assert.equal(reloaded.thread.latestEventType, "codex_followup_completed");
  assert.equal(reloaded.thread.continuationCycleCount, 1);
  assert.match(reloaded.thread.latestSummary, /Codex|可开始下一轮/);
});

test("syncCodexThreadMirror clears stale dispatch errors after a real completion", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "completion clears error thread",
    threadId: "thread-completion-clears-error",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "previous summary",
  });

  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        dispatchThreadMessage: async () => {
          throw new Error("桌面端暂时不可接收新指令");
        },
      }),
    /桌面端暂时不可接收新指令/,
  );

  const failed = await readLoopSnapshot(configRoot);
  assert.match(failed.thread.lastContinuationError, /桌面端暂时不可接收新指令/);

  await fs.writeFile(
    failed.paths.threadPath,
    `${JSON.stringify(
      {
        ...failed.thread,
        continuationStatus: "dispatching",
      },
      null,
      2,
    )}\n`,
  );

  const synced = await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "new verified result after native delivery",
  });

  assert.equal(synced.thread.continuationStatus, "idle");
  assert.equal(synced.thread.latestEventType, "codex_followup_completed");
  assert.equal(synced.thread.lastContinuationError, "");
});

test("readLoopSnapshot drops stale continuation errors outside error state", async () => {
  const configRoot = await createWorkspace();
  const initialSnapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "stale non-error thread",
    threadId: "thread-stale-non-error",
    singleThreadMode: true,
  });

  await fs.writeFile(
    initialSnapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...(await readLoopSnapshot(configRoot)).thread,
        continuationStatus: "idle",
        latestEventType: "codex_followup_completed",
        lastContinuationError: "旧的失败信息",
      },
      null,
      2,
    )}\n`,
  );

  const snapshot = await readLoopSnapshot(configRoot);

  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.lastContinuationError, "");
  assert.equal(snapshot.health.lastContinuationError, "");
});

test("runLoopTurn writes completion immediately when the Codex dispatcher returns a finished message", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "dispatcher completion thread",
    threadId: "thread-dispatch-complete",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "previous summary",
  });

  const snapshot = await runLoopTurn(configRoot, {
    dispatchThreadMessage: async () => ({
      lastMessage: "Completed the next verified Codex batch",
      completionObserved: true,
    }),
  });

  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_completed");
  assert.equal(snapshot.thread.continuationCycleCount, 1);
  assert.match(snapshot.thread.latestCodexSummary, /Completed the next verified Codex batch/);
});

test("runLoopTurn clears pending guidance when the dispatched turn completes immediately", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "立即完成补充线程",
    threadId: "thread-immediate-guidance-clear",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "上一轮已完成，等待下一条指令。",
  });
  await savePendingGuidance(configRoot, {
    text: "下一轮优先确认用户补充不会被重复发送。",
  });

  let dispatchedPrompt = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return {
        lastMessage: "Codex 已完成本轮，并确认不会重复发送用户补充。",
        completionObserved: true,
      };
    },
  });

  assert.match(dispatchedPrompt, /用户临时补充/);
  assert.match(dispatchedPrompt, /不会被重复发送/);
  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_completed");
  assert.equal(snapshot.thread.pendingUserGuidance, "");
  assert.equal(snapshot.thread.pendingUserGuidanceAt, "");
});

test("runLoopTurn preserves guidance added after dispatch starts when completion returns immediately", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "立即完成并发补充线程",
    threadId: "thread-immediate-guidance-append",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "上一轮已完成，等待下一条指令。",
  });
  await savePendingGuidance(configRoot, {
    text: "这条补充已经进入本次发送。",
  });

  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async () => {
      await savePendingGuidance(configRoot, {
        text: "这条补充是发送开始后新增的，应该留到下一轮。",
      });
      return {
        lastMessage: "Codex 已完成本轮。",
        completionObserved: true,
      };
    },
  });

  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.doesNotMatch(snapshot.thread.pendingUserGuidance, /已经进入本次发送/);
  assert.match(snapshot.thread.pendingUserGuidance, /应该留到下一轮/);
  assert.ok(snapshot.thread.pendingUserGuidanceAt);
});

test("runLoopTurn preserves guidance added after dispatch starts while waiting for Codex", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      language: "zh-CN",
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
      },
    },
  });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "等待中并发补充线程",
    threadId: "thread-waiting-guidance-append",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "上一轮已完成，等待下一条指令。",
  });
  await savePendingGuidance(configRoot, {
    text: "这条补充已经进入等待中的本次发送。",
  });

  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async () => {
      await savePendingGuidance(configRoot, {
        text: "这条补充是在等待 Codex 期间新增的，必须留到下一轮。",
      });
      return {
        deliveryObserved: true,
        completionObserved: false,
        lastMessage: "",
      };
    },
  });

  assert.equal(snapshot.thread.continuationStatus, "dispatching");
  assert.doesNotMatch(snapshot.thread.pendingUserGuidance, /已经进入等待中的本次发送/);
  assert.match(snapshot.thread.pendingUserGuidance, /必须留到下一轮/);
  assert.ok(snapshot.thread.pendingUserGuidanceAt);
});

test("runLoopTurn fails when native dispatch does not confirm target-thread delivery", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "visible thread",
    threadId: "thread-delivery-unconfirmed",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "previous summary",
  });

  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        dispatchThreadMessage: async () => ({
          deliveryObserved: false,
          completionObserved: false,
          lastMessage: "",
        }),
      }),
    /未确认送达|没有观察到目标线程/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(snapshot.state.mode, "stopped");
  assert.equal(snapshot.thread.continuationStatus, "error");
  assert.match(snapshot.thread.lastContinuationError, /未确认送达|没有观察到目标线程/);
});

test("runLoopTurn keeps waiting when native delivery succeeds but Codex has not completed yet", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "visible thread",
    threadId: "thread-visible-wait",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Previous turn already finished",
  });

  const snapshot = await runLoopTurn(configRoot, {
    dispatchThreadMessage: async () => ({
      lastMessage: "",
      deliveryObserved: true,
      completionObserved: false,
      dispatchedTurnId: "turn-waiting",
    }),
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
  });

  assert.equal(snapshot.state.mode, "running");
  assert.equal(snapshot.thread.continuationStatus, "dispatching");
  assert.equal(snapshot.thread.lastContinuationError, "");
  assert.equal(snapshot.thread.latestEventType, "codex_followup_sent_waiting");
});

test("runLoopTurn rejects duplicate dispatch while a continuation is actively in flight", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "主线程",
    threadId: "thread-busy",
    singleThreadMode: true,
  });

  const busySnapshot = await readLoopSnapshot(configRoot);
  await fs.writeFile(
    busySnapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...busySnapshot.thread,
        continuationStatus: "dispatching",
        lastDispatchAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await assert.rejects(
    () => runLoopTurn(configRoot),
    /already dispatching/i,
  );
});

test("runLoopTurn rejects dispatch while supervisor review is in progress", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "监督复盘线程",
    threadId: "thread-reviewing",
    singleThreadMode: true,
  });

  const reviewingSnapshot = await readLoopSnapshot(configRoot);
  await fs.writeFile(
    reviewingSnapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...reviewingSnapshot.thread,
        continuationStatus: "reviewing",
        latestEventType: "supervisor_review_started",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await assert.rejects(
    () => runLoopTurn(configRoot),
    /监督复盘|review/i,
  );
});

test("runLoopTurn does not send another prompt while Codex is still processing", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "busy thread",
    threadId: "thread-still-processing",
    singleThreadMode: true,
  });

  const busySnapshot = await readLoopSnapshot(configRoot);
  await fs.writeFile(
    busySnapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...busySnapshot.thread,
        continuationEnabled: true,
        continuationStatus: "dispatching",
        lastDispatchAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const refreshed = await readLoopSnapshot(configRoot);
  assert.equal(refreshed.thread.continuationStatus, "dispatching");
  assert.equal(refreshed.thread.lastContinuationError, "");
  assert.match(refreshed.health.issues.join(","), /continuation:stalled/);

  await assert.rejects(
    () => runLoopTurn(configRoot),
    /already dispatching/i,
  );
});

test("runLoopTurn rejects using the current Codex session thread as the loop target", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  const originalThreadId = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "thread-self";

  try {
    await saveThreadBinding(configRoot, {
      workspaceName: "demo",
      threadTitle: "当前会话线程",
      threadId: "thread-self",
      singleThreadMode: true,
    });

    await assert.rejects(
      () => runLoopTurn(configRoot),
      /current Codex session/i,
    );
  } finally {
    if (originalThreadId === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = originalThreadId;
    }
  }
});

test("renameLoop updates loop name in config and runtime snapshot", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const snapshot = await renameLoop(configRoot, {
    loopName: "core-longrun-loop",
  });

  assert.equal(snapshot.config.loopName, "core-longrun-loop");
  assert.equal(snapshot.state.loopName, "core-longrun-loop");
});

test("listLoops seeds a generic default loop for the workspace", async () => {
  const configRoot = await createWorkspace();
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      { ...buildConfig() },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const loops = await listLoops(configRoot);

  assert.equal(loops.currentLoopId, "run-a");
  assert.equal(loops.loops.length, 1);
  assert.equal(loops.loops[0].name, "demo");
  assert.equal(loops.loops[0].threadTitle, "未绑定线程");
  assert.equal(loops.loops[0].budgets.maxMinutes, 120);
});

test("createLoop persists a new loop and selectLoop switches active config", async () => {
  const configRoot = await createWorkspace();
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      { ...buildConfig() },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await createLoop(configRoot, {
    loopName: "二阶段验证",
    runId: "run-phase-2",
    threadTitle: "二阶段验证",
    budgets: {
      maxMinutes: 90,
      maxTokens: 45000,
      finalizeLeadMinutes: 10,
      finalizeLeadTokens: 6000,
    },
  });

  const selected = await selectLoop(configRoot, { loopId: "run-phase-2" });

  assert.equal(selected.config.currentRunId, "run-phase-2");
  assert.equal(selected.config.loopName, "二阶段验证");
  assert.equal(selected.thread.threadTitle, "二阶段验证");
});

test("updateBudgets normalizes stop limits and syncs the current loop registry", async () => {
  const configRoot = await createWorkspace();

  const snapshot = await updateBudgets(configRoot, {
    maxMinutes: "240",
    maxTokens: "",
    finalizeLeadMinutes: "-5",
    finalizeLeadTokens: "8000",
  });
  const loops = await listLoops(configRoot);
  const currentLoop = loops.loops.find((loop) => loop.id === loops.currentLoopId);
  const config = JSON.parse(
    await fs.readFile(path.join(configRoot, "codex_loop", "config.json"), "utf8"),
  );

  assert.equal(snapshot.state.budgets.maxMinutes, 240);
  assert.equal(snapshot.state.budgets.maxTokens, 50000);
  assert.equal(snapshot.state.budgets.finalizeLeadMinutes, 15);
  assert.equal(snapshot.state.budgets.finalizeLeadTokens, 8000);
  assert.equal(currentLoop.budgets.maxMinutes, 240);
  assert.equal(currentLoop.budgets.maxTokens, 50000);
  assert.equal(currentLoop.budgets.finalizeLeadMinutes, 15);
  assert.equal(currentLoop.budgets.finalizeLeadTokens, 8000);
  assert.equal(config.budgets.maxMinutes, 240);
  assert.equal(config.budgets.maxTokens, 50000);
});

test("updateLoopSupervisor stores project-specific npc rules and merges them into ollama prompts", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveUserOverrides(configRoot, {
    conversation: {
      promptGenerator: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5:7b",
        baseUrl: "http://127.0.0.1:11434",
      },
      supervisor: {
        roleTraits: "全局：像产品经理一样控制范围。",
        testingRules: "全局：完成里程碑后再验收。",
        acceptanceCriteria: "全局：每轮必须可验证。",
      },
    },
  });

  await updateLoopSupervisor(configRoot, {
    roleTraits: "当前项目：像挑剔真实用户一样检查移动端引导。",
    testingRules: "当前项目：每次循环都要确认历史对话左右分布清楚。",
    acceptanceCriteria: "当前项目：手机 10 秒内能判断 Codex 是否正在处理。",
  });

  const snapshot = await readLoopSnapshot(configRoot);
  assert.match(snapshot.loop.supervisor.roleTraits, /挑剔真实用户/);
  assert.match(
    snapshot.profile.resolved.conversation.supervisor.roleTraits,
    /全局：像产品经理一样控制范围/,
  );
  assert.match(
    snapshot.profile.resolved.conversation.supervisor.roleTraits,
    /当前 loop：当前项目：像挑剔真实用户/,
  );
  assert.match(
    snapshot.profile.resolved.conversation.supervisor.testingRules,
    /历史对话左右分布清楚/,
  );

  let requestBody = null;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          summary: "监督复盘：按当前 loop 规则继续。",
          nextInstruction: "先修复移动端对话流。",
          shouldContinue: true,
          needsIndependentVerification: true,
          verificationCommands: ["npm run test"],
          acceptanceFocus: ["移动端判断状态"],
          risks: [],
        }),
      }),
    };
  };

  await generateMilestoneReviewWithOllama({
    snapshot,
    fallbackReview: {
      summary: "降级复盘",
      nextInstruction: "继续推进。",
      verificationCommands: ["npm run test"],
      acceptanceFocus: ["移动端状态"],
    },
    fetchImpl,
  });

  assert.match(requestBody.prompt, /当前项目：像挑剔真实用户一样检查移动端引导/);
  assert.match(requestBody.prompt, /手机 10 秒内能判断 Codex 是否正在处理/);
});

test("selectLoop restores the saved thread binding for that loop", async () => {
  const configRoot = await createWorkspace();

  await createLoop(configRoot, {
    loopName: "alpha loop",
    runId: "alpha-loop",
    threadTitle: "Alpha Thread",
  });

  await createLoop(configRoot, {
    loopName: "beta loop",
    runId: "beta-loop",
    threadTitle: "Beta Thread",
  });

  await selectLoop(configRoot, { loopId: "alpha-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "Alpha Thread",
    threadId: "thread-alpha",
    singleThreadMode: true,
    note: "alpha binding",
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "continue alpha",
    latestCodexSummary: "alpha summary",
  });

  await selectLoop(configRoot, { loopId: "beta-loop" });
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "Beta Thread",
    threadId: "thread-beta",
    singleThreadMode: true,
    note: "beta binding",
  });

  const restored = await selectLoop(configRoot, { loopId: "alpha-loop" });

  assert.equal(restored.thread.threadId, "thread-alpha");
  assert.equal(restored.thread.threadTitle, "Alpha Thread");
  assert.equal(restored.thread.note, "alpha binding");
  assert.equal(restored.thread.lastUserInstructionSummary, "continue alpha");
  assert.equal(restored.thread.latestCodexSummary, "alpha summary");
});

test("selectLoop writes a visible note describing the current loop binding state", async () => {
  const configRoot = await createWorkspace();

  await createLoop(configRoot, {
    loopName: "alpha loop",
    runId: "alpha-loop",
    threadTitle: "Alpha Thread",
  });

  await selectLoop(configRoot, { loopId: "alpha-loop" });
  const unbound = await readLoopSnapshot(configRoot);
  assert.match(unbound.thread.note, /alpha loop/i);
  assert.match(unbound.thread.note, /\u672a\u7ed1\u5b9a|\u7ebf\u7a0b/);

  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "Alpha Thread",
    threadId: "thread-alpha",
    singleThreadMode: true,
  });

  const rebound = await selectLoop(configRoot, { loopId: "alpha-loop" });
  assert.match(rebound.thread.note, /Alpha Thread/);
  assert.match(rebound.thread.note, /thread-alpha/);
});

test("deleteLoop removes an inactive loop from the registry", async () => {
  const configRoot = await createWorkspace();
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      { ...buildConfig() },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await createLoop(configRoot, {
    loopName: "待删除循环",
    runId: "run-delete-me",
    threadTitle: "待删除循环",
  });

  const loops = await deleteLoop(configRoot, { loopId: "run-delete-me" });

  assert.equal(loops.loops.some((loop) => loop.id === "run-delete-me"), false);
  assert.equal(loops.currentLoopId, "run-a");
});

test("deleteLoop also removes the bound Codex automation when present", async () => {
  const configRoot = await createWorkspace();
  await createLoop(configRoot, {
    loopName: "带自动化的循环",
    runId: "run-delete-automation",
    threadTitle: "带自动化的循环",
  });

  const loopsPath = path.join(configRoot, "codex_loop", "settings", "loops.json");
  const loopsJson = JSON.parse(await fs.readFile(loopsPath, "utf8"));
  loopsJson.loops = loopsJson.loops.map((loop) =>
    loop.id === "run-delete-automation"
      ? {
          ...loop,
          threadBinding: {
            ...(loop.threadBinding || {}),
            threadId: "thread-delete-1",
            heartbeatAutomation: "automation-delete-1",
          },
        }
      : loop,
  );
  await fs.writeFile(loopsPath, `${JSON.stringify(loopsJson, null, 2)}\n`, "utf8");

  const automationRoot = path.join(os.homedir(), ".codex", "automations", "automation-delete-1");
  await fs.mkdir(automationRoot, { recursive: true });
  await fs.writeFile(
    path.join(automationRoot, "automation.toml"),
    [
      'id = "automation-delete-1"',
      'kind = "heartbeat"',
      'target_thread_id = "thread-delete-1"',
      'rrule = "RRULE:FREQ=MINUTELY;INTERVAL=10"',
    ].join("\n"),
    "utf8",
  );

  const result = await deleteLoop(configRoot, { loopId: "run-delete-automation" });

  assert.equal(result.loops.some((loop) => loop.id === "run-delete-automation"), false);
  assert.equal(result.automationCleanup.deleted, true);
  await assert.rejects(fs.access(path.join(automationRoot, "automation.toml")));
});

test("loop creation assistant asks for missing project path first", async () => {
  const configRoot = await createWorkspace();
  const state = await getLoopCreationAssistantState(configRoot);

  assert.equal(state.status, "collecting");
  assert.equal(state.currentQuestion.id, "workspace_root");
  assert.match(state.currentQuestion.prompt, /项目路径|workspace/i);
});

test("loop creation assistant can start from a natural-language planning intent", async () => {
  const configRoot = await createWorkspace();
  const projectRoot = path.join(configRoot, "demo-project");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-project",
        scripts: {
          test: "vitest run",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "docs", "RULES.md"), "# rules\n", "utf8");

  let state = await replyLoopCreationAssistant(configRoot, {
    answer: projectRoot,
  });
  assert.equal(state.currentQuestion.id, "project_name");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "我要针对这个项目做自动化 loop 规划，先帮我设计第一个循环",
    planner: {
      enabled: true,
    },
    planLoop: async ({ draft, answer }) => {
      assert.equal(draft.workspaceRoot, projectRoot);
      assert.match(answer, /自动化 loop 规划/);
      return {
        source: "template",
        objectiveSummary: "先围绕核心链路设计首个循环",
        suggestedProjectName: "opencow",
        suggestedLoopName: "首个核心链路循环",
        suggestedBranch: "dev",
        checklist: ["确认规则文档", "确认分支"],
        riskNotes: ["Git 已存在"],
        nextQuestion: "项目名要直接使用 opencow 吗？",
      };
    },
  });

  assert.equal(state.step, "plan_review");
  assert.equal(state.draft.intent, "我要针对这个项目做自动化 loop 规划，先帮我设计第一个循环");
  assert.equal(state.draft.plan.objectiveSummary, "先围绕核心链路设计首个循环");
  assert.equal(state.draft.projectName, "opencow");
  assert.equal(state.draft.loopName, "首个核心链路循环");
  assert.equal(state.draft.branch, "dev");
  assert.equal(state.currentQuestion.id, "plan_review");
  assert.match(state.currentQuestion.prompt, /opencow|项目名/);
  assert.equal(state.draft.plan.pendingField, "project_name");
});

test("loop creation assistant can review planner suggestions step by step before creation", async () => {
  const configRoot = await createWorkspace();
  const projectRoot = path.join(configRoot, "planner-project");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "planner-project" }, null, 2)}\n`,
    "utf8",
  );
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "docs", "RULES.md"), "# rules\n", "utf8");

  let state = await replyLoopCreationAssistant(configRoot, {
    answer: projectRoot,
  });
  assert.equal(state.currentQuestion.id, "project_name");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "我要先规划这个项目的首个自动化循环",
    planner: {
      enabled: true,
    },
    planLoop: async () => ({
      source: "template",
      objectiveSummary: "先围绕启动、停止和可见状态搭建首个任务",
      suggestedProjectName: "规划项目",
      suggestedLoopName: "首个任务规划",
      suggestedBranch: "dev",
      checklist: ["确认项目名", "确认任务名", "确认分支", "确认文档来源"],
      riskNotes: ["需要优先验证真实线程绑定"],
      nextQuestion: "项目名先使用规划项目可以吗？",
    }),
  });

  assert.equal(state.currentQuestion.id, "plan_review");
  assert.equal(state.draft.plan.pendingField, "project_name");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "改成桌面控制台项目",
  });
  assert.equal(state.draft.projectName, "桌面控制台项目");
  assert.equal(state.currentQuestion.id, "plan_review");
  assert.equal(state.draft.plan.pendingField, "loop_name");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "使用建议",
  });
  assert.equal(state.draft.loopName, "首个任务规划");
  assert.equal(state.currentQuestion.id, "plan_review");
  assert.equal(state.draft.plan.pendingField, "branch");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "feature/desktop-loop",
  });
  assert.equal(state.draft.branch, "feature/desktop-loop");
  assert.equal(state.currentQuestion.id, "docs_confirmed");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "confirm",
  });

  assert.equal(state.status, "completed");
  assert.equal(state.createdLoop.loop.projectName, "桌面控制台项目");
  assert.equal(state.createdLoop.loop.name, "首个任务规划");
  assert.equal(state.createdLoop.loop.branch, "feature/desktop-loop");
  assert.equal(
    state.createdLoop.loop.creation.planning.objectiveSummary,
    "先围绕启动、停止和可见状态搭建首个任务",
  );
  assert.deepEqual(state.createdLoop.loop.creation.planning.checklist, [
    "确认项目名",
    "确认任务名",
    "确认分支",
    "确认文档来源",
  ]);
  assert.deepEqual(state.createdLoop.loop.creation.planning.riskNotes, [
    "需要优先验证真实线程绑定",
  ]);
  assert.equal(state.createdLoop.loop.creation.evidence.gitStatus, "ready");
  assert.equal(state.createdLoop.loop.creation.evidence.detectedCommands.length, 0);

  const snapshot = await selectLoop(configRoot, { loopId: state.createdLoop.loop.id });
  assert.equal(
    snapshot.loop.creation.planning.objectiveSummary,
    "先围绕启动、停止和可见状态搭建首个任务",
  );
  const mobile = await exportMobileView(configRoot);
  assert.match(mobile.loop.creation.planning.riskSummary, /真实线程绑定/);
  assert.match(mobile.loop.creation.evidenceSummary, /git.*ready|ready.*git/i);
});

test("loop creation assistant can detect git, docs, and create a grouped loop", async () => {
  const configRoot = await createWorkspace();
  const projectRoot = path.join(configRoot, "demo-project");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-project",
        scripts: {
          test: "vitest run",
          build: "vite build",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "docs", "DEV_RULES.md"), "# rules\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "docs", "开发文档.md"), "# dev doc\n", "utf8");

  let state = await replyLoopCreationAssistant(configRoot, {
    answer: projectRoot,
  });
  assert.equal(state.currentQuestion.id, "project_name");
  assert.equal(state.draft.workspaceRoot, projectRoot);
  assert.equal(state.draft.git.hasGit, true);

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "演示项目",
  });
  assert.equal(state.currentQuestion.id, "loop_name");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "核心链路推进",
  });
  assert.equal(state.currentQuestion.id, "branch");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "dev",
  });
  assert.equal(state.currentQuestion.id, "docs_confirmed");
  assert.equal(state.draft.docs.ruleDocs.length > 0, true);
  assert.equal(state.draft.docs.devDocs.length > 0, true);

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "confirm",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.createdLoop.loop.name, "核心链路推进");
  assert.equal(state.createdLoop.loop.projectName, "演示项目");
  assert.equal(state.createdLoop.loop.branch, "dev");
  assert.equal(state.createdLoop.loop.workspaceRoot, projectRoot);
  assert.equal(state.createdLoop.loop.git.hasGit, true);
  assert.equal(state.createdLoop.loop.docs.ruleDocs.some((file) => /DEV_RULES\.md$/.test(file)), true);

  const loops = await listLoops(configRoot);
  const createdLoop = loops.loops.find((loop) => loop.id === state.createdLoop.loop.id);
  assert.equal(createdLoop.projectName, "演示项目");
  assert.equal(createdLoop.workspaceRoot, projectRoot);
});

test("syncCodexThreadMirror stores normalized Codex linkage summaries", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const snapshot = await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "Continue refining the reusable loop tool",
    lastAssistantActionSummary: "Added thread mirror metadata and tests",
    latestCodexSummary: "Thread mirror now tracks recent state and summaries",
  });

  assert.equal(
    snapshot.thread.lastUserInstructionSummary,
    "Continue refining the reusable loop tool",
  );
  assert.equal(
    snapshot.thread.lastAssistantActionSummary,
    "Added thread mirror metadata and tests",
  );
  assert.equal(
    snapshot.thread.latestCodexSummary,
    "Thread mirror now tracks recent state and summaries",
  );
});

test("syncCodexThreadMirror ignores thread-id-only summaries", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "demo thread",
    threadId: "019e9db5-73ae-7292-877f-83b6bf6ab13a",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Meaningful previous summary",
  });

  const snapshot = await syncCodexThreadMirror(configRoot, {
    latestCodexSummary:
      "当前窗口的 thread id 是 `019e9db5-73ae-7292-877f-83b6bf6ab13a`。",
  });

  assert.equal(snapshot.thread.latestCodexSummary, "Meaningful previous summary");
});

test("loop creation assistant supports going back and restarting", async () => {
  const configRoot = await createWorkspace();
  const projectRoot = path.join(configRoot, "demo-project");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".git", "HEAD"),
    "ref: refs/heads/dev\n",
    "utf8",
  );

  let state = await replyLoopCreationAssistant(configRoot, {
    answer: projectRoot,
  });
  assert.equal(state.step, "project_name");

  state = await replyLoopCreationAssistant(configRoot, {
    answer: "演示项目",
  });
  assert.equal(state.step, "loop_name");

  state = await goBackLoopCreationAssistant(configRoot);
  assert.equal(state.step, "project_name");

  state = await restartLoopCreationAssistant(configRoot);
  assert.equal(state.step, "workspace_root");
  assert.equal(state.draft.workspaceRoot, "");
});

test("exportLoopSummary includes Codex linkage summaries", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "Keep the thread history seamless",
    lastAssistantActionSummary: "Added summary export route",
    latestCodexSummary: "Summary export is ready for lightweight clients",
  });

  const summary = await exportLoopSummary(configRoot);

  assert.equal(
    summary.lastUserInstructionSummary,
    "Keep the thread history seamless",
  );
  assert.equal(
    summary.lastAssistantActionSummary,
    "Added summary export route",
  );
  assert.equal(
    summary.latestCodexSummary,
    "Summary export is ready for lightweight clients",
  );
});

test("readLoopSnapshot marks health issue when heartbeat is stale", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await startRun(configRoot);
  const staleAt = new Date(Date.now() - 1000 * 60 * 20).toISOString();
  const nextState = {
    ...snapshot.state,
    startedAt: staleAt,
    lastHeartbeatAt: staleAt,
  };

  await fs.writeFile(
    snapshot.paths.statePath,
    `${JSON.stringify(nextState, null, 2)}\n`,
    "utf8",
  );

  const refreshed = await readLoopSnapshot(configRoot);
  assert.equal(refreshed.health.ok, false);
  assert.match(refreshed.health.issues.join(","), /heartbeat:stale/);
});

test("readLoopSnapshot reports long-running Codex work without converting it to failure", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "long-running thread",
    threadId: "thread-long-running",
    singleThreadMode: true,
  });

  const currentThread = (await readLoopSnapshot(configRoot)).thread;
  await fs.writeFile(
    snapshot.paths.threadPath,
    `${JSON.stringify(
      {
        ...currentThread,
        continuationEnabled: true,
        continuationStatus: "dispatching",
        lastContinuationError: "",
        lastDispatchAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const refreshed = await readLoopSnapshot(configRoot);
  assert.equal(refreshed.thread.continuationStatus, "dispatching");
  assert.equal(refreshed.thread.lastContinuationError, "");
  assert.equal(refreshed.health.ok, false);
  assert.match(refreshed.health.issues.join(","), /continuation:stalled/);
});

test("readLoopSnapshot marks health issue when transcript is stale during an active run", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await startRun(configRoot);
  const staleAt = new Date(Date.now() - 1000 * 60 * 20).toISOString();

  await fs.utimes(
    snapshot.paths.transcriptPath,
    new Date(staleAt),
    new Date(staleAt),
  );

  const refreshed = await readLoopSnapshot(configRoot);
  assert.equal(refreshed.health.ok, false);
  assert.match(refreshed.health.issues.join(","), /transcript:stale/);
});

test("runLoopTurn rejects store-only delivery that is not visible in the desktop thread", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "visible thread",
    threadId: "thread-isolated",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "Previous turn already finished",
  });

  await assert.rejects(
    () =>
      runLoopTurn(configRoot, {
        dispatchThreadMessage: async () => ({
          lastMessage: "",
          transport: "app-server",
          delivery: "thread_store_only",
        }),
      }),
    /未确认送达|没有观察到目标线程/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(snapshot.thread.continuationStatus, "error");
  assert.match(snapshot.thread.lastContinuationError, /未确认送达|没有观察到目标线程/);
});
