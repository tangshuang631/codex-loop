import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { resolveProjectLayout } from "../app/server/lib/paths.mjs";

test("resolveProjectLayout starts a standalone console from codex-loop root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-paths-"));
  const loopRoot = path.join(tempRoot, "codex-loop");
  const oldProjectRoot = path.join(tempRoot, "old-project");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.mkdir(oldProjectRoot, { recursive: true });
  await fs.writeFile(path.join(loopRoot, "config.json"), "{}\n", "utf8");
  await fs.writeFile(
    path.join(loopRoot, "config.local.json"),
    `${JSON.stringify({ workspaceRoot: oldProjectRoot }, null, 2)}\n`,
    "utf8",
  );

  const layout = await resolveProjectLayout(loopRoot);

  assert.equal(layout.codexLoopRoot, loopRoot);
  assert.equal(layout.workspaceRoot, loopRoot);
  assert.equal(layout.runtimeRoot, path.join(loopRoot, "runtime"));
});
