import fs from "node:fs/promises";
import path from "node:path";

import { findAvailablePortPair, normalizePort } from "../app/server/lib/network.mjs";
import { loadLoopConfig } from "./lib/config-loader.mjs";
import { resolveWorkspaceAndLoopRoot } from "./lib/workspace-context.mjs";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertPath(targetPath, message) {
  if (!(await exists(targetPath))) {
    throw new Error(message);
  }
}

async function resolveRequiredFiles(workspaceRoot, config) {
  if (!workspaceRoot || path.resolve(workspaceRoot) === path.resolve(config.codexLoopRoot || "")) {
    return {
      projectRules: "",
      docsRoot: "",
      progressPath: "",
      strict: false,
    };
  }

  return {
    projectRules: "",
    docsRoot: "",
    progressPath: "",
    strict: false,
  };
}

async function main() {
  const { workspaceRoot, codexLoopRoot } = await resolveWorkspaceAndLoopRoot(process.cwd());
  const { config, configPath, localConfigPath } = await loadLoopConfig(codexLoopRoot);
  config.codexLoopRoot = codexLoopRoot;
  const packagePath = path.join(codexLoopRoot, "package.json");
  const requiredFiles = await resolveRequiredFiles(workspaceRoot, config);

  await assertPath(packagePath, `Missing codex_loop package file: ${packagePath}`);
  await assertPath(configPath, `Missing codex_loop config file: ${configPath}`);

  if (requiredFiles.strict) {
    await assertPath(
      requiredFiles.projectRules,
      `Missing project rules file: ${requiredFiles.projectRules}`,
    );
    await assertPath(
      requiredFiles.docsRoot,
      `Missing project docs directory: ${requiredFiles.docsRoot}`,
    );
    await assertPath(
      requiredFiles.progressPath,
      `Missing starting progress file: ${requiredFiles.progressPath}`,
    );
  }

  if (!config.branch || !config.budgets) {
    throw new Error("codex_loop/config.json is missing required fields: branch, budgets.");
  }

  const host = (process.env.CODEX_LOOP_HOST || "127.0.0.1").trim();
  let apiPort = null;
  let webPort = null;
  let portCheck = {
    ok: true,
    warning: "",
  };

  try {
    const pair = await findAvailablePortPair(host, {
      apiPreferredPort: normalizePort(process.env.CODEX_LOOP_PORT, 3000),
      webPreferredPort: normalizePort(process.env.CODEX_LOOP_WEB_PORT, 3001),
      attempts: 50,
    });
    apiPort = pair.apiPort;
    webPort = pair.webPort;
  } catch (error) {
    portCheck = {
      ok: false,
      warning:
        error.message ||
        `Could not bind local ports on ${host}.`,
    };
  }

  const result = {
    ok: true,
    workspaceRoot,
    codexLoopRoot,
    config: {
      projectName: config.projectName,
      branch: config.branch,
      budgets: config.budgets,
      workspaceRoot: config.workspaceRoot || "",
      localConfigPath,
    },
    ports: {
      host,
      apiPort,
      webPort,
    },
    portCheck,
    requiredFiles,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
