import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

function runNode(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function createStandaloneLoopRoot() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-check-"));
  const loopRoot = path.join(tempRoot, "codex-loop");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify(
      {
        projectName: "",
        branch: "dev",
        budgets: {
          maxMinutes: 120,
          maxTokens: 50000,
          finalizeLeadMinutes: 15,
          finalizeLeadTokens: 5000,
        },
        projectAdapter: "generic",
        currentRunId: "default-run",
        loopName: "默认循环",
        threadTitle: "默认线程",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(loopRoot, "package.json"),
    `${JSON.stringify({ name: "codex-loop-test" }, null, 2)}\n`,
    "utf8",
  );
  return loopRoot;
}

test("check-env supports generic standalone mode without project-specific required files", async () => {
  const loopRoot = await createStandaloneLoopRoot();
  const result = await runNode([path.join(repoRoot, "scripts", "check-env.mjs")], loopRoot);

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.projectName, "");
  assert.equal(parsed.requiredFiles.projectRules, "");
  assert.equal(parsed.requiredFiles.docsRoot, "");
  assert.equal(parsed.requiredFiles.progressPath, "");
});
