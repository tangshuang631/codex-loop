import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const reportRootLabel = "runtime/frontend-evidence";
const reportRoot = path.join(root, ...reportRootLabel.split("/"));

const targets = [
  {
    name: "桌面端",
    distLabel: "dist/web",
    distDir: path.join(root, "dist", "web"),
    requiredText: ["历史对话", "发送引导", "截图证据", "生产阶段", "生产成熟度", "剩余缺口", "验证目标", "启动预检"],
  },
  {
    name: "移动端",
    distLabel: "dist/mobile",
    distDir: path.join(root, "dist", "mobile"),
    requiredText: ["历史对话", "发送引导", "截图证据", "生产阶段", "生产成熟度", "剩余缺口", "验证目标", "启动预检"],
  },
];

function nowForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function collectTextFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(fullPath)));
      continue;
    }

    if (/\.(html|js|css|json|webmanifest)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function inspectTarget(target) {
  const files = await collectTextFiles(target.distDir);
  const contents = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
  const bundleText = contents.join("\n");
  const missing = target.requiredText.filter((text) => !bundleText.includes(text));

  return {
    name: target.name,
    dist: target.distLabel,
    status: missing.length ? "failed" : "passed",
    checkedFiles: files.map((file) => path.relative(root, file).replace(/\\/g, "/")),
    requiredText: target.requiredText,
    missing,
  };
}

async function writeReport(report) {
  await fs.mkdir(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `${nowForFile()}-frontend-evidence.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

async function main() {
  const startedAt = new Date();
  process.stdout.write("codex-loop 前端证据检查开始。\n");

  const results = [];
  for (const target of targets) {
    try {
      const result = await inspectTarget(target);
      results.push(result);
      process.stdout.write(
        `[前端证据检查] ${target.name}: ${result.status === "passed" ? "通过" : "失败"}\n`,
      );
    } catch (error) {
      results.push({
        name: target.name,
        dist: target.distLabel,
        status: "failed",
        error: error?.message || String(error),
      });
      process.stdout.write(`[前端证据检查] ${target.name}: 失败\n`);
    }
  }

  const failed = results.find((result) => result.status === "failed");
  const report = {
    title: "codex-loop 前端证据检查",
    status: failed ? "failed" : "passed",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    scope: "检查桌面端和移动端构建产物是否包含关键中文产品界面信号。",
    results,
    nextAction: failed
      ? "先确认桌面端和移动端构建产物是否包含历史对话、发送引导、截图证据、生产阶段、生产成熟度、剩余缺口、验证目标和启动预检。"
      : "前端关键状态、历史对话、生产阶段、生产成熟度、剩余缺口、验证目标、启动预检和引导入口已进入构建产物。",
  };
  const reportPath = await writeReport(report);
  process.stdout.write(`报告路径: ${reportPath}\n`);
  process.stdout.write(`codex-loop 前端证据检查${failed ? "失败" : "通过"}。\n`);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
