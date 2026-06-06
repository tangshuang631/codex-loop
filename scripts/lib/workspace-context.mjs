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

export async function resolveWorkspaceAndLoopRoot(startDir = process.cwd()) {
  const envWorkspaceRoot = process.env.CODEX_LOOP_WORKSPACE_ROOT;
  if (envWorkspaceRoot) {
    return {
      workspaceRoot: path.resolve(envWorkspaceRoot),
      codexLoopRoot: path.resolve(envWorkspaceRoot, "codex_loop"),
    };
  }

  const directConfigPath = path.join(startDir, "config.json");
  if (await exists(directConfigPath)) {
    return {
      workspaceRoot: path.dirname(startDir),
      codexLoopRoot: startDir,
    };
  }

  const nestedConfigPath = path.join(startDir, "codex_loop", "config.json");
  if (await exists(nestedConfigPath)) {
    return {
      workspaceRoot: startDir,
      codexLoopRoot: path.join(startDir, "codex_loop"),
    };
  }

  return {
    workspaceRoot: startDir,
    codexLoopRoot: path.join(startDir, "codex_loop"),
  };
}
