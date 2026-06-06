import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initializeRun } from "../scripts/lib/init-run.mjs";

test("initializeRun scaffolds runtime files for a new loop", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const result = await initializeRun({
    workspaceRoot,
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
  assert.match(logText, /run_initialized/);
});
