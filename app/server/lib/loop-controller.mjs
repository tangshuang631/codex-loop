import {
  markContinuationFailed,
  readLoopSnapshot,
  reviewCodexMilestone,
  requestGracefulStop,
  runLoopTurn,
} from "./runtime-store.mjs";
import { decideLoopControllerGate } from "./loop-core/controller-gates.mjs";

function defaultControllerStatus() {
  return {
    running: false,
    state: "stopped",
    label: "未运行",
    detail: "自动循环没有运行。",
    nextAction: "需要继续时点击开始循环。",
  };
}

function controllerStatus(state, overrides = {}) {
  const map = {
    scheduled: {
      running: true,
      state: "scheduled",
      label: "准备中",
      detail: "自动循环已启动，正在读取当前状态。",
      nextAction: "保持控制台运行，系统会自动判断下一步。",
    },
    ready_to_dispatch: {
      running: true,
      state: "ready_to_dispatch",
      label: "准备发送",
      detail: "自动循环准备发送下一轮指令。",
      nextAction: "系统会自动发送下一轮；如需调整，先停止循环。",
    },
    waiting_codex: {
      running: true,
      state: "waiting_codex",
      label: "等待 Codex",
      detail: "上一条指令已发送，正在等待 Codex 完成当前轮。",
      nextAction: "等待 Codex 完成；如有新要求，写入下一轮补充引导。",
    },
    supervisor_reviewing: {
      running: true,
      state: "supervisor_reviewing",
      label: "监督复盘中",
      detail: "Codex 已完成当前轮，本地模型 NPC 正在复盘并决定下一步。",
      nextAction: "等待复盘结束；如有新要求，先写入下一轮补充引导。",
    },
    paused_by_review: {
      running: false,
      state: "paused_by_review",
      label: "已暂停",
      detail: "监督复盘建议先暂停，等待人工确认后再继续。",
      nextAction: "查看监督复盘和最近记录，确认后再重新开始循环。",
    },
    budget_stopped: {
      running: false,
      state: "budget_stopped",
      label: "已到停止条件",
      detail: "预算或停止条件已达到，已停止自动发送下一轮指令。",
      nextAction: "查看最近记录；需要继续时调整停止条件后重新开始。",
    },
    monitor_only_stopped: {
      running: false,
      state: "monitor_only_stopped",
      label: "监控中",
      detail: "监控模式的一次性引导已结束，不会自动循环。",
      nextAction: "继续查看 Codex 回复；需要时在底部再发送新的引导。",
    },
    error_stopped: {
      running: false,
      state: "error_stopped",
      label: "已停止",
      detail: "自动循环遇到错误，已停止继续发送。",
      nextAction: "查看最近错误，修复后再重新开始循环。",
    },
    stopped: defaultControllerStatus(),
  };

  return {
    ...(map[state] || map.stopped),
    ...overrides,
  };
}

export function createLoopController({
  readSnapshot = readLoopSnapshot,
  runTurn = runLoopTurn,
  markFailed = markContinuationFailed,
  reviewCompletion = reviewCodexMilestone,
  requestStop = requestGracefulStop,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const activeLoops = new Map();
  const lastStatuses = new Map();

  function rememberStatus(startDir, status) {
    const active = activeLoops.get(startDir);
    if (active) {
      active.status = status;
    }
    lastStatuses.set(startDir, status);
    return status;
  }

  function scheduleNext(active, startDir, delayMs) {
    rememberStatus(startDir, active.status || controllerStatus("scheduled"));
    active.timer = schedule(() => {
      void executeLoop(startDir);
    }, delayMs);
  }

  async function executeLoop(startDir) {
    const active = activeLoops.get(startDir);
    if (!active || active.stopped) {
      return;
    }

    try {
      const snapshot = await readSnapshot(startDir);
      const gate = decideLoopControllerGate(snapshot, active);

      if (gate.type === "stopped") {
        rememberStatus(startDir, defaultControllerStatus());
        activeLoops.delete(startDir);
        return;
      }

      if (gate.type === "waiting_codex") {
        active.awaitingCompletion = true;
        rememberStatus(startDir, controllerStatus("waiting_codex"));
        scheduleNext(active, startDir, 1500);
        return;
      }

      if (gate.type === "supervisor_reviewing") {
        rememberStatus(startDir, controllerStatus("supervisor_reviewing"));
        scheduleNext(active, startDir, 1500);
        return;
      }

      if (gate.type === "error_stopped") {
        rememberStatus(
          startDir,
          controllerStatus("error_stopped", {
            detail: gate.detail || "自动循环遇到错误，已停止继续发送。",
          }),
        );
        activeLoops.delete(startDir);
        return;
      }

      if (gate.type === "budget_stopped") {
        rememberStatus(startDir, controllerStatus("budget_stopped"));
        await requestStop(startDir, {
          reason: "预算已到达，codex-loop 已停止自动发送下一轮指令。",
        });
        activeLoops.delete(startDir);
        return;
      }

      if (gate.type === "monitor_only_stopped") {
        rememberStatus(startDir, controllerStatus("monitor_only_stopped"));
        activeLoops.delete(startDir);
        return;
      }

      if (gate.type === "waiting_for_new_completion") {
        rememberStatus(startDir, controllerStatus("waiting_codex"));
        scheduleNext(active, startDir, 1500);
        return;
      }

      if (gate.type === "needs_supervisor_review") {
        const completionAt = gate.completionAt || snapshot.thread?.lastCompletionAt || "";
        active.lastCompletionAt = completionAt;
        active.awaitingCompletion = false;
        rememberStatus(startDir, controllerStatus("supervisor_reviewing"));
        const review = await reviewCompletion(startDir, snapshot);
        if (
          review?.shouldContinue === false ||
          review?.thread?.latestEventType === "supervisor_review_skipped"
        ) {
          rememberStatus(startDir, controllerStatus("paused_by_review"));
          activeLoops.delete(startDir);
          return;
        }

        const reviewedSnapshot = await readSnapshot(startDir);
        const reviewedGate = decideLoopControllerGate(reviewedSnapshot, active);
        if (reviewedGate.type === "stopped") {
          rememberStatus(startDir, defaultControllerStatus());
          activeLoops.delete(startDir);
          return;
        }
        if (reviewedGate.type === "waiting_codex") {
          active.awaitingCompletion = true;
          rememberStatus(startDir, controllerStatus("waiting_codex"));
          scheduleNext(active, startDir, 1500);
          return;
        }
        if (reviewedGate.type === "supervisor_reviewing") {
          rememberStatus(startDir, controllerStatus("supervisor_reviewing"));
          scheduleNext(active, startDir, 1500);
          return;
        }
        if (reviewedGate.type === "error_stopped") {
          rememberStatus(
            startDir,
            controllerStatus("error_stopped", {
              detail: reviewedGate.detail || "自动循环遇到错误，已停止继续发送。",
            }),
          );
          activeLoops.delete(startDir);
          return;
        }
        if (reviewedGate.type === "budget_stopped") {
          rememberStatus(startDir, controllerStatus("budget_stopped"));
          await requestStop(startDir, {
            reason: "预算已到达，codex-loop 已停止自动发送下一轮指令。",
          });
          activeLoops.delete(startDir);
          return;
        }
        if (reviewedGate.type === "monitor_only_stopped") {
          rememberStatus(startDir, controllerStatus("monitor_only_stopped"));
          activeLoops.delete(startDir);
          return;
        }
        if (reviewedGate.type === "waiting_for_new_completion") {
          rememberStatus(startDir, controllerStatus("waiting_codex"));
          scheduleNext(active, startDir, 1500);
          return;
        }
        if (reviewedGate.type === "needs_supervisor_review") {
          rememberStatus(startDir, controllerStatus("supervisor_reviewing"));
          scheduleNext(active, startDir, 1500);
          return;
        }
      }

      rememberStatus(startDir, controllerStatus("ready_to_dispatch"));
      await runTurn(startDir);
      active.awaitingCompletion = true;
      rememberStatus(startDir, controllerStatus("waiting_codex"));

      const nextSnapshot = await readSnapshot(startDir);
      if (
        nextSnapshot.state.mode !== "running" ||
        nextSnapshot.state.stopRequested ||
        nextSnapshot.state.finalizeRequested
      ) {
        rememberStatus(startDir, defaultControllerStatus());
        activeLoops.delete(startDir);
        return;
      }

      if (activeLoops.has(startDir)) {
        scheduleNext(active, startDir, 1500);
      }
    } catch (error) {
      try {
        if (error?.codexLoopRecorded) {
          activeLoops.delete(startDir);
          return;
        }
        const snapshot = await readSnapshot(startDir);
        await markFailed(startDir, snapshot, {
          message: error.message,
          latestSummary: "循环本轮没有成功发出指令，请查看最近错误后再继续。",
          promptGenerator: "controller",
        });
      } catch {
        // Keep the controller from crashing the whole dashboard if diagnostics fail.
      }
      rememberStatus(
        startDir,
        controllerStatus("error_stopped", {
          detail: error?.message || "自动循环遇到错误，已停止继续发送。",
        }),
      );
      activeLoops.delete(startDir);
    }
  }

  return {
    async start(startDir) {
      const existing = activeLoops.get(startDir);
      if (existing) {
        return false;
      }

      const active = {
        stopped: false,
        timer: null,
        awaitingCompletion: false,
        lastCompletionAt: "",
        status: controllerStatus("scheduled"),
      };
      activeLoops.set(startDir, active);
      rememberStatus(startDir, active.status);
      scheduleNext(active, startDir, 0);
      return true;
    },
    stop(startDir) {
      const active = activeLoops.get(startDir);
      if (!active) {
        return false;
      }

      active.stopped = true;
      if (active.timer) {
        cancel(active.timer);
      }
      rememberStatus(startDir, defaultControllerStatus());
      activeLoops.delete(startDir);
      return true;
    },
    isRunning(startDir) {
      return activeLoops.has(startDir);
    },
    getStatus(startDir) {
      return activeLoops.get(startDir)?.status || lastStatuses.get(startDir) || defaultControllerStatus();
    },
  };
}
