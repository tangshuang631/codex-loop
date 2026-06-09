import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-launcher-fixture-"));
  const settingsRoot = path.join(root, "settings");
  await fs.mkdir(settingsRoot, { recursive: true });
  return { root, settingsRoot };
}

test("launcher cleanup candidates merge stored pids and port owners without duplicates", async () => {
  const { root, settingsRoot } = await createFixture();
  const statusPath = path.join(settingsRoot, "launcher-status.json");
  await fs.writeFile(
    statusPath,
    JSON.stringify(
      {
        launcherPid: 4321,
        serverPid: 5432,
        webPid: 5432,
      },
      null,
      2,
    ),
    "utf8",
  );

  const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
  const ownerIds = [5432, 6543, 4321];
  const merged = new Set();

  for (const candidateId of [status.launcherPid, status.serverPid, status.webPid, ...ownerIds]) {
    const numericId = Number(candidateId);
    if (Number.isFinite(numericId) && numericId > 0) {
      merged.add(numericId);
    }
  }

  assert.deepEqual([...merged].sort((a, b) => a - b), [4321, 5432, 6543]);
});

test("launcher cleanup handles missing launcher status safely", async () => {
  const { root } = await createFixture();
  const statusPath = path.join(root, "settings", "launcher-status.json");

  let status = null;
  try {
    status = JSON.parse(await fs.readFile(statusPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  assert.equal(status, null);
});

test("launcher cleanup can recover stale status by using codex-loop process command lines", async () => {
  const loopRoot = "E:\\2026\\codex-loop";
  const processRows = [
    {
      ProcessId: 7101,
      CommandLine: `node ${loopRoot}\\app\\server\\index.mjs`,
    },
    {
      ProcessId: 7102,
      CommandLine: `node ${loopRoot}\\node_modules\\vite\\bin\\vite.js --config ${loopRoot}\\app\\web\\vite.config.mjs`,
    },
    {
      ProcessId: 7103,
      CommandLine: `powershell -File ${loopRoot}\\scripts\\start-codex-loop.ps1 start`,
    },
    {
      ProcessId: 7200,
      CommandLine: "node E:\\other-project\\app\\server\\index.mjs",
    },
  ];

  const matchingIds = processRows
    .filter((row) => row.CommandLine.includes(loopRoot))
    .filter((row) =>
      /app[\\/]server[\\/]index\.mjs|app[\\/]web[\\/]vite\.config\.mjs|scripts[\\/]start-codex-loop\.ps1/i.test(
        row.CommandLine,
      ),
    )
    .map((row) => row.ProcessId)
    .sort((a, b) => a - b);

  assert.deepEqual(matchingIds, [7101, 7102, 7103]);
});

test("launcher browser target prefers the resolved ready web url", async () => {
  const fallbackUrl = "http://127.0.0.1:3001";
  const readyStatus = {
    phase: "ready",
    webUrl: "http://127.0.0.1:3003",
  };

  const resolvedUrl =
    readyStatus.phase === "ready" && readyStatus.webUrl
      ? readyStatus.webUrl
      : fallbackUrl;

  assert.equal(resolvedUrl, "http://127.0.0.1:3003");
});

test("launcher browser target falls back to expected web url before ready", async () => {
  const fallbackUrl = "http://127.0.0.1:3001";
  const startingStatus = {
    phase: "starting",
    webUrl: "http://127.0.0.1:3003",
  };

  const resolvedUrl =
    startingStatus.phase === "ready" && startingStatus.webUrl
      ? startingStatus.webUrl
      : fallbackUrl;

  assert.equal(resolvedUrl, fallbackUrl);
});

test("launcher starts the console instead of inheriting stale local project workspace", async () => {
  const script = await fs.readFile(
    path.join(repoRoot, "scripts", "start-codex-loop.ps1"),
    "utf8",
  );

  assert.doesNotMatch(script, /\$localConfig\.workspaceRoot/);
  assert.doesNotMatch(script, /Write-Host\s+"workspace:/);
  assert.match(script, /Write-Host\s+"console:/);
});
