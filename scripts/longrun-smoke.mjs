import fs from "node:fs/promises";
import path from "node:path";

import { createLoopController } from "../app/server/lib/loop-controller.mjs";

const root = process.cwd();
const reportRootLabel = "runtime/longrun-smoke";
const reportRoot = path.join(root, ...reportRootLabel.split("/"));

function nowForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function makeSnapshot(overrides = {}) {
  return {
    state: {
      mode: "running",
      stopRequested: false,
      finalizeRequested: false,
      elapsedMinutes: 0,
      consumedTokens: 0,
      budgets: {
        maxMinutes: 240,
        maxTokens: 200000,
        finalizeLeadMinutes: 0,
        finalizeLeadTokens: 0,
      },
      ...(overrides.state || {}),
    },
    thread: {
      continuationStatus: "idle",
      latestEventType: "",
      lastCompletionAt: "",
      lastSupervisorReviewAt: "",
      ...(overrides.thread || {}),
    },
  };
}

async function flushScheduled(queue) {
  const task = queue.shift();
  if (!task) {
    return false;
  }

  task();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return true;
}

async function writeReport(report) {
  await fs.mkdir(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `${nowForFile()}-longrun-smoke.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

async function runSmoke() {
  const scheduled = [];
  const events = [];
  let currentSnapshot = makeSnapshot();
  let runCount = 0;
  let reviewCount = 0;
  let stopCount = 0;

  const controller = createLoopController({
    readSnapshot: async () => currentSnapshot,
    runTurn: async () => {
      runCount += 1;
      events.push(`发送第 ${runCount} 轮`);
      currentSnapshot = makeSnapshot({
        thread: {
          continuationStatus: "dispatching",
          latestEventType: "codex_followup_dispatched",
          lastCompletionAt: currentSnapshot.thread.lastCompletionAt,
          lastSupervisorReviewAt: currentSnapshot.thread.lastSupervisorReviewAt,
        },
      });
    },
    reviewCompletion: async (_startDir, snapshot) => {
      reviewCount += 1;
      events.push(`复盘完成 ${snapshot.thread.lastCompletionAt}`);
      currentSnapshot = makeSnapshot({
        thread: {
          continuationStatus: "idle",
          latestEventType: "supervisor_review_completed",
          lastCompletionAt: snapshot.thread.lastCompletionAt,
          lastSupervisorReviewAt: new Date(
            Date.parse(snapshot.thread.lastCompletionAt) + 1000,
          ).toISOString(),
        },
      });
      return { shouldContinue: true };
    },
    requestStop: async (_startDir, payload) => {
      stopCount += 1;
      events.push(payload.reason);
      currentSnapshot = makeSnapshot({
        state: {
          mode: "stopped",
          stopRequested: true,
          elapsedMinutes: 120,
          budgets: {
            maxMinutes: 120,
            maxTokens: 200000,
            finalizeLeadMinutes: 0,
            finalizeLeadTokens: 0,
          },
        },
        thread: currentSnapshot.thread,
      });
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return fn;
    },
    cancel: () => {},
  });

  await controller.start("longrun-smoke");
  await flushScheduled(scheduled);

  if (runCount !== 1 || controller.getStatus("longrun-smoke").state !== "waiting_codex") {
    throw new Error("第一轮发送后没有进入等待 Codex 状态。");
  }

  await flushScheduled(scheduled);
  if (runCount !== 1) {
    throw new Error("Codex 未完成时不应追发下一轮。");
  }

  currentSnapshot = makeSnapshot({
    thread: {
      continuationStatus: "idle",
      latestEventType: "codex_followup_completed",
      lastCompletionAt: "2026-06-10T08:00:00.000Z",
    },
  });
  await flushScheduled(scheduled);

  if (reviewCount !== 1 || runCount !== 2) {
    throw new Error("Codex 完成后必须先复盘，再发送下一轮。");
  }

  await flushScheduled(scheduled);
  if (runCount !== 2) {
    throw new Error("第二轮等待期间不应重复发送。");
  }

  currentSnapshot = makeSnapshot({
    state: {
      elapsedMinutes: 120,
      budgets: {
        maxMinutes: 120,
        maxTokens: 200000,
        finalizeLeadMinutes: 0,
        finalizeLeadTokens: 0,
      },
    },
    thread: {
      continuationStatus: "idle",
      latestEventType: "codex_followup_completed",
      lastCompletionAt: "2026-06-10T08:30:00.000Z",
      lastSupervisorReviewAt: "2026-06-10T08:30:10.000Z",
    },
  });
  await flushScheduled(scheduled);

  if (stopCount !== 1 || controller.isRunning("longrun-smoke")) {
    throw new Error("到达停止条件后必须停止自动循环。");
  }

  return {
    title: "codex-loop 长跑 smoke 检查",
    status: "passed",
    scope: "本地模拟 loop 控制器，不发送真实 Codex 消息。",
    evidence: {
      runCount,
      reviewCount,
      stopCount,
      events,
    },
    checks: [
      "第一轮发送后进入等待 Codex",
      "Codex 未完成时不追发",
      "Codex 完成后先监督复盘再续发",
      "预算到达后停止自动发送",
    ],
  };
}

async function main() {
  process.stdout.write("长跑 smoke 检查开始。\n");
  const startedAt = new Date();

  try {
    const report = await runSmoke();
    report.startedAt = startedAt.toISOString();
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
    const reportPath = await writeReport(report);
    process.stdout.write("长跑 smoke 检查通过。\n");
    process.stdout.write(`报告路径: ${reportPath}\n`);
  } catch (error) {
    const report = {
      title: "codex-loop 长跑 smoke 检查",
      status: "failed",
      scope: "本地模拟 loop 控制器，不发送真实 Codex 消息。",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      error: error?.message || String(error),
      nextAction: "先修复 loop 控制器节奏，再进入真实长期循环。",
    };
    const reportPath = await writeReport(report);
    process.stderr.write(`${error?.stack || error}\n`);
    process.stderr.write(`报告路径: ${reportPath}\n`);
    process.exitCode = 1;
  }
}

main();
