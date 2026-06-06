import { readLoopSnapshot, runLoopTurn } from "./runtime-store.mjs";

export function createLoopController({
  readSnapshot = readLoopSnapshot,
  runTurn = runLoopTurn,
} = {}) {
  const activeLoops = new Map();

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

      await runTurn(startDir);

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
        active.timer = setTimeout(() => {
          void executeLoop(startDir);
        }, 500);
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
      };
      activeLoops.set(startDir, active);
      active.timer = setTimeout(() => {
        void executeLoop(startDir);
      }, 0);
      return true;
    },
    stop(startDir) {
      const active = activeLoops.get(startDir);
      if (!active) {
        return false;
      }

      active.stopped = true;
      if (active.timer) {
        clearTimeout(active.timer);
      }
      activeLoops.delete(startDir);
      return true;
    },
    isRunning(startDir) {
      return activeLoops.has(startDir);
    },
  };
}
