import { readLoopSnapshot, runLoopTurn } from "./runtime-store.mjs";

export function createLoopController({
  readSnapshot = readLoopSnapshot,
  runTurn = runLoopTurn,
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
    } catch {
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
