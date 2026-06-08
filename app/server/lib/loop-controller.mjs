import {
  markContinuationFailed,
  readLoopSnapshot,
  requestGracefulStop,
  runLoopTurn,
} from "./runtime-store.mjs";

function budgetLimitReached(state = {}) {
  const budgets = state.budgets || {};
  const maxMinutes = Number(budgets.maxMinutes);
  const maxTokens = Number(budgets.maxTokens);
  const finalizeLeadMinutes = Number(budgets.finalizeLeadMinutes || 0);
  const finalizeLeadTokens = Number(budgets.finalizeLeadTokens || 0);
  const elapsedMinutes = Number(state.elapsedMinutes || 0);
  const consumedTokens = Number(state.consumedTokens || 0);

  return (
    (Number.isFinite(maxMinutes) && elapsedMinutes >= Math.max(0, maxMinutes - finalizeLeadMinutes)) ||
    (Number.isFinite(maxTokens) && consumedTokens >= Math.max(0, maxTokens - finalizeLeadTokens))
  );
}

export function createLoopController({
  readSnapshot = readLoopSnapshot,
  runTurn = runLoopTurn,
  markFailed = markContinuationFailed,
  requestStop = requestGracefulStop,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const activeLoops = new Map();

  function scheduleNext(active, startDir, delayMs) {
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
      if (
        snapshot.state.mode !== "running" ||
        snapshot.state.stopRequested ||
        snapshot.state.finalizeRequested
      ) {
        activeLoops.delete(startDir);
        return;
      }

      if (snapshot.thread?.continuationStatus === "dispatching") {
        active.awaitingCompletion = true;
        scheduleNext(active, startDir, 1500);
        return;
      }

      if (snapshot.thread?.continuationStatus === "error") {
        activeLoops.delete(startDir);
        return;
      }

      if (budgetLimitReached(snapshot.state)) {
        await requestStop(startDir, {
          reason: "预算已到达，codex-loop 已停止自动发送下一轮指令。",
        });
        activeLoops.delete(startDir);
        return;
      }

      if (active.awaitingCompletion) {
        const completionAt = snapshot.thread?.lastCompletionAt || "";
        if (!completionAt || completionAt === active.lastCompletionAt) {
          scheduleNext(active, startDir, 1500);
          return;
        }

        active.lastCompletionAt = completionAt;
        active.awaitingCompletion = false;
      }

      await runTurn(startDir);
      active.awaitingCompletion = true;

      const nextSnapshot = await readSnapshot(startDir);
      if (
        nextSnapshot.state.mode !== "running" ||
        nextSnapshot.state.stopRequested ||
        nextSnapshot.state.finalizeRequested
      ) {
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
      };
      activeLoops.set(startDir, active);
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
      activeLoops.delete(startDir);
      return true;
    },
    isRunning(startDir) {
      return activeLoops.has(startDir);
    },
  };
}
