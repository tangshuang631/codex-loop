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
      thread: {
        continuationStatus: "idle",
        latestEventType: "supervisor_review_completed",
        lastCompletionAt: "2026-06-07T13:50:59.000Z",
        lastSupervisorReviewAt: "2026-06-07T13:51:10.000Z",
      },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "dispatching", lastCompletionAt: "2026-06-07T13:50:59.000Z" },
    },
  ];

  const controller = createLoopController({
    readSnapshot: async () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    reviewCompletion: async () => {},
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

test("loop controller exposes a readable status while waiting for Codex", async () => {
  let readCount = 0;
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
  ];

  const controller = createLoopController({
    readSnapshot: async () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    runTurn: async () => {},
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.deepEqual(controller.getStatus("demo"), {
    running: false,
    state: "stopped",
    label: "未运行",
    detail: "自动循环没有运行。",
    nextAction: "需要继续时点击开始循环。",
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(controller.getStatus("demo").state, "scheduled");

  assert.equal(await flushScheduled(scheduled), true);
  const status = controller.getStatus("demo");

  assert.equal(status.running, true);
  assert.equal(status.state, "waiting_codex");
  assert.equal(status.label, "等待 Codex");
  assert.match(status.detail, /已发送|Codex/);
  assert.match(status.nextAction, /等待|补充引导/);
});

test("loop controller exposes supervisor reviewing and budget stop states", async () => {
  const scheduled = [];
  const reviewSnapshots = [
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: {
        continuationStatus: "idle",
        latestEventType: "codex_followup_completed",
        lastCompletionAt: "2026-06-08T03:00:00.000Z",
        lastSupervisorReviewAt: "",
      },
    },
    {
      state: {
        mode: "running",
        stopRequested: false,
        finalizeRequested: false,
        elapsedMinutes: 120,
        consumedTokens: 1000,
        budgets: {
          maxMinutes: 120,
          maxTokens: 50000,
          finalizeLeadMinutes: 0,
          finalizeLeadTokens: 0,
        },
      },
      thread: {
        continuationStatus: "idle",
        latestEventType: "supervisor_review_completed",
        lastCompletionAt: "2026-06-08T03:00:00.000Z",
        lastSupervisorReviewAt: "2026-06-08T03:01:00.000Z",
      },
    },
  ];
  let readCount = 0;
  const controller = createLoopController({
    readSnapshot: async () =>
      reviewSnapshots[Math.min(readCount++, reviewSnapshots.length - 1)],
    reviewCompletion: async () => {
      assert.equal(controller.getStatus("demo").state, "supervisor_reviewing");
      return {
        thread: {
          latestEventType: "supervisor_review_completed",
        },
      };
    },
    runTurn: async () => {},
    requestStop: async () => ({}),
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);

  const stopped = controller.getStatus("demo");
  assert.equal(stopped.running, false);
  assert.equal(stopped.state, "budget_stopped");
  assert.equal(stopped.label, "已到停止条件");
  assert.match(stopped.detail, /预算|停止条件/);
  assert.match(stopped.nextAction, /查看|调整/);
});

test("loop controller reviews a completed Codex turn before dispatching the next turn", async () => {
  let readCount = 0;
  const calls = [];
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
      thread: { continuationStatus: "idle", lastCompletionAt: "2026-06-08T02:15:00.000Z" },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: {
        continuationStatus: "idle",
        latestEventType: "supervisor_review_completed",
        lastCompletionAt: "2026-06-08T02:15:00.000Z",
        lastSupervisorReviewAt: "2026-06-08T02:15:10.000Z",
      },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "dispatching", lastCompletionAt: "2026-06-08T02:15:00.000Z" },
    },
  ];

  const controller = createLoopController({
    readSnapshot: async () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    reviewCompletion: async (startDir, snapshot) => {
      calls.push(`review:${startDir}:${snapshot.thread.lastCompletionAt}`);
    },
    runTurn: async (startDir) => {
      calls.push(`run:${startDir}`);
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);
  assert.deepEqual(calls, ["run:demo"]);

  assert.equal(await flushScheduled(scheduled), true);
  assert.deepEqual(calls, [
    "run:demo",
    "review:demo:2026-06-08T02:15:00.000Z",
    "run:demo",
  ]);
});

test("loop controller reviews an already-completed turn after restart before dispatching", async () => {
  const calls = [];
  const scheduled = [];
  const snapshot = {
    state: { mode: "running", stopRequested: false, finalizeRequested: false },
    thread: {
      continuationStatus: "idle",
      latestEventType: "codex_followup_completed",
      lastCompletionAt: "2026-06-08T02:20:00.000Z",
      lastSupervisorReviewAt: "",
    },
  };

  const controller = createLoopController({
    readSnapshot: async () => snapshot,
    reviewCompletion: async (startDir, currentSnapshot) => {
      calls.push(`review:${startDir}:${currentSnapshot.thread.lastCompletionAt}`);
      return {
        thread: {
          latestEventType: "supervisor_review_completed",
        },
      };
    },
    runTurn: async (startDir) => {
      calls.push(`run:${startDir}`);
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);

  assert.deepEqual(calls, [
    "review:demo:2026-06-08T02:20:00.000Z",
    "run:demo",
  ]);
});

test("loop controller waits during an existing supervisor review without duplicating it", async () => {
  let readCount = 0;
  const calls = [];
  const scheduled = [];
  const snapshots = [
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: {
        continuationStatus: "reviewing",
        latestEventType: "supervisor_review_started",
        lastCompletionAt: "2026-06-08T02:25:00.000Z",
        lastSupervisorReviewAt: "",
      },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: {
        continuationStatus: "idle",
        latestEventType: "supervisor_review_completed",
        lastCompletionAt: "2026-06-08T02:25:00.000Z",
        lastSupervisorReviewAt: "2026-06-08T02:25:20.000Z",
      },
    },
  ];

  const controller = createLoopController({
    readSnapshot: async () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    reviewCompletion: async () => {
      calls.push("review");
      return {
        thread: {
          latestEventType: "supervisor_review_completed",
        },
      };
    },
    runTurn: async (startDir) => {
      calls.push(`run:${startDir}`);
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);
  assert.deepEqual(calls, []);

  assert.equal(await flushScheduled(scheduled), true);
  assert.deepEqual(calls, ["run:demo"]);
});

test("loop controller stops before dispatching when supervisor review asks to pause", async () => {
  let readCount = 0;
  const calls = [];
  const scheduled = [];

  const snapshots = [
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "idle", lastCompletionAt: "" },
    },
    {
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "idle", lastCompletionAt: "2026-06-08T02:30:00.000Z" },
    },
  ];

  const controller = createLoopController({
    readSnapshot: async () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    reviewCompletion: async () => {
      calls.push("review");
      return {
        thread: {
          latestEventType: "supervisor_review_skipped",
          lastContinuationError: "监督复盘建议暂停等待人工确认。",
        },
      };
    },
    runTurn: async () => {
      calls.push("run");
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);
  assert.deepEqual(calls, ["run"]);

  assert.equal(await flushScheduled(scheduled), true);
  assert.deepEqual(calls, ["run", "review"]);
  assert.equal(controller.isRunning("demo"), false);
});

test("loop controller records a visible failure when a turn crashes", async () => {
  const scheduled = [];
  const failures = [];
  const snapshot = {
    state: { mode: "running", stopRequested: false, finalizeRequested: false },
    thread: { continuationStatus: "idle", lastCompletionAt: "" },
  };

  const controller = createLoopController({
    readSnapshot: async () => snapshot,
    runTurn: async () => {
      throw new Error("native dispatch unavailable");
    },
    markFailed: async (startDir, failedSnapshot, details) => {
      failures.push({ startDir, failedSnapshot, details });
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].details.message, "native dispatch unavailable");
  assert.equal(controller.isRunning("demo"), false);
});

test("loop controller stops before sending another turn when budget limit is reached", async () => {
  let runTurnCount = 0;
  const stopRequests = [];
  const scheduled = [];
  const snapshots = [
    {
      state: {
        mode: "running",
        stopRequested: false,
        finalizeRequested: false,
        elapsedMinutes: 120,
        consumedTokens: 1000,
        budgets: {
          maxMinutes: 120,
          maxTokens: 50000,
          finalizeLeadMinutes: 0,
          finalizeLeadTokens: 0,
        },
      },
      thread: { continuationStatus: "idle", lastCompletionAt: "" },
    },
  ];

  const controller = createLoopController({
    readSnapshot: async () => snapshots[0],
    runTurn: async () => {
      runTurnCount += 1;
    },
    requestStop: async (startDir, payload) => {
      stopRequests.push({ startDir, payload });
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);

  assert.equal(runTurnCount, 0);
  assert.equal(stopRequests.length, 1);
  assert.equal(stopRequests[0].startDir, "demo");
  assert.match(stopRequests[0].payload.reason, /预算|budget/i);
  assert.equal(controller.isRunning("demo"), false);
});

test("loop controller reviews monitor-mode completion before stopping automatic control", async () => {
  const scheduled = [];
  let runTurnCount = 0;
  let reviewCount = 0;
  let readCount = 0;
  const snapshots = [
    {
      state: {
        mode: "running",
        monitorOnly: true,
        stopRequested: false,
        finalizeRequested: false,
      },
      thread: {
        continuationStatus: "idle",
        latestEventType: "codex_followup_completed",
        lastCompletionAt: "2026-06-09T12:00:00.000Z",
        lastSupervisorReviewAt: "",
      },
    },
    {
      state: {
        mode: "running",
        monitorOnly: true,
        stopRequested: false,
        finalizeRequested: false,
      },
      thread: {
        continuationStatus: "idle",
        latestEventType: "supervisor_review_completed",
        lastCompletionAt: "2026-06-09T12:00:00.000Z",
        lastSupervisorReviewAt: "2026-06-09T12:01:00.000Z",
      },
    },
  ];
  const controller = createLoopController({
    readSnapshot: async () => snapshots[Math.min(readCount++, snapshots.length - 1)],
    runTurn: async () => {
      runTurnCount += 1;
    },
    reviewCompletion: async () => {
      reviewCount += 1;
      return {
        thread: {
          latestEventType: "supervisor_review_completed",
        },
      };
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  assert.equal(await controller.start("demo"), true);
  assert.equal(await flushScheduled(scheduled), true);

  const status = controller.getStatus("demo");
  assert.equal(status.running, false);
  assert.equal(status.state, "monitor_only_stopped");
  assert.match(status.detail, /监控模式|不会自动循环/);
  assert.equal(controller.isRunning("demo"), false);
  assert.equal(runTurnCount, 0);
  assert.equal(reviewCount, 1);
});
