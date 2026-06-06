import fs from "node:fs/promises";
import path from "node:path";

import { findAvailablePort, normalizePort } from "../app/server/lib/network.mjs";
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

async function findProgressFile(workspaceRoot) {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  const match = entries.find(
    (entry) =>
      entry.isFile() &&
      entry.name.includes("2026.6.6-22-48") &&
      entry.name.toLowerCase().endsWith(".md"),
  );

  if (!match) {
    throw new Error(
      `Missing starting progress file under ${workspaceRoot}. Expected a markdown file containing 2026.6.6-22-48 in its name.`,
    );
  }

  return path.join(workspaceRoot, match.name);
}

async function main() {
  const { workspaceRoot, codexLoopRoot } = await resolveWorkspaceAndLoopRoot(process.cwd());
  const configPath = path.join(codexLoopRoot, "config.json");
  const packagePath = path.join(codexLoopRoot, "package.json");
  const opencowRulesPath = path.join(workspaceRoot, "OPENCOW_CORE_RULES.md");
  const docsRoot = path.join(workspaceRoot, "docs", "v1.0");
  const progressPath = await findProgressFile(workspaceRoot);

  await assertPath(packagePath, `Missing codex_loop package file: ${packagePath}`);
  await assertPath(configPath, `Missing codex_loop config file: ${configPath}`);
  await assertPath(opencowRulesPath, `Missing project rules file: ${opencowRulesPath}`);
  await assertPath(docsRoot, `Missing project docs directory: ${docsRoot}`);
  await assertPath(progressPath, `Missing starting progress file: ${progressPath}`);

  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!config.projectName || !config.branch || !config.budgets) {
    throw new Error("codex_loop/config.json is missing required fields: projectName, branch, budgets.");
  }

  const host = process.env.CODEX_LOOP_HOST || "127.0.0.1";
  let apiPort = null;
  let webPort = null;
  let portCheck = {
    ok: true,
    warning: "",
  };

  try {
    apiPort = await findAvailablePort(host, normalizePort(process.env.CODEX_LOOP_PORT, 4318), 20);
    webPort = await findAvailablePort(host, normalizePort(process.env.CODEX_LOOP_WEB_PORT, 4173), 20);
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
    },
    ports: {
      host,
      apiPort,
      webPort,
    },
    portCheck,
    requiredFiles: {
      projectRules: opencowRulesPath,
      docsRoot,
      progressPath,
    },
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
