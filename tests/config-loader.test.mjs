import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadLoopConfig } from "../scripts/lib/config-loader.mjs";

test("loadLoopConfig ignores stale local workspaceRoot for the standalone console", async () => {
  const loopRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-config-"));
  const staleProject = path.join(loopRoot, "old-project");
  await fs.mkdir(staleProject, { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify({ projectName: "console", branch: "dev", budgets: {} }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(loopRoot, "config.local.json"),
    `${JSON.stringify({ workspaceRoot: staleProject }, null, 2)}\n`,
    "utf8",
  );

  const { config } = await loadLoopConfig(loopRoot);

  assert.equal(config.workspaceRoot, undefined);
});

test("loadLoopConfig keeps explicit environment workspace override", async () => {
  const loopRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-config-"));
  const workspaceRoot = path.join(loopRoot, "explicit-project");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify({ projectName: "console", branch: "dev", budgets: {} }, null, 2)}\n`,
    "utf8",
  );

  const previous = process.env.CODEX_LOOP_WORKSPACE_ROOT;
  process.env.CODEX_LOOP_WORKSPACE_ROOT = workspaceRoot;
  try {
    const { config } = await loadLoopConfig(loopRoot);
    assert.equal(config.workspaceRoot, workspaceRoot);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_LOOP_WORKSPACE_ROOT;
    } else {
      process.env.CODEX_LOOP_WORKSPACE_ROOT = previous;
    }
  }
});
