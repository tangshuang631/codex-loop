import { ensureDir, writeJson, appendJsonLine, joinWithin } from "./fs-helpers.mjs";
import { createInitialState } from "./state.mjs";

export async function initializeRun({ workspaceRoot, config, runId, nowIso }) {
  const runtimeRoot = joinWithin(workspaceRoot, "codex_loop", "runtime", runId);
  const logsRoot = joinWithin(runtimeRoot, "logs");

  await ensureDir(logsRoot);

  const state = createInitialState({
    projectName: config.projectName,
    branch: config.branch,
    budgets: config.budgets,
  });

  const statePath = joinWithin(runtimeRoot, "state.json");
  const logPath = joinWithin(logsRoot, "events.jsonl");

  await writeJson(statePath, state);
  await appendJsonLine(logPath, {
    type: "run_initialized",
    at: nowIso,
    runId,
    projectName: config.projectName,
    branch: config.branch,
  });

  return {
    runtimeRoot,
    statePath,
    logPath,
  };
}
