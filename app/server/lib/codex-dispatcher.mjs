import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let cachedCodexCommand = "";

function resolveCodexCommand() {
  if (cachedCodexCommand) {
    return cachedCodexCommand;
  }

  if (process.env.CODEX_CLI_PATH) {
    cachedCodexCommand = process.env.CODEX_CLI_PATH;
    return cachedCodexCommand;
  }

  if (process.platform !== "win32") {
    cachedCodexCommand = "codex";
    return cachedCodexCommand;
  }

  for (const candidate of ["codex.exe", "codex"]) {
    const result = spawnSync("where.exe", [candidate], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.status === 0) {
      const resolved = String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (resolved) {
        cachedCodexCommand = resolved;
        return cachedCodexCommand;
      }
    }
  }

  cachedCodexCommand = "codex";
  return cachedCodexCommand;
}

export async function dispatchThreadMessage({
  threadId,
  prompt,
  workspaceRoot,
  model,
}) {
  const outputPath = path.join(
    os.tmpdir(),
    `codex-loop-last-message-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );

  const args = [
    "-C",
    workspaceRoot,
    "--dangerously-bypass-approvals-and-sandbox",
    "exec",
    "resume",
    threadId,
    prompt,
    "--json",
    "--output-last-message",
    outputPath,
  ];

  if (model) {
    args.splice(4, 0, "--model", model);
  }

  const child = spawn(resolveCodexCommand(), args, {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];

  child.stdout.on("data", (chunk) => {
    stdout.push(chunk);
  });

  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  let lastMessage = "";
  try {
    lastMessage = await fs.readFile(outputPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  } finally {
    await fs.rm(outputPath, { force: true });
  }

  if (exitCode !== 0) {
    const details = Buffer.concat(stderr).toString("utf8").trim()
      || Buffer.concat(stdout).toString("utf8").trim()
      || `codex exited with code ${exitCode}`;
    throw new Error(details);
  }

  return {
    exitCode,
    lastMessage: lastMessage.trim(),
    stdout: Buffer.concat(stdout).toString("utf8"),
    completionObserved: Boolean(lastMessage.trim()),
  };
}
