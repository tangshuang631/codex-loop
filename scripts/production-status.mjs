import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const MAX_REPORT_AGE_HOURS = Number(process.env.CODEX_LOOP_STATUS_MAX_REPORT_AGE_HOURS || 12);

const reportKinds = [
  {
    key: "productionCheck",
    label: "最近生产检查",
    dirLabel: "runtime/production-checks",
    suffix: "production-check.json",
  },
  {
    key: "frontendEvidence",
    label: "前端证据",
    dirLabel: "runtime/frontend-evidence",
    suffix: "frontend-evidence.json",
  },
  {
    key: "longrunSmoke",
    label: "长跑节奏",
    dirLabel: "runtime/longrun-smoke",
    suffix: "longrun-smoke.json",
  },
];

function resolveLabel(label) {
  return path.join(root, ...label.split("/"));
}

async function readLatestReport(kind) {
  const dir = resolveLabel(kind.dirLabel);
  let entries = [];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        label: kind.label,
        status: "missing",
        dir: kind.dirLabel,
        summary: "还没有生成报告。",
      };
    }
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(kind.suffix))
    .map((entry) => path.join(dir, entry.name));

  if (!files.length) {
    return {
      label: kind.label,
      status: "missing",
      dir: kind.dirLabel,
      summary: "还没有生成报告。",
    };
  }

  const withStats = await Promise.all(
    files.map(async (file) => ({ file, stat: await fs.stat(file) })),
  );
  withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const latest = withStats[0];
  const report = JSON.parse(await fs.readFile(latest.file, "utf8"));
  const relativePath = path.relative(root, latest.file).replace(/\\/g, "/");
  const finishedAt = report.finishedAt || "";
  const ageHours = getReportAgeHours(finishedAt, latest.stat.mtimeMs);
  const isStale = ageHours > MAX_REPORT_AGE_HOURS;
  const summary = summarizeReport(kind, report);

  return {
    label: kind.label,
    status: isStale ? "stale" : report.status || "unknown",
    rawStatus: report.status || "unknown",
    path: relativePath,
    finishedAt,
    ageHours: Number(ageHours.toFixed(2)),
    isStale,
    durationMs: report.durationMs || 0,
    summary: isStale ? `${summary}，但报告已过期` : summary,
  };
}

function getReportAgeHours(finishedAt, fallbackMtimeMs) {
  const finishedMs = Date.parse(finishedAt);
  const baseMs = Number.isFinite(finishedMs) ? finishedMs : fallbackMtimeMs;
  return Math.max(0, (Date.now() - baseMs) / 36e5);
}

function summarizeReport(kind, report) {
  if (kind.key === "productionCheck") {
    const checks = Array.isArray(report.checks) ? report.checks : [];
    const failed = checks.find((check) => check.status === "failed");
    return failed
      ? `${failed.name || "某项检查"}失败：${failed.command || "未记录命令"}`
      : `${checks.length || report.commandCount || 0} 项检查通过`;
  }

  if (kind.key === "frontendEvidence") {
    const results = Array.isArray(report.results) ? report.results : [];
    const failed = results.find((item) => item.status === "failed");
    return failed
      ? `${failed.name || "前端"}缺少证据：${(failed.missing || []).join("、") || failed.error || "未记录原因"}`
      : "历史对话、发送引导、截图证据已进入构建产物";
  }

  if (kind.key === "longrunSmoke") {
    const checks = Array.isArray(report.checks) ? report.checks : [];
    return report.status === "passed"
      ? `本地长跑节奏通过：${checks.length || 0} 项护栏`
      : report.error || "长跑节奏检查未通过";
  }

  return report.nextAction || report.summary || "未记录摘要。";
}

function deriveNextAction(items) {
  const stale = items.find((item) => item.status === "stale");
  if (stale) {
    return `${stale.label}已过期，请重新运行 npm run production:check 后再判断是否适合继续长期运行。`;
  }
  const failed = items.find((item) => item.status && item.status !== "passed");
  if (failed) {
    return `先处理${failed.label}：${failed.summary}`;
  }
  return "可以进入真实任务使用；长时间运行仍建议保留人工观察和运行日志。";
}

async function main() {
  const startedAt = new Date();
  const items = [];

  for (const kind of reportKinds) {
    items.push(await readLatestReport(kind));
  }

  const status = items.every((item) => item.status === "passed") ? "passed" : "attention";
  const report = {
    title: "codex-loop 生产状态摘要",
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    sections: items,
    nextActionLabel: "下一步建议",
    nextAction: deriveNextAction(items),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (status !== "passed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
