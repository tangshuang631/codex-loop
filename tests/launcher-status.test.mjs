import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  readLauncherStatus,
  requestLauncherShutdown,
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

test("writeLauncherStatus preserves known ports and pids when later patches omit them", async () => {
  const { tempRoot } = await createWorkspace();

  await writeLauncherStatus(tempRoot, {
    phase: "ready",
    host: "127.0.0.1",
    apiPort: 3000,
    webPort: 3001,
    apiBaseUrl: "http://127.0.0.1:3000/api",
    webUrl: "http://127.0.0.1:3001",
    launcherPid: 4100,
    serverPid: 4200,
    webPid: 4300,
    serverReady: true,
    webReady: true,
    note: "running",
  });

  const written = await writeLauncherStatus(tempRoot, {
    phase: "failed",
    note: "frontend exited",
    error: "web exited with code 1",
    webPid: 0,
  });

  assert.equal(written.apiPort, 3000);
  assert.equal(written.webPort, 3001);
  assert.equal(written.apiBaseUrl, "http://127.0.0.1:3000/api");
  assert.equal(written.webUrl, "http://127.0.0.1:3001");
  assert.equal(written.launcherPid, 4100);
  assert.equal(written.serverPid, 4200);
  assert.equal(written.webPid, 4300);
  assert.equal(written.phase, "failed");
  assert.equal(written.error, "web exited with code 1");
});

test("requestLauncherShutdown marks stopping state and schedules launcher termination", async () => {
  const { tempRoot } = await createWorkspace();
  const scheduled = [];
  const killed = [];

  await writeLauncherStatus(tempRoot, {
    phase: "ready",
    launcherPid: 43210,
    note: "running",
  });

  const result = await requestLauncherShutdown(
    tempRoot,
    {
      reason: "manual shutdown",
      note: "closing from dashboard",
      delayMs: 250,
    },
    {
      schedule(callback, delayMs) {
        scheduled.push(delayMs);
        callback();
        return { unref() {} };
      },
      killProcessTree(pid) {
        killed.push(pid);
        return true;
      },
    },
  );

  assert.equal(result.requested, true);
  assert.equal(result.launcherPid, 43210);
  assert.deepEqual(scheduled, [250]);
  assert.deepEqual(killed, [43210]);

  const nextStatus = await readLauncherStatus(tempRoot);
  assert.equal(nextStatus.phase, "stopping");
  assert.equal(nextStatus.shuttingDown, true);
  assert.equal(nextStatus.shutdownReason, "manual shutdown");
});
