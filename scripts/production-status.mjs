import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadLoopConfig } from "./lib/config-loader.mjs";
import { buildProductionObservation } from "./production-observer.mjs";

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
  {
    key: "productionObservation",
    label: "真实运行观测",
    dirLabel: "runtime/production-observations",
    suffix: "production-observation.json",
  },
];

function currentRoot() {
  return process.cwd();
}

function resolveLabel(label, root = currentRoot()) {
  return path.join(root, ...label.split("/"));
}

function cleanText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatTargetLabel(target = {}) {
  return [
    cleanText(target.threadTitle, cleanText(target.workspaceName, cleanText(target.runId, "当前任务"))),
    cleanText(target.workspaceRoot),
    cleanText(target.threadId),
  ].filter(Boolean).join(" / ");
}

function appendTargetConfirmation(action, target = {}) {
  const targetLabel = formatTargetLabel(target);
  if (!targetLabel) return action;
  return `${action} 当前验证目标：${targetLabel}。触发真实循环前，请确认这就是要继续的任务。`;
}

async function readLatestReport(kind, {
  root = currentRoot(),
  now = new Date(),
} = {}) {
  const dir = resolveLabel(kind.dirLabel, root);
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
  const ageHours = getReportAgeHours(finishedAt, latest.stat.mtimeMs, now);
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
    nextAction: report.diagnosis?.nextAction || report.nextAction || "",
    waiting: report.waiting || null,
    diagnosis: report.diagnosis || null,
    counters: report.counters || null,
  };
}

async function readLiveProductionObservation(kind, {
  root = currentRoot(),
  runId = null,
  now = new Date(),
} = {}) {
  const resolvedRunId = runId || await resolveObservedRunId(root);
  const logPath = path.join(root, "runtime", resolvedRunId, "logs", "events.jsonl");
  let stat = null;

  try {
    stat = await fs.stat(logPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const report = await buildProductionObservation({ root, runId: resolvedRunId, now });
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  const ageHours = Number.isFinite(nowMs)
    ? Math.max(0, (nowMs - stat.mtimeMs) / 36e5)
    : getReportAgeHours(report.finishedAt || "", stat.mtimeMs, now);
  const isStale = ageHours > MAX_REPORT_AGE_HOURS;
  const summary = summarizeReport(kind, report);
  return {
    label: kind.label,
    status: isStale ? "stale" : report.status || "unknown",
    rawStatus: report.status || "unknown",
    path: report.loop?.logPath || path.relative(root, logPath).replace(/\\/g, "/"),
    finishedAt: report.finishedAt || "",
    ageHours: Number(ageHours.toFixed(2)),
    isStale,
    durationMs: report.durationMs || 0,
    summary: isStale
      ? "真实运行观测已过期，需要重新生成运行记录后再判断长期稳定性。"
      : summary,
    nextAction: isStale
      ? "请重新运行 npm run production:observe，或重新启动一次真实任务生成新的运行记录。"
      : report.diagnosis?.nextAction || report.nextAction || "",
    waiting: report.waiting || null,
    diagnosis: report.diagnosis || null,
    counters: report.counters || null,
  };
}

function getReportAgeHours(finishedAt, fallbackMtimeMs, now = new Date()) {
  const finishedMs = Date.parse(finishedAt);
  const baseMs = Number.isFinite(finishedMs) ? finishedMs : fallbackMtimeMs;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  return Math.max(0, ((Number.isFinite(nowMs) ? nowMs : Date.now()) - baseMs) / 36e5);
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
    const requiredTexts = [
      ...new Set(
        results
          .flatMap((item) => (Array.isArray(item.requiredText) ? item.requiredText : []))
          .filter(Boolean),
      ),
    ];
    return failed
      ? `${failed.name || "前端"}缺少证据：${(failed.missing || []).join("、") || failed.error || "未记录原因"}`
      : `${requiredTexts.length ? requiredTexts.join("、") : "关键界面信号"} 已进入构建产物`;
  }

  if (kind.key === "longrunSmoke") {
    const checks = Array.isArray(report.checks) ? report.checks : [];
    return report.status === "passed"
      ? `本地长跑节奏通过：${checks.length || 0} 项护栏`
      : report.error || "长跑节奏检查未通过";
  }

  if (kind.key === "productionObservation") {
    const counters = report.counters || {};
    const closedLoops = counters.closedLoops || Math.min(
      counters.dispatches || 0,
      counters.completions || 0,
      counters.supervisorReviews || 0,
    );
    const diagnosis = report.diagnosis || {};
    const waiting = report.waiting || {};
    const userMessage = typeof diagnosis.userMessage === "string" ? diagnosis.userMessage.trim() : "";
    const waitingMinutes = Number(waiting.waitingMinutes);
    const waitingLabel =
      report.status === "waiting" && Number.isFinite(waitingMinutes) && waitingMinutes > 0
        ? `已等待约 ${waitingMinutes} 分钟，`
        : "";
    return report.status === "passed"
      ? `真实运行已形成 ${closedLoops} 轮真实闭环，达到长期运行基本证据：发送 ${counters.dispatches || 0} 次，完成 ${counters.completions || 0} 次，NPC 复盘 ${counters.supervisorReviews || 0} 次`
      : `${waitingLabel}${userMessage || report.summary || "真实运行观测需要留意"}`;
  }

  return report.nextAction || report.summary || "未记录摘要。";
}

function hasPartialClosedLoopEvidence(item = {}) {
  const closedLoops = Number(item.counters?.closedLoops || 0);
  return (
    closedLoops > 0 ||
    /1 轮真实闭环|1 轮完整闭环|已经观察到 1 轮/u.test(
      `${item.summary || ""}\n${item.nextAction || ""}`,
    )
  );
}

function needsSupervisorRecovery(item = {}) {
  if (item.status === "stale") {
    return false;
  }
  if (item.diagnosis?.category === "completion_missing_supervisor_review") {
    return true;
  }
  if (
    Number(item.counters?.completions || 0) > Number(item.counters?.supervisorReviews || 0) &&
    Number(item.counters?.closedLoops || 0) === 0
  ) {
    return true;
  }
  const textBlock = [
    item.summary,
    item.nextAction,
    item.diagnosis?.userMessage,
    item.diagnosis?.nextAction,
  ].filter(Boolean).join("\n");
  return /缺少\s*NPC\s*监督复盘|补齐监督复盘|production:recover/u.test(textBlock);
}

function supervisorRecoveryAction() {
  return "先运行 npm run production:recover 补齐监督复盘；该命令不会发送下一轮指令。";
}

function deriveNextAction(items, target = {}) {
  const stale = items.find((item) => item.status === "stale");
  if (stale) {
    if (stale.label === "真实运行观测") {
      return `${stale.label}已过期，请重新运行 npm run production:observe，或重新启动一次真实任务生成新的运行记录。`;
    }
    return `${stale.label}已过期，请重新运行 npm run production:check 后再判断是否适合继续长期运行。`;
  }
  const waiting = items.find((item) => item.status === "waiting");
  if (waiting) {
    const needsHumanCheck = Boolean(waiting.waiting?.needsHumanCheck);
    const waitingMinutes = Number(waiting.waiting?.waitingMinutes);
    const waitLabel = Number.isFinite(waitingMinutes) && waitingMinutes > 0
      ? `已等待约 ${waitingMinutes} 分钟，`
      : "";
    const action = needsHumanCheck
      ? "请确认 Codex 是否仍在处理或是否卡在确认步骤；不要重复发送。"
      : waiting.nextAction || waiting.summary;
    return `${waiting.label}正在等待：${waitLabel}${action}`;
  }
  const failed = items.find((item) => item.status && item.status !== "passed");
  if (failed) {
    if (failed.label === "真实运行观测" && needsSupervisorRecovery(failed)) {
      return supervisorRecoveryAction();
    }
    if (failed.label === "真实运行观测" && hasPartialClosedLoopEvidence(failed)) {
      return appendTargetConfirmation(failed.nextAction || failed.summary, target);
    }
    return `先处理${failed.label}：${failed.nextAction || failed.summary}`;
  }
  return appendTargetConfirmation(
    "可以进入真实任务使用；长时间运行仍建议保留人工观察和运行日志。",
    target,
  );
}

function deriveOverallStatus(items) {
  if (items.some((item) => item.status && !["passed", "waiting"].includes(item.status))) {
    return "attention";
  }
  if (items.some((item) => item.status === "waiting")) {
    return "waiting";
  }
  return "passed";
}

function deriveReadiness(items, target = {}) {
  const codeGateLabels = new Set(["最近生产检查", "前端证据", "长跑节奏"]);
  const codeGatesPassed = items
    .filter((item) => codeGateLabels.has(item.label))
    .every((item) => item.status === "passed");
  const observation = items.find((item) => item.label === "真实运行观测");
  const failed = items.find((item) => item.status && !["passed", "waiting", "stale"].includes(item.status));
  const failedCodeGate = items.find((item) =>
    codeGateLabels.has(item.label) &&
    item.status &&
    !["passed", "waiting", "stale"].includes(item.status),
  );
  const supervisorRecoveryNeeded = observation && needsSupervisorRecovery(observation);

  if (failedCodeGate || (failed && !codeGatesPassed)) {
    const item = failedCodeGate || failed;
    return {
      stage: "blocked",
      summary: `生产检查还不能通过：${item.label}需要处理。`,
      nextAction: item.nextAction || item.summary || "先处理失败项，再重新运行 npm run production:check。",
    };
  }

  if (codeGatesPassed && supervisorRecoveryNeeded) {
    return {
      stage: "blocked",
      summary: "Codex 已完成但还缺少 NPC 监督复盘，暂时不能继续发送下一轮。",
      nextAction: supervisorRecoveryAction(),
    };
  }

  if (codeGatesPassed && observation?.status === "passed") {
    return {
      stage: "production",
      summary: "代码闸门和真实 2 轮闭环证据都已通过，可以进入有人工观察的长期运行。",
      nextAction: "继续保留运行日志和人工观察，再逐步提高自动化时长。",
    };
  }

  if (codeGatesPassed && observation?.status === "waiting") {
    return {
      stage: "observing",
      summary: "代码闸门已通过，真实任务正在等待 Codex 完成这一轮，还不能判断长期稳定性。",
      nextAction: observation.nextAction || "等待 Codex 完成后，让 NPC 复盘并继续观察是否形成 2 轮闭环。",
    };
  }

  if (
    codeGatesPassed &&
    observation?.status === "attention" &&
    (
      observation.rawStatus === "attention" ||
      observation.summary ||
      observation.nextAction
    )
  ) {
    if (hasPartialClosedLoopEvidence(observation)) {
      return {
        stage: "trial",
        summary: "代码闸门已通过，并已观察到 1 轮真实闭环；适合短时试用，但还缺少第 2 轮连续闭环证据。",
        nextAction: appendTargetConfirmation(
          observation.nextAction || "再跑至少 1 轮真实任务，确认发送、Codex 完成和 NPC 复盘能连续出现。",
          target,
        ),
      };
    }
  }

  if (failed) {
    return {
      stage: "blocked",
      summary: `生产检查还不能通过：${failed.label}需要处理。`,
      nextAction: failed.nextAction || failed.summary || "先处理失败项，再重新运行 npm run production:check。",
    };
  }

  if (codeGatesPassed) {
    return {
      stage: "trial",
      summary: "代码闸门已通过，适合短时真实试用；但还缺少真实 2 轮闭环证据，暂不适合提高自动化时长。",
      nextAction: appendTargetConfirmation(
        "启动真实任务，观察至少 2 次发送、Codex 完成、NPC 复盘的连续闭环，再判断是否提高自动化时长。",
        target,
      ),
    };
  }

  return {
    stage: "blocked",
    summary: "代码闸门还没有全部通过，暂不适合投入真实任务。",
    nextAction: "先运行 npm run production:check，并按失败项修复后再继续。",
  };
}

function deriveMaturity(items, readiness = {}) {
  const stage = readiness.stage || "blocked";
  const observation = items.find((item) => item.label === "真实运行观测") || {};
  const codeGateLabels = new Set(["最近生产检查", "前端证据", "长跑节奏"]);
  const codeGatesPassed = items
    .filter((item) => codeGateLabels.has(item.label))
    .every((item) => item.status === "passed");
  const partialClosedLoop = hasPartialClosedLoopEvidence(observation);
  const supervisorRecoveryNeeded = needsSupervisorRecovery(observation);
  const gaps = [];
  const evidence = [];

  if (codeGatesPassed) {
    evidence.push("代码闸门已通过。");
  } else {
    gaps.push("代码闸门还没有全部通过。");
  }

  if (stage === "production") {
    evidence.push("已观察到至少 2 轮真实闭环。");
    return {
      label: "可长跑",
      percent: 90,
      canTrial: true,
      canLongRun: true,
      summary: "代码闸门和真实 2 轮闭环证据都已通过，可以进入有人工观察的长期运行。",
      gaps,
      evidence,
    };
  }

  if (stage === "observing") {
    evidence.push("真实任务正在运行观测中。");
    gaps.push("等待 Codex 完成当前轮并形成 NPC 复盘。");
    gaps.push("还缺少第 2 轮真实闭环证据。");
    return {
      label: "观察中",
      percent: codeGatesPassed ? 70 : 45,
      canTrial: codeGatesPassed,
      canLongRun: false,
      summary: "代码闸门已通过，但真实任务仍在等待当前轮结果，还不能判断长期稳定性。",
      gaps,
      evidence,
    };
  }

  if (supervisorRecoveryNeeded) {
    evidence.push("Codex 已有完成回复。");
    gaps.push("需要先补齐监督复盘。");
    gaps.push("恢复前不能继续发送下一轮。");
    return {
      label: "需恢复",
      percent: codeGatesPassed ? 68 : 40,
      canTrial: false,
      canLongRun: false,
      summary: "Codex 已完成但还缺少 NPC 监督复盘，暂时不能继续发送下一轮。",
      gaps,
      evidence,
    };
  }

  if (stage === "trial") {
    if (partialClosedLoop) {
      evidence.push("已观察到 1 轮真实闭环。");
      gaps.push("还缺少第 2 轮真实闭环证据。");
      gaps.push("长时间运行前仍需要连续发送、Codex 完成和 NPC 复盘证据。");
      return {
        label: "短时试用",
        percent: 75,
        canTrial: true,
        canLongRun: false,
        summary: "代码闸门已通过，并已观察到 1 轮真实闭环；适合短时试用，但还缺少第 2 轮连续闭环证据。",
        gaps,
        evidence,
      };
    }

    gaps.push("还缺少真实 2 轮闭环证据。");
    gaps.push("需要先观察发送、Codex 完成和 NPC 复盘是否连续出现。");
    return {
      label: "短时试用",
      percent: codeGatesPassed ? 65 : 40,
      canTrial: codeGatesPassed,
      canLongRun: false,
      summary: "代码闸门已通过，适合短时真实试用；但还缺少真实 2 轮闭环证据。",
      gaps,
      evidence,
    };
  }

  gaps.push(readiness.nextAction || readiness.summary || "先处理生产检查失败项。");
  return {
    label: "需处理",
    percent: codeGatesPassed ? 55 : 35,
    canTrial: false,
    canLongRun: false,
    summary: readiness.summary || "生产检查还不能通过，暂不适合投入真实任务。",
    gaps,
    evidence,
  };
}

export async function readProductionStatusSummary({
  refreshObservation = true,
  runId = null,
  now = new Date(),
} = {}) {
  const startedAt = new Date();
  const items = [];
  const resolvedRunId = runId || await resolveObservedRunId(currentRoot());
  const target = await readProductionTarget({ root: currentRoot(), runId: resolvedRunId });

  for (const kind of reportKinds) {
    if (refreshObservation && kind.key === "productionObservation") {
      const liveObservation = await readLiveProductionObservation(kind, { runId: resolvedRunId, now });
      if (liveObservation?.status === "stale") {
        const latestReport = await readLatestReport(kind, { now });
        items.push(latestReport.status && !["missing", "stale"].includes(latestReport.status)
          ? latestReport
          : liveObservation);
        continue;
      }
      items.push(liveObservation || await readLatestReport(kind, { now }));
      continue;
    }
    items.push(await readLatestReport(kind, { now }));
  }

  const status = deriveOverallStatus(items);
  const readiness = deriveReadiness(items, target);
  return {
    title: "codex-loop 生产状态摘要",
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    target,
    readiness,
    maturity: deriveMaturity(items, readiness),
    sections: items,
    nextActionLabel: "下一步建议",
    nextAction: deriveNextAction(items, target),
  };
}

async function readProductionTarget({
  root = currentRoot(),
  runId = "assistant-loop",
} = {}) {
  const threadPath = path.join(root, "runtime", runId, "thread.json");
  const loop = await readProductionTargetLoop({ root, runId });
  let thread = {};
  try {
    thread = JSON.parse(await fs.readFile(threadPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const binding = loop?.threadBinding || {};

  return {
    runId,
    threadId: cleanText(thread.threadId, cleanText(binding.threadId)),
    threadTitle: cleanText(thread.threadTitle, cleanText(binding.threadTitle, cleanText(loop?.threadTitle))),
    workspaceRoot: cleanText(thread.workspaceRoot, cleanText(binding.workspaceRoot, cleanText(loop?.workspaceRoot))),
    workspaceName: cleanText(thread.workspaceName, cleanText(binding.workspaceName, cleanText(loop?.projectName))),
    projectName: cleanText(loop?.projectName),
    loopName: cleanText(loop?.name),
    continuationStatus: cleanText(thread.continuationStatus),
  };
}

async function readProductionTargetLoop({
  root = currentRoot(),
  runId = "assistant-loop",
} = {}) {
  const registryPath = path.join(root, "settings", "loops.json");
  try {
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    const loops = Array.isArray(registry.loops) ? registry.loops : [];
    return (
      loops.find((loop) => loop.id === runId || loop.runId === runId) ||
      loops.find((loop) => loop.id === registry.currentLoopId || loop.runId === registry.currentLoopId) ||
      null
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveObservedRunId(root = currentRoot()) {
  if (process.env.CODEX_LOOP_OBSERVE_RUN_ID) {
    return process.env.CODEX_LOOP_OBSERVE_RUN_ID;
  }

  try {
    const { config } = await loadLoopConfig(root);
    if (config.currentRunId) {
      return config.currentRunId;
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !/Missing codex-loop config file/u.test(String(error?.message || ""))) {
      throw error;
    }
  }

  return "assistant-loop";
}

async function main() {
  const report = await readProductionStatusSummary();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
