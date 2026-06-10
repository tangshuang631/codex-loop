import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const reportRootLabel = "runtime/production-checks";
const reportRoot = path.join(root, ...reportRootLabel.split("/"));
const STATUS = {
  passed: { status: "passed" },
  failed: { status: "failed" },
};

const checks = [
  {
    name: "环境检查",
    command: process.execPath,
    args: ["scripts/check-env.mjs"],
    display: "npm run loop:check",
  },
  {
    name: "长跑 smoke 检查",
    command: process.execPath,
    args: ["scripts/longrun-smoke.mjs"],
    display: "npm run loop:smoke",
  },
  {
    name: "验证命令",
    command: process.execPath,
    args: ["--test", "tests/*.test.mjs"],
    display: "npm test",
  },
  {
    name: "桌面端构建",
    command: process.execPath,
    args: ["node_modules/vite/bin/vite.js", "build", "--config", "app/web/vite.config.mjs"],
    display: "npm run build:web",
  },
  {
    name: "移动端构建",
    command: process.execPath,
    args: ["node_modules/vite/bin/vite.js", "build", "--config", "app/mobile/vite.config.mjs"],
    display: "npm run build:mobile",
  },
  {
    name: "工作区差异检查",
    command: "git",
    args: ["diff", "--check"],
    display: "git diff --check",
  },
  {
    name: "暂存区差异检查",
    command: "git",
    args: ["diff", "--cached", "--check"],
    display: "git diff --cached --check",
  },
];

function nowForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function trimOutput(value) {
  const lines = String(value || "").split(/\r?\n/);
  return lines.slice(-80).join("\n").trim();
}

function runCheck(check) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(check.command, check.args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      resolve({
        name: check.name,
        command: check.display,
        status: STATUS.failed.status,
        exitCode: null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        stdout: trimOutput(stdout),
        stderr: trimOutput(`${stderr}\n${error.stack || error.message}`),
      });
    });

    child.on("close", (code) => {
      resolve({
        name: check.name,
        command: check.display,
        status: code === 0 ? STATUS.passed.status : STATUS.failed.status,
        exitCode: code,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
      });
    });
  });
}

async function writeReport(report) {
  await fs.mkdir(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `${nowForFile()}-production-check.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

async function main() {
  const startedAt = new Date();
  const results = [];

  process.stdout.write("生产就绪检查开始。\n");

  for (const check of checks) {
    process.stdout.write(`\n[生产就绪检查] ${check.name}: ${check.display}\n`);
    const result = await runCheck(check);
    results.push(result);
    process.stdout.write(
      `[生产就绪检查] ${check.name}: ${result.status === STATUS.passed.status ? "通过" : "失败"}\n`,
    );

    if (result.status === STATUS.failed.status) {
      break;
    }
  }

  const failed = results.find((result) => result.status === STATUS.failed.status);
  const report = {
    title: "codex-loop 生产就绪检查",
    status: failed ? "failed" : "passed",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    commandCount: results.length,
    checks: results,
    nextAction: failed
      ? "先处理失败的验证命令，再重新运行 npm run production:check。"
      : "可以进入真实任务使用；长时间运行仍建议保留人工观察和运行日志。",
  };

  const reportPath = await writeReport(report);
  process.stdout.write(`\n报告路径: ${reportPath}\n`);
  process.stdout.write(`生产就绪检查${failed ? "失败" : "通过"}。\n`);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
