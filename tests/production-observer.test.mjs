import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildProductionObservation } from "../scripts/production-observer.mjs";

test("production observer builds a readable timeline from real runtime events", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "demo-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T08:00:00.000Z",
        summary: "循环已启动。",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T08:01:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续完成移动端历史对话验收。",
      },
      {
        type: "codex_followup_sent_waiting",
        at: "2026-06-10T08:01:02.000Z",
        summary: "消息已送达绑定线程，正在等待 Codex 完成这一轮回复。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T08:10:00.000Z",
        latestAssistantPreview: "Codex 已完成移动端历史对话展示并跑过测试。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T08:12:00.000Z",
        summary: "NPC 以产品经理和测试人员视角确认可以继续。",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T08:13:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续完成移动端生产观测验收。",
      },
      {
        type: "codex_followup_sent_waiting",
        at: "2026-06-10T08:13:02.000Z",
        summary: "消息已送达绑定线程，正在等待 Codex 完成第二轮回复。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T08:18:00.000Z",
        latestAssistantPreview: "Codex 已完成第二轮移动端生产观测展示。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T08:19:00.000Z",
        summary: "NPC 复盘确认第二轮仍可继续。",
      },
      {
        type: "graceful_stop_completed",
        at: "2026-06-10T08:20:00.000Z",
        summary: "循环已停止。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "demo-loop",
  });

  assert.equal(report.title, "codex-loop 真实运行观测报告");
  assert.equal(report.status, "passed");
  assert.match(report.startedAt, /2026|20\d\d/);
  assert.match(report.finishedAt, /2026|20\d\d/);
  assert.equal(typeof report.durationMs, "number");
  assert.equal(report.loop.runId, "demo-loop");
  assert.equal(report.timeline.length, 10);
  assert.equal(report.counters.dispatches, 2);
  assert.equal(report.counters.completions, 2);
  assert.equal(report.counters.supervisorReviews, 2);
  assert.equal(report.counters.failures, 0);
  assert.equal(report.counters.stopEvents, 1);
  assert.match(report.summary, /已观察到 2 轮发送、Codex 完成和 NPC 复盘/);
  assert.match(report.nextAction, /可以继续真实任务/);
  assert.match(report.timeline.map((item) => item.label).join("\n"), /Codex 已完成一轮/);
  assert.match(report.timeline.map((item) => item.detail).join("\n"), /移动端历史对话/);
});

test("production observer treats one complete cycle as trial evidence, not long-run readiness", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "single-cycle-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T08:00:00.000Z",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T08:01:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续完成移动端历史对话验收。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T08:10:00.000Z",
        latestAssistantPreview: "Codex 已完成移动端历史对话展示并跑过测试。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T08:12:00.000Z",
        summary: "NPC 以产品经理和测试人员视角确认可以继续。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "single-cycle-loop",
  });

  assert.equal(report.status, "attention");
  assert.equal(report.counters.closedLoops, 1);
  assert.match(report.summary, /只观察到 1 轮完整闭环/);
  assert.match(report.nextAction, /再跑至少 1 轮/);
});

test("production observer only counts ordered dispatch-completion-review cycles", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "unordered-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-10T08:00:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T08:01:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T08:02:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T08:03:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T08:04:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T08:05:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T08:06:00.000Z" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "unordered-loop",
  });

  assert.equal(report.status, "attention");
  assert.equal(report.counters.dispatches, 2);
  assert.equal(report.counters.completions, 2);
  assert.equal(report.counters.supervisorReviews, 2);
  assert.equal(report.counters.closedLoops, 0);
  assert.match(report.summary, /还没有形成发送、完成、NPC 复盘的完整闭环证据/);
});

test("production observer defaults to config.currentRunId for multi-task consoles", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  await fs.writeFile(
    path.join(tempRoot, "config.json"),
    `${JSON.stringify({ currentRunId: "current-task-run", projectName: "当前任务" }, null, 2)}\n`,
    "utf8",
  );

  const oldLogDir = path.join(tempRoot, "runtime", "assistant-loop", "logs");
  await fs.mkdir(oldLogDir, { recursive: true });
  await fs.writeFile(
    path.join(oldLogDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-08T08:00:00.000Z" },
      { type: "codex_followup_failed", at: "2026-06-08T08:01:00.000Z" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const logDir = path.join(tempRoot, "runtime", "current-task-run", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-10T08:00:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T08:01:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T08:05:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T08:06:00.000Z" },
      { type: "codex_followup_dispatching", at: "2026-06-10T08:08:00.000Z" },
      { type: "codex_followup_completed", at: "2026-06-10T08:12:00.000Z" },
      { type: "supervisor_review_completed", at: "2026-06-10T08:13:00.000Z" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
  });

  assert.equal(report.status, "passed");
  assert.equal(report.loop.runId, "current-task-run");
  assert.match(report.loop.logPath, /current-task-run/);
  assert.equal(report.counters.closedLoops, 2);
});

test("production observer marks missing or failed long-run evidence as attention", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const missing = await buildProductionObservation({
    root: tempRoot,
    runId: "missing-loop",
  });

  assert.equal(missing.status, "attention");
  assert.match(missing.summary, /还没有可用的真实运行记录/);
  assert.match(missing.nextAction, /先启动一次真实任务/);

  const logDir = path.join(tempRoot, "runtime", "failed-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      JSON.stringify({
        type: "codex_followup_dispatching",
        at: "2026-06-10T09:00:00.000Z",
        promptGenerator: "ollama",
      }),
      JSON.stringify({
        type: "codex_followup_failed",
        at: "2026-06-10T09:01:00.000Z",
        message: "向 Codex 桌面线程发送下一轮指令失败。",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const failed = await buildProductionObservation({
    root: tempRoot,
    runId: "failed-loop",
  });

  assert.equal(failed.status, "attention");
  assert.equal(failed.counters.failures, 1);
  assert.match(failed.summary, /发现 1 条未恢复失败记录/);
  assert.match(failed.nextAction, /先处理失败记录/);
});

test("production observer diagnoses sent-but-timeout failures separately from dispatch failures", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "timeout-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T11:00:00.000Z",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T11:01:00.000Z",
        promptPreview: "继续完成真实链路验证。",
      },
      {
        type: "codex_followup_sent_waiting",
        at: "2026-06-10T11:01:02.000Z",
        summary: "消息已送达绑定线程，正在等待 Codex 完成这一轮回复。",
      },
      {
        type: "codex_followup_failed",
        at: "2026-06-10T11:11:02.000Z",
        message: "Codex 已收到指令，但等待这一轮回复超时。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "timeout-loop",
  });

  assert.equal(report.status, "attention");
  assert.equal(report.diagnosis.category, "codex_timeout_after_delivery");
  assert.match(report.diagnosis.userMessage, /指令已经送达/);
  assert.match(report.diagnosis.nextAction, /不要立即连续补发/);
});

test("production observer treats later Codex mirror replies as timeout recovery evidence", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "timeout-recovered-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T11:00:00.000Z",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T11:01:00.000Z",
        promptPreview: "继续完成真实链路验证。",
      },
      {
        type: "codex_followup_failed",
        at: "2026-06-10T11:11:00.000Z",
        message: "Codex 已收到指令，但等待这一轮回复超时。",
      },
      {
        type: "codex_conversation_mirror_synced",
        at: "2026-06-10T11:30:00.000Z",
        latestAssistantAt: "2026-06-10T11:29:00.000Z",
        latestAssistantPreview: "Codex 已经完成这一轮开发，并给出验证结果。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "timeout-recovered-loop",
  });

  assert.equal(report.diagnosis.category, "codex_reply_recovered_after_timeout");
  assert.equal(report.counters.failures, 0);
  assert.equal(report.counters.completions, 1);
  assert.match(report.summary, /缺少 NPC 监督复盘/);
  assert.match(report.nextAction, /production:recover/);
  assert.match(report.diagnosis.nextAction, /production:recover/);
  assert.doesNotMatch(report.nextAction, /不要立即连续补发/);
  assert.match(report.timeline.map((item) => item.detail).join("\n"), /Codex 已经完成这一轮开发/);
});

test("production observer stops asking for recovery after recovered replies are reviewed", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "timeout-reviewed-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-10T11:00:00.000Z" },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T11:01:00.000Z",
        promptPreview: "继续完成真实链路验证。",
      },
      {
        type: "codex_followup_failed",
        at: "2026-06-10T11:11:00.000Z",
        message: "Codex 已收到指令，但等待这一轮回复超时。",
      },
      {
        type: "codex_conversation_mirror_synced",
        at: "2026-06-10T11:30:00.000Z",
        latestAssistantAt: "2026-06-10T11:29:00.000Z",
        latestAssistantPreview: "Codex 已经完成这一轮开发，并给出验证结果。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T11:31:00.000Z",
        summary: "NPC 复盘确认恢复后的回复可以继续观察。",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "timeout-reviewed-loop",
  });

  assert.equal(report.counters.closedLoops, 1);
  assert.notEqual(report.diagnosis.category, "codex_reply_recovered_after_timeout");
  assert.doesNotMatch(report.diagnosis.nextAction, /production:recover/);
  assert.doesNotMatch(report.nextAction, /production:recover/);
  assert.match(report.nextAction, /再跑至少 1 轮/);
});

test("production observer reports delivered turns that are still waiting as waiting instead of failure", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "waiting-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T14:00:00.000Z",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T14:01:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续验证等待态。",
      },
      {
        type: "codex_followup_sent_waiting",
        at: "2026-06-10T14:01:02.000Z",
        summary: "消息已送达绑定线程，正在等待 Codex 完成这一轮回复。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "waiting-loop",
  });

  assert.equal(report.status, "waiting");
  assert.equal(report.diagnosis.category, "codex_waiting_after_delivery");
  assert.match(report.summary, /正在等待 Codex/);
  assert.match(report.nextAction, /不要重复发送/);
});

test("production observer includes waiting duration and human-check threshold", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "long-waiting-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T14:00:00.000Z",
      },
      {
        type: "codex_followup_sent_waiting",
        at: "2026-06-10T14:01:00.000Z",
        summary: "消息已送达绑定线程，正在等待 Codex 完成这一轮回复。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "long-waiting-loop",
    now: new Date("2026-06-10T14:17:00.000Z"),
  });

  assert.equal(report.status, "waiting");
  assert.equal(report.waiting.waitingMinutes, 16);
  assert.equal(report.waiting.waitAttentionMinutes, 15);
  assert.equal(report.waiting.needsHumanCheck, true);
  assert.match(report.summary, /已等待约 16 分钟/);
  assert.match(report.nextAction, /确认 Codex 是否仍在处理/);
});

test("production observer treats legacy received timeout details as delivered timeout", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "legacy-timeout-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T12:00:00.000Z",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T12:01:00.000Z",
        promptPreview: "继续完成真实链路验证。",
      },
      {
        type: "codex_followup_failed",
        at: "2026-06-10T12:11:00.000Z",
        message: "Codex 已收到指令，但等待这一轮回复超时。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "legacy-timeout-loop",
  });

  assert.equal(report.diagnosis.category, "codex_timeout_after_delivery");
  assert.match(report.diagnosis.userMessage, /指令已经送达/);
});

test("production observer diagnoses the latest failed followup even after an earlier completion", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "mixed-cycle-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T13:00:00.000Z",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T13:01:00.000Z",
        promptPreview: "第一轮继续。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T13:05:00.000Z",
        latestAssistantPreview: "第一轮完成。",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T13:06:00.000Z",
        promptPreview: "第二轮继续。",
      },
      {
        type: "codex_followup_failed",
        at: "2026-06-10T13:16:00.000Z",
        message: "Codex 已收到指令，但等待这一轮回复超时。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "mixed-cycle-loop",
  });

  assert.equal(report.diagnosis.category, "codex_timeout_after_delivery");
  assert.match(report.diagnosis.nextAction, /不要立即连续补发/);
});

test("production observer dedupes repeated stop noise and repairs unreadable legacy details", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "noisy-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "graceful_stop_requested",
        at: "2026-06-10T10:00:00.000Z",
        reason: "??????????,??????",
      },
      {
        type: "graceful_stop_completed",
        at: "2026-06-10T10:01:00.000Z",
        summary: "graceful stop completed",
      },
      {
        type: "graceful_stop_completed",
        at: "2026-06-10T10:01:00.001Z",
        summary: "graceful stop completed",
      },
      {
        type: "graceful_stop_completed",
        at: "2026-06-10T10:01:00.002Z",
        summary: "graceful stop completed",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "noisy-loop",
  });

  assert.equal(report.timeline.length, 2);
  assert.equal(report.counters.stopEvents, 1);
  assert.match(report.timeline[0].detail, /旧日志详情不可读/);
  assert.doesNotMatch(report.timeline.map((item) => item.detail).join("\n"), /\?{4,}/);
});

test("production observer judges the latest run cycle while preserving historical failures", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "recovered-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      {
        type: "run_started_from_console",
        at: "2026-06-10T08:00:00.000Z",
      },
      {
        type: "codex_followup_failed",
        at: "2026-06-10T08:01:00.000Z",
        message: "旧窗口不可接收新指令。",
      },
      {
        type: "run_started_from_console",
        at: "2026-06-10T09:00:00.000Z",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T09:01:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续推进真实长跑验证。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T09:08:00.000Z",
        latestAssistantPreview: "Codex 已完成一轮真实验证。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T09:10:00.000Z",
        summary: "NPC 复盘认为当前轮可以继续。",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T09:11:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续推进第二轮真实长跑验证。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T09:18:00.000Z",
        latestAssistantPreview: "Codex 已完成第二轮真实验证。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T09:20:00.000Z",
        summary: "NPC 复盘认为第二轮也可以继续。",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "recovered-loop",
  });

  assert.equal(report.status, "passed");
  assert.equal(report.counters.failures, 0);
  assert.equal(report.history.failureCount, 1);
  assert.equal(report.history.totalTimelineEvents, 9);
  assert.equal(report.counters.closedLoops, 2);
  assert.match(report.summary, /最近一次运行周期/);
  assert.doesNotMatch(report.timeline.map((item) => item.detail).join("\n"), /旧窗口不可接收/);
});

test("production observer treats early same-run failures as resolved after two later closed loops", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-observer-"));
  const logDir = path.join(tempRoot, "runtime", "same-run-recovered-loop", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "events.jsonl"),
    [
      { type: "run_started_from_console", at: "2026-06-10T09:00:00.000Z" },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T09:01:00.000Z",
        promptPreview: "第一次发送失败后重试。",
      },
      {
        type: "codex_followup_failed",
        at: "2026-06-10T09:02:00.000Z",
        message: "Codex 桌面端短暂不可接收新指令。",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T09:05:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续推进第一轮稳定验证。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T09:12:00.000Z",
        latestAssistantPreview: "第一轮稳定验证已完成。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T09:13:00.000Z",
        summary: "NPC 复盘确认第一轮可继续。",
      },
      {
        type: "codex_followup_dispatching",
        at: "2026-06-10T09:15:00.000Z",
        promptGenerator: "ollama",
        promptPreview: "继续推进第二轮稳定验证。",
      },
      {
        type: "codex_followup_completed",
        at: "2026-06-10T09:22:00.000Z",
        latestAssistantPreview: "第二轮稳定验证已完成。",
      },
      {
        type: "supervisor_review_completed",
        at: "2026-06-10T09:23:00.000Z",
        summary: "NPC 复盘确认第二轮可继续。",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const report = await buildProductionObservation({
    root: tempRoot,
    runId: "same-run-recovered-loop",
  });

  assert.equal(report.status, "passed");
  assert.equal(report.counters.failures, 1);
  assert.equal(report.counters.unresolvedFailures, 0);
  assert.equal(report.counters.closedLoops, 2);
  assert.match(report.summary, /2 轮发送、Codex 完成和 NPC 复盘/);
  assert.match(report.diagnosis.userMessage, /早期失败已被后续稳定闭环覆盖/);
});
