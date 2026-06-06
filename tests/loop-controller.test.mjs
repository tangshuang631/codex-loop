import test from "node:test";
import assert from "node:assert/strict";

import { createLoopController } from "../app/server/lib/loop-controller.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("createLoopController does not start the same loop twice", async () => {
  let runCount = 0;
  const controller = createLoopController({
    readSnapshot: async () => ({
      state: {
        mode: "running",
        stopRequested: false,
        finalizeRequested: false,
      },
    }),
    runTurn: async () => {
      runCount += 1;
      await wait(20);
    },
  });

  const first = await controller.start("workspace-a");
  const second = await controller.start("workspace-a");
  await wait(5);
  controller.stop("workspace-a");

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(runCount >= 1, true);
});

test("createLoopController stop prevents scheduling the next cycle", async () => {
  let runCount = 0;
  const controller = createLoopController({
    readSnapshot: async () => ({
      state: {
        mode: "running",
        stopRequested: false,
        finalizeRequested: false,
      },
    }),
    runTurn: async () => {
      runCount += 1;
      await wait(10);
    },
  });

  await controller.start("workspace-b");
  await wait(5);
  const stopped = controller.stop("workspace-b");
  await wait(700);

  assert.equal(stopped, true);
  assert.equal(runCount, 1);
  assert.equal(controller.isRunning("workspace-b"), false);
});
