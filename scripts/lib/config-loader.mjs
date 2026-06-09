import fs from "node:fs/promises";
import path from "node:path";

async function readJsonIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function mergeConfig(baseConfig = {}, overrideConfig = {}) {
  const { workspaceRoot: _legacyWorkspaceRoot, ...safeOverrideConfig } =
    overrideConfig || {};
  return {
    ...baseConfig,
    ...safeOverrideConfig,
    budgets: {
      ...(baseConfig.budgets || {}),
      ...(safeOverrideConfig.budgets || {}),
    },
  };
}

function splitConfigForPersistence(config = {}) {
  const {
    workspaceRoot,
    projectName,
    branch,
    budgets,
    projectAdapter,
    currentRunId,
    loopName,
    threadTitle,
    ...rest
  } = config;

  return {
    baseConfig: {
      projectName,
      branch,
      budgets,
      projectAdapter,
      currentRunId,
      loopName,
      threadTitle,
      ...rest,
    },
    localConfig: workspaceRoot ? { workspaceRoot } : {},
  };
}

export async function loadLoopConfig(codexLoopRoot) {
  const configPath = path.join(codexLoopRoot, "config.json");
  const localConfigPath = path.join(codexLoopRoot, "config.local.json");

  const baseConfig = await readJsonIfExists(configPath);
  if (!baseConfig) {
    throw new Error(`Missing codex-loop config file: ${configPath}`);
  }

  const localConfig = await readJsonIfExists(localConfigPath);
  const mergedConfig = mergeConfig(baseConfig, localConfig || {});

  if (process.env.CODEX_LOOP_WORKSPACE_ROOT) {
    mergedConfig.workspaceRoot = process.env.CODEX_LOOP_WORKSPACE_ROOT;
  }

  if (process.env.CODEX_LOOP_PROJECT_NAME) {
    mergedConfig.projectName = process.env.CODEX_LOOP_PROJECT_NAME;
  }

  if (process.env.CODEX_LOOP_BRANCH) {
    mergedConfig.branch = process.env.CODEX_LOOP_BRANCH;
  }

  if (process.env.CODEX_LOOP_RUN_ID) {
    mergedConfig.currentRunId = process.env.CODEX_LOOP_RUN_ID;
  }

  if (process.env.CODEX_LOOP_LOOP_NAME) {
    mergedConfig.loopName = process.env.CODEX_LOOP_LOOP_NAME;
  }

  if (process.env.CODEX_LOOP_THREAD_TITLE) {
    mergedConfig.threadTitle = process.env.CODEX_LOOP_THREAD_TITLE;
  }

  return {
    config: mergedConfig,
    configPath,
    localConfigPath,
  };
}

export async function saveLoopConfig(codexLoopRoot, config) {
  const configPath = path.join(codexLoopRoot, "config.json");
  const localConfigPath = path.join(codexLoopRoot, "config.local.json");
  const { baseConfig, localConfig } = splitConfigForPersistence(config);

  await fs.writeFile(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`, "utf8");

  if (Object.keys(localConfig).length > 0) {
    await fs.writeFile(
      localConfigPath,
      `${JSON.stringify(localConfig, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    configPath,
    localConfigPath,
  };
}
