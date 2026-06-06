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
  assert.equal(resolved.workspaceRoot, tempRoot);
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
