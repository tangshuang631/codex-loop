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
  startRun,
  selectLoop,
  renameLoop,
  recordHeartbeat,
  requestGracefulStop,
  saveThreadBinding,
  syncCodexThreadMirror,
} from "../app/server/lib/runtime-store.mjs";
import { saveUserOverrides } from "../app/server/lib/adapter-store.mjs";
import {
  generateCodexSummaryWithOllama,
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
    /Transcript Mirror/,
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
  assert.match(snapshot.thread.latestSummary, /heartbeat/i);

  const transcriptText = await fs.readFile(initialSnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /run_started_from_console/);
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
  assert.match(transcriptText, /已发送到 Codex 线程/);
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
  assert.equal(requestBodies[1].think, false);
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
    /本地模型生成续跑消息失败，请检查 Ollama 和模型配置。/,
  );

  const snapshot = await readLoopSnapshot(configRoot);
  assert.match(snapshot.thread.lastContinuationError, /ollama unavailable/);
  assert.equal(snapshot.thread.continuationStatus, "error");
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

test("runLoopTurn recovers a stalled dispatch and continues with the next turn", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "recovered thread",
    threadId: "thread-recovered",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    lastUserInstructionSummary: "continue the core loop",
    latestCodexSummary: "the previous continuation stalled while waiting for Codex",
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

  let dispatchedPrompt = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async ({ fallbackPrompt }) => fallbackPrompt,
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return { lastMessage: "Recovered and completed the next continuation turn" };
    },
  });

  assert.match(dispatchedPrompt, /下一步：|Next:/i);
  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.threadId, "thread-recovered");

  const transcriptText = await fs.readFile(busySnapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /codex_followup_recovered|Recovered|stalled|reset/i);
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

test("readLoopSnapshot recovers a stalled continuation dispatch so the loop can continue", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);
  const staleAt = new Date(Date.now() - 1000 * 60 * 10).toISOString();
  await saveThreadBinding(configRoot, {
    workspaceName: "demo",
    threadTitle: "stalled thread",
    threadId: "thread-123",
    singleThreadMode: true,
  });
  await syncCodexThreadMirror(configRoot, {
    latestCodexSummary: "stalled run",
  });
  const nextThread = {
    ...((await readLoopSnapshot(configRoot)).thread),
    continuationEnabled: true,
    continuationStatus: "dispatching",
    lastDispatchAt: staleAt,
  };
  await fs.writeFile(snapshot.paths.threadPath, `${JSON.stringify(nextThread, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "settings", "loops.json"),
    `${JSON.stringify(
      {
        currentLoopId: "run-a",
        version: 1,
        generatedAt: new Date().toISOString(),
        loops: [
          {
            id: "run-a",
            runId: "run-a",
            name: "demo",
            threadTitle: "stalled thread",
            branch: "dev",
            projectName: "demo",
            projectAdapter: "generic",
            budgets: buildConfig().budgets,
            startContextPaths: [],
            threadBinding: nextThread,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const refreshed = await readLoopSnapshot(configRoot);
  assert.equal(refreshed.thread.continuationStatus, "idle");
  assert.match(refreshed.thread.lastContinuationError, /stalled|timed out|reset/i);
  assert.equal(refreshed.health.ok, true);

  const transcriptText = await fs.readFile(snapshot.paths.transcriptPath, "utf8");
  assert.match(transcriptText, /stalled|reset|恢复/i);
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
