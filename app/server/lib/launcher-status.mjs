import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { ensureDir, writeJson } from "../../../scripts/lib/fs-helpers.mjs";
import { resolveProjectLayout } from "./paths.mjs";

function createDefaultStatus() {
  return {
    phase: "idle",
    host: "",
    apiPort: 0,
    webPort: 0,
    apiBaseUrl: "",
    webUrl: "",
    serverReady: false,
    webReady: false,
    launcherPid: 0,
    serverPid: 0,
    webPid: 0,
    shuttingDown: false,
    shutdownRequestedAt: "",
    shutdownReason: "",
    note: "",
    error: "",
    updatedAt: "",
  };
}

async function resolveLauncherStatusPath(startDir = process.cwd()) {
  const { codexLoopRoot } = await resolveProjectLayout(startDir);
  return path.join(codexLoopRoot, "settings", "launcher-status.json");
}

export async function readLauncherStatus(startDir = process.cwd()) {
  const statusPath = await resolveLauncherStatusPath(startDir);
  try {
    return JSON.parse(await fs.readFile(statusPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return createDefaultStatus();
    }
    throw error;
  }
}

export async function writeLauncherStatus(startDir = process.cwd(), payload = {}) {
  const statusPath = await resolveLauncherStatusPath(startDir);
  const currentStatus = await readLauncherStatus(startDir);
  const nextPayload = { ...payload };

  for (const key of ["apiPort", "webPort", "launcherPid", "serverPid", "webPid"]) {
    if ((nextPayload[key] ?? 0) <= 0 && (currentStatus[key] ?? 0) > 0) {
      nextPayload[key] = currentStatus[key];
    }
  }

  for (const key of ["host", "apiBaseUrl", "webUrl"]) {
    if (!nextPayload[key] && currentStatus[key]) {
      nextPayload[key] = currentStatus[key];
    }
  }

  for (const key of ["serverReady", "webReady"]) {
    if (nextPayload[key] === undefined && currentStatus[key] !== undefined) {
      nextPayload[key] = currentStatus[key];
    }
  }

  const nextStatus = {
    ...createDefaultStatus(),
    ...currentStatus,
    ...nextPayload,
    updatedAt: nextPayload.updatedAt || new Date().toISOString(),
  };
  await ensureDir(path.dirname(statusPath));
  await writeJson(statusPath, nextStatus);
  return nextStatus;
}

async function defaultKillProcessTree(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }

  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", `taskkill /PID ${numericPid} /T /F`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  }

  process.kill(numericPid, "SIGTERM");
  return true;
}

export async function requestLauncherShutdown(
  startDir = process.cwd(),
  payload = {},
  tools = {},
) {
  const schedule = tools.schedule || globalThis.setTimeout;
  const killProcessTree = tools.killProcessTree || defaultKillProcessTree;
  const delayMs = Math.max(150, Number(payload.delayMs) || 600);
  const currentStatus = await readLauncherStatus(startDir);
  const launcherPid = Number(currentStatus.launcherPid || 0);
  const shutdownReason = payload.reason || "manual shutdown requested";

  const nextStatus = await writeLauncherStatus(startDir, {
    ...currentStatus,
    phase: "stopping",
    shuttingDown: true,
    shutdownRequestedAt: new Date().toISOString(),
    shutdownReason,
    note: payload.note || "正在关闭 codex-loop 控制台。",
    error: "",
  });

  if (launcherPid > 0) {
    const timer = schedule(() => {
      void killProcessTree(launcherPid);
    }, delayMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  return {
    requested: true,
    launcherPid,
    delayMs,
    shutdownReason,
    phase: nextStatus.phase,
  };
}
