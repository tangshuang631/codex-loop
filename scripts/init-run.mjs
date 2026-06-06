import fs from "node:fs/promises";
import path from "node:path";

import { initializeRun } from "./lib/init-run.mjs";

async function main() {
  const workspaceRoot = process.cwd();
  const configPath = path.join(workspaceRoot, "codex_loop", "config.json");
  const configText = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(configText);
  const runId = config.currentRunId || `run-${Date.now()}`;
  const nowIso = new Date().toISOString();

  const result = await initializeRun({
    workspaceRoot,
    config,
    runId,
    nowIso,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
