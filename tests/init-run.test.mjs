import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initializeRun } from "../scripts/lib/init-run.mjs";

test("initializeRun scaffolds runtime files for a new loop", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const codexLoopRoot = path.join(tempRoot, "codex-loop");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(codexLoopRoot, { recursive: true });

  const result = await initializeRun({
    workspaceRoot,
    codexLoopRoot,
    config: {
      projectName: "demo",
      branch: "dev",
      budgets: {
        maxMinutes: 120,
        maxTokens: 60000,
        finalizeLeadMinutes: 15,
        finalizeLeadTokens: 8000,
      },
    },
    runId: "run-001",
    nowIso: "2026-06-06T10:00:00.000Z",
  });

  const stateText = await fs.readFile(result.statePath, "utf8");
  const logText = await fs.readFile(result.logPath, "utf8");

  assert.match(stateText, /"projectName": "demo"/);
  assert.match(stateText, /"startedAt": "2026-06-06T10:00:00.000Z"/);
  assert.match(stateText, /waiting for the first heartbeat or Codex progress sync/i);
  assert.match(logText, /run_initialized/);
  assert.match(result.runtimeRoot, /codex-loop[\\/]runtime[\\/]run-001$/);
});

test("initializeRun preserves existing runtime state and event log for an active loop", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const codexLoopRoot = path.join(tempRoot, "codex-loop");
  const runtimeRoot = path.join(codexLoopRoot, "runtime", "run-001");
  const logsRoot = path.join(runtimeRoot, "logs");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(logsRoot, { recursive: true });

  const existingState = {
    version: 1,
    projectName: "demo",
    loopName: "demo loop",
    branch: "dev",
    startedAt: "2026-06-06T08:00:00.000Z",
    mode: "running",
    stopRequested: false,
    finalizeRequested: false,
    budgets: {
      maxMinutes: 120,
      maxTokens: 60000,
      finalizeLeadMinutes: 15,
      finalizeLeadTokens: 8000,
    },
    elapsedMinutes: 42,
    consumedTokens: 2048,
    activeTask: "Keep the current loop moving",
    lastNote: "Existing note",
    recentSummary: "Existing summary",
    lastHeartbeatAt: "2026-06-06T08:42:00.000Z",
    events: [
      {
        type: "heartbeat",
        at: "2026-06-06T08:42:00.000Z",
      },
    ],
  };
  await fs.writeFile(
    path.join(runtimeRoot, "state.json"),
    `${JSON.stringify(existingState, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(logsRoot, "events.jsonl"),
    `${JSON.stringify({ type: "heartbeat", at: "2026-06-06T08:42:00.000Z" })}\n`,
    "utf8",
  );

  const result = await initializeRun({
    workspaceRoot,
    codexLoopRoot,
    config: {
      projectName: "demo",
      branch: "dev",
      budgets: {
        maxMinutes: 120,
        maxTokens: 60000,
        finalizeLeadMinutes: 15,
        finalizeLeadTokens: 8000,
      },
    },
    runId: "run-001",
    nowIso: "2026-06-06T10:00:00.000Z",
  });

  const stateText = await fs.readFile(result.statePath, "utf8");
  const logText = await fs.readFile(result.logPath, "utf8");

  assert.match(stateText, /"elapsedMinutes": 42/);
  assert.match(stateText, /"recentSummary": "Existing summary"/);
  assert.doesNotMatch(logText, /run_initialized/);
  assert.match(logText, /heartbeat/);
});
