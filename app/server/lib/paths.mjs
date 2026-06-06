import fs from "node:fs/promises";
import path from "node:path";
import { loadLoopConfig } from "../../../scripts/lib/config-loader.mjs";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

export async function resolveCodexLoopRoot(startDir = process.cwd()) {
  const directConfigPath = path.join(startDir, "config.json");
  if (await exists(directConfigPath)) {
    return startDir;
  }

  const nestedRoot = path.join(startDir, "codex_loop");
  const nestedConfigPath = path.join(nestedRoot, "config.json");
  if (await exists(nestedConfigPath)) {
    return nestedRoot;
  }

  throw new Error(
    `Could not locate codex_loop root from ${startDir}. Expected config.json in the current directory or in a child codex_loop directory.`,
  );
}

export async function resolveWorkspaceRoot(startDir = process.cwd()) {
  const codexLoopRoot = await resolveCodexLoopRoot(startDir);
  const { config } = await loadLoopConfig(codexLoopRoot);
  return config.workspaceRoot
    ? path.resolve(config.workspaceRoot)
    : path.dirname(codexLoopRoot);
}

export async function resolveProjectLayout(startDir = process.cwd()) {
  const codexLoopRoot = await resolveCodexLoopRoot(startDir);
  const { config, configPath } = await loadLoopConfig(codexLoopRoot);
  const workspaceRoot = config.workspaceRoot
    ? path.resolve(config.workspaceRoot)
    : path.dirname(codexLoopRoot);

  return {
    codexLoopRoot,
    workspaceRoot,
    configPath,
    runtimeRoot: path.join(codexLoopRoot, "runtime"),
  };
}
