import fs from "node:fs/promises";
import path from "node:path";

import {
  appendJsonLine,
  ensureDir,
  writeJson,
} from "../../../scripts/lib/fs-helpers.mjs";
import { initializeRun } from "../../../scripts/lib/init-run.mjs";
import { applyHeartbeat, decideLoopMode } from "../../../scripts/lib/state.mjs";
import { readResolvedLoopProfile } from "./adapter-store.mjs";
import { resolveProjectLayout } from "./paths.mjs";

function nowIso() {
  return new Date().toISOString();
}

async function readJson(filePath, fallbackValue = null) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
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

function createThreadDefaults(config) {
  return {
    workspaceName: config.projectName || "\u672a\u547d\u540d\u9879\u76ee",
    threadTitle: "\u672a\u7ed1\u5b9a\u7ebf\u7a0b",
    threadId: "",
    singleThreadMode: true,
    note: "",
    heartbeatAutomation: "",
    currentRunId: config.currentRunId || "default-run",
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
    lastUpdatedAt: nowIso(),
  };
}

function defaultTranscript(thread) {
  return `# Transcript Mirror

- \u5de5\u4f5c\u533a\uff1a${thread.workspaceName}
- \u4e3b\u7ebf\u7a0b\u6807\u9898\uff1a${thread.threadTitle}
- \u4e3b\u7ebf\u7a0b ID\uff1a${thread.threadId || "\u672a\u7ed1\u5b9a"}

\u672c\u6587\u4ef6\u662f\u672c\u5730\u955c\u50cf\uff0c\u4e0d\u4ee3\u66ff Codex \u684c\u9762\u7ebf\u7a0b\u4e3b\u5386\u53f2\u3002
`;
}

function createEmptyErrorState() {
  return {
    message: "",
    area: "",
    updatedAt: "",
  };
}

function modeLabel(mode) {
  if (mode === "running") {
    return "\u8fd0\u884c\u4e2d";
  }

  if (mode === "finalize_after_current") {
    return "\u6536\u5c3e\u4e2d";
  }

  if (mode === "stopped") {
    return "\u5df2\u505c\u6b62";
  }

  return "\u672a\u77e5";
}

function summarizeSnapshot({ config, state, thread, profile, paths, errorState }) {
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
  const latestEventType = state.events?.at(-1)?.type || thread.latestEventType || "";

  return {
    ...thread,
    ...overrides,
    currentRunId: overrides.currentRunId ?? thread.currentRunId ?? state.currentRunId,
    latestMode: overrides.latestMode ?? state.mode,
    latestModeLabel: overrides.latestModeLabel ?? modeLabel(state.mode),
    latestActiveTask: overrides.latestActiveTask ?? state.activeTask ?? "",
    latestSummary: overrides.latestSummary ?? state.recentSummary ?? state.lastNote ?? "",
    latestHeartbeatAt: overrides.latestHeartbeatAt ?? state.lastHeartbeatAt ?? "",
    latestEventType,
    latestVerification:
      overrides.latestVerification ?? thread.latestVerification ?? "",
    lastUpdatedAt: overrides.lastUpdatedAt ?? nowIso(),
  };
}

async function persistThreadMirror(threadPath, currentThread, state, overrides = {}) {
  const nextThread = buildThreadMirror(currentThread, state, overrides);
  await writeJson(threadPath, nextThread);
  return nextThread;
}

export async function ensureLoopArtifacts(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readJson(layout.configPath);

  if (!config) {
    throw new Error(`Missing codex_loop config at ${layout.configPath}`);
  }

  const runId = config.currentRunId || "default-run";
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
      config,
      runId,
      nowIso: nowIso(),
    });
    state = await readJson(statePath);
  }

  let thread = await readJson(threadPath);
  if (!thread) {
    thread = createThreadDefaults(config);
    await writeJson(threadPath, thread);
  }

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

  return summarizeSnapshot({
    config,
    state,
    thread,
    profile,
    paths: {
      runtimeDir,
      statePath,
      logPath,
      transcriptPath,
      threadPath,
      errorPath,
      workspaceRoot: layout.workspaceRoot,
      codexLoopRoot: layout.codexLoopRoot,
    },
    errorState,
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
    singleThreadMode:
      payload.singleThreadMode ?? snapshot.thread.singleThreadMode,
    note: payload.note ?? snapshot.thread.note,
    heartbeatAutomation:
      payload.heartbeatAutomation ?? snapshot.thread.heartbeatAutomation,
  };

  const nextThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    updatedThread,
    snapshot.state,
    {
      lastUpdatedAt: nowIso(),
    },
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
  const nextState = {
    ...snapshot.state,
    stopRequested: true,
    finalizeRequested: true,
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
  await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    lastUpdatedAt: nowIso(),
  });
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

  await writeJson(
    path.join(snapshot.paths.codexLoopRoot, "config.json"),
    nextConfig,
  );

  const nextState = {
    ...snapshot.state,
    budgets: {
      ...snapshot.state.budgets,
      ...payload,
    },
  };

  await writeJson(snapshot.paths.statePath, nextState);
  await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    lastUpdatedAt: nowIso(),
  });
  await appendJsonLine(snapshot.paths.logPath, {
    type: "budgets_updated",
    at: nowIso(),
    budgets: nextState.budgets,
  });

  return readLoopSnapshot(startDir);
}

export async function startRun(startDir = process.cwd()) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const nextState = {
    ...snapshot.state,
    mode: "running",
    stopRequested: false,
    finalizeRequested: false,
    events: [
      ...snapshot.state.events,
      {
        type: "run_started_from_console",
        at: nowIso(),
      },
    ],
  };

  await writeJson(snapshot.paths.statePath, nextState);
  await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    lastUpdatedAt: nowIso(),
  });
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));
  return readLoopSnapshot(startDir);
}

export async function renameLoop(startDir = process.cwd(), payload = {}) {
  const snapshot = await ensureLoopArtifacts(startDir);
  const loopName = (payload.loopName || "").trim();

  if (!loopName) {
    throw new Error("loopName is required");
  }

  const nextConfig = {
    ...snapshot.config,
    loopName,
  };

  const nextState = {
    ...snapshot.state,
    loopName,
    events: [
      ...snapshot.state.events,
      {
        type: "loop_renamed",
        at: nowIso(),
        loopName,
      },
    ],
  };

  await writeJson(
    path.join(snapshot.paths.codexLoopRoot, "config.json"),
    nextConfig,
  );
  await writeJson(snapshot.paths.statePath, nextState);
  await persistThreadMirror(snapshot.paths.threadPath, snapshot.thread, nextState, {
    lastUpdatedAt: nowIso(),
  });
  await appendJsonLine(snapshot.paths.logPath, nextState.events.at(-1));

  return readLoopSnapshot(startDir);
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
  const nextThread = await persistThreadMirror(
    snapshot.paths.threadPath,
    snapshot.thread,
    nextState,
    {
      latestHeartbeatAt: at,
      lastUpdatedAt: at,
    },
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
  await appendJsonLine(snapshot.paths.logPath, {
    type: "codex_thread_mirror_synced",
    at: nextThread.lastUpdatedAt,
    threadId: nextThread.threadId,
  });

  return readLoopSnapshot(startDir);
}
