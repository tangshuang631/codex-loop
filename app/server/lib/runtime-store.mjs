import fs from "node:fs/promises";
import path from "node:path";

import { appendJsonLine, ensureDir, writeJson } from "../../../scripts/lib/fs-helpers.mjs";
import { loadLoopConfig, saveLoopConfig } from "../../../scripts/lib/config-loader.mjs";
import { initializeRun } from "../../../scripts/lib/init-run.mjs";
import { applyHeartbeat, decideLoopMode } from "../../../scripts/lib/state.mjs";
import { readResolvedLoopProfile } from "./adapter-store.mjs";
import { deleteAutomationForThread } from "./automation-store.mjs";
import { dispatchThreadMessage as defaultDispatchThreadMessage } from "./codex-dispatcher.mjs";
import { readLauncherStatus } from "./launcher-status.mjs";
import { planLoopWithFallback } from "./ollama-loop-planner.mjs";
import { generatePromptWithOllama } from "./ollama-prompt-generator.mjs";
import { resolveProjectLayout } from "./paths.mjs";

function nowIso() {
  return new Date().toISOString();
}

const DEFAULT_LOOP_ID = "default-run";
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

本文档是本地镜像，不替代 Codex 桌面端线程历史。`;
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
  return `loop-${Date.now()}`;
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
  workspaceRoot,
  budgets,
  startContextPaths = [],
  docs = null,
  git = null,
  creation = null,
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
    workspaceRoot: workspaceRoot || "",
    budgets,
    startContextPaths,
    docs,
    git,
    creation,
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
        workspaceRoot: config.workspaceRoot || workspaceRoot,
        budgets: { ...config.budgets },
        startContextPaths: [],
        threadBinding: createLoopThreadBinding(config),
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
    workspaceRoot: loop.workspaceRoot || config.workspaceRoot,
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
      text.includes("自动化") ||
      text.includes("规划") ||
      text.includes("循环") ||
      text.includes("计划") ||
      text.includes("首个")
    )
  );
}

function buildLoopAssistantQuestion(step, draft = createLoopAssistantDraft()) {
  if (step === "workspace_root") {
    return {
      id: "workspace_root",
      prompt: "先告诉我这个 loop 对应的项目路径，我会自动检测 git、文档和可用命令。",
      placeholder: "例如 E:\\2026\\codex-loop",
    };
  }

  if (step === "project_name") {
    const suggestedName = safeText(draft.plan?.suggestedProjectName, draft.projectName);
    return {
      id: "project_name",
      prompt: draft.plan?.nextQuestion || "这个项目希望在左侧栏显示成什么项目名？",
      placeholder: suggestedName || draft.projectName || "例如 codex-loop",
    };
  }

  if (step === "loop_name") {
    const suggestedLoopName = safeText(draft.plan?.suggestedLoopName, draft.loopName);
    return {
      id: "loop_name",
      prompt: "这个新 loop 的名称是什么？建议写成当前要推进的子任务。",
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
      prompt: "这个 loop 主要工作的分支是什么？默认建议使用 dev。",
      placeholder: suggestedBranch || "dev",
    };
  }

  return {
    id: "docs_confirmed",
    prompt:
      "我已经找到 git 和文档线索。回复 `confirm` 直接创建，或补充你想强制纳入的规则文档路径。",
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
        lowerName.includes("约束") ||
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
    updatedAt: nowIso(),
  };
  await ensureDir(path.dirname(assistantPath));
  await writeJson(assistantPath, initial);
  return { assistantPath, state: initial };
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

function buildContinuationStrategy(snapshot) {
  const shouldFinalize = snapshot.state.mode === "finalize_after_current";
  const generator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  return {
    contextCard: {
      whyContinue: snapshot.thread.lastUserInstructionSummary || "继续当前 loop 主线任务",
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
        ? "当前处于收尾模式：完成当前小批任务后总结、验证、收尾。"
        : "当前处于推进模式：优先完成下一批边界清晰、可验证的小任务。",
    },
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
  const strategy = buildContinuationStrategy(snapshot);
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
          ? "线程已绑定，循环已停下。可以先查看总结，确认上下文后再重新开始。"
          : "循环已停下。建议先查看本轮总结；如需继续，再绑定线程后重新开始。"
        : snapshot.thread.threadId
          ? snapshot.thread.continuationStatus === "dispatching"
            ? "Codex 正在当前线程处理中，先等待这一轮完成。"
            : "线程已绑定，可以继续观察进展，或手动续跑一轮。"
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
    strategy,
    bindingNote,
    suggestedAction,
    latestPrompt: snapshot.thread.lastDispatchPrompt || "",
    transcriptEntries: parseTranscriptEntries(transcriptText),
  };
}

function buildTranscriptEntry({ at, activeTask, note, summary, mode }) {
  return [
    "",
    `## ${at}`,
    `- Active task: ${activeTask || "n/a"}`,
    `- Note: ${note || "n/a"}`,
    `- Summary: ${summary || "n/a"}`,
    `- Thread mirror mode: ${mode || "n/a"}`,
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
  const language = safeText(
    snapshot.profile?.resolved?.conversation?.language,
    snapshot.profile?.overrides?.conversation?.language || "zh-CN",
  ).toLowerCase();
  const englishPreferred = language.startsWith("en");

  const instructions = englishPreferred
    ? [
        "Continue the same Codex thread from its latest verified checkpoint.",
        "Use the current loop settings and latest thread summary as the source of truth.",
        "After the next bounded batch, report progress, verification, and the next step.",
      ]
    : [
        "继续在同一个 Codex 线程中，从最近一次已验证的检查点往下推进。",
        "以当前 loop 设置和最近线程摘要作为唯一事实来源，不要偏题。",
        "完成下一批边界清晰的任务后，汇报进展、验证结果和下一步，再继续推进。",
      ];

  if (englishPreferred) {
    return [
      ...instructions,
      "",
      "Current loop context:",
      `- Loop name: ${safeText(snapshot.config.loopName, snapshot.config.projectName)}`,
      `- Thread title: ${safeText(snapshot.thread.threadTitle, "Unbound thread")}`,
      `- Branch: ${safeText(snapshot.config.branch, "dev")}`,
      `- User intent summary: ${safeText(snapshot.thread.lastUserInstructionSummary, "Continue the current loop")}`,
      `- Last Codex action: ${safeText(snapshot.thread.lastAssistantActionSummary, "None yet")}`,
      `- Latest Codex summary: ${safeText(snapshot.thread.latestCodexSummary, "None yet")}`,
    ].join("\n");
  }

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
    latestSummary: finalizingSummary,
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

async function runLoopTurnLegacy(
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

export async function runLoopTurn(
  startDir = process.cwd(),
  {
    dispatchThreadMessage = defaultDispatchThreadMessage,
    generateFollowupPrompt = generatePromptWithOllama,
  } = {},
) {
  const snapshot = await ensureLoopArtifacts(startDir);
  if (!snapshot.thread.threadId) {
    throw new Error("Cannot continue loop because no Codex thread is bound.");
  }

  const fallbackPrompt = buildFollowupPrompt(snapshot);
  const promptGenerator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  if (!promptGenerator.enabled || promptGenerator.provider !== "ollama") {
    return runLoopTurnLegacy(startDir, { dispatchThreadMessage });
  }

  let prompt = fallbackPrompt;
  let promptGenerationError = "";

  try {
    prompt = await generateFollowupPrompt({
      snapshot,
      fallbackPrompt,
    });
  } catch (error) {
    promptGenerationError = error.message;
  }

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
      lastContinuationError: promptGenerationError,
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
    promptGenerator: "ollama",
    promptGenerationError,
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
        lastContinuationError: promptGenerationError,
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
      promptGenerator: "ollama",
      promptGenerationError,
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
      promptGenerationError,
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
    startContextPaths: payload.startContextPaths || [],
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

export async function replyLoopCreationAssistant(startDir = process.cwd(), payload = {}) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readConfig(layout);
  const { assistantPath, state } = await loadLoopAssistantState(layout);
  const answer = safeText(payload.answer, "");
  const draft = {
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
        },
      };
      return saveLoopAssistantState(assistantPath, {
        ...state,
        step: "project_name",
        draft: nextDraft,
        currentQuestion: buildLoopAssistantQuestion("project_name", nextDraft),
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
      currentQuestion: buildLoopAssistantQuestion("loop_name", nextDraft),
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
    creation: {
      source: "assistant",
      createdAt: nowIso(),
      projectProfile: draft.projectProfile,
      safety: {
        requireGitPushReminder: true,
        pauseOnPermissionIssue: true,
        requireBranchConfirmation: true,
      },
    },
  });
  const createdLoopId = buildSafeLoopId(draft.loopName, draft.projectName, "assistant-loop");
  const createdLoop = loopRegistry.loops.find((loop) => loop.id === createdLoopId);

  return saveLoopAssistantState(assistantPath, {
    status: "completed",
    step: "completed",
    draft: {
      ...draft,
      docs,
    },
    currentQuestion: null,
    createdLoop: {
      loop: createdLoop,
      summary: `已创建 loop「${createdLoop.name}」，归入项目「${createdLoop.projectName}」。`,
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
