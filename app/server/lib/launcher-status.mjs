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

const KNOWN_MOJIBAKE_TEXT = new Map([
  [
    "鍓嶅悗绔凡灏辩华锛屽彲浠ュ紑濮嬫煡鐪嬪拰鎺у埗寰幆銆?",
    "前后端已就绪，可以开始查看和控制循环。",
  ],
]);

function repairReadableLauncherText(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }
  return KNOWN_MOJIBAKE_TEXT.get(value) || value;
}

function normalizeLauncherStatusText(status) {
  if (!status || typeof status !== "object") {
    return status;
  }
  let changed = false;
  const nextStatus = { ...status };
  for (const key of ["note", "error", "shutdownReason"]) {
    const repaired = repairReadableLauncherText(nextStatus[key]);
    if (repaired !== nextStatus[key]) {
      changed = true;
      nextStatus[key] = repaired;
    }
  }
  return changed ? nextStatus : status;
}

async function defaultProbeUrl(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 700);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeReadyPair({ host, apiPort, webPort, probeUrl }) {
  const apiBaseUrl = `http://${host}:${apiPort}/api`;
  const webUrl = `http://${host}:${webPort}`;
  const [serverReady, webReady] = await Promise.all([
    probeUrl(`${apiBaseUrl}/health`),
    probeUrl(`${webUrl}/`),
  ]);

  if (!serverReady || !webReady) {
    return null;
  }

  return {
    host,
    apiPort,
    webPort,
    apiBaseUrl,
    webUrl,
    serverReady: true,
    webReady: true,
  };
}

async function recoverStaleLauncherStatus(status, tools = {}) {
  if (
    !status ||
    status.phase === "ready" ||
    status.phase === "stopped" ||
    status.phase === "stopping" ||
    status.shuttingDown
  ) {
    return status;
  }

  const probeUrl = tools.probeUrl || defaultProbeUrl;
  const host = status.host || "127.0.0.1";
  const candidates = [
    [Number(status.apiPort), Number(status.webPort)],
    [3000, 3001],
  ].filter(([apiPort, webPort]) =>
    Number.isFinite(apiPort) &&
    Number.isFinite(webPort) &&
    apiPort > 0 &&
    webPort > 0
  );

  const seen = new Set();
  for (const [apiPort, webPort] of candidates) {
    const key = `${apiPort}:${webPort}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const recovered = await probeReadyPair({ host, apiPort, webPort, probeUrl });
    if (recovered) {
      return {
        ...status,
        ...recovered,
        phase: "ready",
        note: "前后端已就绪，可以开始查看和控制循环。",
        error: "",
      };
    }
  }

  return status;
}

async function resolveLauncherStatusPath(startDir = process.cwd()) {
  const { codexLoopRoot } = await resolveProjectLayout(startDir);
  return path.join(codexLoopRoot, "settings", "launcher-status.json");
}

export async function readLauncherStatus(startDir = process.cwd(), tools = {}) {
  const statusPath = await resolveLauncherStatusPath(startDir);
  try {
    const rawStatus = JSON.parse(await fs.readFile(statusPath, "utf8"));
    const status = normalizeLauncherStatusText(rawStatus);
    const recovered = await recoverStaleLauncherStatus(status, tools);
    if (recovered !== rawStatus) {
      await writeJson(statusPath, recovered);
    }
    return recovered;
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
