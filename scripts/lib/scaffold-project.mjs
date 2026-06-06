import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir, writeJson } from "./fs-helpers.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const bundledTemplatesRoot = path.resolve(moduleDir, "../../templates");

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

function renderRunbook({ projectName, commands }) {
  const commandLines =
    commands.length > 0
      ? commands.map((command) => `- \`${command}\``).join("\n")
      : "- Add project verification commands here";

  return `# Project Runbook

## Goal

Run ${projectName} through a strict, recoverable Codex loop.

## Verification commands

${commandLines}

## Loop contract

1. Keep one primary Codex thread whenever possible.
2. Finish the current bounded task before graceful stop.
3. Run verification before claiming completion.
4. Update local mirror files after each meaningful batch.
`;
}

function uniqueCommands(commands) {
  return [...new Set(commands)];
}

export async function detectProjectProfile(workspaceRoot) {
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const cargoTomlPath = path.join(workspaceRoot, "Cargo.toml");
  const pyprojectTomlPath = path.join(workspaceRoot, "pyproject.toml");
  const requirementsTxtPath = path.join(workspaceRoot, "requirements.txt");

  const hasPackageJson = await exists(packageJsonPath);
  const hasCargoToml = await exists(cargoTomlPath);
  const hasPyprojectToml = await exists(pyprojectTomlPath);
  const hasRequirementsTxt = await exists(requirementsTxtPath);

  if (hasPackageJson) {
    const packageJson = await readJson(packageJsonPath);
    const commands = [];
    if (packageJson.scripts?.test) {
      commands.push("npm run test");
    }
    if (packageJson.scripts?.["test:unit"]) {
      commands.push("npm run test:unit");
    }
    if (packageJson.scripts?.build) {
      commands.push("npm run build");
    }
    if (packageJson.scripts?.lint) {
      commands.push("npm run lint");
    }
    if (packageJson.scripts?.["verify:all"]) {
      commands.push("npm run verify:all");
    }

    if (hasCargoToml) {
      commands.push("cargo test");
      return {
        projectType: "hybrid",
        projectName: packageJson.name || path.basename(workspaceRoot),
        commands: uniqueCommands(commands),
        strictness: "very_high",
      };
    }

    return {
      projectType: "node",
      projectName: packageJson.name || path.basename(workspaceRoot),
      commands: uniqueCommands(commands),
      strictness: packageJson.scripts?.["verify:all"] ? "high" : "medium",
    };
  }

  if (hasCargoToml) {
    return {
      projectType: "rust",
      projectName: path.basename(workspaceRoot),
      commands: ["cargo test", "cargo build"],
      strictness: "high",
    };
  }

  if (hasPyprojectToml || hasRequirementsTxt) {
    return {
      projectType: "python",
      projectName: path.basename(workspaceRoot),
      commands: ["python -m pytest"],
      strictness: "high",
    };
  }

  return {
    projectType: "generic",
    projectName: path.basename(workspaceRoot),
    commands: [],
    strictness: "medium",
  };
}

export async function scaffoldProjectAdapter({
  workspaceRoot,
  codexLoopRoot,
  adapterId,
  displayName,
}) {
  const profile = await detectProjectProfile(workspaceRoot);
  const adapterDir = path.join(codexLoopRoot, "projects", adapterId);
  await ensureDir(adapterDir);

  const adapterPath = path.join(adapterDir, "adapter.json");
  const runbookPath = path.join(adapterDir, "RUNBOOK.md");
  const threadPath = path.join(adapterDir, "THREAD.md");

  const adapter = {
    adapterId,
    displayName,
    description: `${displayName} generated adapter profile`,
    singleThread: {
      required: true,
      reason: "Keep Codex history continuous and recoverable.",
    },
    stopPolicy: {
      allowFinishCurrentTask: true,
      requireVerificationBeforeStop: true,
      requireCommitBeforeStop: true,
      requirePushBeforeStop: false,
    },
    budgets: {
      maxMinutes: 180,
      maxTokens: 120000,
      finalizeLeadMinutes: 20,
      finalizeLeadTokens: 15000,
    },
    verification: {
      strictness: profile.strictness,
      commands: profile.commands,
      notes: [
        "Review generated commands and tighten them for this repository before regular use.",
      ],
    },
    threadPolicy: {
      preferHeartbeatContinuation: true,
      requireVisiblePrimaryThread: true,
    },
  };

  await writeJson(adapterPath, adapter);
  await fs.writeFile(
    runbookPath,
    `${renderRunbook({
      projectName: displayName,
      commands: profile.commands,
    })}\n`,
    "utf8",
  );

  const localTemplatePath = path.join(
    codexLoopRoot,
    "templates",
    "THREAD.template.md",
  );
  const bundledTemplatePath = path.join(
    bundledTemplatesRoot,
    "THREAD.template.md",
  );
  const threadTemplatePath = (await exists(localTemplatePath))
    ? localTemplatePath
    : bundledTemplatePath;
  const threadTemplate = await fs.readFile(threadTemplatePath, "utf8");
  await fs.writeFile(threadPath, threadTemplate, "utf8");

  return {
    adapterPath,
    runbookPath,
    threadPath,
    detectedProfile: profile,
  };
}
