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
  saveThreadBinding,
  savePendingGuidance,
  startRun,
  requestGracefulStop,
} from "../app/server/lib/runtime-store.mjs";
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
