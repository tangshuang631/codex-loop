import fs from "node:fs/promises";
import path from "node:path";

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
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));

  const nextState = {
    ...state,
    mode: "stopped",
    events: [
      ...state.events,
      {
        type: "run_finalized",
        at: new Date().toISOString(),
        note: "Loop finalized after current task completion workflow",
      },
    ],
  };

  await writeJson(statePath, nextState);
  await appendJsonLine(logPath, nextState.events.at(-1));
  process.stdout.write(`${JSON.stringify(nextState.events.at(-1), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
