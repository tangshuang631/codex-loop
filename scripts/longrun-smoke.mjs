import fs from "node:fs/promises";
import path from "node:path";

import { createLoopController } from "../app/server/lib/loop-controller.mjs";
import { runSupervisorIndependentVerification } from "../app/server/lib/verification/supervisor-verification.mjs";

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

async function runIndependentVerificationSmoke() {
  const executedCommands = [];
  const review = {
    shouldContinue: true,
    needsIndependentVerification: true,
    verificationCommands: ["node --test tests/supervisor-verification.test.mjs"],
    acceptanceFocus: [
      "产品经理视角：确认下一步没有偏离用户目标。",
      "测试人员视角：确认可验证证据能回写到状态。",
      "真实用户视角：确认移动端能看懂进展和补充引导。",
    ],
  };
  const firstSnapshot = makeSnapshot({
    thread: {
      lastCompletionAt: "2026-06-10T08:30:00.000Z",
    },
  });
  firstSnapshot.paths = { workspaceRoot: root };

  const first = await runSupervisorIndependentVerification(firstSnapshot, review, {
    runVerificationCommand: async ({ command }) => {
      executedCommands.push(command);
      return {
        command,
        ok: true,
        exitCode: 0,
        output: "PM/QA/真实用户验收通过：状态、历史和补充引导可读。",
      };
    },
  });

  if (first.status !== "passed" || executedCommands.length !== 1) {
    throw new Error("Codex 完成里程碑后必须执行一次 PM/QA/真实用户独立验收。");
  }

  const cooldownSnapshot = makeSnapshot({
    thread: {
      lastCompletionAt: "2026-06-10T08:40:00.000Z",
      lastSupervisorVerificationStatus: "passed",
      lastSupervisorVerificationAt: new Date().toISOString(),
      lastSupervisorVerificationCommands: review.verificationCommands,
    },
  });
  cooldownSnapshot.paths = { workspaceRoot: root };

  const cooldown = await runSupervisorIndependentVerification(cooldownSnapshot, review, {
    runVerificationCommand: async () => {
      throw new Error("冷却期内不应重复执行独立验收。");
    },
  });

  if (cooldown.status !== "skipped" || !/冷却期|近期已完成/u.test(cooldown.summary)) {
    throw new Error("PM/QA/真实用户独立验收必须有冷却策略，避免每轮重复打断。");
  }

  return {
    first,
    cooldown,
    executedCommands,
    role: "产品经理 + 测试人员 + 真实用户",
  };
}

async function runSmoke() {
  const scheduled = [];
  const events = [];
  let currentSnapshot = makeSnapshot();
  let runCount = 0;
  let reviewCount = 0;
  let stopCount = 0;
  let generatorSawGuidance = "";
  let dispatchedPromptWithGuidance = "";

  const controller = createLoopController({
    readSnapshot: async () => currentSnapshot,
    runTurn: async () => {
      runCount += 1;
      const pendingUserGuidance = currentSnapshot.thread.pendingUserGuidance || "";
      if (pendingUserGuidance) {
        generatorSawGuidance = pendingUserGuidance;
        dispatchedPromptWithGuidance =
          "本地监督流程已结合 Codex 最新回复和用户补充生成下一步：" +
          pendingUserGuidance;
      }
      events.push(
        pendingUserGuidance
          ? `发送第 ${runCount} 轮，已融合用户补充`
          : `发送第 ${runCount} 轮`,
      );
      currentSnapshot = makeSnapshot({
        thread: {
          continuationStatus: "dispatching",
          latestEventType: "codex_followup_dispatched",
          lastCompletionAt: currentSnapshot.thread.lastCompletionAt,
          lastSupervisorReviewAt: currentSnapshot.thread.lastSupervisorReviewAt,
          lastDispatchPrompt: pendingUserGuidance
            ? dispatchedPromptWithGuidance
            : `第 ${runCount} 轮模拟指令`,
          pendingUserGuidance: "",
          pendingUserGuidanceAt: "",
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
          pendingUserGuidance: snapshot.thread.pendingUserGuidance || "",
          pendingUserGuidanceAt: snapshot.thread.pendingUserGuidanceAt || "",
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
    thread: {
      ...currentSnapshot.thread,
      pendingUserGuidance: "下一轮请优先检查移动端引导是否清楚，并保持小步验证。",
      pendingUserGuidanceAt: "2026-06-10T08:10:00.000Z",
    },
  });
  await flushScheduled(scheduled);
  if (runCount !== 2) {
    throw new Error("用户在 Codex 工作期间补充引导时，不应立刻追发打断。");
  }

  currentSnapshot = makeSnapshot({
    state: {
      elapsedMinutes: 60,
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
      pendingUserGuidance: currentSnapshot.thread.pendingUserGuidance,
      pendingUserGuidanceAt: currentSnapshot.thread.pendingUserGuidanceAt,
    },
  });
  await flushScheduled(scheduled);

  if (
    reviewCount !== 2 ||
    runCount !== 3 ||
    !generatorSawGuidance ||
    currentSnapshot.thread.pendingUserGuidance
  ) {
    throw new Error("Codex 完成后必须让本地监督流程看到用户补充，融合到下一轮后再清空。");
  }
  if (!/移动端引导/.test(dispatchedPromptWithGuidance)) {
    throw new Error("融合后的下一轮指令缺少用户补充重点。");
  }

  await flushScheduled(scheduled);
  if (runCount !== 3) {
    throw new Error("融合用户补充后的等待期间不应重复发送。");
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
      lastCompletionAt: "2026-06-10T09:00:00.000Z",
      lastSupervisorReviewAt: "2026-06-10T09:00:10.000Z",
    },
  });
  await flushScheduled(scheduled);

  if (stopCount !== 1 || controller.isRunning("longrun-smoke")) {
    throw new Error("到达停止条件后必须停止自动循环。");
  }

  const independentVerification = await runIndependentVerificationSmoke();

  return {
    title: "codex-loop 长跑 smoke 检查",
    status: "passed",
    scope: "本地模拟 loop 控制器，不发送真实 Codex 消息。",
    evidence: {
      runCount,
      reviewCount,
      stopCount,
      generatorSawGuidance,
      dispatchedPromptWithGuidance,
      independentVerification,
      events,
    },
    checks: [
      "第一轮发送后进入等待 Codex",
      "Codex 未完成时不追发",
      "Codex 完成后先监督复盘再续发",
      "用户补充会等 Codex 完成后交给本地监督流程合并",
      "定期以产品经理、测试人员和真实用户视角做独立验收，并在冷却期内不重复执行",
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
