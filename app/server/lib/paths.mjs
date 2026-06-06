import fs from "node:fs/promises";
import path from "node:path";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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
  return path.dirname(codexLoopRoot);
}

export async function resolveProjectLayout(startDir = process.cwd()) {
  const codexLoopRoot = await resolveCodexLoopRoot(startDir);
  const workspaceRoot = path.dirname(codexLoopRoot);

  return {
    codexLoopRoot,
    workspaceRoot,
    configPath: path.join(codexLoopRoot, "config.json"),
    runtimeRoot: path.join(codexLoopRoot, "runtime"),
  };
}
