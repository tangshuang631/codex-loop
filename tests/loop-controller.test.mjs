import test from "node:test";
import assert from "node:assert/strict";

import { createLoopController } from "../app/server/lib/loop-controller.mjs";

async function flushScheduled(queue) {
  const task = queue.shift();
  if (!task) {
    return false;
  }

  task();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return true;
}

test("loop controller waits for a real completion signal before dispatching the next turn", async () => {
  let readCount = 0;
  let runTurnCount = 0;
  const scheduled = [];

  const snapshots = [
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "idle", lastCompletionAt: "" },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "dispatching", lastCompletionAt: "" },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "dispatching", lastCompletionAt: "" },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "idle", lastCompletionAt: "2026-06-07T13:50:59.000Z" },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "dispatching", lastCompletionAt: "2026-06-07T13:50:59.000Z" },
    },
  ];

  const controller = createLoopController({
    readSnapshot: async () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    runTurn: async () => {
      runTurnCount += 1;
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);
  assert.equal(runTurnCount, 1);

  assert.equal(await flushScheduled(scheduled), true);
  assert.equal(runTurnCount, 1);

  assert.equal(await flushScheduled(scheduled), true);
  assert.equal(runTurnCount, 2);
});
