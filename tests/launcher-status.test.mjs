import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  readLauncherStatus,
  writeLauncherStatus,
} from "../app/server/lib/launcher-status.mjs";

async function createWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-launcher-"));
  const loopRoot = path.join(tempRoot, "codex_loop");
  const settingsRoot = path.join(loopRoot, "settings");
  await fs.mkdir(settingsRoot, { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify({ workspaceRoot: tempRoot }, null, 2)}\n`,
    "utf8",
  );
  return { tempRoot, loopRoot };
}

test("readLauncherStatus returns a safe default when no launcher status file exists", async () => {
  const { tempRoot } = await createWorkspace();

  const status = await readLauncherStatus(tempRoot);

  assert.equal(status.phase, "idle");
  assert.equal(status.apiBaseUrl, "");
  assert.equal(status.webUrl, "");
});

test("writeLauncherStatus persists launcher visibility fields", async () => {
  const { tempRoot, loopRoot } = await createWorkspace();

  const written = await writeLauncherStatus(tempRoot, {
    phase: "ready",
    apiPort: 3000,
    webPort: 3001,
    apiBaseUrl: "http://127.0.0.1:3000/api",
    webUrl: "http://127.0.0.1:3001",
    serverReady: true,
    webReady: true,
    note: "dev console is ready",
  });

  assert.equal(written.phase, "ready");
  assert.equal(written.apiPort, 3000);
  assert.equal(written.webPort, 3001);
  assert.equal(written.serverReady, true);
  assert.equal(written.webReady, true);

  const saved = JSON.parse(
    await fs.readFile(path.join(loopRoot, "settings", "launcher-status.json"), "utf8"),
  );
  assert.equal(saved.note, "dev console is ready");
  assert.equal(saved.apiBaseUrl, "http://127.0.0.1:3000/api");
});
