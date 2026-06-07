import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createLoop,
  deleteLoop,
  exportLoopSummary,
  ensureLoopArtifacts,
  getLoopCreationAssistantState,
  listLoops,
  readLoopSnapshot,
  replyLoopCreationAssistant,
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

test("ensureLoopArtifacts creates thread metadata and transcript mirror", async () => {
  const configRoot = await createWorkspace();
  const snapshot = await ensureLoopArtifacts(configRoot);

  assert.equal(snapshot.thread.threadTitle, "\u672a\u7ed1\u5b9a\u7ebf\u7a0b");
  assert.match(snapshot.paths.transcriptPath, /transcript\.md$/);
});

test("requestGracefulStop flips stopRequested and enters finalize mode", async () => {
  const configRoot = await createWorkspace();

  await ensureLoopArtifacts(configRoot);
  const nextSnapshot = await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  assert.equal(nextSnapshot.state.stopRequested, true);
  assert.equal(nextSnapshot.state.mode, "finalize_after_current");
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

  assert.equal(snapshot.thread.latestMode, "finalize_after_current");
  assert.equal(snapshot.thread.latestModeLabel, "\u6536\u5c3e\u4e2d");
});

test("requestGracefulStop writes a visible finalizing summary for the UI", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const snapshot = await requestGracefulStop(configRoot, {
    reason: "manual stop",
  });

  assert.match(snapshot.thread.latestSummary, /\u6536\u5c3e|\u505c\u6b62/);
  assert.equal(snapshot.thread.latestEventType, "graceful_stop_requested");
});

test("startRun records a visible launch signal before the first heartbeat", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const snapshot = await startRun(configRoot);

  assert.equal(snapshot.state.mode, "running");
  assert.ok(snapshot.state.startedAt);
  assert.equal(snapshot.state.lastHeartbeatAt, "");
  assert.equal(snapshot.thread.latestEventType, "run_started_from_console");
  assert.match(snapshot.thread.latestSummary, /heartbeat/i);
});

test("runLoopTurn sends the next message to the bound Codex thread and stores visible status", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
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
      assert.match(prompt, /Continue from the current checklist and rules/);
      return {
        lastMessage:
          "Completed the next loop turn and prepared the following verified task.",
      };
    },
  });

  assert.equal(snapshot.thread.continuationStatus, "idle");
  assert.equal(snapshot.thread.continuationCycleCount, 1);
  assert.equal(snapshot.thread.latestEventType, "codex_followup_completed");
  assert.match(snapshot.thread.lastDispatchPrompt, /Continue from the current checklist and rules/);
  assert.match(snapshot.thread.lastDispatchPrompt, /Previous turn completed the launch feedback fix/);
  assert.match(
    snapshot.thread.latestCodexSummary,
    /Completed the next loop turn and prepared the following verified task\./,
  );
  assert.ok(snapshot.thread.lastDispatchAt);
  assert.ok(snapshot.thread.lastCompletionAt);
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

  assert.match(dispatchedPrompt, /当前循环上下文/);
  assert.match(dispatchedPrompt, /继续推进核心链路/);
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

  assert.match(
    dispatchedPrompt,
    /Continue the same Codex thread from its latest verified checkpoint\./,
  );
  assert.match(dispatchedPrompt, /Current loop context:/);
  assert.match(dispatchedPrompt, /Continue the current loop/);
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
      assert.match(fallbackPrompt, /当前循环上下文/);
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

  let dispatchedPrompt = "";
  const snapshot = await runLoopTurn(configRoot, {
    generateFollowupPrompt: async () => {
      throw new Error("ollama unavailable");
    },
    dispatchThreadMessage: async ({ prompt }) => {
      dispatchedPrompt = prompt;
      return { lastMessage: "已回退到模板续发" };
    },
  });

  assert.match(dispatchedPrompt, /当前循环上下文/);
  assert.match(snapshot.thread.lastContinuationError, /ollama unavailable/);
  assert.equal(snapshot.thread.continuationStatus, "idle");
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

  assert.equal(state.step, "project_name");
  assert.equal(state.draft.intent, "我要针对这个项目做自动化 loop 规划，先帮我设计第一个循环");
  assert.equal(state.draft.plan.objectiveSummary, "先围绕核心链路设计首个循环");
  assert.equal(state.draft.projectName, "opencow");
  assert.equal(state.draft.loopName, "首个核心链路循环");
  assert.equal(state.draft.branch, "dev");
  assert.equal(state.currentQuestion.id, "project_name");
  assert.match(state.currentQuestion.prompt, /opencow/);
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

test("readLoopSnapshot marks health issue when continuation dispatch is stalled", async () => {
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
