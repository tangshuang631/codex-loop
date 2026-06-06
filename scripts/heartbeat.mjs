import fs from "node:fs/promises";
import path from "node:path";

import { applyHeartbeat } from "./lib/state.mjs";
import { appendJsonLine, writeJson } from "./lib/fs-helpers.mjs";

async function main() {
  const workspaceRoot = process.cwd();
  const configPath = path.join(workspaceRoot, "codex_loop", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const runId = config.currentRunId;

  if (!runId) {
    throw new Error("config.currentRunId is required");
  }

  const runtimeRoot = path.join(workspaceRoot, "codex_loop", "runtime", runId);
  const statePath = path.join(runtimeRoot, "state.json");
  const logPath = path.join(runtimeRoot, "logs", "events.jsonl");
  const transcriptPath = path.join(runtimeRoot, "transcript.md");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const nowIso = new Date().toISOString();

  const nextState = applyHeartbeat(state, {
    consumedTokens: Number(process.env.CODEX_LOOP_TOKENS || state.consumedTokens),
    activeTask: process.env.CODEX_LOOP_ACTIVE_TASK || state.activeTask,
    note: process.env.CODEX_LOOP_NOTE || state.lastNote,
    progressSummary:
      process.env.CODEX_LOOP_SUMMARY || state.recentSummary || state.lastNote,
    nowIso,
  });

  await writeJson(statePath, nextState);
  await appendJsonLine(logPath, nextState.events.at(-1));
  await fs.appendFile(
    transcriptPath,
    [
      "",
      `## ${nowIso}`,
      `- Active task: ${nextState.activeTask || "n/a"}`,
      `- Note: ${nextState.lastNote || "n/a"}`,
      `- Summary: ${nextState.recentSummary || "n/a"}`,
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(nextState.events.at(-1), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
