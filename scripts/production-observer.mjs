import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadLoopConfig } from "./lib/config-loader.mjs";

const DEFAULT_LIMIT = 80;
const DEFAULT_WAIT_ATTENTION_MINUTES = Number(
  process.env.CODEX_LOOP_WAIT_ATTENTION_MINUTES || 15,
);
const reportRootLabel = "runtime/production-observations";

function nowForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

async function readJsonLines(filePath, limit = DEFAULT_LIMIT) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function eventLabel(type) {
  const labels = {
    run_started_from_console: "循环已启动",
    codex_followup_dispatching: "正在发送指令",
    codex_followup_dispatched: "正在等待 Codex",
    codex_followup_sent_waiting: "指令已送达，等待 Codex",
    codex_followup_completed: "Codex 已完成一轮",
    supervisor_review_started: "NPC 复盘中",
    supervisor_review_completed: "NPC 复盘完成",
    supervisor_review_skipped: "NPC 复盘跳过",
    supervisor_verification_completed: "独立验收完成",
    codex_conversation_mirror_synced: "已同步 Codex 回复",
    codex_followup_failed: "续跑失败",
    codex_followup_stalled: "等待超时",
    graceful_stop_requested: "已请求停止",
    graceful_stop_completed: "已停止循环",
    graceful_stop_wait_elapsed: "停止等待结束",
    runtime_error: "运行异常",
  };
  return labels[type] || "运行记录";
}

function eventDetail(event = {}) {
  const detail = safeText(
    event.latestAssistantPreview ||
      event.summary ||
      event.promptPreview ||
      event.message ||
      event.note ||
      event.reason,
    "未记录详情。",
  );
  if (/^\?+([,，\s]*\?+)*[。.!！?？,，\s]*$/u.test(detail)) {
    return "旧日志详情不可读，请查看原始日志确认当时的停止原因。";
  }
  if (/^graceful stop completed$/iu.test(detail)) {
    return "循环已停止。";
  }
  return detail;
}

function isTimelineEvent(event = {}) {
  return [
    "run_started_from_console",
    "codex_followup_dispatching",
    "codex_followup_dispatched",
    "codex_followup_sent_waiting",
    "codex_followup_completed",
    "supervisor_review_started",
    "supervisor_review_completed",
    "supervisor_review_skipped",
    "supervisor_verification_completed",
    "codex_conversation_mirror_synced",
    "codex_followup_failed",
    "codex_followup_stalled",
    "graceful_stop_requested",
    "graceful_stop_completed",
    "graceful_stop_wait_elapsed",
    "runtime_error",
  ].includes(safeText(event.type));
}

function buildCounters(events) {
  const dispatching = events.filter((event) => event.type === "codex_followup_dispatching").length;
  const sentOnly = events.filter((event) => event.type === "codex_followup_sent_waiting").length;
  const dispatches = dispatching || sentOnly;
  const completions = events.filter((event) => event.type === "codex_followup_completed").length;
  const supervisorReviews = events.filter((event) => event.type === "supervisor_review_completed").length;
  return {
    dispatches,
    completions,
    supervisorReviews,
    closedLoops: Math.min(dispatches, completions, supervisorReviews),
    verificationRuns: events.filter((event) => event.type === "supervisor_verification_completed").length,
    failures: events.filter((event) => /failed|stalled|runtime_error/u.test(event.type)).length,
    stopEvents: events.filter((event) => event.type === "graceful_stop_completed").length,
  };
}

function isDeliveredTimeoutFailure(event = {}) {
  return (
    event.type === "codex_followup_failed" &&
    /(已收到|已送达|received|delivered).*(超时|timeout)|等待这一轮回复超时/iu.test(event.detail || "")
  );
}

function recoverTimeoutsWithMirrorReplies(timeline) {
  let pendingTimeoutIndex = -1;
  let hasRecovery = false;
  const recovered = [];

  for (const event of timeline) {
    if (isDeliveredTimeoutFailure(event)) {
      pendingTimeoutIndex = recovered.length;
      recovered.push(event);
      continue;
    }

    if (
      event.type === "codex_conversation_mirror_synced" &&
      pendingTimeoutIndex >= 0 &&
      safeText(event.detail, "未记录详情。") !== "未记录详情。"
    ) {
      recovered.splice(pendingTimeoutIndex, 1);
      recovered.push({
        ...event,
        type: "codex_followup_completed",
        label: "Codex 已完成一轮",
        recoveredFromTimeout: true,
      });
      pendingTimeoutIndex = -1;
      hasRecovery = true;
      continue;
    }

    recovered.push(event);
  }

  return { timeline: recovered, hasRecovery };
}

function latestRunCycle(timeline) {
  const latestStartIndex = timeline
    .map((event) => event.type)
    .lastIndexOf("run_started_from_console");
  if (latestStartIndex < 0) {
    return {
      current: timeline,
      previous: [],
    };
  }
  return {
    current: timeline.slice(latestStartIndex),
    previous: timeline.slice(0, latestStartIndex),
  };
}

function buildWaitingObservation(timeline, now = new Date()) {
  const latestWaiting = timeline.findLast((event) => event.type === "codex_followup_sent_waiting");
  const waitingAt = Date.parse(latestWaiting?.at || "");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  const waitingMinutes =
    Number.isFinite(waitingAt) && Number.isFinite(nowMs)
      ? Math.max(0, Math.round((nowMs - waitingAt) / 60000))
      : 0;
  const waitAttentionMinutes = Number.isFinite(DEFAULT_WAIT_ATTENTION_MINUTES)
    ? DEFAULT_WAIT_ATTENTION_MINUTES
    : 15;

  return {
    waitingSince: latestWaiting?.at || "",
    waitingMinutes,
    waitAttentionMinutes,
    needsHumanCheck: waitingMinutes >= waitAttentionMinutes,
  };
}

function deriveStatusAndAdvice(counters, timeline, { waiting = null } = {}) {
  if (!timeline.length) {
    return {
      status: "attention",
      summary: "还没有可用的真实运行记录。",
      nextAction: "先启动一次真实任务，让 codex-loop 产生发送、等待、完成和复盘记录后再判断长跑稳定性。",
    };
  }

  if (counters.failures > 0) {
    return {
      status: "attention",
      summary: `发现 ${counters.failures} 条失败记录，需要先排查后再长时间运行。`,
      nextAction: "先处理失败记录，确认线程绑定、Codex 桌面端连接和 Ollama 配置后再重新开始循环。",
    };
  }

  const types = new Set(timeline.map((event) => event.type));
  if (
    types.has("codex_followup_sent_waiting") &&
    !types.has("codex_followup_completed")
  ) {
    const waitLabel = waiting?.waitingMinutes
      ? `已等待约 ${waiting.waitingMinutes} 分钟，`
      : "";
    const needsHumanCheck = Boolean(waiting?.needsHumanCheck);
    return {
      status: "waiting",
      summary: `指令已送达，${waitLabel}正在等待 Codex 完成这一轮。`,
      nextAction: needsHumanCheck
        ? "不要重复发送；请确认 Codex 是否仍在处理或是否卡在确认步骤。如需补充方向，先写入下一轮引导。"
        : "不要重复发送；如需补充方向，先写入下一轮引导，等 Codex 完成后再合并发送。",
    };
  }

  if (counters.closedLoops >= 2) {
    return {
      status: "passed",
      summary: `最近一次运行周期已观察到 ${counters.closedLoops} 轮发送、Codex 完成和 NPC 复盘，具备继续真实长跑的基本证据。`,
      nextAction: "可以继续真实任务；建议继续保留人工观察，并在多轮完成后再提高自动化时长。",
    };
  }

  if (counters.closedLoops === 1) {
    return {
      status: "attention",
      summary: "只观察到 1 轮完整闭环，说明链路可试用，但还不足以证明长期稳定运行。",
      nextAction: "再跑至少 1 轮真实任务，确认发送、Codex 完成和 NPC 复盘能连续出现后，再提高自动化时长。",
    };
  }

  return {
    status: "attention",
    summary: "已有运行记录，但还没有形成发送、完成、NPC 复盘的完整闭环证据。",
    nextAction: "继续观察到至少一轮 Codex 完成和 NPC 复盘后，再判断是否适合长期运行。",
  };
}

function deriveDiagnosis(counters, timeline, { hasRecovery = false } = {}) {
  if (!timeline.length) {
    return {
      category: "no_runtime_events",
      userMessage: "还没有看到这一轮真实运行记录。",
      nextAction: "先启动一次任务，等出现发送、等待、完成或失败记录后再判断。",
    };
  }

  if (counters.failures <= 0) {
    if (hasRecovery || timeline.some((event) => event.recoveredFromTimeout)) {
      return {
        category: "codex_reply_recovered_after_timeout",
        userMessage: "上一轮等待超时后已经同步到 Codex 回复。",
        nextAction: "先查看这条 Codex 回复和本地监督复盘；不要因为旧超时重复发送同一条指令。",
      };
    }
    const types = new Set(timeline.map((event) => event.type));
    if (
      types.has("codex_followup_sent_waiting") &&
      !types.has("codex_followup_completed")
    ) {
      return {
        category: "codex_waiting_after_delivery",
        userMessage: "指令已经送达 Codex，正在等待这一轮完成。",
        nextAction: "不要重复发送；可以先写入下一轮补充，等 Codex 完成后再由本地模型合并处理。",
      };
    }
    return {
      category: "healthy_or_waiting",
      userMessage: "当前周期没有失败记录。",
      nextAction: "继续观察 Codex 完成和 NPC 复盘是否稳定出现。",
    };
  }

  const types = new Set(timeline.map((event) => event.type));
  const details = timeline.map((event) => event.detail).join("\n");
  const latestFailureIndex = timeline.findLastIndex((event) =>
    /failed|stalled|runtime_error/u.test(event.type),
  );
  const latestFailureWindow =
    latestFailureIndex >= 0 ? timeline.slice(Math.max(0, latestFailureIndex - 2)) : timeline;
  const latestFailureDetails = latestFailureWindow.map((event) => event.detail).join("\n");
  const latestFailureTypes = new Set(latestFailureWindow.map((event) => event.type));
  const hasCompletionAfterLatestFailure =
    latestFailureIndex >= 0 &&
    timeline.slice(latestFailureIndex + 1).some((event) => event.type === "codex_followup_completed");
  const hasDeliveredTimeout =
    latestFailureTypes.has("codex_followup_sent_waiting") ||
    /(已收到|已送达|received|delivered).*(超时|timeout)/iu.test(latestFailureDetails);
  if (
    hasDeliveredTimeout &&
    /超时|timeout|waiting/i.test(latestFailureDetails) &&
    !hasCompletionAfterLatestFailure
  ) {
    return {
      category: "codex_timeout_after_delivery",
      userMessage: "指令已经送达 Codex，但这一轮没有在等待时间内返回完成结果。",
      nextAction: "不要立即连续补发；先确认 Codex 是否仍在处理，必要时延长等待时间或查看 Codex 任务是否卡在确认步骤。",
    };
  }

  if (types.has("codex_followup_dispatching") && !types.has("codex_followup_sent_waiting")) {
    return {
      category: "dispatch_failed_before_delivery",
      userMessage: "指令进入发送阶段，但没有观察到已送达 Codex 的记录。",
      nextAction: "优先检查线程绑定、桌面端原生发送入口和本机 Codex 连接状态。",
    };
  }

  if (types.has("runtime_error")) {
    return {
      category: "runtime_error",
      userMessage: "运行时出现异常。",
      nextAction: "先查看最近一条运行异常日志，再重新启动任务。",
    };
  }

  return {
    category: "followup_failed",
    userMessage: "这一轮续跑失败，但当前日志不足以进一步区分发送失败还是等待超时。",
    nextAction: "查看最近记录中的失败详情，并确认线程绑定、Codex 状态和 Ollama 配置。",
  };
}

export async function buildProductionObservation({
  root = process.cwd(),
  runId = null,
  limit = DEFAULT_LIMIT,
  now = new Date(),
} = {}) {
  const startedAt = new Date();
  const resolvedRunId = runId || await resolveObservedRunId(root);
  const logPath = path.join(root, "runtime", resolvedRunId, "logs", "events.jsonl");
  const events = await readJsonLines(logPath, limit);
  const timeline = dedupeTimeline(
    events.filter(isTimelineEvent).map((event) => ({
      at: safeText(event.at),
      type: safeText(event.type),
      label: eventLabel(event.type),
      detail: eventDetail(event).slice(0, 220),
      promptGenerator: safeText(event.promptGenerator),
    })),
  );
  const cycles = latestRunCycle(timeline);
  const recoveredCycle = recoverTimeoutsWithMirrorReplies(cycles.current);
  cycles.current = recoveredCycle.timeline;
  const counters = buildCounters(cycles.current);
  const historyCounters = buildCounters(cycles.previous);
  const waiting = buildWaitingObservation(cycles.current, now);
  const advice = deriveStatusAndAdvice(counters, cycles.current, { waiting });
  const diagnosis = deriveDiagnosis(counters, cycles.current, {
    hasRecovery: recoveredCycle.hasRecovery,
  });

  return {
    title: "codex-loop 真实运行观测报告",
    status: advice.status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    generatedAt: new Date().toISOString(),
    loop: {
      runId: resolvedRunId,
      logPath: path.relative(root, logPath).replace(/\\/g, "/"),
    },
    counters,
    history: {
      failureCount: historyCounters.failures,
      totalTimelineEvents: timeline.length,
      previousTimelineEvents: cycles.previous.length,
    },
    waiting,
    diagnosis,
    summary: advice.summary,
    nextAction: advice.nextAction,
    timeline: cycles.current,
  };
}

async function resolveObservedRunId(root = process.cwd()) {
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

function dedupeTimeline(timeline) {
  const seen = new Set();
  return timeline.filter((item) => {
    const detailKey = item.detail.replace(/\s+/gu, " ").trim();
    const minuteKey = safeText(item.at).slice(0, 16);
    const key = [item.type, detailKey, minuteKey].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function writeReport(root, report) {
  const reportRoot = path.join(root, ...reportRootLabel.split("/"));
  await fs.mkdir(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `${nowForFile()}-production-observation.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

async function main() {
  const report = await buildProductionObservation();
  const reportPath = await writeReport(process.cwd(), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`报告路径: ${reportPath}\n`);
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
