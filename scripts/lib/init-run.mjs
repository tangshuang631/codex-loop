import fs from "node:fs/promises";
import { ensureDir, writeJson, appendJsonLine, joinWithin } from "./fs-helpers.mjs";
import { createInitialState } from "./state.mjs";

export async function initializeRun({ workspaceRoot, codexLoopRoot, config, runId, nowIso }) {
  const runtimeRoot = joinWithin(codexLoopRoot, "runtime", runId);
  const logsRoot = joinWithin(runtimeRoot, "logs");

  await ensureDir(logsRoot);

  const statePath = joinWithin(runtimeRoot, "state.json");
  const logPath = joinWithin(logsRoot, "events.jsonl");
  let hasState = true;
  let hasLog = true;

  try {
    await fs.access(statePath);
  } catch {
    hasState = false;
  }

  try {
    await fs.access(logPath);
  } catch {
    hasLog = false;
  }

  if (!hasState) {
    const state = createInitialState({
      projectName: config.projectName,
      loopName: config.loopName,
      branch: config.branch,
      budgets: config.budgets,
    });
    state.startedAt = nowIso;
    state.recentSummary =
      "Loop initialized; waiting for the first heartbeat or Codex progress sync.";

    await writeJson(statePath, state);
  }

  if (!hasLog) {
    await appendJsonLine(logPath, {
      type: "run_initialized",
      at: nowIso,
      runId,
      projectName: config.projectName,
      branch: config.branch,
    });
  }

  return {
    runtimeRoot,
    statePath,
    logPath,
  };
}
