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
  assert.equal(report.timeline.length, 6);
  assert.equal(report.counters.dispatches, 1);
  assert.equal(report.counters.completions, 1);
  assert.equal(report.counters.supervisorReviews, 1);
  assert.equal(report.counters.failures, 0);
  assert.equal(report.counters.stopEvents, 1);
  assert.match(report.summary, /已观察到发送、等待、Codex 完成和 NPC 复盘/);
  assert.match(report.nextAction, /可以继续真实任务/);
  assert.match(report.timeline.map((item) => item.label).join("\n"), /Codex 已完成一轮/);
  assert.match(report.timeline.map((item) => item.detail).join("\n"), /移动端历史对话/);
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
  assert.match(failed.summary, /发现 1 条失败记录/);
  assert.match(failed.nextAction, /先处理失败记录/);
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
  assert.equal(report.history.totalTimelineEvents, 6);
  assert.match(report.summary, /最近一次运行周期/);
  assert.doesNotMatch(report.timeline.map((item) => item.detail).join("\n"), /旧窗口不可接收/);
});
