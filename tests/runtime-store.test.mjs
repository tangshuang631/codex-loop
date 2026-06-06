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
  listLoops,
  readLoopSnapshot,
  runLoopTurn,
  startRun,
  selectLoop,
  renameLoop,
  recordHeartbeat,
  requestGracefulStop,
  saveThreadBinding,
  syncCodexThreadMirror,
} from "../app/server/lib/runtime-store.mjs";

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
    workspaceName: "opencow",
    threadTitle: "\u8bc4\u4f30\u957f\u65f6\u5f00\u53d1\u65b9\u6848",
    threadId: "thread-123",
    singleThreadMode: true,
    note: "desktop primary thread",
  });

  const snapshot = await readLoopSnapshot(configRoot);
  assert.equal(snapshot.thread.workspaceName, "opencow");
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
    workspaceName: "opencow",
    threadTitle: "按清单继续开发",
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

test("renameLoop updates loop name in config and runtime snapshot", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);

  const snapshot = await renameLoop(configRoot, {
    loopName: "opencow-longrun-core",
  });

  assert.equal(snapshot.config.loopName, "opencow-longrun-core");
  assert.equal(snapshot.state.loopName, "opencow-longrun-core");
});

test("listLoops seeds an opencow loop preset for the workspace", async () => {
  const configRoot = await createWorkspace();
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      {
        ...buildConfig(),
        projectName: "opencow",
        projectAdapter: "opencow",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(configRoot, "OPENCOW_CORE_RULES.md"), "# rules\n", "utf8");
  await fs.mkdir(path.join(configRoot, "docs", "v1.0"), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "开发进度清单2026.6.6-22-48.md"),
    "# progress\n",
    "utf8",
  );

  const loops = await listLoops(configRoot);

  assert.equal(loops.currentLoopId, "opencow-continue-from-checklist");
  assert.equal(loops.loops.length, 1);
  assert.equal(loops.loops[0].name, "按清单继续开发");
  assert.equal(loops.loops[0].threadTitle, "按清单继续开发");
  assert.equal(loops.loops[0].budgets.maxMinutes, 360);
});

test("createLoop persists a new loop and selectLoop switches active config", async () => {
  const configRoot = await createWorkspace();
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      {
        ...buildConfig(),
        projectName: "opencow",
        projectAdapter: "opencow",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(configRoot, "OPENCOW_CORE_RULES.md"), "# rules\n", "utf8");
  await fs.mkdir(path.join(configRoot, "docs", "v1.0"), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "开发进度清单2026.6.6-22-48.md"),
    "# progress\n",
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
      {
        ...buildConfig(),
        projectName: "opencow",
        projectAdapter: "opencow",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(configRoot, "OPENCOW_CORE_RULES.md"), "# rules\n", "utf8");
  await fs.mkdir(path.join(configRoot, "docs", "v1.0"), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "开发进度清单2026.6.6-22-48.md"),
    "# progress\n",
    "utf8",
  );

  await createLoop(configRoot, {
    loopName: "待删除循环",
    runId: "run-delete-me",
    threadTitle: "待删除循环",
  });

  const loops = await deleteLoop(configRoot, { loopId: "run-delete-me" });

  assert.equal(loops.loops.some((loop) => loop.id === "run-delete-me"), false);
  assert.equal(loops.currentLoopId, "opencow-continue-from-checklist");
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
