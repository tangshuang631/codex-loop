import fs from "node:fs/promises";
import path from "node:path";

import { appendJsonLine, ensureDir, writeJson } from "../../../scripts/lib/fs-helpers.mjs";
import { loadLoopConfig, saveLoopConfig } from "../../../scripts/lib/config-loader.mjs";
import { initializeRun } from "../../../scripts/lib/init-run.mjs";
import { applyHeartbeat, decideLoopMode } from "../../../scripts/lib/state.mjs";
import { readResolvedLoopProfile } from "./adapter-store.mjs";
import { dispatchThreadMessage as defaultDispatchThreadMessage } from "./codex-dispatcher.mjs";
import { readLauncherStatus } from "./launcher-status.mjs";
import { resolveProjectLayout } from "./paths.mjs";

function nowIso() {
  return new Date().toISOString();
}

const DEFAULT_LOOP_ID = "default-run";
const OPENCOW_LOOP_ID = "opencow-continue-from-checklist";
const OPENCOW_THREAD_TITLE = "按清单继续开发";
const OPENCOW_PROGRESS_FILENAME = "开发进度清单2026.6.6-22-48.md";
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const CONTINUATION_STALLED_MS = 5 * 60 * 1000;
const TRANSCRIPT_STALE_MS = 15 * 60 * 1000;

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

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = safeText(value, "");
    if (text) {
      return text;
    }
  }
  return "";
}

function pickPreferredThreadMirror(boundThread, savedThread) {
  if (!boundThread) return savedThread || null;
  if (!savedThread) return boundThread;

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
  return `# Transcript Mirror

- 工作区：${thread.workspaceName}
- 主线程标题：${thread.threadTitle}
- 主线程 ID：${thread.threadId || "未绑定"}

本文件是本地镜像，不替代 Codex 桌面端线程历史。`;
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

function buildLoopRegistryPath(codexLoopRoot) {
  return path.join(codexLoopRoot, "settings", "loops.json");
}

function buildLoopEntry({
  id,
  name,
  threadTitle,
  branch,
  projectName,
  projectAdapter,
  budgets,
  startContextPaths = [],
  threadBinding,
}) {
  return {
    id,
    runId: id,
    name,
    threadTitle,
    branch,
    projectName,
    projectAdapter,
    budgets,
    startContextPaths,
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

function buildDefaultRegistry(config, workspaceRoot) {
  const isOpencow =
    config.projectName === "opencow" || config.projectAdapter === "opencow";

  if (!isOpencow) {
    const loopId = config.currentRunId || DEFAULT_LOOP_ID;
    return {
      currentLoopId: loopId,
      loops: [
        buildLoopEntry({
          id: loopId,
          name: config.loopName || config.projectName || "default loop",
          threadTitle: config.threadTitle || config.loopName || "未绑定线程",
          branch: config.branch || "dev",
          projectName: config.projectName || "project",
          projectAdapter: config.projectAdapter || config.projectName || "generic",
          budgets: { ...config.budgets },
          startContextPaths: [],
          threadBinding: createLoopThreadBinding(config),
        }),
      ],
      generatedAt: nowIso(),
      version: 1,
    };
  }

  const progressPath = path.join(workspaceRoot, OPENCOW_PROGRESS_FILENAME);
  const docsRoot = path.join(workspaceRoot, "docs", "v1.0");
  const rulesPath = path.join(workspaceRoot, "OPENCOW_CORE_RULES.md");

  return {
    currentLoopId: OPENCOW_LOOP_ID,
    loops: [
      buildLoopEntry({
        id: OPENCOW_LOOP_ID,
        name: OPENCOW_THREAD_TITLE,
        threadTitle: OPENCOW_THREAD_TITLE,
        branch: "dev",
        projectName: "opencow",
        projectAdapter: "opencow",
        budgets: {
          maxMinutes: 360,
          maxTokens: 120000,
          finalizeLeadMinutes: 30,
          finalizeLeadTokens: 15000,
        },
        startContextPaths: [rulesPath, docsRoot, progressPath],
        threadBinding: createLoopThreadBinding({
          projectName: "opencow",
          threadTitle: OPENCOW_THREAD_TITLE,
          loopName: OPENCOW_THREAD_TITLE,
          currentRunId: OPENCOW_LOOP_ID,
        }),
      }),
    ],
    generatedAt: nowIso(),
    version: 1,
  };
}

function applyLoopToConfig(config, loop) {
  return {
    ...config,
    projectName: loop.projectName || config.projectName,
    projectAdapter: loop.projectAdapter || config.projectAdapter || config.projectName,
    branch: loop.branch || config.branch,
    currentRunId: loop.runId || loop.id,
    loopName: loop.name,
    threadTitle: loop.threadTitle || loop.name,
    budgets: {
      ...config.budgets,
      ...loop.budgets,
    },
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
    return { registry: existingRegistry, registryPath };
  }

  const registry = buildDefaultRegistry(config, layout.workspaceRoot);
  await persistLoopRegistry(layout.codexLoopRoot, registry);

  const defaultLoop = registry.loops[0];
  await saveLoopConfig(layout.codexLoopRoot, applyLoopToConfig(config, defaultLoop));

  return { registry, registryPath };
}

function summarizeLoopRegistry(registry) {
  return {
    currentLoopId: registry.currentLoopId,
    loops: registry.loops.map((loop) => ({
      ...loop,
      threadBinding: undefined,
      boundThreadId: loop.threadBinding?.threadId || "",
      boundThreadTitle: loop.threadBinding?.threadTitle || loop.threadTitle || "",
      isCurrent: loop.id === registry.currentLoopId,
    })),
  };
}

async function readConfig(layout) {
  const { config } = await loadLoopConfig(layout.codexLoopRoot);
  return config;
}

function summarizeSnapshot({ config, state, thread, profile, paths, errorState, health }) {
  return {
    config,
    state: {
      ...state,
      modeLabel: modeLabel(state.mode),
    },
    thread,
    profile,
    paths,
    error: errorState,
    health,
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

    if (line.startsWith("- Active task: ")) {
      current.activeTask = line.slice("- Active task: ".length).trim();
      continue;
    }

    if (line.startsWith("- Note: ")) {
      current.note = line.slice("- Note: ".length).trim();
      continue;
    }

    if (line.startsWith("- Summary: ")) {
      current.summary = line.slice("- Summary: ".length).trim();
      continue;
    }

    if (line.startsWith("- Thread mirror mode: ")) {
      current.mode = line.slice("- Thread mirror mode: ".length).trim();
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries.slice(-8).reverse();
}

export async function exportMobileView(startDir = process.cwd()) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const summary = buildSummaryPayload(snapshot);
  const launcher = await readLauncherStatus(startDir);
  const transcriptText = await fs.readFile(snapshot.paths.transcriptPath, "utf8");
  const bindingNote = safeText(
    snapshot.thread.note,
    snapshot.thread.threadId
      ? `当前已绑定线程：${snapshot.thread.threadTitle || snapshot.thread.threadId}（${snapshot.thread.threadId}）`
      : "当前还没有绑定可见线程，请先绑定线程再启动或续跑。",
  );
  const suggestedAction =
    snapshot.state.mode === "finalize_after_current"
      ? "循环正在收尾，建议等待这一轮结束后查看总结、验证结果和下一步建议。"
      : snapshot.state.mode === "stopped"
        ? snapshot.thread.threadId
          ? "线程已绑定，循环已停下。可以查看总结，或在确认上下文后重新开始。"
          : "循环已停下。建议先查看本轮总结；如果要继续，再绑定线程后重新开始。"
        : snapshot.thread.threadId
          ? snapshot.thread.continuationStatus === "dispatching"
            ? "Codex 正在当前线程处理中，先等待这一轮完成。"
            : "线程已绑定，可以继续观察进展或手动续跑一轮。"
          : "建议先完成线程绑定，再开始循环，这样桌面端和手机端都能看到连续记录。";

  return {
    loop: {
      id: snapshot.config.currentRunId,
      name: snapshot.config.loopName,
      mode: snapshot.state.mode,
      modeLabel: snapshot.state.modeLabel,
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
    bindingNote,
    suggestedAction,
    latestPrompt: snapshot.thread.lastDispatchPrompt || "",
    transcriptEntries: parseTranscriptEntries(transcriptText),
    generatedAt: nowIso(),
  };
}

function buildTranscriptEntry({ at, activeTask, note, summary }) {
  return [
    "",
    `## ${at}`,
    `- Active task: ${activeTask || "n/a"}`,
    `- Note: ${note || "n/a"}`,
    `- Summary: ${summary || "n/a"}`,
  ].join("\n");
}

function buildThreadMirror(thread, state, overrides = {}) {
  const latestEventType =
    overrides.latestEventType ??
    state.events?.at(-1)?.type ??
    thread.latestEventType ??
    "";

  return {
    ...thread,
    ...overrides,
    currentRunId: overrides.currentRunId ?? thread.currentRunId ?? state.currentRunId,
    latestMode: overrides.latestMode ?? state.mode,
    latestModeLabel: overrides.latestModeLabel ?? modeLabel(state.mode),
    latestActiveTask: firstNonEmpty(
      overrides.latestActiveTask,
      state.activeTask,
      thread.latestActiveTask,
    ),
    latestSummary: firstNonEmpty(
      overrides.latestSummary,
      state.recentSummary,
      state.lastNote,
      thread.latestSummary,
    ),
    latestHeartbeatAt: firstNonEmpty(
      overrides.latestHeartbeatAt,
      state.lastHeartbeatAt,
      thread.latestHeartbeatAt,
    ),
    latestEventType,
    latestVerification: overrides.latestVerification ?? thread.latestVerification ?? "",
    continuationStatus:
      overrides.continuationStatus ?? thread.continuationStatus ?? "idle",
    continuationEnabled:
      overrides.continuationEnabled ?? thread.continuationEnabled ?? false,
    continuationCycleCount:
      overrides.continuationCycleCount ?? thread.continuationCycleCount ?? 0,
    lastDispatchAt: overrides.lastDispatchAt ?? thread.lastDispatchAt ?? "",
    lastCompletionAt: overrides.lastCompletionAt ?? thread.lastCompletionAt ?? "",
    lastDispatchPrompt:
      overrides.lastDispatchPrompt ?? thread.lastDispatchPrompt ?? "",
    lastContinuationError:
      overrides.lastContinuationError ?? thread.lastContinuationError ?? "",
    lastUpdatedAt: overrides.lastUpdatedAt ?? nowIso(),
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
  const instructions =
    snapshot.config.projectAdapter === "opencow"
      ? [
          "继续严格按照 OPENCOW_CORE_RULES.md、docs/v1.0 和当前开发进度清单执行。",
          "保持在同一个可见线程内续接刚刚完成的工作，不要重开话题。",
          "先完成当前最重要的一小批改动，再给出已做内容、验证结果、下一步，并继续推进。",
        ]
      : [
          "Continue the same Codex thread from its latest verified checkpoint.",
          "Use the current loop settings and latest thread summary as the source of truth.",
          "After the next bounded batch, report progress, verification, and the next step.",
        ];

  return [
    ...instructions,
    "",
    "当前循环上下文：",
    `- 循环名称：${safeText(snapshot.config.loopName, snapshot.config.projectName)}`,
    `- 线程标题：${safeText(snapshot.thread.threadTitle, "未绑定线程")}`,
    `- 分支：${safeText(snapshot.config.branch, "dev")}`,
    `- 用户意图摘要：${safeText(snapshot.thread.lastUserInstructionSummary, "继续当前循环")}`,
    `- 上一轮 Codex 动作：${safeText(snapshot.thread.lastAssistantActionSummary, "暂无")}`,
    `- 最近 Codex 摘要：${safeText(snapshot.thread.latestCodexSummary, "暂无")}`,
  ].join("\n");
}

async function fileHealth(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
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
    throw error;
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
  const checks = await Promise.all([
    fileHealth(paths.statePath, "state"),
    fileHealth(paths.threadPath, "thread"),
    fileHealth(paths.transcriptPath, "transcript"),
    fileHealth(paths.errorPath, "error"),
    fileHealth(paths.logPath, "events"),
  ]);
  return buildHealthSummary(checks, state, thread, errorState);
}

export async function ensureLoopArtifacts(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const initialConfig = await readConfig(layout);
  const { registry } = await loadLoopRegistry(layout, initialConfig);
  const config = await readConfig(layout);
  const currentLoop =
    registry.loops.find((loop) => loop.id === config.currentRunId) || registry.loops[0];

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
  const profile = await readResolvedLoopProfile(startDir);
  const paths = {
    runtimeDir,
    statePath,
    logPath,
    transcriptPath,
    threadPath,
    errorPath,
    workspaceRoot: layout.workspaceRoot,
    codexLoopRoot: layout.codexLoopRoot,
  };
  const health = await inspectLoopHealth(paths, state, thread, errorState);

  return summarizeSnapshot({
    config,
    state,
    thread,
    profile,
    paths,
    errorState,
    health,
  });
}

export async function readLoopSnapshot(startDir = process.cwd()) {
  return ensureLoopArtifacts(startDir);
}

export async function saveThreadBinding(startDir = process.cwd(), payload) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const updatedThread = {
    ...snapshot.thread,
    workspaceName: payload.workspaceName ?? snapshot.thread.workspaceName,
    threadTitle: payload.threadTitle ?? snapshot.thread.threadTitle,
    threadId: payload.threadId ?? snapshot.thread.threadId,
    singleThreadMode: payload.singleThreadMode ?? snapshot.thread.singleThreadMode,
    note: payload.note ?? snapshot.thread.note,
    heartbeatAutomation:
      payload.heartbeatAutomation ?? snapshot.thread.heartbeatAutomation,
  };

  const nextThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    updatedThread,
    snapshot.state,
    {
      continuationEnabled: Boolean(payload.threadId ?? snapshot.thread.threadId),
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

export async function requestGracefulStop(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const reason = payload.reason || "manual stop requested";
  const finalizingSummary =
    "已收到停止指令，当前循环进入收尾状态。请完成当前批次后输出总结、验证结果和下一步建议。";
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
      at: nowIso(),
      reason,
      mode: nextState.mode,
    },
  ];

  await writeJson(snapshot.paths.statePath, nextState);
  const nextThread = await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    continuationStatus: "idle",
    latestSummary: "已收到停止指令，当前循环进入收尾状态。请完成当前批次后输出总结、验证结果和下一步建议。",
    latestEventType: "graceful_stop_requested",
    lastUpdatedAt: nowIso(),
  });
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  return readLoopSnapshot(startDir);
}

export async function updateBudgets(startDir = process.cwd(), payload) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const nextConfig = {
    ...snapshot.config,
    budgets: {
      ...snapshot.config.budgets,
      ...payload,
    },
  };
  await saveLoopConfig(snapshot.paths.codexLoopRoot, nextConfig);

  const nextState = {
    ...snapshot.state,
    budgets: {
      ...snapshot.state.budgets,
      ...payload,
    },
  };
  await writeJson(snapshot.paths.statePath, nextState);
  await appendJsonLine(snapshot.paths.logPath, {
    type: "budgets_updated",
    at: nowIso(),
    budgets: nextState.budgets,
  });
  return readLoopSnapshot(startDir);
}

export async function startRun(startDir = process.cwd()) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const at = nowIso();
  const nextState = {
    ...snapshot.state,
    startedAt: snapshot.state.startedAt || at,
    mode: "running",
    stopRequested: false,
    finalizeRequested: false,
    events: [...snapshot.state.events, { type: "run_started_from_console", at }],
  };

  await writeJson(snapshot.paths.statePath, nextState);
  const nextThread = await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    latestSummary: "循环已启动，正在等待第一轮 heartbeat 或 Codex 线程续跑结果。",
    latestActiveTask: "",
    latestHeartbeatAt: snapshot.thread.latestHeartbeatAt || "",
    continuationEnabled: Boolean(snapshot.thread.threadId),
    continuationStatus: "idle",
    lastContinuationError: "",
    lastUpdatedAt: at,
  });
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...nextThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  return readLoopSnapshot(startDir);
}

export async function runLoopTurn(
  startDir = process.cwd(),
  { dispatchThreadMessage = defaultDispatchThreadMessage } = {},
) {
  const snapshot = await ensureLoopArtifacts(startDir);
  if (!snapshot.thread.threadId) {
    throw new Error("Cannot continue loop because no Codex thread is bound.");
  }

  const prompt = buildFollowupPrompt(snapshot);
  const dispatchAt = nowIso();
  const dispatchingThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    snapshot.state,
    {
      continuationEnabled: true,
      continuationStatus: "dispatching",
      lastDispatchAt: dispatchAt,
      lastDispatchPrompt: prompt,
      lastContinuationError: "",
      latestSummary: "正在向绑定的 Codex 线程发送下一条续跑消息。",
      lastUpdatedAt: dispatchAt,
    },
  );
  await updateRegistryLoopBinding(
    snapshot.paths.codexLoopRoot,
    snapshot.config.currentRunId,
    (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...dispatchingThread } }),
  );
  await appendJsonLine(snapshot.paths.logPath, {
    type: "codex_followup_dispatched",
    at: dispatchAt,
    threadId: snapshot.thread.threadId,
  });

  try {
    const result = await dispatchThreadMessage({
      threadId: snapshot.thread.threadId,
      prompt,
      workspaceRoot: snapshot.paths.workspaceRoot,
    });
    const completedAt = nowIso();
    const refreshed = await ensureLoopArtifacts(startDir);
    const completedThread = await persistThreadMirror(
      refreshed.paths.threadPath,
      refreshed.thread,
      refreshed.state,
      {
        continuationEnabled: true,
        continuationStatus: "idle",
        continuationCycleCount: (refreshed.thread.continuationCycleCount || 0) + 1,
        lastCompletionAt: completedAt,
        lastContinuationError: "",
        latestSummary: "下一条循环消息已发送到 Codex 线程，正在等待该线程完成这一轮。",
        latestCodexSummary: safeText(result.lastMessage, refreshed.thread.latestCodexSummary),
        latestEventType: "codex_followup_completed",
        lastUpdatedAt: completedAt,
      },
    );
    await updateRegistryLoopBinding(
      refreshed.paths.codexLoopRoot,
      refreshed.config.currentRunId,
      (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...completedThread } }),
    );
    await appendJsonLine(refreshed.paths.logPath, {
      type: "codex_followup_completed",
      at: completedAt,
      threadId: refreshed.thread.threadId,
    });
    return readLoopSnapshot(startDir);
  } catch (error) {
    const failedAt = nowIso();
    const refreshed = await ensureLoopArtifacts(startDir);
    const failedThread = await persistThreadMirror(
      refreshed.paths.threadPath,
      refreshed.thread,
      refreshed.state,
      {
        continuationEnabled: true,
        continuationStatus: "error",
        lastContinuationError: error.message,
        latestSummary: "向 Codex 线程续发下一轮消息失败，请检查线程绑定或本机 Codex CLI 状态。",
        latestEventType: "codex_followup_failed",
        lastUpdatedAt: failedAt,
      },
    );
    await updateRegistryLoopBinding(
      refreshed.paths.codexLoopRoot,
      refreshed.config.currentRunId,
      (loop) => ({ threadBinding: { ...(loop.threadBinding || {}), ...failedThread } }),
    );
    await appendJsonLine(refreshed.paths.logPath, {
      type: "codex_followup_failed",
      at: failedAt,
      threadId: refreshed.thread.threadId,
      message: error.message,
    });
    throw error;
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

export async function createLoop(startDir = process.cwd(), payload = {}) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { registry, registryPath } = await loadLoopRegistry(layout, config);
  const loopName = (payload.loopName || "").trim();
  if (!loopName) {
    throw new Error("loopName is required");
  }

  const requestedId = payload.loopId || payload.runId || sanitizeLoopId(loopName);
  const loopId = sanitizeLoopId(requestedId);
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
    budgets: { ...config.budgets, ...(payload.budgets || {}) },
    startContextPaths: payload.startContextPaths || [],
    threadBinding: createLoopThreadBinding(
      {
        ...config,
        currentRunId: loopId,
        loopName,
        threadTitle: payload.threadTitle || loopName,
        projectName: payload.projectName || config.projectName || "project",
      },
      {
        workspaceName: payload.projectName || config.projectName || "project",
        threadTitle: payload.threadTitle || loopName,
      },
    ),
  });

  const nextRegistry = {
    ...registry,
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
    ? `当前 loop：${loop.name}，已绑定线程 ${selectedSnapshot.thread.threadTitle || loop.threadTitle}（${selectedSnapshot.thread.threadId}）。`
    : `当前 loop：${loop.name}，尚未绑定可见线程，请先完成线程绑定再启动续跑。`;
  const currentNote = safeText(selectedSnapshot.thread.note, "");
  const isSystemLoopNote = currentNote.startsWith("当前 loop：");
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

  const nextRegistry = {
    ...registry,
    loops: registry.loops.filter((loop) => loop.id !== payload.loopId),
  };
  await writeJson(registryPath, nextRegistry);
  return summarizeLoopRegistry(nextRegistry);
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
    latestHeartbeatAt: at,
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

export async function syncCodexThreadMirror(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
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
    latestCodexSummary:
      payload.latestCodexSummary ?? snapshot.thread.latestCodexSummary ?? "",
    lastUpdatedAt: nowIso(),
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
  });
  return readLoopSnapshot(startDir);
}
