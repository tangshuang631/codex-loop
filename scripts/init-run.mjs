import fs from "node:fs/promises";

import { initializeRun } from "./lib/init-run.mjs";
import { loadLoopConfig } from "./lib/config-loader.mjs";
import { resolveWorkspaceAndLoopRoot } from "./lib/workspace-context.mjs";

async function main() {
  const { workspaceRoot, codexLoopRoot } = await resolveWorkspaceAndLoopRoot(
    process.cwd(),
  );
  const { config } = await loadLoopConfig(codexLoopRoot);
  const runId = config.currentRunId || `run-${Date.now()}`;
  const nowIso = new Date().toISOString();

  const result = await initializeRun({
    workspaceRoot,
    codexLoopRoot,
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
