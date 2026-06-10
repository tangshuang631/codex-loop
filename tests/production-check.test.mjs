import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readProductionStatusSummary } from "../scripts/production-status.mjs";
import { readProductionPreflightSummary } from "../scripts/production-preflight.mjs";
import { runProductionRecovery } from "../scripts/production-recover.mjs";

async function read(path) {
  return fs.readFile(path, "utf8");
}

test("production readiness check is exposed as one verified command", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/production-check.mjs");

  assert.equal(packageJson.scripts["production:check"], "node scripts/production-check.mjs");
  assert.match(source, /loop:check/);
  assert.match(source, /loop:smoke/);
  assert.match(source, /npm test/);
  assert.match(source, /npm run build:web/);
  assert.match(source, /npm run build:mobile/);
  assert.match(source, /git diff --check/);
});

test("production preflight is exposed as a read-only gate before real loop dispatch", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/production-preflight.mjs");

  assert.equal(packageJson.scripts["production:preflight"], "node scripts/production-preflight.mjs");
  assert.match(source, /真实循环前预检/);
  assert.match(source, /readProductionStatusSummary/);
  assert.match(source, /当前验证目标/);
  assert.doesNotMatch(source, /runLoopTurn|sendPendingGuidance|startRun|dispatchThreadMessage/);
});

test("production preflight reports trial readiness with explicit target confirmation", async () => {
  const status = {
    status: "attention",
    target: {
      runId: "assistant-loop",
      threadId: "thread-123",
      threadTitle: "按清单继续开发",
      workspaceRoot: "E:\\2026\\opencow",
      continuationStatus: "idle",
    },
    readiness: {
      stage: "trial",
      summary: "代码闸门已通过，并已观察到 1 轮真实闭环。",
      nextAction:
        "再跑至少 1 轮真实任务，确认发送、Codex 完成和 NPC 复盘能连续出现。 当前验证目标：按清单继续开发 / E:\\2026\\opencow / thread-123。触发真实循环前，请确认这就是要继续的任务。",
    },
    sections: [
      { label: "最近生产检查", status: "passed", summary: "8 项检查通过" },
      { label: "前端证据", status: "passed", summary: "关键界面信号已进入构建产物" },
      { label: "长跑节奏", status: "passed", summary: "本地长跑节奏通过" },
      {
        label: "真实运行观测",
        status: "attention",
        summary: "已经观察到 1 轮发送、Codex 完成和 NPC 复盘。",
        nextAction: "再跑至少 1 轮真实任务，确认发送、Codex 完成和 NPC 复盘能连续出现。",
      },
    ],
  };

  const preflight = await readProductionPreflightSummary({
    readProductionStatusSummary: async () => status,
  });

  assert.equal(preflight.title, "codex-loop 真实循环前预检");
  assert.equal(preflight.status, "ready_with_attention");
  assert.equal(preflight.canDispatch, true);
  assert.equal(preflight.target.workspaceRoot, "E:\\2026\\opencow");
  assert.match(preflight.summary, /可以短时试用/);
  assert.match(preflight.nextAction, /确认当前验证目标/);
  assert.match(preflight.nextAction, /E:\\2026\\opencow/);
  assert.match(preflight.evidence.join("\n"), /代码闸门/);
  assert.match(preflight.evidence.join("\n"), /还缺少第 2 轮/);
});

test("production preflight blocks dispatching to the current codex-loop thread", async () => {
  const status = {
    status: "attention",
    target: {
      runId: "assistant-loop",
      threadId: "thread-self",
      threadTitle: "当前 codex-loop 窗口",
      workspaceRoot: "E:\\2026\\codex-loop",
      continuationStatus: "idle",
    },
    readiness: {
      stage: "trial",
      summary: "代码闸门已通过，并已观察到 1 轮真实闭环。",
      nextAction: "再跑至少 1 轮真实任务。",
    },
    sections: [
      { label: "最近生产检查", status: "passed", summary: "8 项检查通过" },
      { label: "前端证据", status: "passed", summary: "关键界面信号已进入构建产物" },
      { label: "长跑节奏", status: "passed", summary: "本地长跑节奏通过" },
      {
        label: "真实运行观测",
        status: "attention",
        summary: "已经观察到 1 轮发送、Codex 完成和 NPC 复盘。",
      },
    ],
  };

  const preflight = await readProductionPreflightSummary({
    currentCodexThreadId: "thread-self",
    readProductionStatusSummary: async () => status,
  });

  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.canDispatch, false);
  assert.match(preflight.summary, /当前 codex-loop 自己所在的 Codex 线程/);
  assert.match(preflight.nextAction, /绑定另一个可见 Codex 窗口/);
  assert.match(preflight.evidence.join("\n"), /不能把当前线程作为目标/);
});

test("production preflight blocks dispatch when Codex completion still needs supervisor recovery", async () => {
  const status = {
    status: "attention",
    target: {
      runId: "assistant-loop",
      threadId: "thread-needs-review",
      threadTitle: "需要复盘的任务",
      workspaceRoot: "E:\\2026\\opencow",
      continuationStatus: "idle",
    },
    readiness: {
      stage: "trial",
      summary: "代码闸门已通过，适合短时试用。",
      nextAction: "先运行 npm run production:recover 补齐监督复盘；该命令不会发送下一轮指令。",
    },
    sections: [
      { label: "最近生产检查", status: "passed", summary: "8 项检查通过" },
      { label: "前端证据", status: "passed", summary: "关键界面信号已进入构建产物" },
      { label: "长跑节奏", status: "passed", summary: "本地长跑节奏通过" },
      {
        label: "真实运行观测",
        status: "attention",
        summary: "Codex 已有完成回复，但还缺少 NPC 监督复盘，暂时不能算完整闭环。",
        nextAction: "先运行 npm run production:recover 补齐监督复盘；该命令不会发送下一轮指令。",
      },
    ],
  };

  const preflight = await readProductionPreflightSummary({
    readProductionStatusSummary: async () => status,
  });

  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.canDispatch, false);
  assert.match(preflight.summary, /还缺少 NPC 监督复盘/);
  assert.match(preflight.nextAction, /production:recover/);
  assert.match(preflight.evidence.join("\n"), /补齐监督复盘/);
});

test("long-run smoke check is exposed and uses simulated controller dependencies", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/longrun-smoke.mjs");

  assert.equal(packageJson.scripts["loop:smoke"], "node scripts/longrun-smoke.mjs");
  assert.match(source, /createLoopController/);
  assert.match(source, /readSnapshot/);
  assert.match(source, /runTurn/);
  assert.match(source, /reviewCompletion/);
  assert.match(source, /pendingUserGuidance/);
  assert.match(source, /NPC|监督复盘|generatorSawGuidance/);
  assert.match(source, /产品经理|测试人员|真实用户|PM|QA/);
  assert.match(source, /independentVerification|独立验收/);
  assert.match(source, /cooldown|冷却|不重复/);
  assert.match(source, /runtime[\\/]longrun-smoke/);
  assert.doesNotMatch(source, /codex-dispatcher|sendCodex|native dispatch/i);
});

test("production readiness check writes a Chinese evidence report", async () => {
  const source = await read("scripts/production-check.mjs");

  assert.match(source, /生产就绪检查/);
  assert.match(source, /验证命令/);
  assert.match(source, /前端证据检查/);
  assert.match(source, /frontend-evidence-check\.mjs/);
  assert.match(source, /报告路径/);
  assert.match(source, /runtime[\\/]production-checks/);
  assert.match(source, /status:\s*"passed"/);
  assert.match(source, /status:\s*"failed"/);
});

test("frontend evidence check verifies built desktop and mobile product surfaces", async () => {
  const source = await read("scripts/frontend-evidence-check.mjs");

  assert.match(source, /codex-loop 前端证据检查/);
  assert.match(source, /dist[\\/]web/);
  assert.match(source, /dist[\\/]mobile/);
  assert.match(source, /历史对话/);
  assert.match(source, /发送引导/);
  assert.match(source, /截图证据/);
  assert.match(source, /生产阶段/);
  assert.match(source, /验证目标/);
  assert.match(source, /启动预检/);
  assert.match(source, /runtime[\\/]frontend-evidence/);
});

test("production status frontend evidence summary includes production stage", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [
      {
        name: "桌面端",
        status: "passed",
        requiredText: ["历史对话", "发送引导", "截图证据", "生产阶段", "验证目标", "启动预检", "待合并", "本地模型", "NPC"],
      },
      {
        name: "移动端",
        status: "passed",
        requiredText: ["历史对话", "发送引导", "截图证据", "生产阶段", "验证目标", "启动预检", "待合并", "本地模型", "NPC"],
      },
    ],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: false,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });
    const frontend = status.sections.find((section) => section.label === "前端证据");

    assert.equal(frontend.status, "passed");
    assert.match(frontend.summary, /生产阶段/);
    assert.match(frontend.summary, /验证目标/);
    assert.match(frontend.summary, /历史对话/);
    assert.match(frontend.summary, /发送引导/);
    assert.match(frontend.summary, /NPC 已进入构建产物/);
    assert.doesNotMatch(frontend.summary, /NPC已进入构建产物/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status summarizes recent production evidence for long-running use", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/production-status.mjs");

  assert.equal(packageJson.scripts["production:status"], "node scripts/production-status.mjs");
  assert.equal(packageJson.scripts["production:observe"], "node scripts/production-observer.mjs");
  assert.match(source, /codex-loop 生产状态摘要/);
  assert.match(source, /runtime[\\/]production-checks/);
  assert.match(source, /runtime[\\/]frontend-evidence/);
  assert.match(source, /runtime[\\/]longrun-smoke/);
  assert.match(source, /runtime[\\/]production-observations/);
  assert.match(source, /最近生产检查/);
  assert.match(source, /前端证据/);
  assert.match(source, /长跑节奏/);
  assert.match(source, /真实运行观测/);
  assert.match(source, /下一步建议/);
});

test("production recovery backfills supervisor review without sending another turn", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/production-recover.mjs");

  assert.equal(packageJson.scripts["production:recover"], "node scripts/production-recover.mjs");
  assert.match(source, /ensureSupervisorReview/);
  assert.match(source, /生产恢复/);
  assert.match(source, /不会发送下一轮/);
  assert.doesNotMatch(source, /runLoopTurn|sendPendingGuidanceOnce|startRun/);
});

test("production recovery consumes recovered observation replies before supervisor review", async () => {
  const calls = [];
  const result = await runProductionRecovery("/demo/root", {
    ensureSupervisorReview: async () => {
      calls.push("ensure");
      return calls.length === 1
        ? {
            reviewed: false,
            reason: "当前没有需要监督复盘的 Codex 完成结果。",
            thread: {
              threadId: "thread-a",
              threadTitle: "恢复测试",
              latestEventType: "pending_guidance_cleared",
            },
          }
        : {
            reviewed: true,
            reason: "已补齐当前 Codex 完成结果的监督复盘。",
            thread: {
              threadId: "thread-a",
              threadTitle: "恢复测试",
              latestEventType: "supervisor_review_completed",
              lastSupervisorSource: "template",
              lastSupervisorReviewAt: "2026-06-10T12:20:00.000Z",
            },
          };
    },
    buildProductionObservation: async () => ({
      diagnosis: { category: "codex_reply_recovered_after_timeout" },
      timeline: [
        {
          type: "codex_followup_completed",
          at: "2026-06-10T12:10:00.000Z",
          detail: "Codex 已完成恢复后的真实回复。",
          recoveredFromTimeout: true,
        },
      ],
    }),
    syncCodexThreadMirror: async (root, payload) => {
      calls.push(["sync", root, payload.latestCodexSummary, payload.forceCompletion]);
      return {};
    },
  });

  assert.deepEqual(calls, [
    "ensure",
    ["sync", "/demo/root", "Codex 已完成恢复后的真实回复。", true],
    "ensure",
  ]);
  assert.equal(result.status, "recovered");
  assert.equal(result.reviewed, true);
  assert.match(result.reason, /已补齐/);
  assert.match(result.safety, /不会发送下一轮指令/);
});

test("production status treats stale reports as attention instead of current health", async () => {
  const source = await read("scripts/production-status.mjs");

  assert.match(source, /MAX_REPORT_AGE_HOURS/);
  assert.match(source, /isStale/);
  assert.match(source, /已过期/);
  assert.match(source, /重新运行 npm run production:check/);
});

test("production status surfaces observation diagnosis as the actionable next step", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = new Date().toISOString();
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "latest-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "发现 1 条失败记录，需要先排查后再长时间运行。",
    diagnosis: {
      category: "codex_timeout_after_delivery",
      userMessage: "指令已经送达 Codex，但这一轮没有在等待时间内返回完成结果。",
      nextAction: "不要立即连续补发；先确认 Codex 是否仍在处理。",
    },
    counters: {
      dispatches: 1,
      completions: 0,
      supervisorReviews: 0,
    },
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary();
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "attention");
    assert.match(observation.summary, /指令已经送达 Codex/);
    assert.match(status.nextAction, /不要立即连续补发/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status keeps delivered waiting observations as waiting instead of attention", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = new Date().toISOString();
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "latest-production-observation.json", {
    status: "waiting",
    finishedAt: now,
    durationMs: 1,
    summary: "指令已送达，正在等待 Codex 完成这一轮。",
    nextAction: "不要重复发送；如需补充方向，先写入下一轮引导。",
    diagnosis: {
      category: "codex_waiting_after_delivery",
      userMessage: "指令已经送达 Codex，正在等待这一轮完成。",
      nextAction: "不要重复发送；可以先写入下一轮补充。",
    },
    counters: {
      dispatches: 1,
      completions: 0,
      supervisorReviews: 0,
    },
    waiting: {
      waitingSince: now,
      waitingMinutes: 18,
      waitAttentionMinutes: 15,
      needsHumanCheck: true,
    },
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary();
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "waiting");
    assert.equal(observation.status, "waiting");
    assert.equal(observation.waiting.waitingMinutes, 18);
    assert.equal(observation.waiting.needsHumanCheck, true);
    assert.match(observation.summary, /正在等待/);
    assert.match(observation.summary, /已等待约 18 分钟/);
    assert.match(status.nextAction, /不要重复发送/);
    assert.match(status.nextAction, /确认 Codex 是否仍在处理/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status refreshes real observation from current runtime logs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "old-production-observation.json", {
    status: "attention",
    finishedAt: "2026-06-10T14:00:00.000Z",
    durationMs: 1,
    summary: "旧观测失败，不应覆盖当前真实日志。",
    diagnosis: {
      nextAction: "旧建议不应继续显示。",
    },
  });

  const logDir = path.join(tempRoot, "runtime", "assistant-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-10T14:10:00.000Z" },
      {
        type: "codex_followup_sent_waiting",
        at: "2026-06-10T14:12:00.000Z",
        summary: "消息已送达绑定线程，正在等待 Codex 完成这一轮回复。",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: true,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "waiting");
    assert.equal(observation.status, "waiting");
    assert.match(observation.summary, /已等待约 8 分钟/);
    assert.doesNotMatch(status.nextAction, /旧建议/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status defaults to the configured current run instead of assistant-loop", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await fs.writeFile(
    path.join(tempRoot, "config.json"),
    `${JSON.stringify({ currentRunId: "current-task-run", projectName: "当前任务" }, null, 2)}\n`,
    "utf8",
  );
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });

  const staleLogDir = path.join(tempRoot, "runtime", "assistant-loop", "logs");
  await fs.mkdir(staleLogDir, { recursive: true });
  const staleLogPath = path.join(staleLogDir, "events.jsonl");
  await fs.writeFile(
    staleLogPath,
    [
      { type: "run_started_from_console", at: "2026-06-08T05:53:43.574Z" },
      { type: "codex_followup_failed", at: "2026-06-08T05:57:53.245Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  await fs.utimes(staleLogPath, new Date("2026-06-08T05:57:53.245Z"), new Date("2026-06-08T05:57:53.245Z"));

  const currentLogDir = path.join(tempRoot, "runtime", "current-task-run", "logs");
  await fs.mkdir(currentLogDir, { recursive: true });
  await fs.writeFile(
    path.join(currentLogDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-10T14:00:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T14:01:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T14:05:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T14:06:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T14:08:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T14:12:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T14:13:00.000Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: true,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "passed");
    assert.equal(observation.status, "passed");
    assert.match(observation.path, /current-task-run/);
    assert.doesNotMatch(observation.path, /assistant-loop/);
    assert.match(observation.summary, /2 轮真实闭环/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status marks stale live runtime observations by log age", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });

  const logDir = path.join(tempRoot, "runtime", "assistant-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, "events.jsonl");
  await fs.writeFile(
    logPath,
    [
      { type: "run_started_from_console", at: "2026-06-08T05:53:43.574Z" },
      {
        type: "codex_followup_failed",
        at: "2026-06-08T05:57:53.245Z",
        message: "Codex 已收到指令，但等待这一轮回复超时。",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  await fs.utimes(logPath, new Date("2026-06-08T05:57:53.245Z"), new Date("2026-06-08T05:57:53.245Z"));

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: true,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "attention");
    assert.equal(observation.status, "stale");
    assert.equal(observation.isStale, true);
    assert.match(observation.summary, /已过期/);
    assert.doesNotMatch(observation.summary, /上一轮|等待超时|已经同步/);
    assert.match(status.nextAction, /重新启动一次真实任务|重新运行 npm run production:observe/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status falls back to the latest fresh observation report when live log is stale", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "fresh-production-observation.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    summary: "已观察到 2 轮发送、Codex 完成和 NPC 复盘。",
    counters: {
      dispatches: 2,
      completions: 2,
      supervisorReviews: 2,
      closedLoops: 2,
    },
  });

  const logDir = path.join(tempRoot, "runtime", "assistant-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, "events.jsonl");
  await fs.writeFile(
    logPath,
    [
      { type: "run_started_from_console", at: "2026-06-08T05:53:43.574Z" },
      { type: "codex_followup_failed", at: "2026-06-08T05:57:53.245Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  await fs.utimes(logPath, new Date("2026-06-08T05:57:53.245Z"), new Date("2026-06-08T05:57:53.245Z"));

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: true,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "passed");
    assert.equal(status.readiness.stage, "production");
    assert.equal(observation.status, "passed");
    assert.match(observation.path, /production-observations/);
    assert.match(observation.summary, /2 轮真实闭环/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status separates passed code gates from missing live long-run evidence", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }, { status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });

  const logDir = path.join(tempRoot, "runtime", "assistant-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, "events.jsonl");
  await fs.writeFile(
    logPath,
    [
      { type: "run_started_from_console", at: "2026-06-08T05:53:43.574Z" },
      { type: "codex_followup_completed", at: "2026-06-08T05:57:53.245Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  await fs.utimes(logPath, new Date("2026-06-08T05:57:53.245Z"), new Date("2026-06-08T05:57:53.245Z"));

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: true,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });

    assert.equal(status.status, "attention");
    assert.equal(status.readiness.stage, "trial");
    assert.match(status.readiness.summary, /代码闸门已通过/);
    assert.match(status.readiness.summary, /缺少真实 2 轮闭环证据/);
    assert.match(status.readiness.nextAction, /启动真实任务/);
    assert.match(status.readiness.nextAction, /发送、Codex 完成、NPC 复盘/);
    assert.doesNotMatch(status.readiness.summary, /长期无人值守/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status treats one real closed loop as trial evidence instead of blocked", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "one-cycle-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "只观察到 1 轮完整闭环，说明链路可试用，但还不足以证明长期稳定运行。",
    nextAction: "再跑至少 1 轮真实任务，确认发送、Codex 完成和 NPC 复盘能连续出现。",
    diagnosis: {
      category: "partial_closed_loop_observed",
      userMessage: "已经观察到 1 轮发送、Codex 完成和 NPC 复盘。",
      nextAction: "再跑至少 1 轮真实任务，确认发送、Codex 完成和 NPC 复盘能连续出现。",
    },
    counters: {
      dispatches: 1,
      completions: 1,
      supervisorReviews: 1,
      closedLoops: 1,
    },
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: false,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });

    assert.equal(status.status, "attention");
    assert.equal(status.readiness.stage, "trial");
    assert.match(status.readiness.summary, /1 轮真实闭环/);
    assert.match(status.readiness.nextAction, /再跑至少 1 轮/);
    assert.match(status.nextAction, /再跑至少 1 轮/);
    assert.doesNotMatch(status.nextAction, /先处理真实运行观测/);
    assert.doesNotMatch(status.readiness.summary, /不能通过|需要处理/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status includes the bound task target before asking for another real loop", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await fs.writeFile(
    path.join(tempRoot, "config.json"),
    `${JSON.stringify({ currentRunId: "assistant-loop" }, null, 2)}\n`,
    "utf8",
  );
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "one-cycle-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "只观察到 1 轮完整闭环，说明链路可试用，但还不足以证明长期稳定运行。",
    nextAction: "再跑至少 1 轮真实任务，确认发送、Codex 完成和 NPC 复盘能连续出现。",
    counters: {
      dispatches: 1,
      completions: 1,
      supervisorReviews: 1,
      closedLoops: 1,
    },
  });
  await fs.mkdir(path.join(tempRoot, "runtime", "assistant-loop"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "runtime", "assistant-loop", "thread.json"),
    `${JSON.stringify({
      threadId: "thread-123",
      threadTitle: "按清单继续开发",
      workspaceRoot: "E:\\2026\\opencow",
      workspaceName: "opencow",
      continuationStatus: "idle",
    }, null, 2)}\n`,
    "utf8",
  );

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: false,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });

    assert.equal(status.readiness.stage, "trial");
    assert.equal(status.target.runId, "assistant-loop");
    assert.equal(status.target.threadId, "thread-123");
    assert.equal(status.target.threadTitle, "按清单继续开发");
    assert.equal(status.target.workspaceRoot, "E:\\2026\\opencow");
    assert.match(status.readiness.nextAction, /当前验证目标：按清单继续开发/);
    assert.match(status.readiness.nextAction, /E:\\2026\\opencow/);
    assert.match(status.readiness.nextAction, /确认这就是要继续的任务/);
    assert.match(status.nextAction, /当前验证目标：按清单继续开发/);
    assert.match(status.nextAction, /确认这就是要继续的任务/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status completes the target workspace from the loop registry", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await fs.writeFile(
    path.join(tempRoot, "config.json"),
    `${JSON.stringify({ currentRunId: "assistant-loop" }, null, 2)}\n`,
    "utf8",
  );
  await fs.mkdir(path.join(tempRoot, "settings"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "settings", "loops.json"),
    `${JSON.stringify({
      currentLoopId: "assistant-loop",
      loops: [
        {
          id: "assistant-loop",
          runId: "assistant-loop",
          name: "按清单继续开发",
          projectName: "opencow",
          workspaceRoot: "E:\\2026\\opencow",
          threadBinding: {
            threadId: "thread-123",
            threadTitle: "按清单继续开发",
          },
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "one-cycle-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "只观察到 1 轮完整闭环，说明链路可试用，但还不足以证明长期稳定运行。",
    counters: { dispatches: 1, completions: 1, supervisorReviews: 1, closedLoops: 1 },
  });
  await fs.mkdir(path.join(tempRoot, "runtime", "assistant-loop"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "runtime", "assistant-loop", "thread.json"),
    `${JSON.stringify({
      threadId: "thread-123",
      threadTitle: "按清单继续开发",
      workspaceName: "按清单继续开发",
      continuationStatus: "idle",
    }, null, 2)}\n`,
    "utf8",
  );

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: false,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });

    assert.equal(status.target.workspaceRoot, "E:\\2026\\opencow");
    assert.equal(status.target.projectName, "opencow");
    assert.match(status.readiness.nextAction, /E:\\2026\\opencow/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status exposes the two-cycle live evidence threshold", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });

  const logDir = path.join(tempRoot, "runtime", "assistant-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-10T14:00:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T14:01:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T14:05:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T14:06:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T14:08:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T14:12:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T14:13:00.000Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: true,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "passed");
    assert.equal(observation.status, "passed");
    assert.match(observation.summary, /2 轮真实闭环/);
    assert.match(observation.summary, /长期运行基本证据/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status exposes structured maturity and remaining gaps", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "one-cycle-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "只观察到 1 轮完整闭环，说明链路可试用，但还不足以证明长期稳定运行。",
    counters: { dispatches: 1, completions: 1, supervisorReviews: 1, closedLoops: 1 },
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: false,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });

    assert.equal(status.maturity.label, "短时试用");
    assert.equal(status.maturity.percent, 75);
    assert.equal(status.maturity.canTrial, true);
    assert.equal(status.maturity.canLongRun, false);
    assert.match(status.maturity.summary, /还缺少第 2 轮连续闭环证据/);
    assert.ok(status.maturity.gaps.some((gap) => /第 2 轮真实闭环/.test(gap)));
    assert.ok(status.maturity.evidence.some((item) => /代码闸门已通过/.test(item)));
    assert.ok(status.maturity.evidence.some((item) => /已观察到 1 轮真实闭环/.test(item)));
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status marks missing supervisor recovery as not ready for trial", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "needs-recovery-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "Codex 已有完成回复，但还缺少 NPC 监督复盘，暂时不能算完整闭环。",
    nextAction: "先运行 npm run production:recover 补齐监督复盘；该命令不会发送下一轮指令。",
    diagnosis: {
      category: "completion_missing_supervisor_review",
      userMessage: "Codex 已有完成回复，但还缺少 NPC 监督复盘，暂时不能算完整闭环。",
      nextAction: "先运行 npm run production:recover 补齐监督复盘；该命令不会发送下一轮指令。",
    },
    counters: {
      dispatches: 1,
      completions: 1,
      supervisorReviews: 0,
      closedLoops: 0,
    },
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: false,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });

    assert.equal(status.readiness.stage, "blocked");
    assert.match(status.readiness.summary, /缺少 NPC 监督复盘/);
    assert.match(status.readiness.nextAction, /production:recover/);
    assert.equal(status.maturity.label, "需恢复");
    assert.equal(status.maturity.canTrial, false);
    assert.equal(status.maturity.canLongRun, false);
    assert.ok(status.maturity.gaps.some((gap) => /补齐监督复盘/.test(gap)));
    assert.match(status.nextAction, /production:recover/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("production status detects supervisor recovery from structured diagnosis", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = "2026-06-10T14:20:00.000Z";
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "structured-recovery-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "当前轮已经结束，但复盘步骤尚未完成。",
    nextAction: "运行恢复命令后再继续。",
    diagnosis: {
      category: "completion_missing_supervisor_review",
      userMessage: "当前轮已经结束，但复盘步骤尚未完成。",
      nextAction: "运行恢复命令后再继续。",
    },
    counters: {
      dispatches: 1,
      completions: 1,
      supervisorReviews: 0,
      closedLoops: 0,
    },
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary({
      refreshObservation: false,
      now: new Date("2026-06-10T14:20:00.000Z"),
    });

    assert.equal(status.readiness.stage, "blocked");
    assert.equal(status.maturity.label, "需恢复");
    assert.equal(status.maturity.canTrial, false);
    assert.match(status.readiness.nextAction, /production:recover/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("frontend evidence check requires closed-loop evidence progress on desktop and mobile", async () => {
  const source = await read("scripts/frontend-evidence-check.mjs");
  const readme = await read("README.md");
  const architecture = await read("docs/enterprise-loop-architecture.md");

  assert.match(source, /闭环证据/);
  assert.match(source, /真实闭环/);
  assert.match(source, /复制命令/);
  assert.match(source, /复制文件/);
  assert.match(source, /本地模型/);
  assert.match(source, /NPC/);
  assert.match(source, /待合并/);
  assert.match(source, /先确认桌面端和移动端构建产物是否包含/);
  assert.match(source, /闭环证据/);
  assert.match(readme, /闭环证据/);
  assert.match(architecture, /闭环证据/);
});

test("docs make production readiness check the pre-use gate", async () => {
  const readme = await read("README.md");
  const checklist = await read("codex-loop6.7-13-29开发清单.md");
  const architecture = await read("docs/enterprise-loop-architecture.md");

  for (const source of [readme, checklist, architecture]) {
    assert.match(source, /npm run production:check/);
    assert.match(source, /npm run production:observe/);
    assert.match(source, /生产就绪检查|投入使用前|生产化检查/);
  }
});
