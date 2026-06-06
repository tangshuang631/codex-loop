import fs from "node:fs/promises";
import path from "node:path";

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
  const nextStatus = {
    ...createDefaultStatus(),
    ...payload,
    updatedAt: payload.updatedAt || new Date().toISOString(),
  };
  await ensureDir(path.dirname(statusPath));
  await writeJson(statusPath, nextStatus);
  return nextStatus;
}
