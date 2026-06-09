import fs from "node:fs/promises";
import path from "node:path";

import { appendJsonLine, ensureDir, writeJson } from "../../../scripts/lib/fs-helpers.mjs";
import { loadLoopConfig, saveLoopConfig } from "../../../scripts/lib/config-loader.mjs";
import { initializeRun } from "../../../scripts/lib/init-run.mjs";
import { applyHeartbeat, decideLoopMode } from "../../../scripts/lib/state.mjs";
import { readResolvedLoopProfile } from "./adapter-store.mjs";
import { deleteAutomationForThread } from "./automation-store.mjs";
import { dispatchThreadMessage as defaultDispatchThreadMessage } from "./codex-dispatcher.mjs";
import { resolveCodexThread as defaultResolveCodexThread } from "./codex-link/thread-resolver.mjs";
import { readCodexConversationMirror } from "./codex-session-reader.mjs";
import { readLauncherStatus } from "./launcher-status.mjs";
import { resolveReviewHumanDeferral } from "./npc/confirmation-policy.mjs";
import { planLoopWithFallback } from "./ollama-loop-planner.mjs";
import {
  generateCodexSummaryWithOllama,
  generateMilestoneReviewWithOllama,
  generatePromptWithOllama,
} from "./ollama-prompt-generator.mjs";
import { resolveProjectLayout } from "./paths.mjs";
import { classifyContinuationFailure } from "./runtime-governance/failure-classifier.mjs";
import {
  defaultRunSupervisorVerificationCommand,
  injectVerificationIntoInstruction,
  runSupervisorIndependentVerification,
} from "./verification/supervisor-verification.mjs";

function nowIso() {
  return new Date().toISOString();
}

const DEFAULT_LOOP_ID = "default-run";
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const CONTINUATION_STALLED_MS = 5 * 60 * 1000;
const FINALIZE_WAIT_MS = 90 * 1000;
const TRANSCRIPT_STALE_MS = 15 * 60 * 1000;
const AUTO_FAIL_STALLED_CONTINUATION = false;
const activeContinuationKeys = new Set();
const activeRecoveryKeys = new Set();
const activeSnapshotRefreshes = new Map();

async function readJson(filePath, fallbackValue = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeText(filePath, text) {
  await fs.writeFile(filePath, text, "utf8");
}

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

function stripMarkdownCode(text) {
  return safeText(text, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isThreadIdOnlySummary(text, threadId = "") {
  const normalized = stripMarkdownCode(text);
  if (!normalized) {
    return false;
  }

  const candidateId = safeText(threadId, "");
  const mentionsThreadId =
    /thread\s*id/i.test(normalized) ||
    /当前窗口/.test(normalized) ||
    /当前线程/.test(normalized);
  const containsIdentifier =
    (candidateId && normalized.includes(candidateId)) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(normalized);
  const shortStatus = normalized.length <= 120;

  return mentionsThreadId && containsIdentifier && shortStatus;
}

function sanitizeCodexSummary(candidate, { previous = "", threadId = "" } = {}) {
  const nextSummary = safeText(candidate, "");
  if (!nextSummary) {
    return safeText(previous, "");
  }
  if (isThreadIdOnlySummary(nextSummary, threadId)) {
    return safeText(previous, "");
  }
  return nextSummary;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = safeText(value, "");
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeUserFacingTaskText(value) {
  return safeText(value, "")
    .replace(/当前\s*loop\s*/g, "当前任务")
    .replace(/创建\s*loop\s*/g, "创建任务")
    .replace(/新建\s*loop\s*/g, "新建任务")
    .replace(/loop\s*规则/g, "任务规则")
    .replace(/loop\s*名/g, "任务名")
    .replace(/loop\s*目标/g, "任务目标");
}

function summarizeForFollowup(value, maxLength = 220) {
  const normalized = normalizeUserFacingTaskText(stripMarkdownCode(value));
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function buildPromptPreview(prompt, maxLength = 180) {
  return summarizeForFollowup(prompt, maxLength);
}

function normalizeTextList(value, maxItems = 5, maxLength = 120) {
  const items = Array.isArray(value)
    ? value
    : safeText(value, "").split(/\r?\n|[,，]/u);
  return items
    .map((item) => summarizeForFollowup(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeSupervisorSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    roleTraits: summarizeForFollowup(source.roleTraits, 600),
    testingRules: summarizeForFollowup(source.testingRules, 600),
    acceptanceCriteria: summarizeForFollowup(source.acceptanceCriteria, 600),
  };
}

function hasSupervisorSettings(value = {}) {
  const supervisor = normalizeSupervisorSettings(value);
  return Boolean(
    supervisor.roleTraits ||
      supervisor.testingRules ||
      supervisor.acceptanceCriteria,
  );
}

function mergeLoopSupervisorField(globalValue, loopValue) {
  const globalText = safeText(globalValue, "");
  const loopText = safeText(loopValue, "");
  if (globalText && loopText) {
    return `${globalText}\n当前任务：${loopText}`;
  }
  if (loopText) {
    return `当前任务：${loopText}`;
  }
  return globalText;
}

function applyLoopSupervisorToProfile(profile = {}, loopSupervisor = {}) {
  const supervisor = normalizeSupervisorSettings(loopSupervisor);
  if (!hasSupervisorSettings(supervisor)) {
    return profile;
  }

  const resolved = profile.resolved || {};
  const conversation = resolved.conversation || {};
  const globalSupervisor = conversation.supervisor || {};
  return {
    ...profile,
    resolved: {
      ...resolved,
      conversation: {
        ...conversation,
        supervisor: {
          ...globalSupervisor,
          roleTraits: mergeLoopSupervisorField(
            globalSupervisor.roleTraits,
            supervisor.roleTraits,
          ),
          testingRules: mergeLoopSupervisorField(
            globalSupervisor.testingRules,
            supervisor.testingRules,
          ),
          acceptanceCriteria: mergeLoopSupervisorField(
            globalSupervisor.acceptanceCriteria,
            supervisor.acceptanceCriteria,
          ),
        },
      },
    },
  };
}

function normalizePositiveNumber(value, fallback, { min = 1 } = {}) {
  const nextValue = Number(value);
  if (!Number.isFinite(nextValue) || nextValue < min) {
    return fallback;
  }
  return Math.floor(nextValue);
}

function normalizeBudgetsPatch(payload = {}, currentBudgets = {}) {
  return {
    maxMinutes: normalizePositiveNumber(payload.maxMinutes, currentBudgets.maxMinutes, { min: 1 }),
    maxTokens: normalizePositiveNumber(payload.maxTokens, currentBudgets.maxTokens, { min: 1 }),
    finalizeLeadMinutes: normalizePositiveNumber(
      payload.finalizeLeadMinutes,
      currentBudgets.finalizeLeadMinutes,
      { min: 0 },
    ),
    finalizeLeadTokens: normalizePositiveNumber(
      payload.finalizeLeadTokens,
      currentBudgets.finalizeLeadTokens,
      { min: 0 },
    ),
  };
}

async function readJsonLines(filePath, limit = 20) {
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
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readableRuntimeEventTitle(type, event = {}) {
  if (type === "codex_followup_failed") {
    return (
      safeText(event.failureLabel, "") ||
      classifyContinuationFailure({
        message: event.message,
        latestSummary: event.summary,
        promptGenerationError: event.promptGenerationError,
        promptGenerator: event.promptGenerator,
      }).label
    );
  }

  const titles = {
    artifacts_verified: "运行文件已就绪",
    thread_binding_updated: "已绑定线程",
    run_started_from_console: "已开始循环",
    heartbeat: "已同步进展",
    pending_guidance_saved: "已记录下一轮补充",
    pending_guidance_cleared: "已清空补充引导",
    monitor_guidance_send_requested: "监控模式发送引导",
    codex_followup_dispatching: "正在发送下一轮指令",
    codex_followup_dispatched: "正在等待 Codex 回复",
    codex_followup_sent_waiting: "指令已送达，等待 Codex",
    codex_followup_completed: "Codex 已完成一轮",
    supervisor_review_started: "监督复盘中",
    supervisor_review_completed: "已完成监督复盘",
    supervisor_review_skipped: "已跳过监督复盘",
    supervisor_verification_completed: "已完成独立验收",
    loop_supervisor_updated: "已更新当前任务 NPC",
    codex_thread_mirror_synced: "已同步 Codex 记录",
    codex_conversation_mirror_synced: "已同步 Codex 对话",
    codex_followup_failed: "续跑失败",
    codex_followup_stalled: "等待超时，已停止自动续发",
    graceful_stop_requested: "已请求停止",
    graceful_stop_completed: "已停止循环",
    graceful_stop_wait_elapsed: "停止等待已结束",
    runtime_error: "运行异常",
    summary_exported: "已导出摘要",
    loop_renamed: "已重命名任务",
  };
  return titles[type] || "运行记录";
}

function readableRuntimeEventDetail(event = {}) {
  const type = safeText(event.type, "");
  if (type === "codex_followup_completed") {
    return firstNonEmpty(
      event.latestAssistantPreview,
      event.summary,
      "已收到 Codex 新回复，等待下一次指令。",
    );
  }
  if (type === "graceful_stop_completed") {
    return firstNonEmpty(
      event.summary,
      event.note,
      /graceful stop completed/i.test(safeText(event.reason, ""))
        ? "循环已停止。"
        : event.reason,
      "循环已停止。",
    );
  }
  if (type === "codex_followup_failed") {
    const failure = classifyContinuationFailure({
      message: event.message,
      latestSummary: event.summary,
      promptGenerationError: event.promptGenerationError,
      promptGenerator: event.promptGenerator,
    });
    return firstNonEmpty(
      event.failureAction,
      event.failureLabel,
      failure.nextAction,
      failure.userMessage,
      "查看最近记录并按提示修复后再重新开始循环。",
    );
  }
  return firstNonEmpty(
    event.preview,
    event.progressSummary,
    event.summary,
    event.note,
    event.reason,
    event.message,
    event.error,
    event.promptPreview,
    event.nextInstructionPreview,
    event.latestAssistantPreview,
    event.threadTitle,
    event.loopName,
    event.threadId,
  );
}

function normalizeRuntimeEventDetail(text) {
  return summarizeForFollowup(text, 180).replace(/\s+/g, " ").trim();
}

function readableRuntimeEventDedupeKey(event = {}) {
  const type = safeText(event.type, "");
  if (type === "codex_conversation_mirror_synced") {
    return [
      type,
      safeText(event.threadId, ""),
      safeText(event.latestAssistantAt, ""),
      normalizeRuntimeEventDetail(readableRuntimeEventDetail(event)),
    ].join("|");
  }

  if (type === "codex_thread_mirror_synced") {
    return [
      type,
      safeText(event.threadId, ""),
      normalizeRuntimeEventDetail(readableRuntimeEventDetail(event)),
    ].join("|");
  }

  if (type === "codex_followup_completed") {
    return [
      type,
      safeText(event.threadId, ""),
      normalizeRuntimeEventDetail(readableRuntimeEventDetail(event)),
    ].join("|");
  }

  if (
    type === "codex_followup_dispatching" ||
    type === "codex_followup_sent_waiting" ||
    type === "codex_followup_dispatched"
  ) {
    return [
      type,
      safeText(event.threadId, ""),
      normalizeRuntimeEventDetail(readableRuntimeEventDetail(event)),
    ].join("|");
  }

  if (type === "graceful_stop_completed") {
    return [
      type,
      normalizeRuntimeEventDetail(readableRuntimeEventDetail(event)),
    ].join("|");
  }

  return "";
}

function isLowSignalRuntimeEvent(event = {}) {
  const type = safeText(event.type, "");
  if (type !== "codex_thread_mirror_synced") {
    return false;
  }

  return !firstNonEmpty(
    event.preview,
    event.progressSummary,
    event.summary,
    event.note,
    event.reason,
    event.message,
    event.error,
    event.latestAssistantPreview,
  );
}

async function readReadableRuntimeEvents(logPath, limit = 12) {
  const events = await readJsonLines(logPath, Math.max(limit * 20, 120));
  const seen = new Set();
  const latestOnlySeen = new Set();
  const seenVisibleDetails = new Set();
  return events
    .reverse()
    .filter((event) => !isLowSignalRuntimeEvent(event))
    .filter((event) => {
      const type = safeText(event.type, "");
      if (type === "codex_conversation_mirror_synced") {
        if (latestOnlySeen.has(type)) {
          return false;
        }
        latestOnlySeen.add(type);
      }
      const key = readableRuntimeEventDedupeKey(event);
      if (!key) {
        return true;
      }
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((event) => {
      const type = safeText(event.type, "");
      return {
        at: safeText(event.at, ""),
        type,
        title: readableRuntimeEventTitle(type, event),
        detail: summarizeForFollowup(readableRuntimeEventDetail(event), 180),
        tone: /failed|error|stalled/i.test(type) ? "danger" : "normal",
      };
    })
    .filter((event) => event.at || event.type)
    .filter((event) => {
      const detailKey = normalizeRuntimeEventDetail(event.detail);
      if (!detailKey) {
        return true;
      }
      if (seenVisibleDetails.has(detailKey)) {
        return false;
      }
      seenVisibleDetails.add(detailKey);
      return true;
    })
    .slice(0, limit);
}

function markErrorAlreadyRecorded(error) {
  if (error && typeof error === "object") {
    error.codexLoopRecorded = true;
  }
  return error;
}

function pendingGuidanceAfterDispatch(thread = {}, dispatchedGuidance = "") {
  const currentGuidance = safeText(thread.pendingUserGuidance, "");
  const consumedGuidance = safeText(dispatchedGuidance, "");
  if (!currentGuidance || !consumedGuidance) {
    return {
      pendingUserGuidance: currentGuidance,
      pendingUserGuidanceAt: currentGuidance
        ? safeText(thread.pendingUserGuidanceAt, "")
        : "",
    };
  }

  let nextGuidance = currentGuidance;
  if (currentGuidance === consumedGuidance) {
    nextGuidance = "";
  } else if (currentGuidance.startsWith(consumedGuidance + "\n")) {
    nextGuidance = currentGuidance.slice(consumedGuidance.length).replace(/^\n+/u, "");
  }

  return {
    pendingUserGuidance: nextGuidance,
    pendingUserGuidanceAt: nextGuidance ? safeText(thread.pendingUserGuidanceAt, "") : "",
  };
}

async function markDispatchWaiting(
  snapshot,
  {
    prompt,
    dispatchAt,
    promptGenerator = "template",
    promptGenerationError = "",
    promptGenerationWarning = "",
  },
) {
  const monitorOnlyDispatch = Boolean(snapshot.state.monitorOnly);
  const dispatchingSummary = monitorOnlyDispatch
    ? "监控模式正在发送这条引导；只发送这一条，不会开启自动循环。"
    : "正在通过 Codex 桌面端原生链路发送指令，等待确认送达。";
  const dispatchingThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    snapshot.state,
    {
      continuationEnabled: true,
      continuationStatus: "dispatching",
      lastDispatchAt: dispatchAt,
      lastDispatchPrompt: prompt,
      lastContinuationError: promptGenerationError,
      promptGenerationWarning,
      latestSummary: dispatchingSummary,
      latestEventType: "codex_followup_dispatching",
      lastUpdatedAt: dispatchAt,
    },
  );
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...dispatchingThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "codex_followup_dispatching",
    at: dispatchAt,
    threadId: snapshot.thread.threadId,
    threadTitle: snapshot.thread.threadTitle,
    workspaceRoot: snapshot.paths.workspaceRoot,
    promptGenerator,
    promptGenerationError,
    promptGenerationWarning,
    summary: dispatchingSummary,
    promptPreview: buildPromptPreview(prompt),
  });
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at: dispatchAt,
    activeTask: snapshot.state.activeTask,
    note: "codex-loop 正在发送指令",
    summary:
      dispatchingSummary +
      " 发送目标：" +
      (snapshot.thread.threadTitle || snapshot.thread.threadId) +
      "。指令预览：" +
      buildPromptPreview(prompt),
    mode: snapshot.state.mode,
  });
  return dispatchingThread;
}

async function markDispatchSentWithoutCompletion(
  startDir,
  {
    consumedPendingGuidance = "",
    promptGenerator = "template",
    promptGenerationError = "",
    promptGenerationWarning = "",
  } = {},
) {
  const sentAt = nowIso();
  const refreshed = await ensureLoopArtifacts(startDir);
  const nextPendingGuidance = pendingGuidanceAfterDispatch(
    refreshed.thread,
    consumedPendingGuidance,
  );
  const monitorOnlyDispatch = Boolean(refreshed.state.monitorOnly);
  const sentSummary = monitorOnlyDispatch
    ? "监控模式引导已送达绑定线程，正在等待 Codex 完成这一轮；只发送这一条，不会开启自动循环。"
    : "消息已送达绑定线程，正在等待 Codex 完成这一轮回复。";
  const sentThread = await persistThreadMirror(
    refreshed.paths.threadPath,
    refreshed.thread,
    refreshed.state,
    {
      continuationEnabled: true,
      continuationStatus: "dispatching",
      ...nextPendingGuidance,
      lastContinuationError: promptGenerationError,
      promptGenerationWarning,
      latestSummary: sentSummary,
      latestEventType: "codex_followup_sent_waiting",
      lastUpdatedAt: sentAt,
    },
  );
  await updateRegistryLoopBinding(
    refreshed.paths.codexLoopRoot,
    refreshed.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...sentThread } }),
  );
  await appendJsonLine(refreshed.paths.logPath, {
    type: "codex_followup_sent_waiting",
    at: sentAt,
    threadId: refreshed.thread.threadId,
    threadTitle: refreshed.thread.threadTitle,
    promptGenerator,
    promptGenerationError,
    promptGenerationWarning,
    summary: sentSummary,
  });
  await appendTranscriptEntry(refreshed.paths.transcriptPath, {
    at: sentAt,
    activeTask: refreshed.state.activeTask,
    note: "等待 Codex 回复",
    summary: monitorOnlyDispatch
      ? "已确认目标线程收到这条监控模式引导；只发送这一条，不会开启自动循环。"
      : "已确认目标线程收到本次指令，但这一轮还没有可同步的回复内容。",
    mode: refreshed.state.mode,
  });
  return readLoopSnapshot(startDir);
}

async function markSupervisorReviewStarted(snapshot, { at = nowIso() } = {}) {
  const reviewingThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    snapshot.state,
    {
      continuationStatus: "reviewing",
      latestSummary: "Codex 已完成当前轮，本地模型 NPC 正在复盘回复并决定下一步。",
      latestEventType: "supervisor_review_started",
      lastContinuationError: "",
      lastUpdatedAt: at,
    },
  );
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...reviewingThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "supervisor_review_started",
    at,
    threadId: reviewingThread.threadId,
    threadTitle: reviewingThread.threadTitle,
    latestCodexSummary: snapshot.thread.latestCodexSummary,
  });
  return reviewingThread;
}

function pickPreferredThreadMirror(boundThread, savedThread) {
  if (!boundThread) return savedThread || null;
  if (!savedThread) return boundThread;
  if (savedThread.continuationStatus === "dispatching") {
    return savedThread;
  }

  const boundUpdatedAt = Date.parse(boundThread.lastUpdatedAt || "");
  const savedUpdatedAt = Date.parse(savedThread.lastUpdatedAt || "");

  if (Number.isFinite(boundUpdatedAt) && Number.isFinite(savedUpdatedAt)) {
    return boundUpdatedAt >= savedUpdatedAt ? boundThread : savedThread;
  }

  if (Number.isFinite(boundUpdatedAt)) {
    return boundThread;
  }

  if (Number.isFinite(savedUpdatedAt)) {
    return savedThread;
  }

  return {
    ...boundThread,
    ...savedThread,
  };
}

function modeLabel(mode) {
  if (mode === "running") return "运行中";
  if (mode === "finalize_after_current") return "收尾中";
  if (mode === "stopped") return "已停止";
  return "未知";
}

function createThreadDefaults(config) {
  return {
    workspaceName: config.projectName || "未命名项目",
    threadTitle: config.threadTitle || config.loopName || "未绑定线程",
    workspaceRoot: config.workspaceRoot || "",
    windowTitle: config.threadTitle || config.loopName || "",
    threadId: "",
    singleThreadMode: true,
    note: "",
    heartbeatAutomation: "",
    currentRunId: config.currentRunId || DEFAULT_LOOP_ID,
    latestMode: "running",
    latestModeLabel: modeLabel("running"),
    latestActiveTask: "",
    latestSummary: "",
    latestHeartbeatAt: "",
    latestEventType: "run_initialized",
    latestVerification: "",
    lastUserInstructionSummary: "",
    lastAssistantActionSummary: "",
    latestCodexSummary: "",
    continuationStatus: "idle",
    continuationEnabled: false,
    continuationCycleCount: 0,
    lastDispatchAt: "",
    lastCompletionAt: "",
    lastDispatchPrompt: "",
    lastContinuationError: "",
    lastSupervisorReview: "",
    lastSupervisorReviewAt: "",
    lastSupervisorInstruction: "",
    lastSupervisorSource: "",
    supervisorNeedsIndependentVerification: false,
    lastSupervisorVerificationCommands: [],
    lastSupervisorAcceptanceFocus: [],
    lastSupervisorVerificationStatus: "",
    lastSupervisorVerificationSummary: "",
    lastSupervisorVerificationResults: [],
    lastSupervisorVerificationAt: "",
    supervisorReviewWarning: "",
    lastUpdatedAt: nowIso(),
  };
}

function createLoopThreadBinding(config, overrides = {}) {
  return {
    ...createThreadDefaults(config),
    ...overrides,
    threadTitle:
      overrides.threadTitle || config.threadTitle || config.loopName || "未绑定线程",
    currentRunId: overrides.currentRunId || config.currentRunId || DEFAULT_LOOP_ID,
    continuationEnabled: Boolean(overrides.threadId),
    lastUpdatedAt: overrides.lastUpdatedAt || nowIso(),
  };
}

function defaultTranscript(thread) {
  return [
    "# 本地对话记录",
    "",
    "- 工作区：" + thread.workspaceName,
    "- 线程标题：" + thread.threadTitle,
    "- 线程 ID：" + (thread.threadId || "未绑定"),
    "",
    "本文档是 codex-loop 的本地镜像记录，不替代 Codex 桌面端线程历史。",
  ].join("\n");
}

function createEmptyErrorState() {
  return { message: "", area: "", updatedAt: "" };
}

function sanitizeLoopId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildSafeLoopId(...values) {
  for (const value of values) {
    const sanitized = sanitizeLoopId(value);
    if (sanitized) {
      return sanitized;
    }
  }
  return "loop-" + Date.now();
}

function buildLoopRegistryPath(codexLoopRoot) {
  return path.join(codexLoopRoot, "settings", "loops.json");
}

function hashText(value) {
  let hash = 0;
  for (const character of safeText(value, "")) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function buildSafeProjectId(projectName) {
  const name = safeText(projectName, "project");
  return buildSafeLoopId(name, "project-" + hashText(name), "project");
}

function buildProjectEntry({
  id,
  name,
  projectName,
  workspaceRoot = "",
  projectAdapter = "generic",
  createdAt = nowIso(),
  updatedAt = nowIso(),
} = {}) {
  const resolvedName = safeText(name || projectName, "未分类项目");
  return {
    id: safeText(id, buildSafeProjectId(resolvedName)),
    name: resolvedName,
    workspaceRoot: safeText(workspaceRoot, ""),
    projectAdapter: safeText(projectAdapter, "generic"),
    createdAt,
    updatedAt,
  };
}

function buildLoopEntry({
  id,
  name,
  threadTitle,
  branch,
  projectName,
  projectAdapter,
  workspaceRoot,
  budgets,
  startContextPaths = [],
  docs = null,
  git = null,
  creation = null,
  supervisor = null,
  threadBinding,
}) {
  const normalizedSupervisor = normalizeSupervisorSettings(supervisor || {});
  return {
    id,
    runId: id,
    name,
    threadTitle,
    branch,
    projectName,
    projectAdapter,
    workspaceRoot: workspaceRoot || "",
    budgets,
    startContextPaths,
    docs,
    git,
    creation,
    supervisor: hasSupervisorSettings(normalizedSupervisor)
      ? normalizedSupervisor
      : null,
    threadBinding: threadBinding || createLoopThreadBinding({
      projectName,
      threadTitle,
      loopName: name,
      currentRunId: id,
    }),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeLoopContextPaths(startContextPaths = [], docs = null) {
  return [
    ...(Array.isArray(startContextPaths) ? startContextPaths : []),
    ...(Array.isArray(docs?.ruleDocs) ? docs.ruleDocs : []),
    ...(Array.isArray(docs?.devDocs) ? docs.devDocs : []),
  ]
    .map((item) => safeText(item, ""))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function buildDefaultRegistry(config, workspaceRoot) {
  const loopId = config.currentRunId || DEFAULT_LOOP_ID;
  const projectName = config.projectName || "project";
  return {
    currentLoopId: loopId,
    projects: [
      buildProjectEntry({
        name: projectName,
        workspaceRoot: config.workspaceRoot || workspaceRoot,
        projectAdapter: config.projectAdapter || config.projectName || "generic",
      }),
    ],
    loops: [
      buildLoopEntry({
        id: loopId,
        name: config.loopName || config.projectName || "default loop",
        threadTitle: config.threadTitle || config.loopName || "未绑定线程",
        branch: config.branch || "dev",
        projectName,
        projectAdapter: config.projectAdapter || config.projectName || "generic",
        workspaceRoot: config.workspaceRoot || workspaceRoot,
        budgets: { ...config.budgets },
        startContextPaths: normalizeLoopContextPaths(
          config.startContextPaths || [],
          config.docs || null,
        ),
        docs: config.docs || null,
        git: config.git || null,
        supervisor: normalizeSupervisorSettings(config.supervisor || {}),
        threadBinding: createLoopThreadBinding(config),
      }),
    ],
    generatedAt: nowIso(),
    version: 1,
  };
}

function isPlaceholderDefaultLoop(loop) {
  if (!loop || loop.id !== DEFAULT_LOOP_ID) {
    return false;
  }
  const projectName = safeText(loop.projectName, "");
  const name = safeText(loop.name, "");
  const title = safeText(loop.threadTitle, "");
  return (
    projectName === "project" ||
    name === "default loop" ||
    name.includes("默认循环") ||
    title.includes("Codex Loop ???")
  );
}

function normalizeRegistryProjects(registry) {
  const byName = new Map();
  const addProject = (source = {}) => {
    const project = buildProjectEntry(source);
    const key = project.name.toLocaleLowerCase();
    const current = byName.get(key);
    if (!current) {
      byName.set(key, project);
      return;
    }

    byName.set(key, {
      ...current,
      workspaceRoot: current.workspaceRoot || project.workspaceRoot,
      projectAdapter: current.projectAdapter || project.projectAdapter,
      updatedAt: current.updatedAt || project.updatedAt,
    });
  };

  for (const project of Array.isArray(registry.projects) ? registry.projects : []) {
    addProject(project);
  }

  for (const loop of Array.isArray(registry.loops) ? registry.loops : []) {
    addProject({
      name: loop.projectName || "未分类项目",
      workspaceRoot: loop.workspaceRoot || "",
      projectAdapter: loop.projectAdapter || "generic",
      createdAt: loop.createdAt || nowIso(),
      updatedAt: loop.updatedAt || nowIso(),
    });
  }

  return Array.from(byName.values());
}

function pickRegistryCurrentLoop(registry) {
  const current =
    registry.loops.find((loop) => loop.id === registry.currentLoopId) ||
    registry.loops[0] ||
    null;
  if (!isPlaceholderDefaultLoop(current)) {
    return current;
  }
  return registry.loops.find((loop) => !isPlaceholderDefaultLoop(loop)) || current;
}

function normalizeLoopRegistry(registry) {
  const selected = pickRegistryCurrentLoop(registry);
  const normalizedProjects = normalizeRegistryProjects(registry);
  const projectsChanged =
    JSON.stringify(Array.isArray(registry.projects) ? registry.projects : []) !==
    JSON.stringify(normalizedProjects);

  if (!projectsChanged && (!selected || selected.id === registry.currentLoopId)) {
    return registry;
  }
  return {
    ...registry,
    currentLoopId: selected?.id || registry.currentLoopId,
    projects: normalizedProjects,
    loops:
      selected && selected.id !== registry.currentLoopId
        ? registry.loops.map((loop) =>
            loop.id === selected.id ? { ...loop, updatedAt: nowIso() } : loop,
          )
        : registry.loops,
  };
}

function applyLoopToConfig(config, loop) {
  return {
    ...config,
    projectName: loop.projectName || config.projectName,
    projectAdapter: loop.projectAdapter || config.projectAdapter || config.projectName,
    workspaceRoot: loop.workspaceRoot || config.workspaceRoot,
    branch: loop.branch || config.branch,
    currentRunId: loop.runId || loop.id,
    loopName: loop.name,
    threadTitle: loop.threadTitle || loop.name,
    startContextPaths: normalizeLoopContextPaths(
      loop.startContextPaths || [],
      loop.docs || config.docs || null,
    ),
    docs: loop.docs ?? config.docs ?? null,
    git: loop.git ?? config.git ?? null,
    budgets: {
      ...config.budgets,
      ...loop.budgets,
    },
  };
}

function applySelectedLoopToLayout(layout, loop) {
  const loopWorkspaceRoot = safeText(loop?.workspaceRoot, "");
  if (!loopWorkspaceRoot) {
    return layout;
  }

  return {
    ...layout,
    workspaceRoot: path.resolve(loopWorkspaceRoot),
  };
}

async function persistLoopRegistry(codexLoopRoot, registry) {
  await ensureDir(path.join(codexLoopRoot, "settings"));
  const registryPath = buildLoopRegistryPath(codexLoopRoot);
  await writeJson(registryPath, registry);
  return registryPath;
}

async function loadLoopRegistry(layout, config) {
  const registryPath = buildLoopRegistryPath(layout.codexLoopRoot);
  const existingRegistry = await readJson(registryPath);
  if (existingRegistry?.loops?.length) {
    const normalizedRegistry = normalizeLoopRegistry(existingRegistry);
    if (normalizedRegistry !== existingRegistry) {
      await writeJson(registryPath, normalizedRegistry);
      const selectedLoop = pickRegistryCurrentLoop(normalizedRegistry);
      if (selectedLoop) {
        await saveLoopConfig(layout.codexLoopRoot, applyLoopToConfig(config, selectedLoop));
      }
    }
    return { registry: normalizedRegistry, registryPath };
  }

  const registry = buildDefaultRegistry(config, layout.workspaceRoot);
  await persistLoopRegistry(layout.codexLoopRoot, registry);

  const defaultLoop = registry.loops[0];
  await saveLoopConfig(layout.codexLoopRoot, applyLoopToConfig(config, defaultLoop));

  return { registry, registryPath };
}

function summarizeLoopRegistry(registry) {
  const visibleLoops = registry.loops.filter((loop) => !isPlaceholderDefaultLoop(loop));
  const loops = visibleLoops.length ? visibleLoops : registry.loops;
  const projectCounts = new Map();
  for (const loop of loops) {
    const projectName = loop.projectName || "未分类项目";
    projectCounts.set(projectName, (projectCounts.get(projectName) || 0) + 1);
  }

  const projects = normalizeRegistryProjects(registry).map((project) => {
    const taskCount = projectCounts.get(project.name) || 0;
    return {
      ...project,
      taskCount,
      isEmpty: taskCount === 0,
    };
  });

  return {
    currentLoopId: registry.currentLoopId,
    projects,
    loops: loops.map((loop) => ({
      ...loop,
      threadBinding: undefined,
      boundThreadId: loop.threadBinding?.threadId || "",
      boundThreadTitle: loop.threadBinding?.threadTitle || loop.threadTitle || "",
      isCurrent: loop.id === registry.currentLoopId,
    })),
  };
}

function buildAssistantStatePath(codexLoopRoot) {
  return path.join(codexLoopRoot, "settings", "loop-creation-assistant.json");
}

function createLoopAssistantDraft() {
  return {
    workspaceRoot: "",
    projectName: "",
    loopName: "",
    branch: "dev",
    intent: "",
    plan: {
      source: "",
      objectiveSummary: "",
      suggestedProjectName: "",
      suggestedLoopName: "",
      suggestedBranch: "",
      checklist: [],
      riskNotes: [],
      nextQuestion: "",
      error: "",
      pendingField: "",
      reviewNotes: [],
    },
    git: {
      hasGit: false,
      branch: "",
      recommendedBranch: "dev",
      pushRequired: true,
      status: "missing",
    },
    docs: {
      ruleDocs: [],
      devDocs: [],
      notes: [],
    },
    projectProfile: {
      projectType: "generic",
      commands: [],
      strictness: "medium",
    },
  };
}

function appendAssistantMessage(history = [], role, text, meta = "") {
  const content = safeText(text, "");
  if (!content) {
    return history;
  }
  return [
    ...history,
    {
      role,
      text: content,
      meta: safeText(meta, ""),
      at: nowIso(),
    },
  ].slice(-20);
}

function normalizeAssistantFieldAnswer(answer) {
  const text = safeText(answer, "");
  if (!text) {
    return "";
  }
  return text
    .replace(/^(改成|改为)\s*/u, "")
    .trim();
}

function buildLoopSnapshot(loop) {
  if (!loop) {
    return {
      id: "",
      name: "",
      projectName: "",
      branch: "",
      creation: null,
      supervisor: normalizeSupervisorSettings(),
    };
  }

  return {
    id: loop.id,
    runId: loop.runId || loop.id,
    name: loop.name || "",
    projectName: loop.projectName || "",
    branch: loop.branch || "",
    workspaceRoot: loop.workspaceRoot || "",
    creation: normalizeLoopCreation(loop.creation),
    supervisor: normalizeSupervisorSettings(loop.supervisor || {}),
  };
}

function normalizeCreationPlanning(plan = {}) {
  const source = plan && typeof plan === "object" ? plan : {};
  const riskNotes = normalizeTextList(source.riskNotes || [], 8, 160);
  return {
    source: safeText(source.source, ""),
    objectiveSummary: safeText(source.objectiveSummary, ""),
    checklist: normalizeTextList(source.checklist || [], 12, 160),
    riskNotes,
    riskSummary: riskNotes.join("；"),
    nextQuestion: safeText(source.nextQuestion, ""),
    confirmedAt: safeText(source.confirmedAt, ""),
  };
}

function normalizeCreationEvidence({ git = {}, docs = {}, projectProfile = {} } = {}) {
  const ruleDocs = Array.isArray(docs.ruleDocs) ? docs.ruleDocs : [];
  const devDocs = Array.isArray(docs.devDocs) ? docs.devDocs : [];
  const detectedCommands = normalizeTextList(projectProfile.commands || [], 12, 180);
  const gitStatus = safeText(git.gitStatus || git.status, git.hasGit ? "ready" : "missing");
  return {
    gitStatus,
    hasGit: Boolean(git.hasGit),
    branch: safeText(git.branch || git.recommendedBranch, ""),
    docsCount: ruleDocs.length + devDocs.length,
    ruleDocs,
    devDocs,
    detectedCommands,
    projectType: safeText(projectProfile.projectType, "generic"),
    strictness: safeText(projectProfile.strictness, "medium"),
    summary: `git ${gitStatus} · 文档 ${ruleDocs.length + devDocs.length} 个 · 命令 ${detectedCommands.length} 个`,
  };
}

function normalizeLoopCreation(creation = null) {
  if (!creation || typeof creation !== "object") {
    return null;
  }
  const planning = normalizeCreationPlanning(creation.planning || {});
  const sourceEvidence = creation.evidence || {};
  const evidence = normalizeCreationEvidence({
    git: sourceEvidence,
    docs: sourceEvidence,
    projectProfile: {
      ...(creation.projectProfile || {}),
      commands: sourceEvidence.detectedCommands || creation.projectProfile?.commands || [],
      projectType: sourceEvidence.projectType || creation.projectProfile?.projectType,
      strictness: sourceEvidence.strictness || creation.projectProfile?.strictness,
    },
  });
  return {
    source: safeText(creation.source, ""),
    createdAt: safeText(creation.createdAt, ""),
    planning,
    evidence,
    projectProfile: creation.projectProfile || null,
    safety: creation.safety || null,
  };
}

function buildLoopCreationMetadata({ draft, docs, confirmedAt = nowIso() }) {
  const planning = normalizeCreationPlanning({
    ...(draft.plan || {}),
    confirmedAt,
  });
  const evidence = normalizeCreationEvidence({
    git: draft.git || {},
    docs,
    projectProfile: draft.projectProfile || {},
  });
  return {
    source: "assistant",
    createdAt: confirmedAt,
    planning,
    evidence,
    projectProfile: draft.projectProfile || null,
    safety: {
      requireGitPushReminder: true,
      pauseOnPermissionIssue: true,
      requireBranchConfirmation: true,
    },
  };
}

function applyPlanReviewAnswer(draft, answer) {
  const pendingField = safeText(draft.plan?.pendingField, "");
  const normalizedAnswer = normalizeAssistantFieldAnswer(answer);
  const useSuggested =
    !normalizedAnswer ||
    /^(好|可以|确认|使用建议|用建议|就这样|yes|ok)$/i.test(normalizedAnswer);

  if (pendingField === "project_name") {
    return {
      ...draft,
      projectName: useSuggested
        ? safeText(draft.plan?.suggestedProjectName, draft.projectName)
        : normalizedAnswer,
      plan: {
        ...draft.plan,
        pendingField: "loop_name",
      },
    };
  }

  if (pendingField === "loop_name") {
    return {
      ...draft,
      loopName: useSuggested
        ? safeText(draft.plan?.suggestedLoopName, draft.loopName)
        : normalizedAnswer,
      plan: {
        ...draft.plan,
        pendingField: "branch",
      },
    };
  }

  if (pendingField === "branch") {
    return {
      ...draft,
      branch: normalizeBranchName(
        useSuggested
          ? safeText(draft.plan?.suggestedBranch, draft.branch)
          : normalizedAnswer,
        draft.plan?.suggestedBranch || draft.git.branch || draft.branch || "dev",
      ),
      plan: {
        ...draft.plan,
        pendingField: "",
      },
    };
  }

  return draft;
}

function normalizeBranchName(value, fallback = "dev") {
  const text = safeText(value, fallback);
  return text || fallback;
}

function looksLikePlanningIntent(answer) {
  const text = safeText(answer, "").toLowerCase();
  if (!text) {
    return false;
  }

  return (
    text.length >= 10 &&
    (
      text.includes("loop") ||
      text.includes("自动") ||
      text.includes("规划") ||
      text.includes("循环") ||
      text.includes("计划") ||
      text.includes("任务")
    )
  );
}

function buildLoopAssistantQuestion(step, draft = createLoopAssistantDraft()) {
  if (step === "workspace_root") {
    return {
      id: "workspace_root",
      prompt: "先告诉我这个任务对应的项目路径，我会自动检查 git、文档和可用命令。",
      placeholder: "例如 E:\\2026\\codex-loop",
    };
  }

  if (step === "project_name") {
    const suggestedName = safeText(draft.plan?.suggestedProjectName, draft.projectName);
    return {
      id: "project_name",
      prompt: draft.plan?.nextQuestion || "这个项目在左侧列表里显示成什么名字？",
      placeholder: suggestedName || draft.projectName || "例如 codex-loop",
    };
  }

  if (step === "plan_review") {
    const pendingField = safeText(draft.plan?.pendingField, "project_name");
    if (pendingField === "project_name") {
      return {
        id: "plan_review",
        prompt:
          "我先整理了一版计划。目标是：" +
          safeText(draft.plan?.objectiveSummary, "继续推进当前任务") +
          "。建议项目名使用：" +
          safeText(draft.plan?.suggestedProjectName, draft.projectName || "当前项目") +
          "。确认可回复“使用建议”，也可以直接输入新名字。",
        placeholder: safeText(draft.plan?.suggestedProjectName, draft.projectName || "输入项目名"),
      };
    }

    if (pendingField === "loop_name") {
      return {
        id: "plan_review",
        prompt:
          "接下来确认任务名。我建议使用：" +
          safeText(draft.plan?.suggestedLoopName, draft.loopName || "当前任务") +
          "，这样左侧列表会更清楚。",
        placeholder: safeText(draft.plan?.suggestedLoopName, draft.loopName || "输入任务名"),
      };
    }

    if (pendingField === "branch") {
      return {
        id: "plan_review",
        prompt:
          "最后确认工作分支。当前建议是：" +
          safeText(draft.plan?.suggestedBranch, draft.branch || "dev") +
          "。如果你有自己的分支名，也可以直接改。",
        placeholder: safeText(draft.plan?.suggestedBranch, draft.branch || "dev"),
      };
    }
  }

  if (step === "loop_name") {
    const suggestedLoopName = safeText(draft.plan?.suggestedLoopName, draft.loopName);
    return {
      id: "loop_name",
      prompt: "这个新任务的名称是什么？建议写成当前要推进的子任务。",
      placeholder: suggestedLoopName || "例如 核心链路推进",
    };
  }

  if (step === "branch") {
    const suggestedBranch = safeText(
      draft.plan?.suggestedBranch,
      draft.git.branch || draft.git.recommendedBranch || draft.branch,
    );
    return {
      id: "branch",
      prompt: "这个任务主要工作的分支是什么？默认建议使用 dev。",
      placeholder: suggestedBranch || "dev",
    };
  }

  return {
    id: "docs_confirmed",
    prompt:
      "我已经找到 git 和文档线索。回复 confirm 直接创建，或补充你想强制纳入的规则文档路径。",
    placeholder: "输入 confirm，或粘贴额外文档路径",
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function detectGitMetadata(workspaceRoot) {
  const gitDir = path.join(workspaceRoot, ".git");
  const hasGit = await pathExists(gitDir);
  const headPath = path.join(gitDir, "HEAD");
  let branch = "";

  if (hasGit) {
    try {
      const head = await fs.readFile(headPath, "utf8");
      const match = head.match(/ref:\s+refs\/heads\/([^\r\n]+)/);
      if (match) {
        branch = match[1];
      }
    } catch {}
  }

  return {
    hasGit,
    branch,
    recommendedBranch: branch || "dev",
    pushRequired: true,
    status: hasGit ? "ready" : "missing",
  };
}

async function collectLoopDocs(workspaceRoot) {
  const docs = {
    ruleDocs: [],
    devDocs: [],
    notes: [],
  };

  async function walk(currentPath, depth = 0) {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath, depth + 1);
        continue;
      }

      if (!/\.(md|txt)$/i.test(entry.name)) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      if (
        lowerName.includes("rule") ||
        lowerName.includes("规范") ||
        lowerName.includes("规则") ||
        lowerName.includes("agent")
      ) {
        docs.ruleDocs.push(fullPath);
        continue;
      }

      if (
        lowerName.includes("开发") ||
        lowerName.includes("design") ||
        lowerName.includes("roadmap") ||
        lowerName.includes("runbook") ||
        lowerName.includes("readme")
      ) {
        docs.devDocs.push(fullPath);
      }
    }
  }

  await walk(workspaceRoot, 0);
  docs.ruleDocs = [...new Set(docs.ruleDocs)].slice(0, 8);
  docs.devDocs = [...new Set(docs.devDocs)].slice(0, 8);
  if (!docs.ruleDocs.length) {
    docs.notes.push("未自动发现明显的规则文档，建议手动补充。");
  }
  if (!docs.devDocs.length) {
    docs.notes.push("未自动发现明显的开发文档，建议手动补充。");
  }
  return docs;
}

async function detectProjectProfileForAssistant(workspaceRoot) {
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const cargoTomlPath = path.join(workspaceRoot, "Cargo.toml");
  const pyprojectTomlPath = path.join(workspaceRoot, "pyproject.toml");

  if (await pathExists(packageJsonPath)) {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    const commands = [];
    if (packageJson.scripts?.test) commands.push("npm run test");
    if (packageJson.scripts?.build) commands.push("npm run build");
    if (packageJson.scripts?.lint) commands.push("npm run lint");
    return {
      projectType: await pathExists(cargoTomlPath) ? "hybrid" : "node",
      commands,
      strictness: commands.length >= 2 ? "high" : "medium",
      detectedProjectName: safeText(packageJson.name, path.basename(workspaceRoot)),
    };
  }

  if (await pathExists(cargoTomlPath)) {
    return {
      projectType: "rust",
      commands: ["cargo test", "cargo build"],
      strictness: "high",
      detectedProjectName: path.basename(workspaceRoot),
    };
  }

  if (await pathExists(pyprojectTomlPath)) {
    return {
      projectType: "python",
      commands: ["python -m pytest"],
      strictness: "high",
      detectedProjectName: path.basename(workspaceRoot),
    };
  }

  return {
    projectType: "generic",
    commands: [],
    strictness: "medium",
    detectedProjectName: path.basename(workspaceRoot),
  };
}

async function loadLoopAssistantState(layout) {
  const assistantPath = buildAssistantStatePath(layout.codexLoopRoot);
  const existing = await readJson(assistantPath);
  if (existing) {
    return { assistantPath, state: existing };
  }

  const initial = {
    status: "collecting",
    step: "workspace_root",
    draft: createLoopAssistantDraft(),
    currentQuestion: buildLoopAssistantQuestion("workspace_root"),
    createdLoop: null,
    messages: [
      {
        role: "assistant",
        text: "先告诉我项目路径，我会先识别项目信息，再一起创建任务。",
        meta: "开始创建",
        at: nowIso(),
      },
    ],
    updatedAt: nowIso(),
  };
  await ensureDir(path.dirname(assistantPath));
  await writeJson(assistantPath, initial);
  return { assistantPath, state: initial };
}

function createInitialLoopAssistantState() {
  return {
    status: "collecting",
    step: "workspace_root",
    draft: createLoopAssistantDraft(),
    currentQuestion: buildLoopAssistantQuestion("workspace_root"),
    createdLoop: null,
    messages: [
      {
        role: "assistant",
        text: "先告诉我项目路径，我会先识别项目信息，再一起创建任务。",
        meta: "开始创建",
        at: nowIso(),
      },
    ],
    updatedAt: nowIso(),
  };
}

function normalizeAssistantDraft(state) {
  return {
    ...createLoopAssistantDraft(),
    ...(state.draft || {}),
    git: {
      ...createLoopAssistantDraft().git,
      ...(state.draft?.git || {}),
    },
    docs: {
      ...createLoopAssistantDraft().docs,
      ...(state.draft?.docs || {}),
    },
    plan: {
      ...createLoopAssistantDraft().plan,
      ...(state.draft?.plan || {}),
    },
    projectProfile: {
      ...createLoopAssistantDraft().projectProfile,
      ...(state.draft?.projectProfile || {}),
    },
  };
}

function buildAssistantStateForStep(state, step, draft) {
  return {
    ...state,
    status: "collecting",
    step,
    draft,
    createdLoop: null,
    currentQuestion: buildLoopAssistantQuestion(step, draft),
  };
}

function buildAssistantPreviousState(state, draft) {
  if (state.step === "workspace_root") {
    return {
      ...state,
      currentQuestion: buildLoopAssistantQuestion("workspace_root", draft),
    };
  }

  if (state.step === "project_name") {
    return buildAssistantStateForStep(state, "workspace_root", createLoopAssistantDraft());
  }

  if (state.step === "loop_name") {
    return buildAssistantStateForStep(state, "project_name", draft);
  }

  if (state.step === "branch") {
    return buildAssistantStateForStep(state, "loop_name", draft);
  }

  if (state.step === "plan_review") {
    const pendingField = safeText(draft.plan?.pendingField, "project_name");
    if (pendingField === "branch") {
      return buildAssistantStateForStep(state, "plan_review", {
        ...draft,
        plan: {
          ...draft.plan,
          pendingField: "loop_name",
        },
      });
    }
    if (pendingField === "loop_name") {
      return buildAssistantStateForStep(state, "plan_review", {
        ...draft,
        plan: {
          ...draft.plan,
          pendingField: "project_name",
        },
      });
    }
    return buildAssistantStateForStep(state, "project_name", {
      ...draft,
      intent: "",
      plan: {
        ...createLoopAssistantDraft().plan,
      },
    });
  }

  if (state.step === "docs_confirmed") {
    if (safeText(draft.plan?.objectiveSummary, "")) {
      return buildAssistantStateForStep(state, "plan_review", {
        ...draft,
        plan: {
          ...draft.plan,
          pendingField: "branch",
        },
      });
    }
    return buildAssistantStateForStep(state, "branch", draft);
  }

  if (state.step === "completed") {
    return buildAssistantStateForStep(state, "docs_confirmed", draft);
  }

  return state;
}

async function saveLoopAssistantState(assistantPath, state) {
  await ensureDir(path.dirname(assistantPath));
  await writeJson(assistantPath, {
    ...state,
    updatedAt: nowIso(),
  });
  return {
    ...state,
    updatedAt: nowIso(),
  };
}

async function readConfig(layout) {
  const { config } = await loadLoopConfig(layout.codexLoopRoot);
  return config;
}

function summarizeSnapshot({
  config,
  loop,
  state,
  thread,
  profile,
  paths,
  errorState,
  health,
  codexConversation = null,
  runtimeEvents = [],
}) {
  return {
    config,
    loop: buildLoopSnapshot(loop),
    state: {
      ...state,
      modeLabel: modeLabel(state.mode),
    },
    thread,
    profile,
    paths,
    error: errorState,
    health,
    codexConversation,
    runtimeEvents,
  };
}

function buildSummaryPayload(snapshot) {
  return {
    workspaceName: snapshot.thread.workspaceName,
    threadTitle: snapshot.thread.threadTitle,
    threadId: snapshot.thread.threadId,
    mode: snapshot.state.mode,
    modeLabel: snapshot.state.modeLabel,
    activeTask: snapshot.thread.latestActiveTask || snapshot.state.activeTask || "",
    recentSummary:
      snapshot.thread.latestSummary ||
      snapshot.state.recentSummary ||
      snapshot.state.lastNote ||
      "",
    lastHeartbeatAt:
      snapshot.thread.latestHeartbeatAt || snapshot.state.lastHeartbeatAt || "",
    latestEventType:
      snapshot.thread.latestEventType || snapshot.state.events?.at(-1)?.type || "",
    latestError: snapshot.error.message || "",
    lastUserInstructionSummary: snapshot.thread.lastUserInstructionSummary || "",
    lastAssistantActionSummary: snapshot.thread.lastAssistantActionSummary || "",
    latestCodexSummary: snapshot.thread.latestCodexSummary || "",
    summaryGeneratedAt: nowIso(),
  };
}

function buildContinuationStrategy(snapshot) {
  const shouldFinalize = snapshot.state.mode === "finalize_after_current";
  const generator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  return {
    contextCard: {
      whyContinue: snapshot.thread.lastUserInstructionSummary || "继续当前任务主线",
      nextAction:
        snapshot.thread.latestCodexSummary ||
        snapshot.thread.latestSummary ||
        snapshot.state.recentSummary ||
        "等待下一轮明确进展",
      latestPrompt: snapshot.thread.lastDispatchPrompt || "",
    },
    rhythmCard: {
      continuationStatus: snapshot.thread.continuationStatus,
      continuationCycles: snapshot.thread.continuationCycleCount || 0,
      automationIntervalMinutes: snapshot.thread.heartbeatAutomation ? "已绑定自动化" : "未绑定自动化",
      promptGeneratorMode: generator.enabled ? generator.provider || "enabled" : "template",
    },
    guardrailCard: {
      mode: snapshot.state.mode,
      finalizeRequested: Boolean(snapshot.state.finalizeRequested),
      stopRequested: Boolean(snapshot.state.stopRequested),
      stopRule: shouldFinalize
        ? "当前处于收尾模式：完成当前小批任务后总结、验证并停止。"
        : "当前处于推进模式：优先完成下一批边界清晰、可验证的小任务。",
    },
  };
}

function formatLoopStopLimit(budgets = {}) {
  const maxMinutes = Number(budgets.maxMinutes);
  const maxTokens = Number(budgets.maxTokens);
  const finalizeLeadMinutes = Number(budgets.finalizeLeadMinutes || 0);
  const finalizeLeadTokens = Number(budgets.finalizeLeadTokens || 0);
  const parts = [];

  if (Number.isFinite(maxMinutes) && maxMinutes > 0) {
    parts.push(`最长 ${maxMinutes} 分钟`);
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    parts.push(`最大 ${maxTokens} token`);
  }
  if (
    (Number.isFinite(finalizeLeadMinutes) && finalizeLeadMinutes > 0) ||
    (Number.isFinite(finalizeLeadTokens) && finalizeLeadTokens > 0)
  ) {
    const leadParts = [];
    if (finalizeLeadMinutes > 0) {
      leadParts.push(`${finalizeLeadMinutes} 分钟`);
    }
    if (finalizeLeadTokens > 0) {
      leadParts.push(`${finalizeLeadTokens} token`);
    }
    parts.push(`提前 ${leadParts.join(" / ")} 收尾`);
  }

  return parts.length ? parts.join(" · ") : "未设置停止条件";
}

function blockingHealthIssue(health = {}) {
  const issues = Array.isArray(health.issues) ? health.issues : [];
  if (issues.some((issue) => String(issue).startsWith("workspace:"))) {
    return {
      type: "workspace",
      message: "项目路径不可用，codex-loop 已停止继续发送。请恢复项目目录或重新配置工作区。",
    };
  }
  if (issues.some((issue) => String(issue).startsWith("context:"))) {
    return {
      type: "context",
      message: "项目规则或开发文档不可用，codex-loop 已停止继续发送。请恢复文件或重新配置文档。",
    };
  }
  return null;
}

function deriveMonitorStatus(processState) {
  const map = {
    waiting_next_turn: {
      monitorLevel: "ready",
      monitorLabel: "可继续",
      monitorTone: "ready",
    },
    health_blocked: {
      monitorLevel: "blocked",
      monitorLabel: "需处理",
      monitorTone: "warning",
    },
    codex_working: {
      monitorLevel: "busy",
      monitorLabel: "处理中",
      monitorTone: "active",
    },
    supervisor_reviewing: {
      monitorLevel: "busy",
      monitorLabel: "复盘中",
      monitorTone: "active",
    },
    finalizing: {
      monitorLevel: "busy",
      monitorLabel: "收尾中",
      monitorTone: "warning",
    },
    error: {
      monitorLevel: "error",
      monitorLabel: "失败",
      monitorTone: "danger",
    },
    unbound: {
      monitorLevel: "blocked",
      monitorLabel: "未绑定",
      monitorTone: "warning",
    },
    stopped: {
      monitorLevel: "idle",
      monitorLabel: "已停止",
      monitorTone: "soft",
    },
    monitoring: {
      monitorLevel: "ready",
      monitorLabel: "监控中",
      monitorTone: "ready",
    },
  };
  return map[processState] || {
    monitorLevel: "idle",
    monitorLabel: "待确认",
    monitorTone: "soft",
  };
}

function buildProcessStatus(snapshot) {
  const mode = snapshot.state.mode || "stopped";
  const continuationStatus = snapshot.thread.continuationStatus || "idle";
  const hasThread = Boolean(snapshot.thread.threadId);
  const waitingForCodex = continuationStatus === "dispatching";
  const reviewingSupervisor = continuationStatus === "reviewing";
  const healthBlocker = blockingHealthIssue(snapshot.health);
  const hasPendingGuidance = Boolean(snapshot.thread.pendingUserGuidance);
  const promptGenerationWarning = safeText(snapshot.thread.promptGenerationWarning, "");
  const supervisorReview = safeText(snapshot.thread.lastSupervisorReview, "");
  const supervisorInstruction = safeText(snapshot.thread.lastSupervisorInstruction, "");
  const supervisorReviewWarning = safeText(snapshot.thread.supervisorReviewWarning, "");
  const supervisorVerificationStatus = safeText(
    snapshot.thread.lastSupervisorVerificationStatus,
    "",
  );
  const supervisorVerificationSummary = safeText(
    snapshot.thread.lastSupervisorVerificationSummary,
    "",
  );
  const supervisorVerificationResults = Array.isArray(
    snapshot.thread.lastSupervisorVerificationResults,
  )
    ? snapshot.thread.lastSupervisorVerificationResults
    : [];
  const verificationCommands = normalizeTextList(
    snapshot.thread.lastSupervisorVerificationCommands || [],
    5,
    120,
  );
  const acceptanceFocus = normalizeTextList(
    snapshot.thread.lastSupervisorAcceptanceFocus || [],
    5,
    120,
  );
  const isFinalizing =
    mode === "finalize_after_current" ||
    Boolean(snapshot.state.stopRequested || snapshot.state.finalizeRequested);

  let state = "waiting_next_turn";
  let headline = "等待下一轮";
  let detail =
    promptGenerationWarning ||
    "当前可以发送下一轮指令；如果开启了本地模型，会先合并 Codex 回复和你的补充引导。";
  let canSendNextTurn = hasThread && mode === "running" && continuationStatus === "idle";
  let holdReason = "当前没有阻塞，可以发送下一轮指令。";
  let nextAction = "需要继续时点击开始循环；如果自动循环已开启，可以等待下一次调度。";

  if (!hasThread) {
    state = "unbound";
    headline = "尚未绑定线程";
    detail = "先绑定要接入的 Codex 窗口，再开始循环。";
    canSendNextTurn = false;
    holdReason = "还没有绑定可见的 Codex 线程。";
    nextAction = "先在创建或管理里填写目标窗口 threadId，再开始循环。";
  } else if (isFinalizing) {
    state = "finalizing";
    headline = "正在收尾";
    detail = waitingForCodex
      ? "Codex 正在处理当前轮，完成后 codex-loop 会停止，不会再发送下一条。"
      : "已进入收尾状态，不会再发送下一条指令。";
    canSendNextTurn = false;
    holdReason = waitingForCodex
      ? "已收到停止指令，但 Codex 仍在处理当前轮。"
      : "当前任务已进入收尾状态。";
    nextAction = "等待当前轮结束后查看最后记录；确认无误后再重新开始。";
  } else if (continuationStatus === "error") {
    const failureCategory = safeText(snapshot.thread.lastContinuationFailureCategory, "");
    const failureLabel = safeText(snapshot.thread.lastContinuationFailureLabel, "");
    const failureMessage = safeText(snapshot.thread.lastContinuationFailureMessage, "");
    const failureAction = safeText(snapshot.thread.lastContinuationFailureAction, "");
    state = "error";
    headline = failureLabel || "续跑失败";
    detail =
      failureMessage ||
      snapshot.thread.lastContinuationError ||
      "上一轮没有成功发送或确认，请查看最近记录后再继续。";
    canSendNextTurn = false;
    holdReason = detail;
    nextAction =
      failureAction ||
      "先检查线程绑定和 Codex 桌面端连接；必要时重新绑定后再开始循环。";
  } else if (mode === "stopped") {
    state = hasThread ? "monitoring" : "stopped";
    headline = hasThread ? "监控中" : "已停止";
    detail = hasThread
      ? "当前不会自动循环；可以查看 Codex 历史，或在底部补充后手动发送一次引导。"
      : "当前不会自动发送指令；需要继续时可以手动开始循环。";
    canSendNextTurn = hasThread && continuationStatus === "idle";
    holdReason = hasThread
      ? "监控模式不会自动派发，只有你手动发送引导时才会推进一次。"
      : "当前任务没有在运行。";
    nextAction = hasThread
      ? "需要介入时，在对话底部写补充，再点击待发送补充旁的发送按钮。"
      : "先看对话记录确认结果；需要继续时点击开始循环。";
  } else if (healthBlocker) {
    state = "health_blocked";
    headline = "需要处理配置";
    detail = healthBlocker.message;
    canSendNextTurn = false;
    holdReason = healthBlocker.message;
    nextAction = "先恢复或重新配置后再开始循环。";
  } else if (reviewingSupervisor) {
    state = "supervisor_reviewing";
    headline = "监督复盘中";
    detail = "本地模型 NPC 正在以产品经理、测试人员和真实用户视角复盘 Codex 回复，完成前不会发送下一条指令。";
    canSendNextTurn = false;
    holdReason = "Codex 已完成当前轮，本地模型 NPC 正在复盘并决定下一步。";
    nextAction = "等待复盘结束；如有新要求，可以先写入补充引导。";
  } else if (waitingForCodex) {
    state = "codex_working";
    headline = "Codex 正在处理";
    detail = "当前轮还没有完成，codex-loop 不会追加发送，避免打断 Codex。";
    canSendNextTurn = false;
    holdReason = "Codex 正在执行当前轮，完成前不能追加发送。";
    nextAction = "等待 Codex 完成；如果要补充方向，先写入下一轮引导。";
  } else if (snapshot.state.monitorOnly) {
    state = "monitoring";
    headline = "监控中";
    detail = "监控模式不会自动循环；可以查看 Codex 历史，或在底部补充后手动发送一次引导。";
    canSendNextTurn = false;
    holdReason = "这次手动引导已经结束，codex-loop 不会自动发送下一轮。";
    nextAction = "继续查看记录；需要介入时，在底部写补充并手动发送。";
  }

  const monitorStatus = deriveMonitorStatus(state);
  return {
    state,
    ...monitorStatus,
    headline,
    detail,
    holdReason,
    nextAction,
    waitingForCodex,
    reviewingSupervisor,
    canSendNextTurn,
    hasPendingGuidance,
    pendingGuidancePreview: buildPromptPreview(snapshot.thread.pendingUserGuidance || ""),
    hasSupervisorReview: Boolean(supervisorReview || supervisorInstruction),
    supervisorReview: supervisorReview ? summarizeForFollowup(supervisorReview, 180) : "",
    supervisorInstructionPreview: supervisorInstruction
      ? buildPromptPreview(supervisorInstruction, 180)
      : "",
    supervisorSource: snapshot.thread.lastSupervisorSource || "",
    needsIndependentVerification: Boolean(
      snapshot.thread.supervisorNeedsIndependentVerification,
    ),
    verificationCommands,
    verificationCommandPreview: verificationCommands.join(" · "),
    acceptanceFocusPreview: acceptanceFocus.join(" · "),
    supervisorVerificationStatus,
    supervisorVerificationSummary: supervisorVerificationSummary
      ? summarizeForFollowup(supervisorVerificationSummary, 180)
      : "",
    supervisorVerificationCommandCount: supervisorVerificationResults.length,
    supervisorVerificationAt: snapshot.thread.lastSupervisorVerificationAt || "",
    supervisorReviewWarning,
    promptGenerationWarning,
    failureCategory: snapshot.thread.lastContinuationFailureCategory || "",
    failureLabel: snapshot.thread.lastContinuationFailureLabel || "",
    failureSeverity: snapshot.thread.lastContinuationFailureSeverity || "",
    stopLimit: formatLoopStopLimit(snapshot.state.budgets || snapshot.config.budgets || {}),
    lastDispatchAt: snapshot.thread.lastDispatchAt || "",
    lastCompletionAt: snapshot.thread.lastCompletionAt || "",
    latestEventType: snapshot.thread.latestEventType || snapshot.state.events?.at(-1)?.type || "",
  };
}

function parseTranscriptEntries(transcriptText) {
  const lines = transcriptText.split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("## ")) {
      if (current) {
        entries.push(current);
      }
      current = {
        at: line.slice(3).trim(),
        activeTask: "",
        note: "",
        summary: "",
        mode: "",
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("- Active task: ") || line.startsWith("- 当前任务：")) {
      current.activeTask = line
        .replace(/^- Active task:\s*/u, "")
        .replace(/^- 当前任务：\s*/u, "")
        .trim();
      continue;
    }

    if (line.startsWith("- Note: ") || line.startsWith("- 记录：")) {
      current.note = line
        .replace(/^- Note:\s*/u, "")
        .replace(/^- 记录：\s*/u, "")
        .trim();
      continue;
    }

    if (line.startsWith("- Summary: ") || line.startsWith("- 摘要：")) {
      current.summary = line
        .replace(/^- Summary:\s*/u, "")
        .replace(/^- 摘要：\s*/u, "")
        .trim();
      continue;
    }

    if (line.startsWith("- Thread mirror mode: ") || line.startsWith("- 状态：")) {
      current.mode = line
        .replace(/^- Thread mirror mode:\s*/u, "")
        .replace(/^- 状态：\s*/u, "")
        .trim();
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries.slice(-8).reverse();
}

function buildFallbackTranscriptEntries(snapshot) {
  const summary = firstNonEmpty(
    snapshot?.thread?.latestCodexSummary,
    snapshot?.thread?.latestSummary,
    snapshot?.state?.recentSummary,
  );
  const note = firstNonEmpty(
    snapshot?.thread?.latestEventType,
    snapshot?.thread?.lastAssistantActionSummary,
    snapshot?.thread?.lastUserInstructionSummary,
  );
  const at = firstNonEmpty(
    snapshot?.thread?.lastCompletionAt,
    snapshot?.thread?.lastDispatchAt,
    snapshot?.thread?.lastUpdatedAt,
    snapshot?.state?.lastHeartbeatAt,
    snapshot?.state?.startedAt,
  );

  if (!summary && !note) {
    return [];
  }

  return [
    {
      at: at || nowIso(),
      activeTask: firstNonEmpty(
        snapshot?.thread?.latestActiveTask,
        snapshot?.state?.activeTask,
        snapshot?.config?.loopName,
      ),
      note: note || "recent_summary_recovered",
      summary: summary || "Recovered the latest visible loop summary for the dashboard.",
      mode: snapshot?.state?.mode || snapshot?.thread?.latestMode || "",
    },
  ];
}

export async function exportMobileView(startDir = process.cwd()) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const summary = buildSummaryPayload(snapshot);
  const launcher = await readLauncherStatus(startDir);
  const transcriptText = await fs.readFile(snapshot.paths.transcriptPath, "utf8");
  const transcriptEntries = parseTranscriptEntries(transcriptText);
  const runtimeEvents = await readReadableRuntimeEvents(snapshot.paths.logPath);
  const strategy = buildContinuationStrategy(snapshot);
  const processStatus = buildProcessStatus(snapshot);
  const supervisor = snapshot.profile?.resolved?.conversation?.supervisor || {};
  const pendingGuidanceText = safeText(snapshot.thread.pendingUserGuidance, "");
  const boundThreadLabel = snapshot.thread.threadTitle || snapshot.thread.threadId;
  const bindingNote = safeText(
    snapshot.thread.note,
    snapshot.thread.threadId
      ? "当前已绑定线程：" + boundThreadLabel + "（" + snapshot.thread.threadId + "）"
      : "当前还没有绑定可见线程，请先绑定线程，再开始循环。",
  );
  let suggestedAction = "先绑定线程，再开始循环。";
  if (snapshot.state.mode === "finalize_after_current") {
    suggestedAction = "正在收尾，请等待当前轮结束后查看总结。";
  } else if (snapshot.state.mode === "stopped") {
    suggestedAction = snapshot.thread.threadId
      ? "当前处于监控模式，可以查看记录或手动发送引导；不会自动循环。"
      : "当前已停止，请先绑定线程。";
  } else if (snapshot.state.monitorOnly) {
    if (snapshot.thread.continuationStatus === "dispatching") {
      suggestedAction = "监控模式引导已发送，正在等待 Codex 完成当前轮。";
    } else if (snapshot.thread.continuationStatus === "reviewing") {
      suggestedAction = "监控模式正在复盘 Codex 回复，请等待本地模型给出下一步判断。";
    } else {
      suggestedAction = "当前处于监控模式，可以查看记录或手动发送引导；不会自动派发下一轮。";
    }
  } else if (snapshot.thread.threadId) {
    if (snapshot.thread.continuationStatus === "dispatching") {
      suggestedAction = "Codex 正在处理当前轮，请等待完成后再继续。";
    } else if (snapshot.thread.continuationStatus === "reviewing") {
      suggestedAction = "监督复盘中，请等待本地模型决定下一步。";
    } else {
      suggestedAction = "线程已绑定，可以观察进展或开始下一轮。";
    }
  }
  return {
    loop: {
      id: snapshot.config.currentRunId,
      name: snapshot.config.loopName,
      mode: snapshot.state.mode,
      modeLabel: snapshot.state.modeLabel,
      creation: snapshot.loop.creation
        ? {
            ...snapshot.loop.creation,
            evidenceSummary: snapshot.loop.creation.evidence?.summary || "",
          }
        : null,
    },
    thread: {
      title: snapshot.thread.threadTitle,
      threadId: snapshot.thread.threadId,
      continuationStatus: snapshot.thread.continuationStatus,
      continuationCycleCount: snapshot.thread.continuationCycleCount,
    },
    health: snapshot.health,
    launcher,
    summary,
    strategy,
    processStatus,
    supervisor: {
      roleTraits: safeText(supervisor.roleTraits, ""),
      testingRules: safeText(supervisor.testingRules, ""),
      acceptanceCriteria: safeText(supervisor.acceptanceCriteria, ""),
    },
    pendingGuidance: {
      text: pendingGuidanceText,
      preview: buildPromptPreview(pendingGuidanceText),
      hasPending: Boolean(pendingGuidanceText),
      mergeTiming: "codex_completed",
      mergeTimingLabel: "等 Codex 完成后合并到下一条指令",
    },
    codexConversation: snapshot.codexConversation,
    bindingNote,
    suggestedAction,
    latestPrompt: snapshot.thread.lastDispatchPrompt || "",
    runtimeEvents,
    transcriptEntries:
      transcriptEntries.length > 0
        ? transcriptEntries
        : buildFallbackTranscriptEntries(snapshot),
  };
}
function buildTranscriptEntry({ at, activeTask, note, summary, mode }) {
  return [
    "",
    "## " + at,
    "- 当前任务：" + (activeTask || "n/a"),
    "- 记录：" + (note || "n/a"),
    "- 摘要：" + (summary || "n/a"),
    "- 状态：" + (mode || "n/a"),
  ].join("\n");
}

async function appendTranscriptEntry(transcriptPath, payload = {}) {
  await fs.appendFile(
    transcriptPath,
    buildTranscriptEntry({
      at: payload.at || nowIso(),
      activeTask: payload.activeTask || "",
      note: payload.note || "",
      summary: payload.summary || "",
      mode: payload.mode || "",
    }),
    "utf8",
  );
}

function buildThreadMirror(thread, state, overrides = {}) {
  const latestEventType =
    overrides.latestEventType ??
    thread.latestEventType ??
    state.events?.at(-1)?.type ??
    "";
  const continuationStatus =
    overrides.continuationStatus ?? thread.continuationStatus ?? "idle";
  const lastContinuationError =
    continuationStatus === "error"
      ? overrides.lastContinuationError ?? thread.lastContinuationError ?? ""
      : overrides.lastContinuationError ?? "";
  const lastContinuationFailureCategory =
    continuationStatus === "error"
      ? overrides.lastContinuationFailureCategory ??
        thread.lastContinuationFailureCategory ??
        ""
      : overrides.lastContinuationFailureCategory ?? "";
  const lastContinuationFailureLabel =
    continuationStatus === "error"
      ? overrides.lastContinuationFailureLabel ?? thread.lastContinuationFailureLabel ?? ""
      : overrides.lastContinuationFailureLabel ?? "";
  const lastContinuationFailureSeverity =
    continuationStatus === "error"
      ? overrides.lastContinuationFailureSeverity ??
        thread.lastContinuationFailureSeverity ??
        ""
      : overrides.lastContinuationFailureSeverity ?? "";
  const lastContinuationFailureMessage =
    continuationStatus === "error"
      ? overrides.lastContinuationFailureMessage ??
        thread.lastContinuationFailureMessage ??
        ""
      : overrides.lastContinuationFailureMessage ?? "";
  const lastContinuationFailureAction =
    continuationStatus === "error"
      ? overrides.lastContinuationFailureAction ??
        thread.lastContinuationFailureAction ??
        ""
      : overrides.lastContinuationFailureAction ?? "";

  const nextThread = {
    ...thread,
    ...overrides,
    currentRunId: overrides.currentRunId ?? thread.currentRunId ?? state.currentRunId,
    latestMode: overrides.latestMode ?? state.mode,
    latestModeLabel: overrides.latestModeLabel ?? modeLabel(state.mode),
    latestActiveTask: firstNonEmpty(
      overrides.latestActiveTask,
      thread.latestActiveTask,
      state.activeTask,
    ),
    latestSummary: firstNonEmpty(
      overrides.latestSummary,
      thread.latestSummary,
      state.recentSummary,
      state.lastNote,
    ),
    latestHeartbeatAt: firstNonEmpty(
      overrides.latestHeartbeatAt,
      thread.latestHeartbeatAt,
      state.lastHeartbeatAt,
    ),
    latestEventType,
    latestVerification: overrides.latestVerification ?? thread.latestVerification ?? "",
    continuationStatus,
    continuationEnabled:
      overrides.continuationEnabled ?? thread.continuationEnabled ?? false,
    continuationCycleCount:
      overrides.continuationCycleCount ?? thread.continuationCycleCount ?? 0,
    lastDispatchAt: overrides.lastDispatchAt ?? thread.lastDispatchAt ?? "",
    lastCompletionAt: overrides.lastCompletionAt ?? thread.lastCompletionAt ?? "",
    lastDispatchPrompt:
      overrides.lastDispatchPrompt ?? thread.lastDispatchPrompt ?? "",
    pendingUserGuidance:
      overrides.pendingUserGuidance ?? thread.pendingUserGuidance ?? "",
    pendingUserGuidanceAt:
      overrides.pendingUserGuidanceAt ?? thread.pendingUserGuidanceAt ?? "",
    lastContinuationError,
    lastContinuationFailureCategory,
    lastContinuationFailureLabel,
    lastContinuationFailureSeverity,
    lastContinuationFailureMessage,
    lastContinuationFailureAction,
    lastSupervisorReview:
      overrides.lastSupervisorReview ?? thread.lastSupervisorReview ?? "",
    lastSupervisorReviewAt:
      overrides.lastSupervisorReviewAt ?? thread.lastSupervisorReviewAt ?? "",
    lastSupervisorInstruction:
      overrides.lastSupervisorInstruction ?? thread.lastSupervisorInstruction ?? "",
    lastSupervisorSource:
      overrides.lastSupervisorSource ?? thread.lastSupervisorSource ?? "",
    supervisorNeedsIndependentVerification:
      overrides.supervisorNeedsIndependentVerification ??
      thread.supervisorNeedsIndependentVerification ??
      false,
    lastSupervisorVerificationCommands:
      overrides.lastSupervisorVerificationCommands ??
      thread.lastSupervisorVerificationCommands ??
      [],
    lastSupervisorAcceptanceFocus:
      overrides.lastSupervisorAcceptanceFocus ??
      thread.lastSupervisorAcceptanceFocus ??
      [],
    lastSupervisorVerificationStatus:
      overrides.lastSupervisorVerificationStatus ??
      thread.lastSupervisorVerificationStatus ??
      "",
    lastSupervisorVerificationSummary:
      overrides.lastSupervisorVerificationSummary ??
      thread.lastSupervisorVerificationSummary ??
      "",
    lastSupervisorVerificationResults:
      overrides.lastSupervisorVerificationResults ??
      thread.lastSupervisorVerificationResults ??
      [],
    lastSupervisorVerificationAt:
      overrides.lastSupervisorVerificationAt ??
      thread.lastSupervisorVerificationAt ??
      "",
    supervisorReviewWarning:
      overrides.supervisorReviewWarning ?? thread.supervisorReviewWarning ?? "",
    promptGenerationWarning:
      overrides.promptGenerationWarning ?? thread.promptGenerationWarning ?? "",
    lastUpdatedAt: overrides.lastUpdatedAt ?? nowIso(),
  };
  return {
    ...nextThread,
    note: normalizeUserFacingTaskText(nextThread.note),
    latestSummary: normalizeUserFacingTaskText(nextThread.latestSummary),
    lastDispatchPrompt: normalizeUserFacingTaskText(nextThread.lastDispatchPrompt),
    lastUserInstructionSummary: normalizeUserFacingTaskText(nextThread.lastUserInstructionSummary),
    lastAssistantActionSummary: normalizeUserFacingTaskText(nextThread.lastAssistantActionSummary),
    latestCodexSummary: normalizeUserFacingTaskText(nextThread.latestCodexSummary),
  };
}

async function persistThreadMirror(threadPath, currentThread, state, overrides = {}) {
  const nextThread = buildThreadMirror(currentThread, state, overrides);
  await writeJson(threadPath, nextThread);
  return nextThread;
}

async function updateRegistryLoopBinding(codexLoopRoot, loopId, updater) {
  const layout = {
    codexLoopRoot,
    workspaceRoot: path.dirname(codexLoopRoot),
  };
  const config = await readConfig({ codexLoopRoot });
  const { registry, registryPath } = await loadLoopRegistry(layout, config);
  const nextRegistry = {
    ...registry,
    loops: registry.loops.map((loop) =>
      loop.id === loopId
        ? {
            ...loop,
            ...updater(loop),
            updatedAt: nowIso(),
          }
        : loop,
    ),
  };
  await writeJson(registryPath, nextRegistry);
  return nextRegistry.loops.find((loop) => loop.id === loopId);
}

function buildFollowupPrompt(snapshot) {
  const language = safeText(
    snapshot.profile?.resolved?.conversation?.language,
    snapshot.profile?.overrides?.conversation?.language || "zh-CN",
  ).toLowerCase();
  const englishPreferred = language.startsWith("en");
  const loopName = safeText(snapshot.config.loopName, snapshot.config.projectName || "current loop");
  const branch = safeText(snapshot.config.branch, "dev");
  const latestSummary = firstNonEmpty(
    safeText(snapshot.thread.lastSupervisorInstruction, ""),
    safeText(snapshot.thread.latestCodexSummary, ""),
  );
  const lastAction = safeText(snapshot.thread.lastAssistantActionSummary, "");
  const userIntent = safeText(
    snapshot.thread.lastUserInstructionSummary,
    englishPreferred ? "Continue the current task." : "继续当前任务。",
  );
  const focus = firstNonEmpty(latestSummary, lastAction, userIntent);

  if (englishPreferred) {
    return [
      "Continue loop " + loopName + " on branch " + branch + ".",
      "Next: " + focus,
      "Follow project docs and rules first. Finish one small verifiable batch, then report progress, verification, and next step.",
    ].join("\n");
  }

  return [
    "继续推进「" + loopName + "」，分支「" + branch + "」。",
    "下一步：" + focus,
    "优先遵守项目文档和开发规则。先完成一小批可验证任务，再回复进展、验证结果和下一步。",
  ].join("\n");
}

function buildCompactFollowupPrompt(snapshot) {
  return buildFollowupPrompt(snapshot);
}

function buildVisibleThreadPrompt(snapshot) {
  const language = safeText(
    snapshot.profile?.resolved?.conversation?.language,
    snapshot.profile?.overrides?.conversation?.language || "zh-CN",
  ).toLowerCase();
  const englishPreferred = language.startsWith("en");
  const pendingGuidance = summarizeForFollowup(snapshot.thread.pendingUserGuidance, 180);
  const focus = firstNonEmpty(
    summarizeForFollowup(snapshot.thread.lastSupervisorInstruction),
    summarizeForFollowup(snapshot.thread.latestCodexSummary),
    summarizeForFollowup(snapshot.thread.lastAssistantActionSummary),
    summarizeForFollowup(snapshot.thread.lastUserInstructionSummary),
    englishPreferred ? "Continue the current task." : "继续当前任务。",
  );
  const conciseFocus = safeText(focus, "")
    .replace(/\s+/g, " ")
    .replace(/^[-:：\s]+/, "")
    .slice(0, 120);

  if (englishPreferred) {
    return [
      "Continue in this same Codex thread.",
      "Next: " + (conciseFocus || "Continue the highest-priority verified task."),
      pendingGuidance ? "User added guidance: " + pendingGuidance : "",
      "Follow project docs and rules first. Do one small verifiable batch, then report progress, verification, and next step.",
    ].filter(Boolean).join("\n");
  }

  return [
    "继续在同一个 Codex 线程中推进。",
    "下一步：" + (conciseFocus || "继续当前最高优先级、可验证的小任务。"),
    pendingGuidance ? "用户临时补充：" + pendingGuidance : "",
    "优先遵守项目文档和开发规则。完成一小批可验证任务后，再回复进展、验证结果和下一步。",
  ].filter(Boolean).join("\n");
}

async function fileHealth(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return {
        key: label,
        path: filePath,
        ok: false,
        exists: true,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        issue: "not-file",
      };
    }
    return {
      key: label,
      path: filePath,
      ok: true,
      exists: true,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        key: label,
        path: filePath,
        ok: false,
        exists: false,
        size: 0,
        updatedAt: "",
        issue: "missing",
      };
    }
    return {
      key: label,
      path: filePath,
      ok: false,
      exists: false,
      size: 0,
      updatedAt: "",
      issue: "unreadable",
      error: safeText(error?.message, "文件不可读取"),
    };
  }
}

async function directoryHealth(dirPath, label) {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return {
        key: label,
        path: dirPath,
        ok: false,
        exists: true,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        issue: "not-directory",
      };
    }
    return {
      key: label,
      path: dirPath,
      ok: true,
      exists: true,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        key: label,
        path: dirPath,
        ok: false,
        exists: false,
        size: 0,
        updatedAt: "",
        issue: "missing",
      };
    }
    return {
      key: label,
      path: dirPath,
      ok: false,
      exists: false,
      size: 0,
      updatedAt: "",
      issue: "unreadable",
      error: safeText(error?.message, "目录不可读取"),
    };
  }
}

function buildHealthSummary(checks, state, thread, errorState) {
  const issues = checks
    .filter((item) => !item.ok)
    .map((item) => `${item.key}:${item.issue || "invalid"}`);

  const now = Date.now();
  const heartbeatAt = Date.parse(state.lastHeartbeatAt || thread.latestHeartbeatAt || "");
  if (Number.isFinite(heartbeatAt) && now - heartbeatAt > HEARTBEAT_STALE_MS) {
    issues.push("heartbeat:stale");
  }

  const dispatchAt = Date.parse(thread.lastDispatchAt || "");
  if (
    thread.continuationStatus === "dispatching" &&
    Number.isFinite(dispatchAt) &&
    now - dispatchAt > CONTINUATION_STALLED_MS
  ) {
    issues.push("continuation:stalled");
  }

  const transcriptCheck = checks.find((item) => item.key === "transcript");
  const transcriptUpdatedAt = Date.parse(transcriptCheck?.updatedAt || "");
  if (
    state.mode === "running" &&
    Number.isFinite(transcriptUpdatedAt) &&
    now - transcriptUpdatedAt > TRANSCRIPT_STALE_MS
  ) {
    issues.push("transcript:stale");
  }

  if (thread.continuationStatus === "error" && thread.lastContinuationError) {
    issues.push("continuation:error");
  }

  if (errorState.message) {
    issues.push("runtime:error-state");
  }

  return {
    ok: issues.length === 0,
    issues,
    checks,
    continuationStatus: thread.continuationStatus,
    lastContinuationError: thread.lastContinuationError || "",
  };
}

async function inspectLoopHealth(paths, state, thread, errorState) {
  const contextPaths = Array.isArray(paths.startContextPaths)
    ? paths.startContextPaths
    : [];
  const checks = await Promise.all([
    directoryHealth(paths.workspaceRoot, "workspace"),
    fileHealth(paths.statePath, "state"),
    fileHealth(paths.threadPath, "thread"),
    fileHealth(paths.transcriptPath, "transcript"),
    fileHealth(paths.errorPath, "error"),
    fileHealth(paths.logPath, "events"),
    ...contextPaths.map((filePath) => fileHealth(filePath, "context")),
  ]);
  return buildHealthSummary(checks, state, thread, errorState);
}

function missingContextMessage(health = {}) {
  const invalidContexts = (health.checks || [])
    .filter((check) => check.key === "context" && check.ok === false);
  if (!invalidContexts.length) {
    return "";
  }
  const readableIssue = {
    missing: "缺失",
    "not-file": "不是文件",
    unreadable: "不可读取",
  };
  const details = invalidContexts
    .map((check) => {
      const issue = readableIssue[check.issue] || "不可用";
      return `${check.path}（${issue}）`;
    })
    .join("；");
  return "已配置的项目规则/开发文档不可用，codex-loop 已停止自动续发。请先恢复或重新配置文档：" +
    details;
}

function invalidWorkspaceMessage(health = {}) {
  const invalidWorkspace = (health.checks || [])
    .find((check) => check.key === "workspace" && check.ok === false);
  if (!invalidWorkspace) {
    return "";
  }
  const readableIssue = {
    missing: "不存在",
    "not-directory": "不是目录",
    unreadable: "不可读取",
  };
  const issue = readableIssue[invalidWorkspace.issue] || "不可用";
  return "已配置的项目工作区不可用，codex-loop 已停止自动续发。请先恢复或重新配置项目路径：" +
    `${invalidWorkspace.path}（${issue}）`;
}

function isContinuationStalled(thread, now = Date.now()) {
  const dispatchAt = Date.parse(thread?.lastDispatchAt || "");
  return (
    thread?.continuationStatus === "dispatching" &&
    Number.isFinite(dispatchAt) &&
    now - dispatchAt > CONTINUATION_STALLED_MS
  );
}

function isFinalizationWaitExceeded(state, thread, now = Date.now()) {
  const stopRequestedAt = [...(state?.events || [])]
    .reverse()
    .find((event) => event?.type === "graceful_stop_requested")?.at;
  const stopAt = Date.parse(stopRequestedAt || "");
  return (
    state?.mode === "finalize_after_current" &&
    thread?.continuationStatus === "dispatching" &&
    Number.isFinite(stopAt) &&
    now - stopAt > FINALIZE_WAIT_MS
  );
}

function shouldAutoFinalizeToStopped(state, thread) {
  return (
    state?.mode === "finalize_after_current" &&
    thread?.continuationStatus !== "dispatching"
  );
}

async function finalizeLoopAsStopped(snapshot, reason = "graceful stop completed") {
  const at = nowIso();
  const stoppedSummary = "当前任务已停止。可以先查看最近记录，确认结果后再决定是否重新开始。";
  const nextState = {
    ...snapshot.state,
    mode: "stopped",
    stopRequested: false,
    finalizeRequested: false,
    activeTask: "",
    recentSummary: stoppedSummary,
    lastNote: reason,
    events: [
      ...snapshot.state.events,
      {
        type: "graceful_stop_completed",
        at,
        reason,
        mode: "stopped",
      },
    ],
  };

  await writeJson(snapshot.paths.statePath, nextState);
  const nextThread = await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    continuationStatus: "idle",
    latestSummary: stoppedSummary,
    latestEventType: "graceful_stop_completed",
    lastContinuationError: "",
    lastUpdatedAt: at,
  });
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at,
    activeTask: "",
    note: reason,
    summary: stoppedSummary,
    mode: nextState.mode,
  });
}

export async function markContinuationFailed(
  startDir,
  snapshot,
  {
    failedAt = nowIso(),
    message,
    latestSummary,
    promptGenerationError = "",
    promptGenerator = "",
  } = {},
) {
  const failureMessage = safeText(message, "续跑失败，请检查 Codex 桌面端连接。");
  const summary = safeText(
    latestSummary,
    "向 Codex 桌面线程发送下一轮指令失败，请检查线程绑定和桌面原生连接。",
  );
  const failure = classifyContinuationFailure({
    message: failureMessage,
    latestSummary: summary,
    promptGenerationError,
    promptGenerator,
  });
  const nextState = {
    ...snapshot.state,
    mode: "stopped",
    stopRequested: false,
    finalizeRequested: false,
    recentSummary: summary,
    lastNote: "续跑失败",
    events: [
      ...snapshot.state.events,
      {
        type: "codex_followup_failed",
        at: failedAt,
        threadId: snapshot.thread.threadId,
        message: failureMessage,
        failureCategory: failure.category,
        failureLabel: failure.label,
        failureSeverity: failure.severity,
        failureAction: failure.nextAction,
        promptGenerationError,
        promptGenerator,
        mode: "stopped",
      },
    ],
  };

  await writeJson(snapshot.paths.statePath, nextState);
  const failedThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    nextState,
    {
      continuationEnabled: true,
      continuationStatus: "error",
      lastContinuationError: failureMessage,
      lastContinuationFailureCategory: failure.category,
      lastContinuationFailureLabel: failure.label,
      lastContinuationFailureSeverity: failure.severity,
      lastContinuationFailureMessage: failure.userMessage,
      lastContinuationFailureAction: failure.nextAction,
      latestSummary: summary,
      latestEventType: "codex_followup_failed",
      lastUpdatedAt: failedAt,
    },
  );
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...failedThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at: failedAt,
    activeTask: snapshot.state.activeTask,
    note: "codex_followup_failed",
    summary,
    mode: nextState.mode,
  });
  return readLoopSnapshot(startDir);
}

async function ensureLoopArtifactsUnlocked(startDir = process.cwd(), preResolvedLayout = null) {
  let layout = preResolvedLayout || await resolveProjectLayout(startDir);
  const initialConfig = await readConfig(layout);
  const { registry } = await loadLoopRegistry(layout, initialConfig);
  const config = await readConfig(layout);
  const currentLoop =
    registry.loops.find((loop) => loop.id === config.currentRunId) || registry.loops[0];
  layout = applySelectedLoopToLayout(layout, currentLoop);

  const runId = config.currentRunId || DEFAULT_LOOP_ID;
  const runtimeDir = path.join(layout.runtimeRoot, runId);
  const logsDir = path.join(runtimeDir, "logs");
  const statePath = path.join(runtimeDir, "state.json");
  const threadPath = path.join(runtimeDir, "thread.json");
  const transcriptPath = path.join(runtimeDir, "transcript.md");
  const errorPath = path.join(runtimeDir, "error.json");
  const logPath = path.join(logsDir, "events.jsonl");

  await ensureDir(logsDir);

  let state = await readJson(statePath);
  if (!state) {
    await initializeRun({
      workspaceRoot: layout.workspaceRoot,
      codexLoopRoot: layout.codexLoopRoot,
      config,
      runId,
      nowIso: nowIso(),
    });
    state = await readJson(statePath);
  }

  const savedThread = await readJson(threadPath);
  const boundThread = currentLoop?.threadBinding || createLoopThreadBinding(config);
  const preferredThread =
    pickPreferredThreadMirror(boundThread, savedThread) || createLoopThreadBinding(config);
  let thread = buildThreadMirror(
    preferredThread,
    state,
    {
    currentRunId: runId,
    },
  );

  const recoveryKey = `${layout.codexLoopRoot}:${thread.threadId || runId}`;
  if (
    AUTO_FAIL_STALLED_CONTINUATION &&
    isContinuationStalled(thread) &&
    !activeRecoveryKeys.has(recoveryKey)
  ) {
    activeRecoveryKeys.add(recoveryKey);
    try {
      const recoveredAt = nowIso();
      const recoverySummary =
        "上一轮仍在等待 Codex 完成，系统已停止自动续发。请先确认该线程已经完成当前工作，再手动继续。";
      thread = buildThreadMirror(thread, state, {
        currentRunId: runId,
        continuationStatus: "error",
        lastContinuationError:
          "上一轮仍在等待 Codex 完成，已停止自动续发。",
        latestSummary: recoverySummary,
        latestEventType: "codex_followup_stalled",
        lastUpdatedAt: recoveredAt,
      });
      await appendJsonLine(logPath, {
        type: "codex_followup_stalled",
        at: recoveredAt,
        threadId: thread.threadId,
        previousDispatchAt: thread.lastDispatchAt,
        reason: "continuation_stalled",
      });
      await appendTranscriptEntry(transcriptPath, {
        at: recoveredAt,
        activeTask: state.activeTask,
        note: "codex_followup_stalled",
        summary: recoverySummary,
        mode: state.mode,
      });
      await updateRegistryLoopBinding(
        layout.codexLoopRoot,
        runId,
        (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...thread } }),
      );
    } finally {
      activeRecoveryKeys.delete(recoveryKey);
    }
  }

  await writeJson(threadPath, thread);

  const hadErrorState = await readJson(errorPath, undefined);
  if (!hadErrorState) {
    await writeJson(errorPath, createEmptyErrorState());
  }

  try {
    await fs.access(transcriptPath);
  } catch {
    await writeText(transcriptPath, defaultTranscript(thread));
  }

  if (!hadErrorState) {
    await appendJsonLine(logPath, {
      type: "artifacts_verified",
      at: nowIso(),
      runId,
    });
  }

  const errorState = (await readJson(errorPath)) || createEmptyErrorState();
  const profile = applyLoopSupervisorToProfile(
    await readResolvedLoopProfile(startDir),
    currentLoop?.supervisor,
  );
  const paths = {
    runtimeDir,
    statePath,
    logPath,
    transcriptPath,
    threadPath,
    errorPath,
    startContextPaths: normalizeLoopContextPaths(
      config.startContextPaths || [],
      config.docs || null,
    ),
    workspaceRoot: layout.workspaceRoot,
    codexLoopRoot: layout.codexLoopRoot,
  };
  const codexConversation = await readCodexConversationMirror(thread.threadId);
  const latestCompletionText = safeText(codexConversation.latestCompletion?.text, "");
  const latestCompletionAt = Date.parse(codexConversation.latestCompletion?.at || "");
  const lastCompletionAt = Date.parse(thread.lastCompletionAt || "");
  const shouldSyncCodexConversation =
    latestCompletionText &&
    (!Number.isFinite(lastCompletionAt) ||
      (Number.isFinite(latestCompletionAt) && latestCompletionAt > lastCompletionAt));

  if (shouldSyncCodexConversation) {
    const syncedAt = codexConversation.latestCompletion.at || nowIso();
    const visibleCompletion = await resolveVisibleCodexSummary(
      {
        config,
        state,
        thread,
        profile,
        paths,
      },
      latestCompletionText,
    );
    thread = buildThreadMirror(thread, state, {
      currentRunId: runId,
      latestCodexSummary: visibleCompletion.summary,
      latestSummary: "Codex 已返回最新进展，首页已同步。",
      continuationStatus: "idle",
      continuationCycleCount:
        thread.continuationStatus === "dispatching"
          ? (thread.continuationCycleCount || 0) + 1
          : thread.continuationCycleCount,
      lastCompletionAt: syncedAt,
      lastContinuationError: "",
      latestEventType: "codex_followup_completed",
      lastUpdatedAt: nowIso(),
    });
    await writeJson(threadPath, thread);
    await updateRegistryLoopBinding(
      layout.codexLoopRoot,
      runId,
      (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...thread } }),
    );
    await appendJsonLine(logPath, {
      type: "codex_conversation_mirror_synced",
      at: nowIso(),
      threadId: thread.threadId,
      latestAssistantAt: codexConversation.latestCompletion.at,
      latestAssistantPreview: summarizeForFollowup(latestCompletionText),
      summarySource: visibleCompletion.source,
      summaryError: visibleCompletion.error,
    });
  }

  if (isFinalizationWaitExceeded(state, thread)) {
    const forcedIdleAt = nowIso();
    const forcedSummary =
      "已停止继续追问，当前轮先在这里收尾。若 Codex 稍后有新回复，首页仍会同步到最近记录。";
    thread = buildThreadMirror(thread, state, {
      currentRunId: runId,
      continuationStatus: "idle",
      latestSummary: forcedSummary,
      lastContinuationError: "停止时仍在等待 Codex 回复，已在短暂等待后收尾。",
      latestEventType: "graceful_stop_wait_elapsed",
      lastUpdatedAt: forcedIdleAt,
    });
    await writeJson(threadPath, thread);
    await updateRegistryLoopBinding(
      layout.codexLoopRoot,
      runId,
      (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...thread } }),
    );
    await appendJsonLine(logPath, {
      type: "graceful_stop_wait_elapsed",
      at: forcedIdleAt,
      threadId: thread.threadId,
      waitMs: FINALIZE_WAIT_MS,
      lastDispatchAt: thread.lastDispatchAt,
    });
    await appendTranscriptEntry(transcriptPath, {
      at: forcedIdleAt,
      activeTask: state.activeTask,
      note: "graceful_stop_wait_elapsed",
      summary: forcedSummary,
      mode: state.mode,
    });
  }

  const snapshotForFinalize = {
    config,
    state,
    thread,
    paths: {
      codexLoopRoot: layout.codexLoopRoot,
      statePath,
      threadPath,
      transcriptPath,
      logPath,
    },
  };
  if (shouldAutoFinalizeToStopped(state, thread)) {
    await finalizeLoopAsStopped(snapshotForFinalize);
    state = await readJson(statePath);
    thread = await readJson(threadPath);
  }

  const refreshedCodexConversation = shouldSyncCodexConversation
    ? await readCodexConversationMirror(thread.threadId)
    : codexConversation;
  const health = await inspectLoopHealth(paths, state, thread, errorState);
  const runtimeEvents = await readReadableRuntimeEvents(logPath);

  return summarizeSnapshot({
    config,
    loop: currentLoop,
    state,
    thread,
    profile,
    paths,
    errorState,
    health,
    codexConversation: refreshedCodexConversation,
    runtimeEvents,
  });
}

export async function ensureLoopArtifacts(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const refreshKey = layout.codexLoopRoot;
  const previousRefresh = activeSnapshotRefreshes.get(refreshKey) || Promise.resolve();
  const currentRefresh = previousRefresh
    .catch(() => {})
    .then(() => ensureLoopArtifactsUnlocked(startDir, layout));

  activeSnapshotRefreshes.set(refreshKey, currentRefresh);
  try {
    return await currentRefresh;
  } finally {
    if (activeSnapshotRefreshes.get(refreshKey) === currentRefresh) {
      activeSnapshotRefreshes.delete(refreshKey);
    }
  }
}

export async function readLoopSnapshot(startDir = process.cwd()) {
  return ensureLoopArtifacts(startDir);
}

export async function saveThreadBinding(startDir = process.cwd(), payload) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const requestedThreadId = safeText(payload.threadId, "");
  let resolvedThread = null;
  if (!requestedThreadId && safeText(payload.workspaceRoot, "")) {
    const resolveCodexThread = payload.resolveCodexThread || defaultResolveCodexThread;
    const resolution = await resolveCodexThread({
      workspaceRoot: payload.workspaceRoot,
      windowTitle: payload.windowTitle || payload.threadTitle || payload.workspaceName,
    });
    if (resolution.status !== "matched") {
      throw new Error(resolution.userMessage || "没有找到匹配的 Codex 窗口，请手动填写线程 ID。");
    }
    resolvedThread = resolution;
  }

  const hasPayloadThreadId = Object.prototype.hasOwnProperty.call(payload, "threadId");
  const hasPayloadNote = Object.prototype.hasOwnProperty.call(payload, "note");
  const resolvedThreadId =
    resolvedThread?.threadId ||
    (hasPayloadThreadId ? payload.threadId : snapshot.thread.threadId);
  const resolvedThreadTitle =
    payload.threadTitle ||
    resolvedThread?.threadTitle ||
    snapshot.thread.threadTitle;
  const resolvedWorkspaceName =
    payload.workspaceName ||
    resolvedThread?.workspaceName ||
    snapshot.thread.workspaceName;
  const resolvedWorkspaceRoot =
    payload.workspaceRoot ||
    resolvedThread?.workspaceRoot ||
    snapshot.thread.workspaceRoot ||
    snapshot.loop?.workspaceRoot ||
    "";
  const resolvedWindowTitle =
    payload.windowTitle ||
    resolvedThread?.threadTitle ||
    payload.threadTitle ||
    snapshot.thread.windowTitle ||
    "";
  const resolvedNote = hasPayloadNote
    ? payload.note
    : resolvedThread?.userMessage || snapshot.thread.note;
  const updatedThread = {
    ...snapshot.thread,
    workspaceName: resolvedWorkspaceName,
    threadTitle: resolvedThreadTitle,
    workspaceRoot: resolvedWorkspaceRoot,
    windowTitle: resolvedWindowTitle,
    threadId: resolvedThreadId,
    singleThreadMode: payload.singleThreadMode ?? snapshot.thread.singleThreadMode,
    note: resolvedNote,
    heartbeatAutomation:
      payload.heartbeatAutomation ?? snapshot.thread.heartbeatAutomation,
  };

  const nextThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    updatedThread,
    snapshot.state,
    {
      continuationEnabled: Boolean(resolvedThreadId),
      lastUpdatedAt: nowIso(),
    },
  );

  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({
      threadTitle: nextThread.threadTitle,
      threadBinding: {
        ...(loop.threadBinding || createLoopThreadBinding(snapshot.config)),
        ...nextThread,
      },
    }),
  );

  await appendJsonLine(snapshot.paths.logPath, {
    type: "thread_binding_updated",
    at: nowIso(),
    threadId: nextThread.threadId,
    threadTitle: nextThread.threadTitle,
    workspaceName: nextThread.workspaceName,
  });

  await writeText(snapshot.paths.transcriptPath, defaultTranscript(nextThread));
  return readLoopSnapshot(startDir);
}

export async function savePendingGuidance(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const text = safeText(payload.text, "");
  if (!text) {
    throw new Error("补充内容不能为空。");
  }

  const at = nowIso();
  const previousGuidance = safeText(snapshot.thread.pendingUserGuidance, "");
  const nextGuidance = previousGuidance ? `${previousGuidance}\n${text}` : text;
  const nextThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    snapshot.state,
    {
      pendingUserGuidance: nextGuidance,
      pendingUserGuidanceAt: at,
      latestSummary: "已记录补充引导，会在 Codex 当前轮完成后交给本地模型合并到下一条指令。",
      latestEventType: "pending_guidance_saved",
      lastUpdatedAt: at,
    },
  );

  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "pending_guidance_saved",
    at,
    threadId: nextThread.threadId,
    preview: buildPromptPreview(text),
  });
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at,
    activeTask: snapshot.state.activeTask,
    note: "pending_guidance_saved",
    summary: "已记录补充引导：" + buildPromptPreview(text),
    mode: snapshot.state.mode,
  });
  return readLoopSnapshot(startDir);
}

export async function clearPendingGuidance(startDir = process.cwd()) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const at = nowIso();
  const nextThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    snapshot.state,
    {
      pendingUserGuidance: "",
      pendingUserGuidanceAt: "",
      latestSummary: "已清空未发送的补充引导。",
      latestEventType: "pending_guidance_cleared",
      lastUpdatedAt: at,
    },
  );

  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "pending_guidance_cleared",
    at,
    threadId: nextThread.threadId,
  });
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at,
    activeTask: snapshot.state.activeTask,
    note: "pending_guidance_cleared",
    summary: "已清空未发送的补充引导。",
    mode: snapshot.state.mode,
  });
  return readLoopSnapshot(startDir);
}

export async function requestGracefulStop(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const at = nowIso();
  const reason = payload.reason || "manual stop requested";
  const finalizingSummary =
    "已收到停止指令，当前循环进入收尾状态。请完成当前批次后输出总结、验证结果和下一步建议。";
  const canStopNow = snapshot.thread.continuationStatus !== "dispatching";

  if (canStopNow) {
    await finalizeLoopAsStopped(snapshot, reason);
    return readLoopSnapshot(startDir);
  }

  const nextState = {
    ...snapshot.state,
    stopRequested: true,
    finalizeRequested: true,
    recentSummary: finalizingSummary,
    lastNote: reason,
  };
  const decision = decideLoopMode({
    budgets: nextState.budgets,
    elapsedMinutes: nextState.elapsedMinutes,
    consumedTokens: nextState.consumedTokens,
    stopRequested: true,
    finalizeRequested: true,
    currentMode: nextState.mode,
  });

  nextState.mode = decision.mode;
  nextState.events = [
    ...nextState.events,
    {
      type: "graceful_stop_requested",
      at,
      reason,
      mode: nextState.mode,
    },
  ];

  await writeJson(snapshot.paths.statePath, nextState);
  const nextThread = await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    continuationStatus: "dispatching",
    latestSummary: finalizingSummary,
    latestEventType: "graceful_stop_requested",
    lastUpdatedAt: at,
  });
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at,
    activeTask: nextState.activeTask,
    note: reason,
    summary: finalizingSummary,
    mode: nextState.mode,
  });
  return readLoopSnapshot(startDir);
}

export async function updateBudgets(startDir = process.cwd(), payload) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const nextBudgets = normalizeBudgetsPatch(payload, {
    ...snapshot.config.budgets,
    ...snapshot.state.budgets,
  });
  const nextConfig = {
    ...snapshot.config,
    budgets: {
      ...snapshot.config.budgets,
      ...nextBudgets,
    },
  };
  await saveLoopConfig(snapshot.paths.codexLoopRoot, nextConfig);

  const nextState = {
    ...snapshot.state,
    budgets: {
      ...snapshot.state.budgets,
      ...nextBudgets,
    },
  };
  await writeJson(snapshot.paths.statePath, nextState);
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({
      budgets: {
        ...(loop.budgets || {}),
        ...nextBudgets,
      },
    }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "budgets_updated",
    at: nowIso(),
    budgets: nextState.budgets,
  });
  return readLoopSnapshot(startDir);
}

export async function updateLoopSupervisor(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const supervisor = normalizeSupervisorSettings(payload);
  const savedSupervisor = hasSupervisorSettings(supervisor) ? supervisor : null;
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    () => ({
      supervisor: savedSupervisor,
    }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "loop_supervisor_updated",
    at: nowIso(),
    loopId: snapshot.config.currentRunId,
    hasSupervisor: Boolean(savedSupervisor),
  });
  return readLoopSnapshot(startDir);
}

export async function startRun(startDir = process.cwd()) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const at = nowIso();
  const continuationInFlight = snapshot.thread.continuationStatus === "dispatching";
  const startSummary = continuationInFlight
    ? "上一轮指令已发送到 Codex，正在等待这一轮返回结果。"
    : "循环已启动，等待首轮进展或 Codex 线程结果。";
  const nextState = {
    ...snapshot.state,
    startedAt: snapshot.state.startedAt || at,
    mode: "running",
    monitorOnly: false,
    stopRequested: false,
    finalizeRequested: false,
    recentSummary: startSummary,
    events: [...snapshot.state.events, { type: "run_started_from_console", at }],
  };

  await writeJson(snapshot.paths.statePath, nextState);
  const nextThread = await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    latestSummary: startSummary,
    latestActiveTask: "",
    latestHeartbeatAt: snapshot.thread.latestHeartbeatAt || "",
    latestEventType: continuationInFlight
      ? snapshot.thread.latestEventType || "codex_followup_dispatched"
      : "run_started_from_console",
    continuationEnabled: Boolean(snapshot.thread.threadId),
    continuationStatus: continuationInFlight ? "dispatching" : "idle",
    lastContinuationError: "",
    lastUpdatedAt: at,
  });
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at,
    activeTask: "",
    note: "run_started_from_console",
    summary: nextThread.latestSummary,
    mode: nextState.mode,
  });
  return readLoopSnapshot(startDir);
}

export async function sendPendingGuidanceOnce(
  startDir = process.cwd(),
  {
    dispatchThreadMessage = defaultDispatchThreadMessage,
    generateFollowupPrompt = generatePromptWithOllama,
  } = {},
) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const pendingGuidance = safeText(snapshot.thread.pendingUserGuidance, "");
  if (!pendingGuidance) {
    throw new Error("没有待发送的补充引导。");
  }

  if (snapshot.thread.continuationStatus === "dispatching") {
    throw new Error("Codex 正在处理当前轮，请等完成后再发送引导。");
  }
  if (snapshot.thread.continuationStatus === "reviewing") {
    throw new Error("本地模型正在复盘，请等复盘完成后再发送引导。");
  }

  if (snapshot.state.mode !== "running" || !snapshot.state.monitorOnly) {
    const at = nowIso();
    const monitorSummary =
      "正在以监控模式手动发送这条引导；只推进一次，不会启动自动循环。";
    const nextState = {
      ...snapshot.state,
      mode: "running",
      monitorOnly: true,
      stopRequested: false,
      finalizeRequested: false,
      recentSummary: monitorSummary,
      events: [
        ...snapshot.state.events,
        {
          type: "monitor_guidance_send_requested",
          at,
          mode: "running",
        },
      ],
    };
    await writeJson(snapshot.paths.statePath, nextState);
    const nextThread = await persistThreadMirror(
      snapshot.paths.threadPath,
      snapshot.thread,
      nextState,
      {
        latestSummary: monitorSummary,
        latestEventType: "monitor_guidance_send_requested",
        lastContinuationError: "",
        lastUpdatedAt: at,
      },
    );
    await updateRegistryLoopBinding(
      snapshot.paths.codexLoopRoot,
      snapshot.config.currentRunId,
      (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
    );
    await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
    await appendTranscriptEntry(snapshot.paths.transcriptPath, {
      at,
      activeTask: snapshot.state.activeTask,
      note: "monitor_guidance_send_requested",
      summary: monitorSummary,
      mode: nextState.mode,
    });
  }

  return runLoopTurn(startDir, {
    dispatchThreadMessage,
    generateFollowupPrompt,
  });
}

async function runLoopTurnLegacy(
  startDir = process.cwd(),
  { dispatchThreadMessage = defaultDispatchThreadMessage } = {},
) {
  const snapshot = await ensureLoopArtifacts(startDir);
  if (!snapshot.thread.threadId) {
    throw new Error("还没有绑定 Codex 线程，请先绑定目标窗口再开始循环。");
  }

  const prompt = buildVisibleThreadPrompt(snapshot);
  const dispatchAt = nowIso();
  await markDispatchWaiting(snapshot, {
    prompt,
    dispatchAt,
    promptGenerator: "template",
  });

  try {
    const dispatchResult = await dispatchThreadMessage({
      threadId: snapshot.thread.threadId,
      prompt,
      workspaceRoot: snapshot.paths.workspaceRoot,
    });
    if (safeText(dispatchResult?.lastMessage, "")) {
      return syncCodexThreadMirror(startDir, {
        latestCodexSummary: dispatchResult.lastMessage,
      }, {
        consumedPendingGuidance: snapshot.thread.pendingUserGuidance,
      });
    }
    if (!dispatchResult?.deliveryObserved) {
      throw new Error(
        "Codex 原生发送未确认送达：没有观察到目标线程收到本次指令。",
      );
    }
    return markDispatchSentWithoutCompletion(startDir, {
      consumedPendingGuidance: snapshot.thread.pendingUserGuidance,
      promptGenerator: "template",
    });
  } catch (error) {
    const failedAt = nowIso();
    const refreshed = await ensureLoopArtifacts(startDir);
    await markContinuationFailed(startDir, refreshed, {
      failedAt,
      message: error.message,
      latestSummary: "向 Codex 桌面线程发送下一轮指令失败，请检查线程绑定和桌面原生连接。",
      promptGenerator: "template",
    });
    markErrorAlreadyRecorded(error);
    throw error;
  }
}

export async function runLoopTurn(
  startDir = process.cwd(),
  {
    dispatchThreadMessage = defaultDispatchThreadMessage,
    generateFollowupPrompt = generatePromptWithOllama,
  } = {},
) {
  const layout = await resolveProjectLayout(startDir);
  const continuationKey = layout.codexLoopRoot;
  if (activeContinuationKeys.has(continuationKey)) {
    throw new Error("当前任务已经在发送或等待 Codex 回复，请不要重复点击。");
  }

  activeContinuationKeys.add(continuationKey);

  try {
  const snapshot = await ensureLoopArtifacts(startDir);
  if (!snapshot.thread.threadId) {
    throw new Error("还没有绑定 Codex 线程，请先绑定目标窗口再开始循环。");
  }
  const workspaceErrorMessage = invalidWorkspaceMessage(snapshot.health);
  if (workspaceErrorMessage) {
    const failedAt = nowIso();
    await markContinuationFailed(startDir, snapshot, {
      failedAt,
      message: workspaceErrorMessage,
      latestSummary: workspaceErrorMessage,
      promptGenerator: "workspace-check",
    });
    const error = markErrorAlreadyRecorded(new Error(workspaceErrorMessage));
    throw error;
  }
  const contextErrorMessage = missingContextMessage(snapshot.health);
  if (contextErrorMessage) {
    const failedAt = nowIso();
    await markContinuationFailed(startDir, snapshot, {
      failedAt,
      message: contextErrorMessage,
      latestSummary: contextErrorMessage,
      promptGenerator: "context-check",
    });
    const error = markErrorAlreadyRecorded(new Error(contextErrorMessage));
    throw error;
  }
  if (snapshot.thread.continuationStatus === "dispatching") {
    throw new Error("当前任务已经在发送或等待 Codex 回复，请不要重复点击。");
  }
  if (snapshot.thread.continuationStatus === "reviewing") {
    throw new Error("本地模型监督复盘正在进行，请等待复盘完成后再发送下一轮指令。");
  }
  if (
    snapshot.thread.continuationStatus === "error" &&
    /Automatic re-dispatch is disabled|still waiting for Codex completion|等待 Codex 完成|停止自动续发/i.test(
      safeText(snapshot.thread.lastContinuationError, ""),
    )
  ) {
    throw new Error(
      "上一轮还没有确认 Codex 已完成。请先等目标线程完成当前工作，再手动继续。",
    );
  }
  if (
    process.env.CODEX_THREAD_ID &&
    snapshot.thread.threadId === process.env.CODEX_THREAD_ID
  ) {
    throw new Error(
      "不能把当前 codex-loop 自己所在的 Codex 线程作为目标。请绑定另一个可见 Codex 窗口。",
    );
  }

  const fallbackPrompt = buildVisibleThreadPrompt(snapshot);
  const promptGenerator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  const useOllamaPrompt =
    (promptGenerator.enabled === true || promptGenerator.enabled === "auto") &&
    promptGenerator.provider === "ollama";
  const ollamaAutoMode = promptGenerator.enabled === "auto";
  if (!useOllamaPrompt) {
    return runLoopTurnLegacy(startDir, { dispatchThreadMessage });
  }

  let prompt = fallbackPrompt;
  let promptGenerationError = "";
  let promptGenerationWarning = "";

  try {
    prompt = await generateFollowupPrompt({
      snapshot,
      fallbackPrompt,
    });
  } catch (error) {
    promptGenerationError = safeText(
      error?.message,
      "本地模型生成续跑指令失败，请检查 Ollama 和模型配置。",
    );
    if (ollamaAutoMode) {
      promptGenerationWarning =
        "Ollama 暂时不可用，已降级为精简续跑指令。建议启动 Ollama 或在设置里选择可用模型。";
      promptGenerationError = "";
      prompt = fallbackPrompt;
    } else {
      const failedAt = nowIso();
      const refreshed = await ensureLoopArtifacts(startDir);
    await markContinuationFailed(startDir, refreshed, {
      failedAt,
      message: promptGenerationError,
      latestSummary: "本地模型生成续跑指令失败，请检查 Ollama 和模型配置。",
      promptGenerationError,
      promptGenerator: "ollama",
    });
    throw new Error("本地模型生成续跑指令失败，请检查 Ollama 和模型配置。");
    }
  }

  const dispatchAt = nowIso();
  await markDispatchWaiting(snapshot, {
    prompt,
    dispatchAt,
    promptGenerator: promptGenerationWarning ? "template" : "ollama",
    promptGenerationError,
    promptGenerationWarning,
  });

  try {
    const dispatchResult = await dispatchThreadMessage({
      threadId: snapshot.thread.threadId,
      prompt,
      workspaceRoot: snapshot.paths.workspaceRoot,
    });
    if (safeText(dispatchResult?.lastMessage, "")) {
      return syncCodexThreadMirror(startDir, {
        latestCodexSummary: dispatchResult.lastMessage,
      }, {
        consumedPendingGuidance: snapshot.thread.pendingUserGuidance,
      });
    }
    if (!dispatchResult?.deliveryObserved) {
      throw new Error(
        "Codex 原生发送未确认送达：没有观察到目标线程收到本次指令。",
      );
    }
    return markDispatchSentWithoutCompletion(startDir, {
      consumedPendingGuidance: snapshot.thread.pendingUserGuidance,
      promptGenerator: promptGenerationWarning ? "template" : "ollama",
      promptGenerationError,
      promptGenerationWarning,
    });
  } catch (error) {
    const failedAt = nowIso();
    const refreshed = await ensureLoopArtifacts(startDir);
    await markContinuationFailed(startDir, refreshed, {
      failedAt,
      message: error.message,
      latestSummary: "向 Codex 桌面线程发送下一轮指令失败，请检查线程绑定和桌面原生连接。",
      promptGenerationError,
      promptGenerator: promptGenerationWarning ? "template" : "ollama",
    });
    markErrorAlreadyRecorded(error);
    throw error;
  }
  } finally {
    activeContinuationKeys.delete(continuationKey);
  }
}

export async function renameLoop(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const loopName = (payload.loopName || "").trim();
  if (!loopName) {
    throw new Error("loopName is required");
  }

  const nextConfig = { ...snapshot.config, loopName };
  const nextState = {
    ...snapshot.state,
    loopName,
    events: [...snapshot.state.events, { type: "loop_renamed", at: nowIso(), loopName }],
  };

  await saveLoopConfig(snapshot.paths.codexLoopRoot, nextConfig);
  const updatedLoop = await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({
      name: loopName,
      threadTitle: payload.threadTitle || loop.threadTitle,
      threadBinding: {
        ...(loop.threadBinding || {}),
        threadTitle: payload.threadTitle || loop.threadTitle,
      },
    }),
  );

  await writeJson(snapshot.paths.statePath, nextState);
  await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    threadTitle: payload.threadTitle ?? updatedLoop.threadTitle,
    lastUpdatedAt: nowIso(),
  });
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  return readLoopSnapshot(startDir);
}

export async function listLoops(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { registry } = await loadLoopRegistry(layout, config);
  return summarizeLoopRegistry(registry);
}

export async function createProject(startDir = process.cwd(), payload = {}) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { registry, registryPath } = await loadLoopRegistry(layout, config);
  const projectName = safeText(payload.projectName || payload.name, "");
  if (!projectName) {
    throw new Error("projectName is required");
  }

  const normalizedProjects = normalizeRegistryProjects(registry);
  const existingProject = normalizedProjects.find(
    (project) => project.name.toLocaleLowerCase() === projectName.toLocaleLowerCase(),
  );
  if (existingProject) {
    return {
      ...summarizeLoopRegistry({
        ...registry,
        projects: normalizedProjects,
      }),
      createdProject: existingProject,
      alreadyExists: true,
    };
  }

  const nextProject = buildProjectEntry({
    name: projectName,
    workspaceRoot: payload.workspaceRoot || "",
    projectAdapter: payload.projectAdapter || config.projectAdapter || "generic",
  });
  const nextRegistry = {
    ...registry,
    projects: [...normalizedProjects, nextProject],
  };
  await writeJson(registryPath, nextRegistry);

  return {
    ...summarizeLoopRegistry(nextRegistry),
    createdProject: {
      ...nextProject,
      taskCount: 0,
      isEmpty: true,
    },
  };
}

export async function createLoop(startDir = process.cwd(), payload = {}) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { registry, registryPath } = await loadLoopRegistry(layout, config);
  const loopName = (payload.loopName || "").trim();
  if (!loopName) {
    throw new Error("loopName is required");
  }

  const requestedId = payload.loopId || payload.runId || loopName;
  const loopId = buildSafeLoopId(
    requestedId,
    payload.projectName ? `${payload.projectName}-${loopName}` : "",
    "loop",
  );
  if (!loopId) {
    throw new Error("loopId is required");
  }
  if (registry.loops.some((loop) => loop.id === loopId)) {
    throw new Error(`loop already exists: ${loopId}`);
  }

  const nextLoop = buildLoopEntry({
    id: loopId,
    name: loopName,
    threadTitle: payload.threadTitle || loopName,
    branch: payload.branch || config.branch || "dev",
    projectName: payload.projectName || config.projectName || "project",
    projectAdapter:
      payload.projectAdapter || config.projectAdapter || config.projectName || "generic",
    workspaceRoot: payload.workspaceRoot || config.workspaceRoot || layout.workspaceRoot,
    budgets: { ...config.budgets, ...(payload.budgets || {}) },
    startContextPaths: normalizeLoopContextPaths(
      payload.startContextPaths || [],
      payload.docs || null,
    ),
    docs: payload.docs || null,
    git: payload.git || null,
    creation: payload.creation || null,
    threadBinding: createLoopThreadBinding(
      {
        ...config,
        currentRunId: loopId,
        loopName,
        threadTitle: payload.threadTitle || loopName,
        projectName: payload.projectName || config.projectName || "project",
        workspaceRoot: payload.workspaceRoot || config.workspaceRoot || layout.workspaceRoot,
      },
      {
        workspaceName: payload.projectName || config.projectName || "project",
        threadTitle: payload.threadTitle || loopName,
      },
    ),
  });

  const nextRegistry = {
    ...registry,
    projects: normalizeRegistryProjects({
      ...registry,
      projects: registry.projects || [],
      loops: [...registry.loops, nextLoop],
    }),
    loops: [...registry.loops, nextLoop],
  };
  await writeJson(registryPath, nextRegistry);
  return summarizeLoopRegistry(nextRegistry);
}

export async function selectLoop(startDir = process.cwd(), payload = {}) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { registry, registryPath } = await loadLoopRegistry(layout, config);
  const loop = registry.loops.find((item) => item.id === payload.loopId);
  if (!loop) {
    throw new Error(`loop not found: ${payload.loopId}`);
  }

  const nextRegistry = {
    ...registry,
    currentLoopId: loop.id,
    loops: registry.loops.map((item) =>
      item.id === loop.id ? { ...item, updatedAt: nowIso() } : item,
    ),
  };
  await writeJson(registryPath, nextRegistry);
  await saveLoopConfig(layout.codexLoopRoot, applyLoopToConfig(config, loop));

  const selectedSnapshot = await ensureLoopArtifacts(startDir);
  const hasBoundThread = Boolean(selectedSnapshot.thread.threadId);
  const generatedNote = hasBoundThread
    ? "当前任务：" +
      loop.name +
      "，已绑定线程 " +
      (selectedSnapshot.thread.threadTitle || loop.threadTitle) +
      "（" +
      selectedSnapshot.thread.threadId +
      "）。"
    : "当前任务：" + loop.name + "，尚未绑定可见线程，请先完成线程绑定再启动续跑。";
  const currentNote = safeText(selectedSnapshot.thread.note, "");
  const isSystemLoopNote = currentNote.startsWith("当前 loop：") || currentNote.startsWith("当前任务：");
  const nextNote = currentNote && !isSystemLoopNote ? currentNote : generatedNote;
  await persistThreadMirror(
    selectedSnapshot.paths.threadPath,
    selectedSnapshot.thread,
    selectedSnapshot.state,
    {
      note: nextNote,
      lastUpdatedAt: nowIso(),
    },
  );
  await updateRegistryLoopBinding(
    selectedSnapshot.paths.codexLoopRoot,
    selectedSnapshot.config.currentRunId,
    (currentLoop) => ({
      threadBinding: {
        ...(currentLoop.threadBinding || {}),
        ...selectedSnapshot.thread,
        note: nextNote,
      },
    }),
  );

  return readLoopSnapshot(startDir);
}

export async function deleteLoop(startDir = process.cwd(), payload = {}) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { registry, registryPath } = await loadLoopRegistry(layout, config);
  if (!payload.loopId) {
    throw new Error("loopId is required");
  }
  if (payload.loopId === registry.currentLoopId) {
    throw new Error("cannot delete the active loop");
  }

  const targetLoop = registry.loops.find((loop) => loop.id === payload.loopId);
  if (!targetLoop) {
    throw new Error(`loop not found: ${payload.loopId}`);
  }

  const automationResult = await deleteAutomationForThread(targetLoop.threadBinding || {});

  const nextRegistry = {
    ...registry,
    loops: registry.loops.filter((loop) => loop.id !== payload.loopId),
  };
  await writeJson(registryPath, nextRegistry);
  return {
    ...summarizeLoopRegistry(nextRegistry),
    deletedLoopId: payload.loopId,
    automationCleanup: automationResult,
  };
}

export async function getLoopCreationAssistantState(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const { state } = await loadLoopAssistantState(layout);
  return state;
}

export async function restartLoopCreationAssistant(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const { assistantPath } = await loadLoopAssistantState(layout);
  return saveLoopAssistantState(assistantPath, createInitialLoopAssistantState());
}

export async function goBackLoopCreationAssistant(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const { assistantPath, state } = await loadLoopAssistantState(layout);
  const draft = normalizeAssistantDraft(state);
  const previousState = buildAssistantPreviousState(state, draft);
  return saveLoopAssistantState(assistantPath, {
    ...previousState,
    messages: appendAssistantMessage(
      state.messages || [],
      "assistant",
      "已返回上一步，你可以重新填写这一项。",
      "go_back",
    ),
  });
}

export async function replyLoopCreationAssistant(startDir = process.cwd(), payload = {}) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { assistantPath, state } = await loadLoopAssistantState(layout);
  const answer = safeText(payload.answer, "");
  const draft = normalizeAssistantDraft(state);
  const messageHistory = appendAssistantMessage(
    appendAssistantMessage(state.messages || [], "user", answer),
    "assistant",
    state.currentQuestion?.prompt || "",
    state.currentQuestion?.id || "",
  );

  if (state.step === "workspace_root") {
    const workspaceRoot = path.resolve(answer);
    const git = await detectGitMetadata(workspaceRoot);
    const docs = await collectLoopDocs(workspaceRoot);
    const projectProfile = await detectProjectProfileForAssistant(workspaceRoot);
    const nextState = {
      ...state,
      status: "collecting",
      step: "project_name",
      draft: {
        ...draft,
        workspaceRoot,
        projectName: projectProfile.detectedProjectName,
        branch: normalizeBranchName(git.branch || config.branch || "dev"),
        git,
        docs,
        projectProfile,
      },
      messages: appendAssistantMessage(
        state.messages || [],
        "assistant",
        "已识别项目路径：" + workspaceRoot + "。接下来先确认这个项目在左侧如何显示。",
        "workspace_root",
      ),
      currentQuestion: buildLoopAssistantQuestion("project_name", {
        ...draft,
        projectName: projectProfile.detectedProjectName,
      }),
    };
    return saveLoopAssistantState(assistantPath, nextState);
  }

  if (state.step === "project_name") {
    if (payload.planner?.enabled && !draft.intent && looksLikePlanningIntent(answer)) {
      const plan = payload.planLoop
        ? await payload.planLoop({ draft, answer })
        : await planLoopWithFallback({
            draft,
            answer,
            model: payload.planner?.model,
            baseUrl: payload.planner?.baseUrl,
          });
      const suggestedProjectName =
        safeText(plan.suggestedProjectName, "") ||
        draft.projectName ||
        path.basename(draft.workspaceRoot);
      const suggestedLoopName =
        safeText(plan.suggestedLoopName, "") || draft.loopName;
      const suggestedBranch =
        normalizeBranchName(
          plan.suggestedBranch,
          draft.git.branch || draft.branch || "dev",
        );
      const nextDraft = {
        ...draft,
        intent: answer,
        projectName: suggestedProjectName,
        loopName: suggestedLoopName,
        branch: suggestedBranch,
        plan: {
          ...draft.plan,
          ...plan,
          pendingField: "project_name",
        },
      };
      return saveLoopAssistantState(assistantPath, {
        ...state,
        step: "plan_review",
        draft: nextDraft,
        messages: appendAssistantMessage(
          state.messages || [],
          "assistant",
          "我已经根据项目线索整理出首版计划：" +
            safeText(plan.objectiveSummary, "继续推进当前任务") +
            "。接下来逐项确认关键设置。",
          "plan_ready",
        ),
        currentQuestion: buildLoopAssistantQuestion("plan_review", nextDraft),
      });
    }

    const nextDraft = {
      ...draft,
      projectName: answer || draft.projectName || path.basename(draft.workspaceRoot),
    };
    return saveLoopAssistantState(assistantPath, {
      ...state,
      step: "loop_name",
      draft: nextDraft,
      messages: appendAssistantMessage(
        state.messages || [],
        "assistant",
        "项目名已记录，接下来确认这个任务的名称。",
        "project_name",
      ),
      currentQuestion: buildLoopAssistantQuestion("loop_name", nextDraft),
    });
  }

  if (state.step === "plan_review") {
    const nextDraft = applyPlanReviewAnswer(draft, answer);
    const pendingField = safeText(nextDraft.plan?.pendingField, "");
    if (pendingField) {
      return saveLoopAssistantState(assistantPath, {
        ...state,
        draft: nextDraft,
        messages: appendAssistantMessage(
          state.messages || [],
          "assistant",
          "已记录这一项，我们继续确认下一项关键设置。",
          pendingField,
        ),
        currentQuestion: buildLoopAssistantQuestion("plan_review", nextDraft),
      });
    }

    return saveLoopAssistantState(assistantPath, {
      ...state,
      step: "docs_confirmed",
      draft: nextDraft,
      messages: appendAssistantMessage(
        state.messages || [],
        "assistant",
        "关键设置已经确认完成。最后确认规则文档和补充说明，然后就可以创建任务。",
        "plan_review_done",
      ),
      currentQuestion: buildLoopAssistantQuestion("docs_confirmed", nextDraft),
    });
  }

  if (state.step === "loop_name") {
    const nextDraft = {
      ...draft,
      loopName: answer || draft.loopName || draft.plan?.suggestedLoopName,
    };
    return saveLoopAssistantState(assistantPath, {
      ...state,
      step: "branch",
      draft: nextDraft,
      messages: appendAssistantMessage(
        state.messages || [],
        "assistant",
        "任务名已记录，接下来确认工作分支。",
        "loop_name",
      ),
      currentQuestion: buildLoopAssistantQuestion("branch", nextDraft),
    });
  }

  if (state.step === "branch") {
    const nextDraft = {
      ...draft,
      branch: normalizeBranchName(
        answer,
        draft.plan?.suggestedBranch || draft.git.branch || draft.branch || "dev",
      ),
    };
    return saveLoopAssistantState(assistantPath, {
      ...state,
      step: "docs_confirmed",
      draft: nextDraft,
      messages: appendAssistantMessage(
        state.messages || [],
        "assistant",
        "分支已记录。最后确认规则文档或补充说明，然后就可以创建任务。",
        "branch",
      ),
      currentQuestion: buildLoopAssistantQuestion("docs_confirmed", nextDraft),
    });
  }

  let docs = {
    ...draft.docs,
    ruleDocs: [...(draft.docs?.ruleDocs || [])],
    devDocs: [...(draft.docs?.devDocs || [])],
    notes: [...(draft.docs?.notes || [])],
  };
  if (answer && answer.toLowerCase() !== "confirm") {
    docs.devDocs = [...new Set([...docs.devDocs, path.resolve(answer)])];
  }

  const createdAt = nowIso();
  const creationMetadata = buildLoopCreationMetadata({
    draft,
    docs,
    confirmedAt: createdAt,
  });
  const loopRegistry = await createLoop(startDir, {
    loopName: draft.loopName,
    runId: buildSafeLoopId(draft.loopName, draft.projectName, "assistant-loop"),
    threadTitle: draft.loopName,
    branch: draft.branch,
    projectName: draft.projectName,
    projectAdapter: config.projectAdapter || config.projectName || "generic",
    workspaceRoot: draft.workspaceRoot,
    docs,
    git: draft.git,
    startContextPaths: [...docs.ruleDocs, ...docs.devDocs],
    creation: creationMetadata,
  });
  const createdLoopId = buildSafeLoopId(draft.loopName, draft.projectName, "assistant-loop");
  const createdLoop =
    loopRegistry.loops.find((loop) => loop.id === createdLoopId) ||
    loopRegistry.loops.find((loop) => loop.id === loopRegistry.currentLoopId) ||
    loopRegistry.loops.at(-1);

  return saveLoopAssistantState(assistantPath, {
    status: "completed",
    step: "completed",
    draft: {
      ...draft,
      docs,
    },
    currentQuestion: null,
    messages: appendAssistantMessage(
      state.messages || [],
      "assistant",
      "任务已创建：" + createdLoop.name + "，已归入项目 " + createdLoop.projectName + "。",
      "completed",
    ),
    createdLoop: {
      loop: createdLoop,
      summary: "已创建任务「" + createdLoop.name + "」，归入项目「" + createdLoop.projectName + "」。",
    },
  });
}

export async function recordError(startDir = process.cwd(), payload) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const nextError = {
    message: payload.message || "",
    area: payload.area || "",
    updatedAt: nowIso(),
  };
  await writeJson(snapshot.paths.errorPath, nextError);
  await appendJsonLine(snapshot.paths.logPath, {
    type: "error_recorded",
    at: nextError.updatedAt,
    message: nextError.message,
    area: nextError.area,
  });
  return readLoopSnapshot(startDir);
}

export async function recordHeartbeat(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const at = nowIso();
  const nextState = applyHeartbeat(snapshot.state, {
    consumedTokens:
      Number.isFinite(payload.consumedTokens) ? payload.consumedTokens : undefined,
    activeTask: payload.activeTask,
    note: payload.note,
    progressSummary: payload.progressSummary,
    nowIso: at,
  });

  await writeJson(snapshot.paths.statePath, nextState);
  const nextThread = await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    latestActiveTask: nextState.activeTask,
    latestSummary: nextState.recentSummary || nextState.lastNote,
    latestHeartbeatAt: at,
    latestEventType: nextState.events.at(-1)?.type || snapshot.thread.latestEventType,
    lastUpdatedAt: at,
  });
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  await fs.appendFile(
    snapshot.paths.transcriptPath,
    buildTranscriptEntry({
      at,
      activeTask: nextState.activeTask,
      note: nextState.lastNote,
      summary: nextState.recentSummary,
    }),
    "utf8",
  );
  await fs.appendFile(
    snapshot.paths.transcriptPath,
    `\n- Thread mirror mode: ${nextThread.latestMode}\n`,
    "utf8",
  );
  return readLoopSnapshot(startDir);
}

export async function exportLoopSummary(startDir = process.cwd()) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const summaryPayload = buildSummaryPayload(snapshot);
  const summaryPath = path.join(snapshot.paths.runtimeDir, "summary.json");
  await writeJson(summaryPath, summaryPayload);
  await appendJsonLine(snapshot.paths.logPath, {
    type: "summary_exported",
    at: summaryPayload.summaryGeneratedAt,
    summaryPath,
  });
  return summaryPayload;
}

async function resolveVisibleCodexSummary(
  snapshot,
  rawCodexSummary,
  {
    generateCodexSummary = generateCodexSummaryWithOllama,
  } = {},
) {
  const cleanSummary = safeText(rawCodexSummary, "");
  const generator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  if (!cleanSummary || !generator.enabled || generator.provider !== "ollama") {
    return {
      summary: cleanSummary,
      source: "raw",
      error: "",
    };
  }

  try {
    return {
      summary: await generateCodexSummary({
        snapshot,
        codexText: cleanSummary,
      }),
      source: "ollama",
      error: "",
    };
  } catch (error) {
    return {
      summary: cleanSummary,
      source: "raw",
      error: safeText(error?.message, "本地模型整理 Codex 回复失败。"),
    };
  }
}

function buildFallbackMilestoneReview(snapshot) {
  const latestCodexSummary = safeText(snapshot.thread.latestCodexSummary, "");
  const pendingGuidance = safeText(snapshot.thread.pendingUserGuidance, "");
  const verificationCommands = normalizeTextList(
    [
      ...(Array.isArray(snapshot.config?.verification?.commands)
        ? snapshot.config.verification.commands
        : []),
      ...(Array.isArray(snapshot.profile?.resolved?.verification?.commands)
        ? snapshot.profile.resolved.verification.commands
        : []),
    ],
    5,
    120,
  );
  const focus = firstNonEmpty(
    pendingGuidance,
    latestCodexSummary,
    snapshot.thread.lastAssistantActionSummary,
    snapshot.thread.lastUserInstructionSummary,
    "继续当前最高优先级、边界清晰、可验证的小任务。",
  );

  return {
    summary: latestCodexSummary
      ? "Codex 已完成上一轮，可进入监督复盘后的下一步推进。"
      : "Codex 已返回完成信号，可继续下一轮小步推进。",
    nextInstruction:
      "请基于项目文档、开发规则和上一轮结果，继续推进：" +
      summarizeForFollowup(focus, 260) +
      "。优先做一小批可验证改动；完成后回复改动摘要、验证结果和下一步建议。",
    shouldContinue: true,
    needsIndependentVerification: true,
    verificationCommands,
    acceptanceFocus: [
      "确认上一轮改动是否符合用户目标和文档规则。",
      "优先检查最影响用户判断 loop 状态的可见问题。",
    ],
    risks: [],
  };
}

function normalizeMilestoneReviewResult(result = {}, fallback = {}) {
  const summary = safeText(result.summary, fallback.summary);
  const nextInstruction = safeText(result.nextInstruction, fallback.nextInstruction);
  const risks = normalizeTextList(result.risks, 5, 120);
  const verificationCommands = normalizeTextList(
    result.verificationCommands?.length ? result.verificationCommands : fallback.verificationCommands,
    5,
    120,
  );
  const acceptanceFocus = normalizeTextList(
    result.acceptanceFocus?.length ? result.acceptanceFocus : fallback.acceptanceFocus,
    5,
    120,
  );
  return {
    summary: summarizeForFollowup(summary, 420),
    nextInstruction: summarizeForFollowup(nextInstruction, 700),
    shouldContinue: result.shouldContinue !== false,
    needsIndependentVerification:
      result.needsIndependentVerification ?? fallback.needsIndependentVerification ?? false,
    verificationCommands,
    acceptanceFocus,
    risks,
  };
}

function buildMilestoneReviewDecisionContext(snapshot, fallbackReview = {}) {
  return [
    snapshot.thread.latestCodexSummary,
    snapshot.thread.lastAssistantActionSummary,
    snapshot.thread.lastUserInstructionSummary,
    snapshot.thread.pendingUserGuidance,
    snapshot.state.recentSummary,
    fallbackReview.summary,
    fallbackReview.nextInstruction,
  ]
    .map((item) => safeText(item, ""))
    .filter(Boolean)
    .join("\n");
}

export async function reviewCodexMilestone(
  startDir = process.cwd(),
  {
    generateMilestoneReview = generateMilestoneReviewWithOllama,
    runVerificationCommand = defaultRunSupervisorVerificationCommand,
  } = {},
) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const at = nowIso();
  await markSupervisorReviewStarted(snapshot, { at });
  const fallbackReview = buildFallbackMilestoneReview(snapshot);
  const generator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  const useOllamaReview =
    (generator.enabled === true || generator.enabled === "auto") &&
    generator.provider === "ollama";
  const ollamaAutoMode = generator.enabled === "auto";
  const englishPreferred = safeText(
    snapshot.profile?.resolved?.conversation?.language,
    "zh-CN",
  )
    .toLowerCase()
    .startsWith("en");

  let review = fallbackReview;
  let source = "template";
  let warning = "";

  if (useOllamaReview) {
    try {
      review = normalizeMilestoneReviewResult(
        await generateMilestoneReview({
          snapshot,
          fallbackReview,
        }),
        fallbackReview,
      );
      source = "ollama";
    } catch (error) {
      warning = safeText(
        error?.message,
        "本地模型监督复盘失败，已使用精简复盘继续推进。",
      );
      if (!ollamaAutoMode) {
        throw new Error("本地模型监督复盘失败，请检查 Ollama 和模型配置。");
      }
      review = fallbackReview;
      source = "template";
    }
  }

  review = resolveReviewHumanDeferral({
    review,
    context: buildMilestoneReviewDecisionContext(snapshot, fallbackReview),
    englishPreferred,
  });

  const verification = await runSupervisorIndependentVerification(snapshot, review, {
    runVerificationCommand,
  });
  const nextInstruction = injectVerificationIntoInstruction(
    review.nextInstruction,
    verification,
  );
  const pausedMessage = "监督复盘建议暂停等待人工确认。";
  const pauseFailure = review.shouldContinue
    ? null
    : classifyContinuationFailure({
        message: pausedMessage,
        latestSummary: review.summary,
      });

  const nextThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    snapshot.state,
    {
      continuationStatus: review.shouldContinue ? "idle" : "error",
      lastSupervisorReview: review.summary,
      lastSupervisorReviewAt: at,
      lastSupervisorInstruction: nextInstruction,
      lastSupervisorSource: source,
      supervisorNeedsIndependentVerification: Boolean(review.needsIndependentVerification),
      lastSupervisorVerificationCommands: review.verificationCommands,
      lastSupervisorAcceptanceFocus: review.acceptanceFocus,
      lastSupervisorVerificationStatus: verification.status,
      lastSupervisorVerificationSummary: verification.summary,
      lastSupervisorVerificationResults: verification.results,
      lastSupervisorVerificationAt: verification.ranAt,
      supervisorReviewWarning: warning,
      latestSummary: review.summary,
      latestEventType: review.shouldContinue
        ? "supervisor_review_completed"
        : "supervisor_review_skipped",
      lastContinuationError: review.shouldContinue ? "" : pausedMessage,
      lastContinuationFailureCategory: pauseFailure?.category || "",
      lastContinuationFailureLabel: pauseFailure?.label || "",
      lastContinuationFailureSeverity: pauseFailure?.severity || "",
      lastContinuationFailureMessage: pauseFailure?.userMessage || "",
      lastContinuationFailureAction: pauseFailure?.nextAction || "",
      lastUpdatedAt: at,
    },
  );

  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: review.shouldContinue
      ? "supervisor_review_completed"
      : "supervisor_review_skipped",
    at,
    threadId: nextThread.threadId,
    source,
    warning,
    summary: review.summary,
    nextInstructionPreview: buildPromptPreview(nextInstruction),
    needsIndependentVerification: Boolean(review.needsIndependentVerification),
    verificationCommands: review.verificationCommands,
    verificationStatus: verification.status,
    verificationSummary: verification.summary,
    verificationResults: verification.results,
    acceptanceFocus: review.acceptanceFocus,
    risks: review.risks,
    autoResolvedHumanDeferral: Boolean(review.autoResolvedHumanDeferral),
  });
  if (verification.status && verification.status !== "not_requested") {
    await appendJsonLine(snapshot.paths.logPath, {
      type: "supervisor_verification_completed",
      at: verification.ranAt || at,
      threadId: nextThread.threadId,
      status: verification.status,
      summary: verification.summary,
      results: verification.results,
    });
  }
  await appendTranscriptEntry(snapshot.paths.transcriptPath, {
    at,
    activeTask: snapshot.state.activeTask,
    note: "supervisor_review_completed",
    summary:
      review.summary +
      (verification.summary ? " " + verification.summary : "") +
      " 下一步：" +
      buildPromptPreview(nextInstruction),
    mode: snapshot.state.mode,
  });

  return readLoopSnapshot(startDir);
}

export async function syncCodexThreadMirror(
  startDir = process.cwd(),
  payload = {},
  {
    generateCodexSummary = generateCodexSummaryWithOllama,
    consumedPendingGuidance = "",
  } = {},
) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const visibleSummary = await resolveVisibleCodexSummary(
    snapshot,
    payload.latestCodexSummary,
    { generateCodexSummary },
  );
  const nextCodexSummary = sanitizeCodexSummary(visibleSummary.summary, {
    previous: snapshot.thread.latestCodexSummary,
    threadId: snapshot.thread.threadId,
  });
  const at = nowIso();
  const codexSummaryChanged =
    nextCodexSummary && nextCodexSummary !== safeText(snapshot.thread.latestCodexSummary, "");
  const completedCurrentDispatch =
    snapshot.thread.continuationStatus === "dispatching" && codexSummaryChanged;
  const nextPendingGuidance = completedCurrentDispatch
    ? pendingGuidanceAfterDispatch(snapshot.thread, consumedPendingGuidance)
    : {
        pendingUserGuidance: snapshot.thread.pendingUserGuidance,
        pendingUserGuidanceAt: snapshot.thread.pendingUserGuidanceAt,
      };
  const nextThread = {
    ...snapshot.thread,
    lastUserInstructionSummary:
      payload.lastUserInstructionSummary ??
      snapshot.thread.lastUserInstructionSummary ??
      "",
    lastAssistantActionSummary:
      payload.lastAssistantActionSummary ??
      snapshot.thread.lastAssistantActionSummary ??
      "",
    latestCodexSummary: nextCodexSummary,
    continuationStatus:
      completedCurrentDispatch
        ? "idle"
        : snapshot.thread.continuationStatus,
    continuationCycleCount:
      completedCurrentDispatch
        ? (snapshot.thread.continuationCycleCount || 0) + 1
        : snapshot.thread.continuationCycleCount,
    lastCompletionAt:
      completedCurrentDispatch
        ? at
        : snapshot.thread.lastCompletionAt,
    lastContinuationError: completedCurrentDispatch
      ? ""
      : snapshot.thread.lastContinuationError,
    ...nextPendingGuidance,
    latestEventType:
      completedCurrentDispatch
        ? "codex_followup_completed"
        : snapshot.thread.latestEventType,
    latestSummary:
      completedCurrentDispatch
        ? "Codex 已返回这一轮的新结果，可以开始下一轮。"
        : snapshot.thread.latestSummary,
    lastUpdatedAt: at,
  };
  await writeJson(snapshot.paths.threadPath, nextThread);
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "codex_thread_mirror_synced",
    at: nextThread.lastUpdatedAt,
    threadId: nextThread.threadId,
    summarySource: visibleSummary.source,
    summaryError: visibleSummary.error,
  });
  if (codexSummaryChanged) {
    await appendJsonLine(snapshot.paths.logPath, {
      type: "codex_followup_completed",
      at,
      threadId: nextThread.threadId,
    });
    await appendTranscriptEntry(snapshot.paths.transcriptPath, {
      at,
      activeTask: snapshot.state.activeTask,
      note:
        snapshot.thread.continuationStatus === "dispatching"
          ? "codex_followup_completed"
          : "codex_thread_mirror_synced",
      summary: nextCodexSummary,
      mode: snapshot.state.mode,
    });
  }
  return readLoopSnapshot(startDir);
}
