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

const frontendEvidenceLabels = {
  "conversation-detail-block": "折叠详情",
  "markdown-code-block": "代码块",
  "file-path-chip": "文件路径",
};

function readableFrontendEvidence(text) {
  const value = cleanText(text);
  return frontendEvidenceLabels[value] || value;
}

function collectFrontendEvidenceItems(item = {}) {
  const source = Array.isArray(item.requiredEvidence) && item.requiredEvidence.length
    ? item.requiredEvidence
    : Array.isArray(item.requiredText)
      ? item.requiredText
      : [];
  return [
    ...new Set(
      source
        .map(readableFrontendEvidence)
        .filter(Boolean),
    ),
  ];
}

function buildFrontendEvidenceGroups(report = {}) {
  const results = Array.isArray(report.results) ? report.results : [];
  return results
    .map((item) => ({
      name: cleanText(item.name, "前端"),
      status: cleanText(item.status, "unknown"),
      items: collectFrontendEvidenceItems(item),
    }))
    .filter((group) => group.items.length);
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
  const evidenceGroups = kind.key === "frontendEvidence"
    ? buildFrontendEvidenceGroups(report)
    : null;

  const item = {
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
    guidance: report.guidance || null,
  };
  if (evidenceGroups?.length) {
    item.evidenceGroups = evidenceGroups;
  }
  return item;
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
    guidance: report.guidance || null,
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
          .flatMap(collectFrontendEvidenceItems)
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
    const mergedGuidance = Number(counters.mergedGuidance || report.guidance?.mergedCount || 0);
    const guidancePreview = cleanText(report.guidance?.latestPreview);
    const guidanceLabel = mergedGuidance > 0
      ? `，已合并补充 ${mergedGuidance} 次${guidancePreview ? `：${guidancePreview}` : ""}`
      : "";
    return report.status === "passed"
      ? `真实运行已形成 ${closedLoops} 轮真实闭环，达到长期运行基本证据：发送 ${counters.dispatches || 0} 次，完成 ${counters.completions || 0} 次，NPC 复盘 ${counters.supervisorReviews || 0} 次${guidanceLabel}`
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

function countMergedGuidanceEvidence(item = {}) {
  return Math.max(
    0,
    Number(item.counters?.mergedGuidance || 0),
    Number(item.guidance?.mergedCount || 0),
  );
}

function hasMergedGuidanceEvidence(item = {}) {
  return countMergedGuidanceEvidence(item) > 0;
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
  const observation = items.find((item) => item.label === "真实运行观测");
  if (
    observation?.status === "passed" &&
    Number(observation.counters?.closedLoops || 0) >= 2 &&
    !hasMergedGuidanceEvidence(observation)
  ) {
    return appendTargetConfirmation(
      "真实闭环已经达标，但还缺少用户补充引导被本地模型 / NPC 合并进下一条指令的证据。请从桌面端或移动端写入一次补充引导，等 Codex 完成后确认它被合并发送。",
      target,
    );
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
    if (!hasMergedGuidanceEvidence(observation)) {
      return {
        stage: "trial",
        summary: "代码闸门和真实 2 轮闭环证据已通过，但还缺少用户补充经本地模型 / NPC 合并进下一条指令的真实证据。",
        nextAction: appendTargetConfirmation(
          "在真实任务中从桌面端或移动端写入一次补充引导，等 Codex 完成后确认补充被本地模型 / NPC 合并进下一条指令。",
          target,
        ),
      };
    }
    return {
      stage: "production",
      summary: "代码闸门、真实 2 轮闭环证据和用户补充合并证据都已通过，可以进入有人工观察的长期运行。",
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
  const mergedGuidanceCount = countMergedGuidanceEvidence(observation);
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
    evidence.push(`已观察到 ${mergedGuidanceCount} 次用户补充合并进下一条指令。`);
    return {
      label: "可长跑",
      percent: 90,
      canTrial: true,
      canLongRun: true,
      summary: "代码闸门、真实 2 轮闭环证据和用户补充合并证据都已通过，可以进入有人工观察的长期运行。",
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
    const closedLoops = Number(observation.counters?.closedLoops || 0);
    if (closedLoops >= 2 && !hasMergedGuidanceEvidence(observation)) {
      evidence.push("已观察到至少 2 轮真实闭环。");
      gaps.push("还缺少用户补充经本地模型 / NPC 合并进下一条指令的真实证据。");
      gaps.push("长时间运行前需要确认移动端或桌面端补充引导能被合并到下一轮。");
      return {
        label: "短时试用",
        percent: 82,
        canTrial: true,
        canLongRun: false,
        summary: "真实闭环已达标，但还没有观察到用户补充引导被本地模型 / NPC 合并进下一条指令，暂不进入长期运行。",
        gaps,
        evidence,
      };
    }
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

function buildGuidanceEvidencePlan({
  current = 0,
  canLongRun = false,
  target = {},
} = {}) {
  if (canLongRun) {
    return {
      status: "satisfied",
      summary: "已观察到用户补充经本地模型 / NPC 合并进下一条指令。",
      targetLabel: formatTargetLabel(target),
      steps: [],
    };
  }

  return {
    status: "needs_guidance_merge_evidence",
    summary: "还需要 1 次真实用户补充合并证据：写入补充引导 -> 等 Codex 完成 -> 本地模型 / NPC 合并 -> 下一条指令发出。",
    targetLabel: formatTargetLabel(target),
    steps: [
      {
        label: "写入补充",
        detail: "从桌面端或移动端在对话底部写入下一轮补充引导。",
      },
      {
        label: "等待完成",
        detail: "不要打断 Codex 当前轮，等待它完成并进入可接收下一条指令的状态。",
      },
      {
        label: "模型合并",
        detail: "确认补充引导被本地模型 / NPC 结合 Codex 回复合并进下一条指令。",
      },
      {
        label: "重新检查",
        detail: "重新查看生产状态，确认用户补充合并证据是否出现。",
      },
    ],
    observed: current,
  };
}

function deriveGuidanceEvidence(items, maturity = {}, targetInfo = {}) {
  const observation = items.find((item) => item.label === "真实运行观测") || {};
  const current = countMergedGuidanceEvidence(observation);
  const required = 1;
  const remaining = Math.max(0, required - current);
  const canLongRun = Boolean(maturity.canLongRun || current >= required);
  const label = canLongRun
    ? "已观察到用户补充合并证据"
    : "还差 1 次用户补充合并证据";
  const summary = canLongRun
    ? `已观察到 ${current} 次用户补充被本地模型 / NPC 合并进下一条指令。`
    : "还没有观察到用户补充被 NPC / Ollama / 本地模型合并进下一条指令。";

  return {
    current,
    target: required,
    remaining,
    canLongRun,
    label,
    summary,
    evidencePlan: buildGuidanceEvidencePlan({
      current,
      canLongRun,
      target: targetInfo,
    }),
  };
}

function buildClosedLoopEvidencePlan({
  current = 0,
  remaining = 0,
  canLongRun = false,
  maturity = {},
  target = {},
} = {}) {
  if (canLongRun) {
    return {
      status: "satisfied",
      summary: "真实闭环证据已达到长期运行基本要求，后续继续保留人工观察和运行日志。",
      targetLabel: formatTargetLabel(target),
      steps: [],
    };
  }

  if (maturity.label === "需恢复") {
    return {
      status: "needs_supervisor_recovery",
      summary: "Codex 已有完成回复但还缺少 NPC 复盘，先补齐复盘再决定是否发送下一轮。",
      targetLabel: formatTargetLabel(target),
      steps: [
        {
          label: "补齐复盘",
          detail: "先运行安全恢复入口，只补 NPC 复盘，不发送新指令。",
        },
        {
          label: "重新检查",
          detail: "复盘完成后重新查看生产状态，再判断是否继续真实循环。",
        },
      ],
    };
  }

  return {
    status: "needs_more_real_loop_evidence",
    summary: `还需要 ${remaining} 轮真实闭环：发送下一轮指令 -> Codex 完成 -> NPC 复盘。`,
    targetLabel: formatTargetLabel(target),
    steps: [
      {
        label: "确认目标",
        detail: "确认当前任务、工作区和线程就是要继续验证的对象。",
      },
      {
        label: "发送一轮",
        detail: "只触发一次真实循环或手动发送一次引导，不连续追发。",
      },
      {
        label: "等待 Codex 完成",
        detail: "Codex 未完成前不要追加发送，等待它进入可接收下一条指令的状态。",
      },
      {
        label: "NPC 复盘",
        detail: "Codex 完成后等待产品经理、测试人员、真实用户视角完成复盘。",
      },
      {
        label: "重新检查",
        detail: "重新查看生产状态，确认真实闭环是否达到 2 轮。",
      },
    ],
    observed: current,
  };
}

function deriveClosedLoopEvidence(items, maturity = {}, targetInfo = {}) {
  const observation = items.find((item) => item.label === "真实运行观测") || {};
  const current = Math.max(0, Number(observation.counters?.closedLoops || 0));
  const requiredLoops = 2;
  const remaining = Math.max(0, requiredLoops - current);
  const canLongRun = Boolean(maturity.canLongRun || current >= requiredLoops);
  const label = canLongRun
    ? "已达到长期运行基本证据"
    : `还差 ${remaining} 轮真实闭环`;
  const summary = canLongRun
    ? `已观察到 ${current} 轮真实闭环，达到长期运行基本证据。`
    : `已观察到 ${current} 轮真实闭环，还差 ${remaining} 轮真实闭环才能进入长期运行基本证据。`;

  return {
    current,
    target: requiredLoops,
    remaining,
    canLongRun,
    label,
    summary,
    evidencePlan: buildClosedLoopEvidencePlan({
      current,
      remaining,
      canLongRun,
      maturity,
      target: targetInfo,
    }),
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
  const maturity = deriveMaturity(items, readiness);
  return {
    title: "codex-loop 生产状态摘要",
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    target,
    readiness,
    maturity,
    closedLoopEvidence: deriveClosedLoopEvidence(items, maturity, target),
    guidanceEvidence: deriveGuidanceEvidence(items, maturity, target),
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
