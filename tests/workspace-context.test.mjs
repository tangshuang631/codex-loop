import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { resolveWorkspaceAndLoopRoot } from "../scripts/lib/workspace-context.mjs";

test("resolveWorkspaceAndLoopRoot detects codex_loop cwd correctly", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-root-"));
  const loopRoot = path.join(tempRoot, "codex_loop");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.writeFile(path.join(loopRoot, "config.json"), "{}\n", "utf8");

  const resolved = await resolveWorkspaceAndLoopRoot(loopRoot);
  assert.equal(resolved.workspaceRoot, loopRoot);
  assert.equal(resolved.codexLoopRoot, loopRoot);
});

test("resolveWorkspaceAndLoopRoot detects workspace cwd correctly", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-root-"));
  const loopRoot = path.join(tempRoot, "codex_loop");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.writeFile(path.join(loopRoot, "config.json"), "{}\n", "utf8");

  const resolved = await resolveWorkspaceAndLoopRoot(tempRoot);
  assert.equal(resolved.workspaceRoot, tempRoot);
  assert.equal(resolved.codexLoopRoot, loopRoot);
});

test("resolveWorkspaceAndLoopRoot treats standalone codex-loop root as the console workspace", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-root-"));
  const loopRoot = path.join(tempRoot, "codex-loop");
  const workspaceRoot = path.join(tempRoot, "demo-workspace");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify({ workspaceRoot }, null, 2)}\n`,
    "utf8",
  );

  const resolved = await resolveWorkspaceAndLoopRoot(loopRoot);
  assert.equal(resolved.workspaceRoot, loopRoot);
  assert.equal(resolved.codexLoopRoot, loopRoot);
});

test("resolveWorkspaceAndLoopRoot still supports explicit environment workspace override", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-root-"));
  const loopRoot = path.join(tempRoot, "codex-loop");
  const workspaceRoot = path.join(tempRoot, "demo-workspace");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(loopRoot, "config.json"), "{}\n", "utf8");

  const previous = process.env.CODEX_LOOP_WORKSPACE_ROOT;
  process.env.CODEX_LOOP_WORKSPACE_ROOT = workspaceRoot;
  try {
    const resolved = await resolveWorkspaceAndLoopRoot(loopRoot);
    assert.equal(resolved.workspaceRoot, path.resolve(workspaceRoot));
    assert.equal(resolved.codexLoopRoot, loopRoot);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_LOOP_WORKSPACE_ROOT;
    } else {
      process.env.CODEX_LOOP_WORKSPACE_ROOT = previous;
    }
  }
});
